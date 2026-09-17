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

/* 设置页的接入预设。
 * 这些只是"填表模板"，方便切换服务商时不用记 URL；
 * 是否真能用取决于你的 Key —— 所以设置页有「测试连接」按钮，
 * 不靠这张表打包票。
 * 注意 Agent Plan 必须走 /api/plan/v3（用普通 /api/v3 会 401，实测踩过）。 */
const LLM_PRESETS = [
  { id: 'ark-plan', name: '火山方舟 Agent Plan（当前）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'ark-code-latest', embedModel: 'doubao-embedding-vision',
    note: '个人版套餐。端点必须是 /api/plan/v3，模型名 ark-code-latest。' },
  { id: 'ark-v3', name: '火山方舟 标准版 /api/v3',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-250615', embedModel: 'doubao-embedding-vision',
    note: '按量计费或推理接入点。模型名填 ep-xxx 或官方模型 ID。' },
  { id: 'deepseek', name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', embedModel: '',
    note: 'OpenAI 兼容。注意：DeepSeek 无 embedding 接口，记忆向量会退化为关键词检索。' },
  { id: 'openai', name: 'OpenAI 兼容（自填）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini', embedModel: 'text-embedding-3-small',
    note: '任何 OpenAI 兼容网关（含中转、本地 vLLM/Ollama）都可用这个模板。' },
];

const SYSTEM_PROMPT = `你是贾维斯（JARVIS），用户的桌面常驻助手。

风格：冷静、克制、简洁。像一位可靠的管家，不谄媚、不啰嗦、不用感叹号堆砌热情。
称呼用户为"你"。回答直接给结论，需要展开时才展开。

如果下方提供了【相关记忆】，自然地运用它们，不要复述"根据我的记忆"这类废话。
如果记忆与当前问题无关，忽略它们。
如果你不知道或不确定，直接说不知道。

【最高优先级：不许编造因果】
这条优先于"回答得完整"、优先于"显得有用"。宁可回答不完整，也不许编造。

观察到状态变化（故障消失、数字对不上、指标突变、报错不再出现）时：
1. 先说事实：我看到 X 从 A 变成了 B。
2. 再说来源：这是我刚查的，还是记忆里的旧值。
3. 原因不明就直说"我不知道为什么变了"，并给出能查清的具体动作。
禁止用"可能是……""大概是……""应该是自愈了"来填补空白 ——
一个听起来合理的猜测，和一个查证过的结论，在用户那里长得一模一样，
但前者会让他基于错误的因果做决定。这比承认不知道有害得多。

尤其注意：**你自己看不到代码改动、配置修改、口径调整**。
所以"故障自己好了"这个结论你几乎永远没有依据 ——
真实原因常常是有人改了判定标准、换了数据源、重启了进程。
系统状态变好时，正确回答是"现在是好的，但我不知道是什么让它变好的"。

同样禁止：把"我没查到"说成"没有问题"；
把单次观测说成规律；把工具没返回的字段凭印象补齐。
说"我不知道"不扣分，编造扣分。`;

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

        /* 后台预热复核用的大模型（small 冷加载 20-30s，热复合约 6s）。
         * 延迟 25 秒再拉：避开开麦瞬间与首次 base 转写抢 CPU；
         * 不 await、失败静默。设了空 VERIFY_MODEL（关闭复核）时不预热。 */
        if (voice.VERIFY_MODEL) {
          setTimeout(() => { try { whisper.prewarm(voice.VERIFY_MODEL); } catch (_) {}; },
            25000).unref?.();
        }
      }
    } else if (this.isListening() || this._starting) {
      /* listener.stop() 是 async（要等采集子进程真正退出，
       * 否则孤儿进程锁住 ringmic.exe 让下次启动编译失败）。
       * 这里不 await —— _sync 本身是同步入口，被多处调用；
       * 但必须 catch，否则未处理的 rejection 会打挂进程。 */
      try {
        const p = this.listener && this.listener.stop();
        if (p && typeof p.catch === 'function') p.catch(() => { });
      } catch (_) { }
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
    /* whisper 正在复核（窄带麦低置信时的二次辨认），界面提示"在辨认" */
    if (ev.type === 'whisper_rescuing') {
      this.broadcast('voice_rescuing', { phase: ev.phase });
      return;
    }
    /* 大模型（small）正在对一句低置信指令做精识别，界面提示别让用户干等 */
    if (ev.type === 'whisper_verifying' || ev.type === 'whisper_verified') {
      this.broadcast('voice_' + ev.type, ev);
      return;
    }
    /* ── whisper 唤醒链路的诊断事件（2026-09-13 补）──
     *
     * 之前这些事件在 voice.js 里发出来，却没在这里转发，
     * 浏览器只在成功时收到 voice_wake，失败时**完全静默** ——
     * 于是"喊了没反应"无法判断卡在哪一环。现在如实透传：
     *   whisper_wake_miss  = whisper 听到了但不像唤醒词（识别内容问题）
     *   whisper_wake_skip  = 根本没跑复核（why: no_speech/cooldown/
     *                        ring_not_filled/length/busy —— 采集/节流问题）
     *   whisper_wake_failed= whisper 进程出错
     * 透传原始字段（why/heard/peak/rawText），供界面与排障使用。 */
    if (ev.type === 'whisper_wake_miss' || ev.type === 'whisper_wake_skip'
      || ev.type === 'whisper_wake_failed' || ev.type === 'wake_via_whisper') {
      // 事件名直接加 voice_ 前缀透传（whisper_wake_skip → voice_whisper_wake_skip）
      this.broadcast('voice_' + ev.type, ev);
      return;
    }
    /* ── 实时麦克风音量流（给右下角晶核/波形做声压驱动）──
     * voice.js 常驻环形缓冲约 10Hz 发 {peak,smooth}，smooth 是能量值
     * （起音阈值 VOICE_THRESHOLD=400，正常说话峰值约 800~4000）。
     * 这里归一化成 0..1 的 level 再广播，UI 不依赖原始量纲。
     * 注意：不能落到下面 wake/speech 兜底分支，否则会被当成一句指令。 */
    if (ev.type === 'mic_level') {
      const norm = (v) => Math.max(0, Math.min(1, (v || 0) / 3000));
      this.broadcast('voice_level', {
        peak: ev.peak, smooth: ev.smooth,
        level: norm(ev.smooth),
      });
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

/* 给 whisper 注入动态领域提示词：带上用户本地实际接触过的专名。
 *
 * 实测（2026-09-13）：同一批真实炒股口语，
 *   base + 无词表   → 字准 58%（拖着新能/骨票/原件板塊）
 *   base + 有词表   → 字准 92%
 *   small + 有词表  → 字准 98%
 * initial_prompt 是先验词表，喂过的名字才念得准。
 * db.voiceVocab 汇总了查过资金的个股 + 最近板块龙头 + 板块名，
 * 已去重、按最近活跃排序、限 60 字。60 秒缓存，失败静默退回，绝不挡唤醒。 */
try {
  /* 返回专名数组：voice.js 既用它拼 whisper 提示词，也用它判断
   * "base 转写里的股票名是否一个都没对上"来决定要不要升级 small 复核。 */
  voice.setWhisperPromptProvider(() => (db.voiceVocab ? db.voiceVocab() : []));
} catch (e) {
  console.log('  whisper 动态提示词注入失败（不影响使用）: ' + e.message);
}

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

  /* ── 收盘扫描面板（左栏盯盘主场）──
   *
   * 直接 require close_scan，**不经过 tools.call**：
   * tools.call 会把超过 4000 字符的结果截断（那是为喂模型省 token），
   * 而面板需要完整的 sectors 数组做渲染，截断会破坏卡片。
   * 只读、带超时与错误兜底，失败时返回结构化 error 让面板如实显示。 */
  if (url === '/api/closescan' || url.startsWith('/api/closescan?')) {
    try {
      const q = new URL(url, 'http://x').searchParams;
      const topN = Math.min(30, Math.max(3, parseInt(q.get('topN') || '12', 10) || 12));
      const cs = require('./tools/close_scan');
      const r = await cs.scan({ topN });
      /* 面板只需结构化字段，不带 formatScan 的 text（那是给模型看的） */
      const { text, ...rest } = r;
      return sendJson(res, 200, rest);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  /* 大盘状态：缠论生命阶段 + 散户崩溃冰点（面板卡片，绕开 tools.call 的4000字截断）。
     只读、带错误兜底，缺数据由 market_phase 自己返回 unknown，不编造。 */
  if (url === '/api/market_phase' || url.startsWith('/api/market_phase?')) {
    try {
      const q = new URL(url, 'http://x').searchParams;
      const withMinute = q.get('minute') === '1';
      const sentiment = require('./tools/sentiment');
      const kline = require('./tools/stock_kline');
      const dbm = require('./db');
      const mp = require('./tools/market_phase');
      const r = await mp.assess({
        getBars: (period) => kline.kline('000001', period, period === 'day' ? 240 : 320).then(k => k.bars),
        snapshot: () => sentiment.snapshot(),
        alertSamples: () => dbm.alertSamplesDaily(),
      }, { withMinute });
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  /* 情绪温度热力柱（§5 第 1 项）：每日一条 alert_samples 的 broken_rate/limit_up/limit_down/ladder_height/seal_fund_yi。
     只读、缺数据不编造——broken_rate 缺失的日期保留在返回里（前端灰化），不跳过。 */
  if (url === '/api/sentiment/heatmap' || url.startsWith('/api/sentiment/heatmap?')) {
    try {
      const q = new URL(url, 'http://x').searchParams;
      const days = Math.max(1, Math.min(365, parseInt(q.get('days') || '60', 10)));
      const dbm = require('./db');
      const all = dbm.alertSamplesDaily();
      /* 只取最近 days 天；按 date 升序（alertSamplesDaily 已排序） */
      const points = all.slice(-days).map(r => ({
        date: r.date,
        limit_up: r.limit_up,
        limit_down: r.limit_down,
        broken: r.broken,
        broken_rate: r.broken_rate,
        ladder_height: r.ladder_height,
        seal_fund_yi: r.seal_fund_yi,
      }));
      return sendJson(res, 200, { ok: true, days: points.length, points: points });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
  }

  /* 崩溃冰点基准历史回填（一次性/按需运维）：POST /api/fear_backfill?dry=1 预演。
     较慢（东财 QPS<1，约1-2分钟），只读外部+UPSERT本地，绝不把无保留日期写成0。 */
  if (url.startsWith('/api/fear_backfill') && req.method === 'POST') {
    try {
      const q = new URL(url, 'http://x').searchParams;
      const fb = require('./tools/fear_backfill');
      const r = await fb.backfill({ lookbackDays: 40, dryRun: q.get('dry') === '1' });
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String(e.message || e) });
    }
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

  /* ══════════ 设置：读取 / 保存模型接入配置 ══════════
   *
   * 为什么需要它：用户在方舟后台换了 Agent Plan 的 API Key 之后，
   * 即使 .env 已经改对，运行中的进程仍握着启动时读进内存的旧 Key ——
   * 表现成「配置是对的，但贾维斯连不上模型」，且毫无线索。
   * 所以这里保存后会调用 llm.reload()，当场生效，不用重启。
   *
   * 安全：GET 只回掩码（ark-****77bc），绝不回明文 Key；
   *      写入前备份 .env，避免手滑把唯一的凭证弄没。 */
  if (url === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      llm: llm.getConfig(),
      presets: LLM_PRESETS,
      toolCount: tools.listForModel().length,
      voice: { enabled: voiceHub.enabled, wakeWords: voice.WAKE_WORDS },
    });
  }

  if (url === '/api/settings' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }

    const envPath = require('path').join(__dirname, '..', '.env');
    const fsx = require('fs');

    /* 只允许改这四项，避免设置页变成任意文件写入口 */
    const ALLOW = ['ARK_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL', 'ARK_EMBED_MODEL'];
    const incoming = {};
    for (const k of ALLOW) {
      if (typeof body[k] === 'string' && body[k].trim()) incoming[k] = body[k].trim();
    }
    if (!Object.keys(incoming).length) {
      return sendJson(res, 400, { error: '没有可保存的字段' });
    }
    /* Key 里混入空白/换行是最常见的粘贴事故，会导致 401 且极难看出来 */
    if (incoming.ARK_API_KEY && /\s/.test(incoming.ARK_API_KEY)) {
      return sendJson(res, 400, { error: 'API Key 含空格或换行，请重新复制' });
    }

    try {
      /* 保留原文件的注释与未知字段，只替换命中的键 */
      let lines = fsx.existsSync(envPath)
        ? fsx.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
      if (fsx.existsSync(envPath)) {
        fsx.copyFileSync(envPath, envPath + '.bak');   // 先备份再写
      }
      const seen = new Set();
      lines = lines.map(line => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return line;
        const i = s.indexOf('=');
        if (i < 0) return line;
        const k = s.slice(0, i).trim();
        if (incoming[k] == null) return line;
        seen.add(k);
        return k + '=' + incoming[k];
      });
      for (const k of Object.keys(incoming)) {
        if (!seen.has(k)) lines.push(k + '=' + incoming[k]);
      }
      fsx.writeFileSync(envPath, lines.join('\n'), 'utf8');
    } catch (e) {
      return sendJson(res, 500, { error: '写入 .env 失败：' + e.message });
    }

    const applied = llm.reload();      // 立刻生效，无需重启
    return sendJson(res, 200, { ok: true, applied, config: llm.getConfig() });
  }

  /* 连通性自检：用当前配置真打一次模型，把失败原因如实回给界面。
   * 不做这个的话，用户改完 Key 只能靠"发条消息试试"来验证。 */
  if (url === '/api/settings/test' && req.method === 'POST') {
    if (!llm.hasKey()) return sendJson(res, 200, { ok: false, reason: '未配置 API Key' });
    const t0 = Date.now();
    try {
      /* maxTokens 给足：ark-code-latest 会先产出 reasoning_content，
       * 给 16/64 这类小额度时思维链就把额度吃光，content 返回空字符串。
       * 那会让"连接正常"被误报成"模型返回空"，比不测还糟。 */
      const r = await llm.chat(
        [{ role: 'user', content: '只回复两个字：正常' }],
        { maxTokens: 512, temperature: 0 });
      const ms = Date.now() - t0;
      if (!r.ok) return sendJson(res, 200, { ok: false, ms, reason: r.error || '调用失败' });
      const text = (r.text || '').trim();
      /* 拿到 200 且计费成功即视为连通；文本为空只是模型话少，不是故障 */
      return sendJson(res, 200, {
        ok: true, ms, model: llm.MODEL,
        reply: text ? text.slice(0, 40) : '连接正常（模型未输出正文，仅思维链）',
      });
    } catch (e) {
      return sendJson(res, 200, { ok: false, ms: Date.now() - t0, reason: e.message });
    }
  }

  /* ══════════ 只读数据面板接口（设置页与右栏面板用）══════════ */

  /* 工具清单 + 本轮调用记录。
   * 注意：callLog 的条目没有时间戳字段（见 tools/index.js），
   * 所以这里不编造时间，只给顺序和耗时。 */
  if (url === '/api/tools') {
    const list = tools.listForModel().map(t => {
      const f = t.function || t;
      return { name: f.name, description: (f.description || '').slice(0, 160) };
    });
    const log = (tools.getLog() || []).slice(-40);
    return sendJson(res, 200, {
      count: list.length,
      tools: list,
      recent: log.map(x => ({ name: x.name, ms: x.ms, ok: x.ok, error: x.error || null })),
      calledThisRound: log.length,
    });
  }

  /* 巡视任务队列：冷却状态（真实数据，来自 patrol.cooldownStatus）*/
  if (url === '/api/tasks') {
    try {
      const patrol = require('./patrol');
      const cd = patrol.cooldownStatus() || {};
      const LABELS = {
        market_scan: '大盘扫描', session_scan: '会话巡视', health_check: '数据源体检',
        memory_tidy: '记忆整理', quant_refresh: '量化刷新', close_scan: '收盘复盘',
        market_alert: '异动预警', alert_sample: '预警采样', morning_brief: '盘前简报',
        sector_watch: '板块资金异动',
      };
      const tasks = Object.keys(cd).map(k => ({
        key: k,
        label: LABELS[k] || k,
        ready: !!cd[k].ready,
        readyInSec: cd[k].readyInSec || 0,
        cooldownMs: cd[k].cooldownMs || 0,
        lastRun: cd[k].lastRun || null,
      }));
      return sendJson(res, 200, { tasks });
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

  /* ── 一键设备体检（真实录音 + 双引擎识别，只诊断不启用）── */
  if (url === '/api/voice/checkup' || url.startsWith('/api/voice/checkup?')) {
    const q = new URL(url, 'http://x').searchParams;
    try {
      const chk = require('./voice_checkup');
      const di = q.get('device');
      const opts = di != null && Number.isInteger(Number(di)) ? { only: [Number(di)] } : {};
      const rep = await chk.runCheckup(opts);
      return sendJson(res, 200, Object.assign({ text: chk.formatReport(rep) }, rep));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: '体检失败: ' + e.message });
    }
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
  /* ── 流式 TTS：edge-tts 音频帧到达即写，浏览器首个帧(~1s)就能起播。
   *
   * 与下面整段端点的区别：整段要等 ~1.6-2.3s 拿到完整 mp3 才出声；
   * 这里用 chunked（无 Content-Length），下载与播放重叠。
   * edge-tts 流式失败时降级为整段 SAPI/edge（fallback 到下面逻辑），
   * 但响应头一旦发出就不能再改成 JSON 错误，所以先探测式启动，
   * 失败则 302 到整段端点 —— 浏览器对音频 302 会自动跟随。 */
  if (url === '/api/voice/speak/stream' || url.startsWith('/api/voice/speak/stream?')) {
    const qs = new URL(url, 'http://x').searchParams;
    const text = qs.get('text') || '';
    const rate = parseInt(qs.get('rate') || '0', 10) || 0;
    const voiceId = qs.get('voice') || undefined;
    if (!text.trim()) return sendJson(res, 400, { error: 'text required' });

    let firstChunk = true;
    let aborted = false;
    // 用户打断/关页 → 中止上游。不只是停止 write，还要让合成抛错退出，
    // 否则 edge-tts 的剩余几十个音频帧会被白白下载完（实测 abort 后
    // 上游仍跑到 4.7s），既浪费连接也拖慢下一次合成。
    req.on('close', () => { aborted = true; });

    try {
      await voice.synthesizeStream(text, rate, voiceId, chunk => {
        if (aborted) throw new Error('client aborted stream');
        if (firstChunk) {
          firstChunk = false;
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-store',
            'X-TTS-Engine': 'edge-tts-stream',
            'X-Accel-Buffering': 'no',   // 关键：禁 nginx/中间层缓冲，否则流不起来
          });
        }
        res.write(chunk);
      });
      if (!aborted) res.end();
    } catch (e) {
      /* 用户主动打断：不是错误，静默收尾，绝不回落、不刷警告日志。 */
      if (aborted) { try { res.destroy(); } catch (_) {} return; }
      /* 头还没发出去（首帧前失败）→ 302 让浏览器改取整段端点（含 SAPI 兜底）。
       * 头已发出就只能结束，不能再改状态码 —— 但 edge 首帧失败极少，
       * 真到那一步用户侧表现为短静音，下一句仍走正常重试。 */
      console.warn('[voice] 流式 TTS 失败，回落整段：' + e.message);
      if (!res.headersSent) {
        const dst = '/api/voice/speak?text=' + encodeURIComponent(text)
          + '&rate=' + rate + (voiceId ? '&voice=' + encodeURIComponent(voiceId) : '');
        res.writeHead(302, { Location: dst });
        res.end();
      } else {
        res.end();
      }
    }
    return;
  }

  if (url === '/api/voice/speak' || url.startsWith('/api/voice/speak?')) {
    const q = new URL(url, 'http://x').searchParams;
    const rate = parseInt(q.get('rate') || '0', 10) || 0;
    // 可选音色（id/中文名/昵称）；缺省用 voice.js 的当前音色 currentVoice
    const voiceId = q.get('voice') || undefined;
    if (!text.trim()) return sendJson(res, 400, { error: 'text required' });
    try {
      const r = await voice.synthesize(text, rate, voiceId);
      if (!r) return sendJson(res, 400, { error: 'nothing to speak' });
      const buf = fs.readFileSync(r.file);
      /* 双引擎后 MIME 不再固定为 wav：
       * edge-tts 产出 mp3（audio/mpeg），SAPI 兜底产出 wav（audio/wav）。 */
      res.writeHead(200, {
        'Content-Type': r.mime || 'audio/wav',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Synth-Ms': String(r.ms),
        'X-TTS-Engine': r.engine || 'sapi',
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

    /* 语音轮：前端在这一轮是"说话进来的"时传 voice:true。
     *
     * 为什么需要这个标记：文字回复可以长、可以分点、可以甩表格，
     * 用户用眼睛扫；语音回复是"听"的，同样的内容念出来就是折磨，
     * 而且念完就冷场，用户不知道还能继续说，体感就是"问一句答一句"。
     *
     * 所以语音轮要换一套规则：短、口语、答完给一个自然的话口。
     * 这不是给模型自由发挥，是把语音场景的硬要求写清楚。 */
    const isVoice = body.voice === true;
    const voicePrompt = isVoice ? `
【本轮是语音对话，不是文字对话】
- 先说结论，最多两三句，口语化，不用 Markdown 符号、表格、长分点 —— 这些是用耳朵听的，不是用眼睛看的。
- 数字挑最关键的一两个说，不要把一串数据念出来。
- 回答结束时，给一个自然的话口，让对话能继续，而不是冷场。
  例如"要我继续盯着它吗""要不要看它的龙头""你还想了解哪块"。
  但只在确实有自然的下一步时才问，没有就利落结束，不要每句都硬接一个问题。
- 禁止用反问来填充、禁止套话（"希望对你有帮助"这类一律不要）。

【语音转写可能有错字，你要先纠偏再作答】
- 用户说的是话，经语音识别转成文字，A股专名（股票名、板块名、人名、术语）
  很容易被识别成同音/近音的错字，例如"拓日新能"可能转成"托尔新闻"之类。
- 看到"某只股票/这只股/帮我看XX"这类意图但名字像错字时，不要按字面理解成别的东西，
  也不要直接说"没有这只股票"。先用行情/搜索类工具按近音、板块、关键词去匹配真实标的，
  找到唯一可信的就按它回答，并自然地带出正确名称（不必解释识别错了）。
- 只有匹配出多个、无法确定是哪只时，才简短反问确认，例如"你说的是拓日新能吗"。` : '';

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
        systemPrompt: SYSTEM_PROMPT + voicePrompt,
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
