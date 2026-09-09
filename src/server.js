/**
 * server.js —— 原生 http + SSE，仅监听 127.0.0.1
 *
 * 安全边界（硬编码，不可配置）：
 *   - 只绑定 127.0.0.1，不监听 0.0.0.0，局域网无法访问
 *   - 无 shell 工具
 *   - 文件访问限制在 sandbox/（本阶段未启用）
 *   - 密钥永不进日志、永不返回给前端
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const llm = require('./llm');
const memory = require('./memory');
const mind = require('./mind');
const voice = require('./voice');
/* faster-whisper 可选旁路：装了用它（准确率更高），没装静默回退 System.Speech。
 * require 本身零副作用 —— 不会去探测、不会碰网络、不会安装任何东西。 */
const whisper = require('./whisper_sidecar');
const tools = require('./tools/registry');
const patrol = require('./patrol');
const brain = require('./brain');
const feishu = require('./feishu');

const HOST = '127.0.0.1';
const PORT = 3800;
const UI_DIR = path.join(__dirname, '..', 'ui');

const SYSTEM_PROMPT = `你是贾维斯（JARVIS），用户的桌面常驻助手。

风格：冷静、克制、简洁。像一位可靠的管家，不谄媚、不啰嗦、不用感叹号堆砌热情。
称呼用户为"你"。回答直接给结论，需要展开时才展开。

如果下方提供了【相关记忆】，自然地运用它们，不要复述"根据我的记忆"这类废话。
如果记忆与当前问题无关，忽略它们。
如果你不知道或不确定，直接说不知道。`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

/* ─────────────────── 语音事件中枢 ───────────────────
 * 管理常听进程的生命周期，并把识别事件广播给所有 SSE 订阅者。
 *
 * 设计要点：**按需开麦**。
 * 麦克风是敏感资源，没人订阅时就该关掉，而不是服务一起来就常开。
 * 另外前端可以用 /api/voice/mic?on=0 手动静音。
 */
const voiceHub = {
  clients: new Set(),
  listener: null,
  enabled: true,        // 用户是否允许开麦（界面开关）
  _forceOn: false,      // 用户显式要求常听（不依赖是否有 SSE 订阅者）
  _starting: false,     // 正在启动中 —— 防止异步窗口内重复 spawn 导致进程泄漏

  isListening() { return !!(this.listener && this.listener.running); },

  add(w) {
    this.clients.add(w);
    // 先把当前状态告诉新订阅者，避免界面显示不同步
    w('voice_status', { listening: this.isListening(), enabled: this.enabled,
                        wakeWords: voice.WAKE_WORDS });
    this._sync();
  },

  remove(w) {
    this.clients.delete(w);
    this._sync();
  },

  setEnabled(on) {
    this.enabled = !!on;
    this._sync();
    this.broadcast('voice_status', { listening: this.isListening(), enabled: this.enabled });
  },

  broadcast(ev, data) {
    for (const w of this.clients) { try { w(ev, data); } catch (_) {} }
  },

  /** 根据"有无订阅者 + 是否允许"决定开关常听进程
   *
   * ══════ 实测发现的两个 bug ══════
   *
   * 1. **进程泄漏**：原来只用 isListening()（依赖 listener.running）判断，
   *    但 Listener.start() 是异步的 —— 子进程已 spawn，running 却还是 false
   *    （要等 PowerShell 报 ready 才置 true）。
   *    于是这段时间内再次 _sync() 会认为"没在听"，又 new 一个 Listener。
   *    实测残留了 2 个 powershell.exe 语音子进程，都在抢麦克风。
   *    修法：加 _starting 标志，把"正在启动"也算作已占用。
   *
   * 2. **listening 恒为 false**：POST /api/voice/mic?on=1 只设 enabled，
   *    不产生 SSE 订阅者，而 want 要求 clients.size > 0，
   *    所以用接口开麦永远返回 listening:false，看起来像"语音功能没有"。
   *    修法：区分"用户显式要求开麦"和"有人在看"两件事 ——
   *    _forceOn 为真时即使暂时没有订阅者也保持监听，
   *    这样浏览器 fetch(on=1) 与随后的 EventSource 之间的缝隙不会打断它。
   */
  _sync() {
    const want = this.enabled && (this.clients.size > 0 || this._forceOn);

    if (want) {
      // _starting 防止异步启动窗口内重复 spawn（就是那个进程泄漏）
      if (!this.isListening() && !this._starting) {
        this._starting = true;
        try {
          this.listener = new voice.Listener(ev => {
            if (ev.type === 'ready' || ev.type === 'stopped' || ev.type === 'error') {
              this._starting = false;
            }
            this._onEvent(ev);
          });
          this.listener.start();
        } catch (e) {
          this._starting = false;
          this.listener = null;
          this.broadcast('voice_error', { msg: '麦克风启动失败: ' + e.message });
        }
        /* 兜底：万一 PowerShell 既不 ready 也不报错（实测见过静默失败），
         * 15 秒后解除 _starting，否则语音永久卡在"启动中"再也起不来。 */
        setTimeout(() => { this._starting = false; }, 15000);

        /* 顺便探一次 STT 引擎，结果缓存给 /api/status 用。
         * 异步、不阻塞开麦 —— 探测要启动 Python（约 700ms），
         * 不该让用户点了麦克风还多等这一下。
         * 失败也不影响语音功能：旁路缺失只是准确率略低，不是错误。 */
        whisper.status().then(s => {
          this._sttEngine = s.engine;
          if (s.whisperAvailable) {
            this.broadcast('voice_stt', { engine: s.engine, note: s.note });
          }
        }).catch(() => { this._sttEngine = 'System.Speech'; });
      }
    } else if (this.isListening() || this._starting) {
      try { if (this.listener) this.listener.stop(); } catch (_) {}
      this.listener = null;
      this._starting = false;
    }
  },

  /** 用户通过界面/接口显式开关麦克风（区别于"页面是否打开"） */
  setForce(on) {
    this._forceOn = !!on;
    this._sync();
  },

  _onEvent(ev) {
    if (ev.type === 'ready') {
      this.broadcast('voice_status', { listening: true, enabled: this.enabled });
      return;
    }
    if (ev.type === 'stopped') {
      this.broadcast('voice_status', { listening: false, enabled: this.enabled });
      return;
    }
    if (ev.type === 'error') {
      this.broadcast('voice_error', { msg: ev.msg });
      return;
    }
    /* ── 打断（barge-in）──
     * 朗读中被唤醒或被说话截住。必须立刻通知前端停播 ——
     * 喇叭还在响的话麦克风会收到自己的声音，变成自问自答。 */
    if (ev.type === 'interrupt') {
      this.setSpeaking(false);
      this.broadcast('voice_interrupt', { reason: ev.reason });
      return;
    }
    // 对话窗口结束（用户说"结束/没事了"）
    if (ev.type === 'convo_end') {
      this.broadcast('voice_convo', { open: false, text: ev.text });
      return;
    }
    /* 没听清 —— 上报但不发给模型。
     * 界面能显示"没听清"比完全没反应好，也让用户知道麦克风是活的。 */
    if (ev.type === 'speech_unclear') {
      this.broadcast('voice_unclear', { text: ev.text, conf: ev.conf });
      return;
    }
    // wake / speech
    this.broadcast(ev.type === 'wake' ? 'voice_wake' : 'voice_speech', ev);
  },

  /** 转告 Listener 当前是否在朗读 —— 决定唤醒词算打断还是新一轮 */
  setSpeaking(on) {
    if (this.listener && typeof this.listener.setSpeaking === 'function') {
      this.listener.setSpeaking(on);
    }
    this.broadcast('voice_speaking', { speaking: !!on });
  },

  /** 对话窗口状态（给 /api/status 用） */
  convoOpen() {
    return !!(this.listener && typeof this.listener.inConvo === 'function'
      && this.listener.inConvo());
  },
};

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      d += c;
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

/** 静态文件：路径穿越防护 */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(UI_DIR, rel);
  // 必须仍在 UI_DIR 内
  if (!path.resolve(full).startsWith(path.resolve(UI_DIR))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  /* ── favicon：内联一个极小的 SVG，避免 404 噪音 ── */
  if (url === '/favicon.ico' || url === '/favicon.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#070b11"/>
<circle cx="16" cy="16" r="4" fill="#ff9f1c"/>
<circle cx="16" cy="16" r="10" fill="none" stroke="#4f8cff" stroke-width="1.4" opacity=".7"/>
</svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    res.end(svg);
    return;
  }

  /* ── 状态 ── */
  if (url === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      hasKey: llm.hasKey(),
      model: llm.MODEL,
      counts: db.counts(),
      usage: llm.getUsage(),
      voice: { listening: voiceHub.isListening(), enabled: voiceHub.enabled,
               starting: !!voiceHub._starting,
               convoOpen: voiceHub.convoOpen(),
               wakeWords: voice.WAKE_WORDS,
               convoWindowSec: Math.round(voice.CONVO_WINDOW_MS / 1000),
               /* STT 引擎名。这里读探测缓存（5 分钟 TTL），不阻塞 status ——
                * status 是高频接口，不该每次都启动 Python 进程。 */
               sttEngine: voiceHub._sttEngine || 'System.Speech' },
    });
  }

  /* ── 星图 ── */
  if (url === '/api/starmap') {
    return sendJson(res, 200, memory.starmap());
  }

  /* ── 单条记忆详情（星图点击面板用）──
   * 返回内容 + 合并历史。合并历史里的 dropped_text 是被删记忆的
   * 唯一留存处，所以这个接口也是人工审查/恢复的入口。 */
  if (url.startsWith('/api/memory/')) {
    const id = parseInt(url.slice('/api/memory/'.length).split('?')[0], 10);
    if (!isFinite(id)) return sendJson(res, 400, { error: '无效的记忆 id' });
    const m = db.memById(id);
    if (!m) return sendJson(res, 404, { error: '记忆不存在（可能已被合并）' });
    return sendJson(res, 200, {
      memory: m,
      merges: db.mergesFor(id),
    });
  }

  /* ── 全部合并历史（审查 AI 动过哪些记忆）── */
  if (url === '/api/merges' || url.startsWith('/api/merges?')) {
    const q = new URL(url, 'http://x').searchParams;
    const limit = Math.min(500, parseInt(q.get('limit') || '200', 10) || 200);
    return sendJson(res, 200, { merges: db.allMerges(limit) });
  }

  /* ── 历史 ── */
  if (url.startsWith('/api/history')) {
    return sendJson(res, 200, { messages: db.recentMessages(40) });
  }

  /* ── 检索（调试用，可看命中详情） ── */
  if (url.startsWith('/api/search') && req.method === 'GET') {
    const q = new URL(url, 'http://x').searchParams.get('q') || '';
    const hits = await memory.search(q, 8);
    return sendJson(res, 200, { query: q, hits });
  }

  /* ── 主动意识状态（SSE 长连接） ── */
  if (url === '/api/mind') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 立刻发一个注释帧，让浏览器确认连接已建立
    res.write(': connected\n\n');

    const writer = (ev, data) => {
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    mind.addClient(writer);

    // 心跳注释帧，防止代理/浏览器把空闲连接掐掉
    const ka = setInterval(() => {
      try { res.write(': ka\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(ka);
      mind.removeClient(writer);
    });
    return;   // 不要 res.end()，这是长连接
  }

  /* ── 主动意识状态快照（一次性 JSON，调试用） ── */
  if (url === '/api/mind/state') {
    return sendJson(res, 200, await mind.getSnapshot());
  }

  /* ── 巡视状态 / 手动触发 ──
     GET  /api/patrol        看各任务冷却状态
     POST /api/patrol/run    立刻跑一次巡视（调试 + 用户主动要求"去看看"时用） */
  if (url === '/api/patrol' || url.startsWith('/api/patrol?')) {
    return sendJson(res, 200, {
      cooldowns: patrol.cooldownStatus(),
      thresholds: patrol.THRESHOLDS,
      weeklyDue: patrol.weeklyDue(),
    });
  }
  if (url.startsWith('/api/patrol/run') && req.method === 'POST') {
    const q = new URL(url, 'http://x').searchParams;
    const which = q.get('task');
    try {
      let r;
      if (which === 'market') r = { task: 'market_scan', label: '扫描大盘', result: await patrol.scanMarket() };
      else if (which === 'sessions') r = { task: 'session_scan', label: '巡视会话记录', result: await patrol.scanSessions() };
      else if (which === 'health') r = { task: 'health_check', label: '检查数据源健康', result: await patrol.checkHealth() };
      else r = await patrol.runOne({ reason: 'manual' });
      return sendJson(res, 200, r || { task: null, note: '所有任务都在冷却中' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ── 数据源健康 + 自我诊断 ── */
  if (url === '/api/health/sources' || url.startsWith('/api/health/sources?')) {
    const sh = require('./tools/source_health');
    return sendJson(res, 200, { sources: sh.healthAll(), problems: sh.problems() });
  }
  if (url.startsWith('/api/health/diagnose') && req.method === 'POST') {
    const q = new URL(url, 'http://x').searchParams;
    const source = q.get('source');
    if (!source) return sendJson(res, 400, { error: '缺 source 参数' });
    try {
      const sd = require('./tools/self_diagnose');
      return sendJson(res, 200, await sd.diagnose(source));
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ── 飞书接入状态 ── */
  if (url === '/api/feishu' || url.startsWith('/api/feishu?')) {
    const fs2 = require('./feishu');
    return sendJson(res, 200, fs2.status());
  }

  /* ── Obsidian 库 ── */
  if (url === '/api/obsidian' || url.startsWith('/api/obsidian?')) {
    try {
      const ob = require('./tools/obsidian');
      return sendJson(res, 200, ob.overview());
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ── 语音能力探测 ── */
  if (url === '/api/voice/probe') {
    const base = await voice.probe();
    /* 顺便带上 STT 引擎信息。
     * faster-whisper 是**可选**旁路：装了就用，没装就静默回退系统语音。
     * 不可用时也把安装命令交出来，但绝不代替用户执行 ——
     * 往人家机器上装 500MB 模型是越界。 */
    let stt = null;
    try { stt = await whisper.status(); }
    catch (e) { stt = { engine: 'System.Speech', whisperAvailable: false, reason: e.message }; }
    return sendJson(res, 200, Object.assign({}, base, { stt }));
  }

  /* ── STT 引擎状态（单独接口，便于用户装完后立刻复查） ──
   *
   * ⚠ 必须同时匹配带 query 的形式。第一版写成 `url === '/api/voice/stt'`
   * 却在块内读 ?refresh 参数 —— 自相矛盾：带参数的请求根本进不来，
   * 实测 /api/voice/stt?refresh=1 直接 404。 */
  if (url === '/api/voice/stt' || url.startsWith('/api/voice/stt?')) {
    // 带 ?refresh=1 时清掉探测缓存 —— 用户刚装完不用重启服务
    const q = new URL(url, 'http://x').searchParams;
    if (q.get('refresh') === '1') whisper.resetProbe();
    try { return sendJson(res, 200, await whisper.status()); }
    catch (e) { return sendJson(res, 200, { engine: 'System.Speech', whisperAvailable: false, reason: e.message }); }
  }

  /* ── TTS：合成并返回 WAV 音频流 ──
     GET /api/voice/speak?text=...&rate=0
     浏览器端用 <audio src> 或 fetch+AudioContext 播放。

     ⚠ 必须用 '/api/voice/speak?' 或精确相等来判断，**不能用 startsWith('/api/voice/speak')**：
     那样会把 `/api/voice/speaking`（朗读状态上报）也吞掉，
     当成缺 text 参数的 TTS 请求返回 400。实测踩到过，这是经典前缀冲突。 */
  if (url === '/api/voice/speak' || url.startsWith('/api/voice/speak?')) {
    const q = new URL(url, 'http://x').searchParams;
    const text = q.get('text') || '';
    const rate = parseInt(q.get('rate') || '0', 10) || 0;
    if (!text.trim()) return sendJson(res, 400, { error: 'text required' });
    try {
      const r = await voice.synthesize(text, rate);
      if (!r) return sendJson(res, 400, { error: 'nothing to speak' });
      const buf = fs.readFileSync(r.file);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Synth-Ms': String(r.ms),
      });
      return res.end(buf);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  /* ── 语音识别事件流（SSE）──
     浏览器订阅后即可收到 wake / speech 事件。
     常听进程按需启动：有客户端才开麦，全部断开后关闭，
     避免没人用还一直占着麦克风。 */
  if (url === '/api/voice/listen') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const writer = (ev, data) => {
      try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    voiceHub.add(writer);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ka); voiceHub.remove(writer); });
    return;
  }

  /* ── 手动开关常听（用于界面上的麦克风按钮） ── */
  if (url.startsWith('/api/voice/mic') && req.method === 'POST') {
    const q = new URL(url, 'http://x').searchParams;
    const on = q.get('on') !== '0';
    /* 同时设 enabled 和 forceOn：
     * 只设 enabled 的话，没有 SSE 订阅者时 _sync() 不会启动麦克风，
     * 接口就永远返回 listening:false —— 看起来像"语音功能不存在"。 */
    voiceHub.enabled = on;
    voiceHub.setForce(on);
    /* start() 是异步的（要等 PowerShell 加载 System.Speech 并报 ready），
     * 立刻读 isListening() 必然是 false。这里如实报告"启动中"，
     * 不要把"还没就绪"说成"没在听"，那会让人以为功能坏了。 */
    return sendJson(res, 200, {
      listening: voiceHub.isListening(),
      starting: !!voiceHub._starting,
      enabled: on,
      note: voiceHub._starting
        ? '麦克风正在启动（加载语音引擎需要几秒），就绪后会通过 /api/voice/listen 推送 voice_status'
        : undefined,
    });
  }

  /* ── 朗读状态上报（打断功能的关键） ──
   *
   * 前端开始/结束播放 TTS 时调这个。
   * 服务端要知道"正在朗读"才能判断唤醒词是**打断**还是**新一轮对话** ——
   * 否则喇叭还在响，麦克风收到自己的声音，就变成自问自答。 */
  if (url.startsWith('/api/voice/speaking') && req.method === 'POST') {
    const q = new URL(url, 'http://x').searchParams;
    voiceHub.setSpeaking(q.get('on') !== '0');
    return sendJson(res, 200, { ok: true, convoOpen: voiceHub.convoOpen() });
  }

  /* ── 对话（SSE 流式） ── */
  if (url === '/api/chat' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { error: 'bad json' }); }
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { error: 'empty' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    /* 整条思考链路在 brain.js 里，网页和飞书共用。
     * 抽出去的原因：飞书是长连接，没有 res 对象，原来的代码没法复用。
     * 两份实现会慢慢漂移成"网页答得好、手机答得差"，那是最难查的 bug。 */
    try {
      const r = await brain.think(text, {
        onEvent: send,
        systemPrompt: SYSTEM_PROMPT,
        channel: 'web',
      });

      if (r.ok) {
        send('done', {
          counts: db.counts(),
          usage: llm.getUsage(),
          mind: await mind.getSnapshot(),
          tools: r.toolEvents,
          toolRounds: r.toolRounds,
        });
      }
    } catch (e) {
      send('error', { error: String(e.message || e) });
    }
    res.end();
    return;
  }

  /* ── 静态 UI ── */
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  mind.init();   // 启动主动意识（加载持久化状态 + 开始心跳）
  const c = db.counts();
  console.log(`  JARVIS 已启动  http://${HOST}:${PORT}`);
  console.log(`  模型: ${llm.MODEL}   密钥: ${llm.hasKey() ? '已加载' : '缺失'}`);
  console.log(`  记忆: ${c.memories} 条 / 实体 ${c.entities} 个 / 消息 ${c.messages} 条`);
  console.log(`  主动意识: 已启用（心跳 60s，1:1 节奏）`);
  console.log(`  仅监听本机，局域网无法访问`);

  /* ── 飞书长连接 ──
   *
   * 用 .catch 而不是 await：飞书连不上**绝不能影响本机服务**。
   * 网络波动、凭证过期、飞书侧故障都不该让整个贾维斯起不来 ——
   * 本机对话是核心能力，手机端是增强能力，不能让增强项拖垮核心项。 */
  startFeishu().catch(e => {
    console.log(`  飞书: 启动失败（不影响本机使用）— ${e.message}`);
  });
});

/** 连接飞书并把消息接到同一条大脑 */
async function startFeishu() {
  if (!feishu.configured()) {
    console.log('  飞书: 未配置（.feishu.json 缺失），跳过');
    return;
  }

  const r = await feishu.connect(async (ctx) => {
    const text = String(ctx.text || '').trim();
    if (!text) return null;

    console.log(`  [飞书] 收到: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);

    try {
      /* 走同一条 brain.think —— 手机和网页的回答必须一致。
       * channel='feishu' 只影响输出格式提示（手机屏幕窄），不换人格。 */
      const out = await brain.think(text, {
        systemPrompt: SYSTEM_PROMPT,
        channel: 'feishu',
        maxTokens: 1500,
      });

      if (!out.ok) return `出错了：${out.error}`;

      // 把飞书那边的对话也广播到网页，两端看到同一个会话
      mind.broadcast('feishu_message', {
        from: ctx.userId || 'unknown',
        text, reply: out.text,
        tools: out.toolEvents.map(t => t.name),
      });

      return out.text || '（没有内容）';
    } catch (e) {
      console.log(`  [飞书] 处理失败: ${e.message}`);
      return `处理失败：${e.message}`;
    }
  });

  if (r.ok) {
    console.log('  飞书: 长连接已建立，手机上可以发指令了');
  } else {
    console.log(`  飞书: ${r.error}`);
    if (r.nextStep) console.log(`        下一步 → ${r.nextStep}`);
  }
}
