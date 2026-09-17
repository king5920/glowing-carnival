/**
 * app.js —— 前端逻辑：SSE 对话 + 星图联动
 * 诚实标注：本文件里所有显示的数字都来自后端真实数据，无硬编码假值。
 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  /* 骨架屏占位：数据返回前沿用既有灰阶 token，避免"假空态"。
     数据到达后对应容器被 innerHTML 整体替换，占位自然消失。 */
  const skeleton = lines => '<div class="sk" aria-hidden="true">'
    + lines.map(w => '<div class="sk-line ' + w + '"></div>').join('')
    + '</div>';
  const SK_GAL = ['sk-w90', 'sk-w75', 'sk-w60', 'sk-w75', 'sk-w45', 'sk-w60'];
  const SK_CHAT = ['sk-w60', 'sk-w90', 'sk-w75', 'sk-w45', 'sk-w90', 'sk-w60', 'sk-w75'];
  const chat = $('#chat'), inp = $('#inp'), send = $('#send');
  const stateEl = $('#state'), metaEl = $('#meta');
  const galEl = $('#galaxies'), recEl = $('#recall');
  const GAL_CN = { person: '人物', place: '地点', event: '事件', interest: '兴趣', project: '项目' };

  const TOOL_CN = {
    get_stock_quote: 'A股实时行情',
    get_stock_kline: 'A股K线分析',
    sandbox_list: '查看沙箱目录',
    sandbox_read: '读取沙箱文件',
    sandbox_write: '写入沙箱文件',
    sandbox_append: '追加到沙箱文件',
    sandbox_delete: '删除沙箱文件',
  };
  /* tool_call 事件建的气泡，等 tool_result 回来时原地更新 */
  const toolEls = {};
  let lastPatrol = null;  // 最近一次巡视结果，状态条上能看到
  const _warned = { starmap: false, status: false, history: false, sources: false };

  /** 工具参数的人类可读摘要 */
  function fmtToolArgs(name, args) {
    if (!args) return '';
    if (name === 'get_stock_quote' && Array.isArray(args.codes)) {
      return args.codes.join('、');
    }
    if (name === 'get_stock_kline') {
      const P = { day: '日线', week: '周线', month: '月线' };
      return [args.code, P[args.period] || args.period, args.limit ? args.limit + '根' : '']
        .filter(Boolean).join(' · ');
    }
    // 沙箱类工具统一显示路径
    if (name && name.startsWith('sandbox_')) {
      return args.path || '.';
    }
    // 兜底：紧凑 JSON，截断避免撑破面板
    const s = JSON.stringify(args);
    return s.length > 90 ? s.slice(0, 90) + '…' : s;
  }

  /* 显式状态机：后端 state（idle/think/speak/alert/listen）+ 工具调用态，
     统一映射成「灯 + 中文」。颜色之外永远有文字，色盲可读。 */
  const STATE_CN = {
    idle: '待命', think: '思考中', tool: '取数中', speak: '回复中',
    listen: '聆听中', alert: '出错了',
  };
  function setState(s) {
    const key = STATE_CN[s] ? s : 'idle';
    stateEl.textContent = STATE_CN[key];
    stateEl.className = 'st-' + key;
    if (window.STAR && STAR.setState) STAR.setState(s);
  }

  /* 轻量通知：静默失败兜底 */
  function notify(msg, type) {
    const n = document.createElement('div');
    n.className = 'msg e';
    n.textContent = msg;
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => { if (n.parentNode) n.remove(); }, 6000);
  }

  function bubble(cls, text, label) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (label) { const b = document.createElement('span'); b.className = 'lbl'; b.textContent = label; d.appendChild(b); }
    d.appendChild(document.createTextNode(text));
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  /* 安全 Markdown 渲染抽到 ui/markdown.js（window.JarvisMarkdown），
     那里是纯函数、可单测；这里只做一层兜底，脚本没加载时退回纯文本转义。 */
  function renderMarkdown(src) {
    if (window.JarvisMarkdown && window.JarvisMarkdown.render) return window.JarvisMarkdown.render(src);
    return '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>';
  }

  /* ── 顶栏波形（说话时活跃） ── */
  const wc = $('#wave'), wx = wc.getContext('2d');
  wc.width = 52 * 2; wc.height = 14 * 2; wx.scale(2, 2);
  let amp = 0.12, wt = 0;

  // §4 硬预算：prefers-reduced-motion 时 L2（系统呼吸）全关、L1（数据/语音）直跳终值。
  // 三处动画共享这一判定；失焦暂停由 AnimGate 单独负责，二者互不重叠。
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let wtDrawn = false, vcLastE = null;

  /* ════════════════════════════════════════════════
     语音晶核（融合形态）桥接 —— 右下角独立 WebGL2 overlay
     状态机与现有声纹/喷泉同源（amp 那套），不另起判定：
       idle   待命：晶体自转 + 一层薄粒子，容器整体很淡
       listen 唤醒/聆听：变青、粒子外张
       speak  TTS/应答朗读中：转金绿、粒子随音绽放
     能量优先级：真实麦克风 voice_level > 状态合成值。
     WebGL2 不可用时 mount() 返回 false，静默降级，不影响其它功能。
     ════════════════════════════════════════════════ */
  const vcEl = document.getElementById('voicecore');
  let vcMicLevel = 0;          // 最近一次真实麦声压 0..1
  let vcMicSeenAt = 0;         // 最近一次收到 voice_level 的时间
  let vcState = 'idle';
  function coreSetState(s) {
    vcState = s;
    if (window.VOICECORE) window.VOICECORE.setState(s);
    if (vcEl) { vcEl.classList.toggle('listen', s === 'listen'); vcEl.classList.toggle('live', s !== 'idle'); }
  }
  function coreMicLevel(v) {
    vcMicLevel = Math.max(0, Math.min(1, +v || 0));
    vcMicSeenAt = Date.now();
  }
  // 核心能量驱动（不自己排帧）；挂闸门前必须确认 VOICECORE 已挂上
  AnimGate.gatedLoop(() => {
    if (!window.VOICECORE || !vcEl) return;
    if (!vcEl.dataset.mounted) {
      vcEl.dataset.mounted = window.VOICECORE.mount('voicecore-canvas') ? '1' : '0';
      if (vcEl.dataset.mounted === '1') coreSetState('idle');
    }
    if (vcEl.dataset.mounted !== '1') return;
    // 300ms 内有真实音量流就用它，否则按状态合成（保证 TTS/应答也会动）
    const micFresh = (Date.now() - vcMicSeenAt) < 300;
    let e;
    if (reduceMotion) {
      // §4 L1 直跳终值：按状态取静态能量，不做 sin 逐帧动画
      e = vcState === 'speak' ? 0.75 : vcState === 'listen' ? 0.42
        : vcState === 'think' ? 0.20 : 0.08;
      if (vcLastE === e) return;
      vcLastE = e;
    } else if (micFresh) e = vcMicLevel;
    else if (vcState === 'speak') e = 0.6 + 0.35 * Math.abs(Math.sin(performance.now() / 240));
    else if (vcState === 'listen') e = 0.34 + 0.16 * Math.abs(Math.sin(performance.now() / 420));
    else if (vcState === 'think') e = 0.16 + 0.07 * Math.abs(Math.sin(performance.now() / 520));
    else e = 0.08;
    window.VOICECORE.setEnergy(e);
  });

  // 待机呼吸波（L2 系统呼吸）：失焦/切后台即停，恢复自动续
  AnimGate.gatedLoop(() => {
    if (reduceMotion) {
      // §4：L2 全关——只画一帧静息态，不推进时间
      if (wtDrawn) return;
      wtDrawn = true;
    }
    wt += 0.08;
    wx.clearRect(0, 0, 52, 14);
    wx.strokeStyle = 'rgba(63,208,255,.85)'; wx.lineWidth = 1;
    wx.beginPath();
    for (let x = 0; x < 52; x++) {
      const y = 7 + Math.sin(x * 0.42 + wt) * 5 * amp * (0.6 + 0.4 * Math.sin(x * 0.13 + wt * 0.7));
      x ? wx.lineTo(x, y) : wx.moveTo(x, y);
    }
    wx.stroke();
  });

  /* ════════════════════════════════════════════════
     声纹（候选A 中线波形）—— 星图底部横带

     三态全部来自真实状态机，无模拟：
       待命  amp≈0.12  细微波（几乎平，表示活着）
       聆听  amp≈0.45  中幅（voice_wake / mic awake）
       说话  amp=1      大幅（TTS 朗读中）
     amp 在 handle('state') 与 voice 事件里被真实改写，这里只读。
     ════════════════════════════════════════════════ */
  const vlc = $('#voiceline');
  let vlx = null, vlAmp = 0.12, vlT = 0, vlLastAmp = -1;
  if (vlc) {
    vlx = vlc.getContext('2d');
    AnimGate.gatedLoop(() => {
      if (reduceMotion) {
        // §4 L1 直跳终值：不做时间动画，仅在真实 amp 变化时重画一帧
        if (vlLastAmp === amp) return;
        vlLastAmp = amp;
      }
      const r = vlc.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (vlc.width !== Math.floor(r.width * dpr)) {
        vlc.width = Math.floor(r.width * dpr);
        vlc.height = Math.floor(r.height * dpr);
      }
      vlx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = r.height, mid = H / 2;
      // amp 平滑跟随真实状态，避免跳变
      vlAmp += (amp - vlAmp) * 0.08;
      vlT += 0.09;
      vlx.clearRect(0, 0, W, H);
      // 主波形：多频叠加模拟声压
      vlx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const u = x / W;
        const env = Math.sin(u * Math.PI);            // 两端收细，中间饱满
        const y = mid
          + Math.sin(x * 0.045 + vlT) * (H * 0.32) * vlAmp * env * (0.6 + 0.4 * Math.sin(x * 0.011 + vlT * 0.7))
          + Math.sin(x * 0.012 - vlT * 1.3) * (H * 0.14) * vlAmp * env;
        x ? vlx.lineTo(x, y) : vlx.moveTo(x, y);
      }
      const grad = vlx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'rgba(63,208,255,0)');
      grad.addColorStop(0.18, 'rgba(63,208,255,.55)');
      grad.addColorStop(0.5, 'rgba(63,208,255,.85)');
      grad.addColorStop(0.82, 'rgba(63,208,255,.55)');
      grad.addColorStop(1, 'rgba(63,208,255,0)');
      vlx.strokeStyle = grad; vlx.lineWidth = 1.4; vlx.stroke();
    });
  }

  /* ── 加载星图与统计 ── */
  async function loadStarmap() {
    try {
      const r = await fetch('/api/starmap');
      const d = await r.json();
      window.__starData = d;            // 点击卡片查本地缓存，避免每次点都请求
      if (window.STAR) STAR.build(d);   // 传完整数据（含 memories）
      // 五星系统计（真实条数）
      const byGal = {};
      (d.entities || []).forEach(e => {
        byGal[e.category] = byGal[e.category] || { ents: 0, mems: 0 };
        byGal[e.category].ents++;
        byGal[e.category].mems += e.memCount || 0;
      });
      const keys = ['person', 'place', 'event', 'interest', 'project'];
      galEl.innerHTML = keys.map(k => {
        const v = byGal[k] || { ents: 0, mems: 0 };
        return `<div class="gal"><span>${GAL_CN[k]}</span>
          <span><b>${v.ents}</b> 星座 · <b>${v.mems}</b> 记忆</span></div>`;
      }).join('') + (d.counts
        ? `<div class="gal" style="margin-top:8px;border:none">
             <span>合计</span><span><b>${d.counts.memories}</b> 条记忆</span></div>`
        : '');
      if (!(d.entities || []).length) {
        galEl.innerHTML += '<div class="empty">还没有记忆。<br>说点什么，我会开始记住。</div>';
      }
      // 顶栏显示星图真实规模（对照预览版的 "162节点 334边"）
      if (window.STAR) {
        const s = STAR.stats();
        /* 只填数值，保留 <small> 单位标记 ——
           以前这里 textContent = 'CLUSTER · x节点 y边'，
           把整块结构冲掉了，也和左边的 k 标签重复。 */
        const el = document.getElementById('mesh');
        if (el) el.innerHTML = s.nodes + '<small>节点</small>';
        const ed = document.getElementById('mtEdges');
        if (ed) ed.textContent = s.edges;
      }
    } catch (e) {
      galEl.innerHTML = '<div class="empty">记忆面板连接中断<br>请确认贾维斯已启动</div>';
      if (!_warned.starmap) { _warned.starmap = true; notify('星图连接中断 — 请确认贾维斯已启动', 'warn'); }
    }
  }

  async function loadStatus() {
    try {
      const d = await (await fetch('/api/status')).json();
      const u = d.usage || {};
      metaEl.textContent = `${d.model} · ${d.counts.memories} 记忆 · ${u.calls || 0} 次调用 · ${(u.promptTokens || 0) + (u.completionTokens || 0)} tokens`;

      /* 顶栏指标块：用真实值填充，接口没给就保持 "—"。
         这几格原来是硬编码的 63MB / 104.8K / 20，纯属编造。 */
      const setMt = (id, v, unit) => {
        const el = document.getElementById(id);
        if (!el || v == null) return;
        el.innerHTML = v + (unit ? '<small>' + unit + '</small>' : '');
      };
      const tok = (u.promptTokens || 0) + (u.completionTokens || 0);
      setMt('mtMem', d.counts && d.counts.memories, '条');
      setMt('mtEnt', d.counts && d.counts.entities);
      setMt('mtCalls', u.calls || 0);
      setMt('mtTok', tok >= 1000 ? (tok / 1000).toFixed(1) : tok, tok >= 1000 ? 'K' : '');
      const mdl = document.getElementById('model');
      if (mdl && d.model) mdl.textContent = d.model;
      if (!d.hasKey) bubble('e', '未检测到 ARK_API_KEY，无法对话。');

      /* ══════════ 状态漂移自检 ══════════
       *
       * 实测过的坑：后端 PowerShell 在听（系统托盘显示"麦克风正在使用中"），
       * 前端却没建立 SSE 连接 —— 喊唤醒词识别了、事件发了，但**没人接收**。
       * 用户只看到麦克风指示灯亮着，以为唤醒词没被听见。
       *
       * 这里做一次对账：后端在听而前端没连，就自动补上连接。
       * 「看起来在工作但实际没连上」比「明显坏掉」更难查，
       * 所以宁可多一次自检。 */
      if (d.voice && d.voice.listening && !voiceES) {
        connectVoice();
        micOn = true;
        localStorage.setItem('jarvis_mic', '1');
        syncBtns();
      }
    } catch (e) { if (!_warned.status) { _warned.status = true; notify('状态同步中断', 'warn'); } }
  }

  async function loadHistory() {
    try {
      const d = await (await fetch('/api/history')).json();
      const sk = chat.querySelector('.sk');
      if (sk) sk.remove();                 // 首屏骨架只占位到数据返回
      (d.messages || []).forEach(m => {
        if (m.role === 'user') bubble('u', m.content);
        else if (m.role === 'assistant') assistantBubble(m.content, 'JARVIS');
      });
    } catch (e) {
      const sk = chat.querySelector('.sk');
      if (sk) sk.remove();
      if (!_warned.history) { _warned.history = true; notify('历史记录加载失败', 'warn'); }
    }
  }

  /* ── 发送 ── */
  let busy = false;
  /* 下一轮是否来自语音。语音轮走更短、更口语、答完留话口的规则。
   * 由 voice_speech 处理器在 submit 前置位，submit 消费后立即清掉，
   * 绝不能残留到下一次手动打字 —— 否则文字问题也会被当成语音来答。 */
  let voiceOrigin = false;
  /* 当前这一轮是不是语音轮：submit 置位，整轮回流期间保持，done 时读取后清空。
   * 和 voiceOrigin 的区别：voiceOrigin 在发请求的瞬间就清掉（不能污染下一轮
   * 的请求体），而"这轮要不要弹继续说提示"要等到回复念完才判断。 */
  let currentTurnVoice = false;
  /* 本轮流式回复的累积气泡。reply_delta 第一片时创建，done/新一轮时清空。
   * 用 {el,text} 而不是散落变量，方便 reply 事件判断"是否已流式渲染过"。 */
  const streamBubble = { el: null, text: '' };

  async function submit() {
    const text = inp.value.trim();
    if (!text || busy) return;
    const isVoice = voiceOrigin;
    voiceOrigin = false;
    currentTurnVoice = isVoice;
    streamBubble.el = null;       // 新一轮：重置流式气泡
    streamBubble.text = '';
    fillerSaid = false;           // 新一轮允许垫一次场
    stopFiller();
    busy = true; send.disabled = true; inp.value = '';
    bubble('u', text);
    setState('think');
    showThinking();
    recEl.innerHTML = '<div class="empty">检索中…</div>';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: isVoice }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          const ev = /event: (\w+)/.exec(p);
          const dt = /data: (.+)/s.exec(p);
          if (!ev || !dt) continue;
          let data; try { data = JSON.parse(dt[1]); } catch { continue; }
          handle(ev[1], data);
        }
      }
    } catch (e) {
      hideThinking();
      bubble('e', '请求失败：' + e.message);
      setState('alert');
    }
    busy = false; send.disabled = false; inp.focus();
  }

  /* 思考中指示：提交后立刻给反馈，首个工具调用或回复到达就撤。
     避免"发完话界面毫无反应"——无反馈等待最让人以为卡了。 */
  let thinkEl = null;
  const THINK_PHRASES = ['正在理解问题', '正在检索记忆', '正在思考'];
  function showThinking() {
    hideThinking();
    thinkEl = document.createElement('div');
    thinkEl.className = 'msg thinking';
    thinkEl.setAttribute('aria-label', '贾维斯思考中');
    thinkEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
      + '<span class="think-tx">' + THINK_PHRASES[0] + '…</span>';
    chat.appendChild(thinkEl);
    chat.scrollTop = chat.scrollHeight;
    let pi = 0;
    thinkEl._timer = setInterval(() => {
      pi = (pi + 1) % THINK_PHRASES.length;
      const tx = thinkEl && thinkEl.querySelector('.think-tx');
      if (tx) tx.textContent = THINK_PHRASES[pi] + '…';
    }, 2600);
  }
  function hideThinking() {
    if (!thinkEl) return;
    clearInterval(thinkEl._timer);
    if (thinkEl.parentNode) thinkEl.remove();
    thinkEl = null;
  }

  /* 生成一条助手回复气泡：用安全 markdown 渲染（不再把 ** 当纯文本）*/
  function assistantBubble(text, label, extraCls) {    const d = document.createElement('div');
    d.className = 'msg a md' + (extraCls ? ' ' + extraCls : '');
    if (label) { const b = document.createElement('span'); b.className = 'lbl'; b.textContent = label; d.appendChild(b); }
    d.innerHTML = renderMarkdown(text);
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  function handle(ev, d) {
    if (ev === 'state') {
      setState(d.state);
      amp = d.state === 'speak' ? 1 : 0.12;
      // 晶核三态映射：说话/朗读 speak；模型在想 think（慢速）；其余按是否在聆听窗口
      if (d.state === 'speak') coreSetState('speak');
      else if (d.state === 'think') coreSetState('think');
      else if (d.state === 'idle') coreSetState(awake ? 'listen' : 'idle');
      if (d.state === 'speak' || d.state === 'alert') hideThinking();
    }
    else if (ev === 'recall') {
      const hits = d.hits || [];
      if (!hits.length) { recEl.innerHTML = '<div class="empty">本轮无相关记忆</div>'; return; }
      recEl.innerHTML = hits.map(h => `
        <div class="it hot">${esc(h.content)}
          <div class="meta">${esc(GAL_CN[h.category] || h.category)}${h.entity ? ' · ' + esc(h.entity) : ''} · 分 ${h.score}</div>
        </div>`).join('');
      // 真实命中 → 点亮星图节点（优先按记忆 id，精确到单条记忆）
      hits.forEach(h => {
        if (!window.STAR) return;
        if (h.id != null) STAR.activateMemory(h.id, 1.0);
        if (h.entity) STAR.activate(h.entity, 0.9);
        if (h.entity && STAR.pulseRecall) STAR.pulseRecall(h.entity);
      });
    }
    else if (ev === 'reply_delta') {
      /* 模型流式吐字（P2）。第一片到来时建气泡 + 语音轮开流，
       * 之后持续追加，实现边想边显示、（语音轮）按句先念。 */
      hideThinking();
      const piece = d.text || '';
      if (!streamBubble.el) {
        streamBubble.text = '';
        streamBubble.el = assistantBubble('', 'JARVIS');
        amp = 0.12;
        if (currentTurnVoice && speakOn) speakStart(true);
      }
      streamBubble.text += piece;
      streamBubble.el.innerHTML = renderMarkdown(streamBubble.text);
      chat.scrollTop = chat.scrollHeight;
      if (currentTurnVoice && speakOn) speakFeed(piece);
    }
    else if (ev === 'reply') {
      hideThinking();
      amp = 0.12;
      if (d.streamed && streamBubble.el) {
        /* 流式已渲染：补齐最终全文（delta 与最终文本若有细微出入，以最终为准），
         * 不新建气泡、不重新整段朗读。 */
        if (streamBubble.text !== d.text) {
          streamBubble.text = d.text;
          streamBubble.el.innerHTML = renderMarkdown(d.text);
        }
        if (currentTurnVoice && speakOn) speakEnd();
        else if (currentTurnVoice && micOn) showListenHint();  // 朗读关着也要给窗口提示
      } else {
        assistantBubble(d.text, 'JARVIS');
        speak(d.text, { fromVoice: currentTurnVoice });
      }
    }
    /* 工具调用：显示"正在查…"，拿到结果后原地更新成结论。
     * 不用新气泡，避免一次对话里刷出好几条噪音。 */
    else if (ev === 'tool_call') {
      hideThinking();
      setState('tool');
      const el = bubble('t', TOOL_CN[d.name] || d.name, '调用工具');
      el.dataset.toolId = d.id;
      const argStr = fmtToolArgs(d.name, d.args);
      if (argStr) el.appendChild(Object.assign(document.createElement('div'),
        { className: 'targs', textContent: argStr }));
      toolEls[d.id] = el;
      // 语音轮：查数据前先垫一句话，填满工具+两轮模型的等待（实测约 8 秒）。
      // 真正回答的第一句 delta 到来时会 stopFiller 把它撤掉。
      maybeVoiceFiller(d.name);
    }
    else if (ev === 'tool_result') {
      const el = toolEls[d.id];
      if (el) {
        el.classList.add(d.ok ? 'tok' : 'terr');
        const tag = document.createElement('span');
        tag.className = 'tres';
        tag.textContent = d.ok ? '✓ 已返回' : '✗ 失败';
        el.appendChild(tag);
      }
    }
    else if (ev === 'learned') {
      const ms = d.memories || [];
      if (ms.length) {
        assistantBubble(ms.map(m => '- ' + m.content).join('\n'), '新记忆');
        /* 先重建星图，等 nameToIdx 里真的有了新实体，再触发脉冲。
         * 否则 pulseWrite 里查不到实体索引，脉冲路径返回 null，等于无声。 */
        loadStarmap().then(() => {
          ms.forEach(m => {
            if (m.entity && window.STAR && STAR.pulseWrite) STAR.pulseWrite(m.entity);
          });
        });
      }
    }
    else if (ev === 'error') {
      hideThinking();
      speakStopInternal(true);     // 流式朗读已开始却报错：立即停，别让半句话悬着
      bubble('e', '出错：' + d.error); setState('alert');
    }
    else if (ev === 'done') {
      hideThinking();
      /* 注意：连续对话提示改在 speak() 的 audio 'ended' 里触发，
       * 不能在这里弹——done 时文字刚到、TTS 还没念，
       * 在这里计时会让朗读时长把窗口空跑掉（念完只剩几秒）。 */
      currentTurnVoice = false;
      const u = d.usage || {};
      metaEl.textContent = `${d.counts.memories} 记忆 · ${d.counts.entities} 实体 · ${u.calls || 0} 次调用 · ${(u.promptTokens || 0) + (u.completionTokens || 0)} tokens`;
      loadStatus();   // 一轮结束后刷新顶栏指标（tokens/calls 已变化）
      setTimeout(() => setState('idle'), 600);
    }
  }

  /* ════════════════════════════════════════════════
     数据源健康灯

     为什么必须上界面：
     3 个关键数据源（腾讯行情 / 东财板块 / 资金流）的状态原来完全看不到。
     东财实测会被 IP 风控（连续 socket hang up），一挂界面毫无变化，
     用户只会觉得"贾维斯今天答得不对"——而错的行情比没有行情更危险。

     **探测必须免费**：只读 /api/health/sources 的已记录状态，
     不主动发起真实请求。为了点亮一个灯去消耗数据源配额是本末倒置，
     而且频繁探测本身就会招来风控。
     ════════════════════════════════════════════════ */
  const srcsEl = $('#srcs');

  function renderSources(d) {
    if (!srcsEl || !d) return;
    /* ══ 后端真实字段：degraded / recentSuccessRate / recentCalls / alternative ══
     * **不是** state / ok。第一版我凭印象写了 s.state 和 s.ok，
     * 全部读到 undefined，灯永远灰着 —— 又一次"没查就写"。
     * 这次是照 source_health.js 的 health() 返回值逐字段核对过的。 */
    const list0 = Array.isArray(d) ? d : (d.sources || d.list || []);
    if (!Array.isArray(list0) || !list0.length) { srcsEl.innerHTML = ''; return; }

    // 只显示关键源；非关键源挂了不影响判断，全塞进顶栏会淹没真问题
    const crit = list0.filter(s => s.critical);
    const list = crit.length ? crit : list0;

    srcsEl.innerHTML = list.map(s => {
      /* 三态：
       *   degraded=true          → 红（挂了）
       *   有调用但成功率<100     → 黄（偶发失败）
       *   recentCalls=0          → 灰（未探测）
       * 把"不知道"画成"正常"是骗人，所以未探测必须保持灰色。 */
      let cls = '';
      if (s.degraded) cls = 'down';
      else if (s.recentCalls > 0) {
        cls = (s.recentSuccessRate != null && s.recentSuccessRate < 100) ? 'deg' : 'ok';
      }
      if (cls === 'down' && s.critical) cls += ' crit';

      const stateCn = s.degraded ? '不可用'
        : !s.recentCalls ? '未探测'
        : cls.startsWith('deg') ? `偶发失败（近期成功率 ${s.recentSuccessRate}%）`
        : '正常';
      const alt = s.alternative ? `，备用 ${s.alternative}` : '，无备用源';
      const broken = s.brokenForDays ? `，已坏 ${s.brokenForDays} 天` : '';
      return `<i class="s ${cls}" title="${s.label}：${stateCn}${alt}${broken}"></i>`;
    }).join('');

    const down = list.filter(s => s.degraded).length;
    srcsEl.title = down
      ? `${down} 个关键数据源不可用 —— 行情类回答可能不准`
      : '数据源正常';

    renderSourceBanner(list);
  }

  /* 关键源异常时常驻横幅：明确"行情可能不是最新"，不拿旧数据冒充实时。
     完全不可用=红；只是偶发失败=琥珀降准。只在有关键源受影响时出现。
     时间一律用后端真实时间戳（lastOkMs/lastCheckMs），不用页面加载时刻猜。*/
  const bannerEl = $('#srcbanner'), bannerTxt = $('#srcbanner-txt'), bannerTime = $('#srcbanner-time');

  /* 把"距今多久"说成人话，且诚实：时间戳缺失就明说，绝不假装"刚刚"。*/
  function ago(ms) {
    if (!ms) return null;
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return '不到 1 分钟前';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24 * 10) / 10} 天前`;
  }

  function renderSourceBanner(list) {
    if (!bannerEl) return;
    const critDown = list.filter(s => s.degraded && s.critical);
    const flaky = list.filter(s => !s.degraded && s.critical
      && s.recentCalls > 0 && s.recentSuccessRate != null && s.recentSuccessRate < 100);

    if (critDown.length) {
      const names = critDown.map(s => s.label.replace(/（.*?）/g, '')).slice(0, 3).join('、');
      const more = critDown.length > 3 ? ` 等 ${critDown.length} 个` : '';
      const days = critDown.map(s => s.brokenForDays).filter(Boolean)[0];
      bannerTxt.textContent = `行情源「${names}」${more} 不可用，`
        + `相关数据可能不是最新，请以实时行情软件为准${days ? `（已持续 ${days} 天）` : ''}`;
      bannerEl.classList.add('show');
      bannerEl.classList.remove('degraded');
    } else if (flaky.length) {
      bannerTxt.textContent = `部分行情源响应不稳（近期成功率 ${flaky[0].recentSuccessRate}%），个别数据可能回落到备用源`;
      bannerEl.classList.add('show', 'degraded');
    } else {
      bannerEl.classList.remove('show', 'degraded');
    }

    if (bannerEl.classList.contains('show')) {
      /* 右侧时间锚点：优先显示"最近一次成功距今"（这才是用户要的"数据有多旧"）；
         该源从未成功过就退回显示"最近探测"，两者都没有则明说无记录。*/
      const srcs = critDown.length ? critDown : flaky;
      const newestOk = srcs.map(s => s.lastOkMs).filter(Boolean).sort((a, b) => b - a)[0];
      const newestCheck = srcs.map(s => s.lastCheckMs).filter(Boolean).sort((a, b) => b - a)[0];
      let t = null;
      if (newestOk) t = '最近成功 ' + ago(newestOk);
      else if (newestCheck) t = '最近探测 ' + ago(newestCheck) + '（未成功过）';
      else t = '无探测时间记录';
      bannerTime.textContent = t;
    }
  }

  async function loadSources() {
    try {
      const r = await fetch('/api/health/sources');
      if (!r.ok) return;
      renderSources(await r.json());
    } catch (_) { if (!_warned.sources) { _warned.sources = true; notify('数据源状态获取失败', 'warn'); } }
  }

  loadSources();
  // 5 分钟刷一次。读的是已记录状态，不产生真实请求，所以频率无成本
  setInterval(loadSources, 5 * 60 * 1000);

  /* ════════════════════════════════════════════════
     主动意识联动（/api/mind SSE 长连接）
     ════════════════════════════════════════════════ */

  const mindBox = $('#mindbox'), moodEl = $('#mood'), doingEl = $('#doing');

  // 五轴定义：双极轴范围 -1~1，单极轴 0~1
  // 配色约束（DESIGN.md §1.1/§7 反向纪律）：情绪轴不得借用涨跌红绿、品牌金、告警金——
  // 那些语义色只在各自语境出现。全冷色家族，五轴互不共用任何语义色值：
  //   心境原为 #3fd48a（恰等于 --ok 绿）→ #7aa2e8
  //   唤醒原为 #ff9f1c（恰等于 --warn，与 .scan-err 报错态同值）→ #b98cd4
  const AXES = [
    { k: '警觉', bipolar: false, hi: '#4f8cff' },
    { k: '从容', bipolar: true,  hi: '#8f7fff' },
    { k: '心境', bipolar: true,  hi: '#7aa2e8' },
    { k: '唤醒', bipolar: true,  hi: '#b98cd4' },
    { k: '沉浸', bipolar: false, hi: '#00d4d4' },
  ];

  let axInit = false;
  function renderMind(snap) {
    if (!snap || !snap.axes) return;

    if (!axInit) {
      mindBox.innerHTML = AXES.map(a => `
        <div class="ax">
          <span class="n">${a.k}</span>
          <span class="bar${a.bipolar ? ' bi' : ''}"><i class="fill" data-k="${a.k}"></i></span>
          <span class="v" data-v="${a.k}">—</span>
        </div>`).join('');
      axInit = true;
    }

    for (const a of AXES) {
      const v = snap.axes[a.k];
      if (v == null) continue;
      const fill = mindBox.querySelector(`.fill[data-k="${a.k}"]`);
      const num = mindBox.querySelector(`.v[data-v="${a.k}"]`);
      if (num) num.textContent = v.toFixed(2);
      if (!fill) continue;

      if (a.bipolar) {
        // 双极：从中点 50% 向左或向右延伸
        const half = Math.min(1, Math.abs(v)) * 50;
        if (v >= 0) { fill.style.left = '50%'; fill.style.width = half + '%'; }
        else { fill.style.left = (50 - half) + '%'; fill.style.width = half + '%'; }
      } else {
        fill.style.left = '0%';
        fill.style.width = (Math.max(0, Math.min(1, v)) * 100) + '%';
      }
      fill.style.background = a.hi;
      fill.style.opacity = 0.35 + Math.min(1, Math.abs(v)) * 0.65;
    }

    if (moodEl) moodEl.textContent = snap.mood ? '「' + snap.mood + '」' : '';

    // 五轴驱动星图表现：唤醒→转速与脉动，沉浸→聚拢
    if (window.STAR && STAR.setMood) {
      STAR.setMood({
        arousal: snap.axes['唤醒'],
        valence: snap.axes['心境'],
        immersion: snap.axes['沉浸'],
        connection: snap.axes['警觉'],
      });
    }
  }

  /* ══ 收完整文案，不自动拼前缀 ══
   *
   * 原本这里无条件拼 '贾维斯正在' + label + '…'，
   * 但调用点传进来的 label 风格不一致，拼出来五花八门：
   *   '在听…'            → 贾维斯正在在听……      （叠字）
   *   '没听清…'          → 贾维斯正在没听清…      （用户截图里就是这个）
   *   '对话结束'         → 贾维斯正在对话结束…    （语义反了）
   *   '正在恢复语音监听…' → 贾维斯正在正在恢复…    （叠字）
   * 只有巡视那一处（'巡视 · 3项'）恰好通顺。
   *
   * 自动拼前缀这种"贴心"设计，在调用点一多就必然失控 ——
   * 改成由调用点给完整句子，看得见即所得。 */
  function showDoing(text, ms = 6000) {
    if (!doingEl) return;
    doingEl.textContent = text;
    doingEl.classList.add('on');
    clearTimeout(showDoing._t);
    showDoing._t = setTimeout(() => doingEl.classList.remove('on'), ms);
  }

  function connectMind() {
    let es;
    try { es = new EventSource('/api/mind'); }
    catch (e) { return; }

    es.addEventListener('mind_state', e => {
      try { renderMind(JSON.parse(e.data)); } catch (_) {}
    });

    // 贾维斯主动搭话 / 主动报告巡视发现
    es.addEventListener('mind_proactive', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      const label = d.action === 'report' ? 'JARVIS · 巡视发现' : 'JARVIS · 主动';
      const el = assistantBubble(d.text, label, 'pro');
      // 巡视报告带结构化 findings，按严重度标色显示
      if (Array.isArray(d.findings) && d.findings.length) {
        const box = document.createElement('div');
        box.className = 'pfind';
        d.findings.slice(0, 5).forEach(f => {
          const row = document.createElement('div');
          row.className = 'pfrow sev-' + (f.severity || 'low');
          row.textContent = f.text;
          box.appendChild(row);
        });
        el.appendChild(box);
      }
      setState('speak');
      amp = 1;
      speak(d.text);
      setTimeout(() => { setState('idle'); amp = 0.12; }, 2200);
    });

    // 贾维斯自己找事做（不打扰，只显示状态 + 低调显示发现）
    es.addEventListener('mind_activity', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      const n = Array.isArray(d.findings) ? d.findings.length : 0;
      // 有发现但不值得打扰时，在状态里带上条数，用户想看能看到
      showDoing(n ? `贾维斯正在${d.label || '巡视'} · ${n}项…` : `贾维斯正在${d.label || '巡视'}…`);
      if (n) lastPatrol = { at: Date.now(), label: d.label, task: d.task, findings: d.findings };
    });

    // 断线自动重连（服务重启时不用手动刷新）
    es.onerror = () => {
      es.close();
      setTimeout(connectMind, 4000);
    };
  }

  send.onclick = submit;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  /* ════════════════════════════════════════════════
     语音：TTS 朗读 + ASR 唤醒词/听写
     ════════════════════════════════════════════════ */

  const micBtn = $('#mic'), spkBtn = $('#spk');

  /* 朗读开关持久化到 localStorage，刷新页面不丢设置 */
  let speakOn = localStorage.getItem('jarvis_speak') === '1';

  /* ══════════ 麦克风开关也必须持久化 ══════════
   *
   * 实测 bug（用户报「喊了贾维斯但不能唤醒」）：
   * 这里原本写死 `let micOn = false`，于是刷新页面后
   *   前端 micOn=false → 不调 connectVoice() → **不建立 SSE 连接**
   * 而后端的 _forceOn 仍是 true，PowerShell 还占着麦克风。
   *
   * 结果就是最坑的组合：
   *   系统托盘提示「麦克风正在使用中」（进程真的在听）
   *   喊唤醒词也真的识别了、事件也真的发出来了
   *   **但前端没连 SSE，没人接收** → 界面毫无反应
   *
   * 「看起来在工作但实际没连上」比「明显坏掉」更难查 ——
   * 用户看到麦克风指示灯亮着，只会以为唤醒词没被听见。
   *
   * 朗读开关早就持久化了，麦克风漏了。 */
  let micOn = localStorage.getItem('jarvis_mic') === '1';
  let awake = false;              // 是否已被唤醒（正在等指令）
  let awakeTimer = null;
  let voiceES = null;
  // 朗读音频已改为 speakQ 队列管理（见流式朗读队列），不再用单个 audio 变量。

  /* 唤醒后多久没说话就回到"只听唤醒词"状态。
   *
   * ⚠ 必须和服务端的 CONVO_WINDOW_MS（15 秒）对齐。
   * 2026-09-13 从 30 秒下调到 15 秒（用户实测选择）。
   * 真正的门禁在服务端，这里只是显示状态；显示错了一样误导人。 */
  const AWAKE_WINDOW_MS = 15000;
  /* "不用再喊，直接说"提示的时长：同样 15 秒，
   * 但起点是 TTS 念完（audio 'ended'），不是文字到达。 */
  const CONTINUE_WINDOW_MS = 15000;

  function syncBtns() {
    spkBtn.classList.toggle('on', speakOn);
    micBtn.classList.toggle('on', micOn && !awake);
    micBtn.classList.toggle('awake', awake);
    micBtn.title = !micOn ? '语音输入（点击开启常听）'
      : awake ? '已唤醒，请说指令…'
      : '常听中 · 说「贾维斯」唤醒';
  }

  /* ══════════ 流式朗读队列（P2）══════════
   *
   * 旧链路：等模型把整段答完(~9s) → 整段 TTS(~1s) → 才出声。
   * 新链路：模型一边吐字，这里一边按句切分；凑够一句就立刻请求 TTS 播放，
   * 后续句子排队 —— 第一句在首 token 后约 1-2 秒就能念出，
   * 念第一句的时候模型还在生成后面，天然重叠。
   *
   * 关键约束：
   *   · 一个 Audio 念一句，顺序播放（队列），不能各念各的叠在一起；
   *   · 打断（用户开口/新一轮）必须同时清空队列 + 停当前句；
   *   · 服务端只在"播放开始/全部结束"各报一次 speaking，
   *     换句子不能抖动 speaking=false，否则 barge-in 判定会错。
   */
  const speakQ = {
    active: false,        // 本轮是否在朗读
    fromVoice: false,
    done: false,          // speakEnd 已调用（不会再有新句子）
    pending: '',          // 还没凑成完整句的残片
    queue: [],            // 等待合成的句子（文本）
    ready: [],            // 已合成、可立刻播放的 {url}（预取缓冲）
    fetching: false,      // 是否正在预取一句
    cur: null,            // 正在播放的 Audio
    playing: false,
  };

  /* 句读切分：中文句号/问号/叹号/分号/省略号/换行，英文 .?!。
   * 逗号不切 —— 切太碎会让每句都付一次 TTS 冷启动，反而更慢更磕巴。
   *
   * 关键坑：英文句点不能切到小数点（"涨4.37%"、"3.5亿"）。
   * 用"非数字 . 非数字"才认作句末，避免把 4.37 切成两句。
   * 返回 {done:[], rest}。 */
  function splitSentences(text) {
    const done = [];
    let start = 0;
    const isDigit = c => c >= '0' && c <= '9';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      let cut = false;
      if (c === '。' || c === '！' || c === '？' || c === '；' || c === '\n' || c === '…') {
        cut = true;
      } else if (c === '.' || c === '!' || c === '?') {
        // 小数点两侧都是数字时不切（4.37%、3.5亿）
        const prev = text[i - 1], next = text[i + 1];
        if (!(prev && next && isDigit(prev) && isDigit(next))) cut = true;
      }
      if (cut) {
        // 省略号连续多个 …… 应整体归属一句：跳过后续连续的 … 或 .
        if (c === '…') { while (text[i + 1] === '…' || text[i + 1] === '.') i++; }
        const s = text.slice(start, i + 1).trim();
        if (s) done.push(s);
        start = i + 1;
      }
    }
    return { done, rest: text.slice(start) };
  }

  function speakStart(fromVoice) {
    // 清掉上一轮（正常连续调用时队列本来就是空的，这里是保险）
    speakStopInternal(false);
    cancelWakeAck();            // 正文起念，唤醒应答"在呢"立刻撤，避免叠播
    stopFiller();               // 垫场语立刻撤
    fillerSaid = true;          // 正文开始后本轮不再垫话
    speakQ.active = true;
    speakQ.fromVoice = !!fromVoice;
    speakQ.pending = '';
    speakQ.queue = [];          // 待合成的句子（纯文本）
    speakQ.ready = [];          // 已合成、可立刻播放的 {url}（预取缓冲）
    speakQ.fetching = false;
    reportSpeaking(true);
  }

  function speakFeed(piece) {
    if (!speakQ.active) return;
    speakQ.pending += piece;
    const { done, rest } = splitSentences(speakQ.pending);
    speakQ.pending = rest;
    for (const s of done) { speakQ.queue.push(s); }
    pumpFetch();
    pumpPlay();
  }

  function speakEnd() {
    if (!speakQ.active) return;
    // 残片里还有没标点的结尾（模型最后一句可能没句号）
    const tail = speakQ.pending.trim();
    if (tail) { speakQ.queue.push(tail); speakQ.pending = ''; }
    speakQ.done = true;
    pumpFetch();
    pumpPlay();
  }

  /* 预取：把下一句的 mp3 提前下成 Blob。这样当前句念完时，
   * 下一句的音频通常已在内存，直接 play()，不再为每句付 ~1.5s 冷启动
   * —— 那正是"每个标点后停 3 秒"的根因。
   * 只预取紧邻的一句（ready 最多 1 个）：再深会把可能被打断的内容也下了，
   * 白等还浪费。fetching 标志保证同时只有一个预取请求。 */
  async function pumpFetch() {
    if (!speakQ.active || speakQ.fetching) return;
    if (speakQ.ready.length >= 1 || !speakQ.queue.length) return;
    const sentence = speakQ.queue.shift();
    speakQ.fetching = true;          // 同步置位：next() 据此判断"还有一句在路上"
    try {
      const resp = await fetch('/api/voice/speak/stream?text=' + encodeURIComponent(sentence));
      if (!resp.ok) throw new Error('tts ' + resp.status);
      const blob = await resp.blob();
      speakQ.fetching = false;
      if (!speakQ.active) return;          // 被打断，丢弃
      speakQ.ready.push({ url: URL.createObjectURL(blob) });
      pumpPlay();
    } catch (_) {
      speakQ.fetching = false;
      // 单句失败：继续尝试后面的句子，别让整轮卡死
      if (speakQ.active) pumpFetch();
    }
  }

  function pumpPlay() {
    if (speakQ.playing || !speakQ.active) return;
    const item = speakQ.ready.shift();
    if (!item) {
      // 没有就绪音频：若不会再有内容，则结束；否则等预取完成后会再触发
      if (speakQ.done && !speakQ.queue.length && !speakQ.fetching) finishSpeak();
      return;
    }
    const a = new Audio(item.url);
    speakQ.cur = a;
    speakQ.playing = true;
    const release = () => { URL.revokeObjectURL(item.url); };
    const next = () => {
      speakQ.playing = false;
      speakQ.cur = null;
      release();
      pumpFetch();
      if (!speakQ.active) return;          // 已被打断
      if (speakQ.ready.length) pumpPlay();
      else if (speakQ.done && !speakQ.queue.length && !speakQ.fetching) finishSpeak();
      // 还有句子在预取/生成 → fetch 完成后 pumpPlay 会接上
    };
    a.addEventListener('ended', next);
    a.addEventListener('error', next);     // 单句失败不拖垮整轮
    a.play().catch(next);
  }

  function finishSpeak() {
    if (!speakQ.active) return;
    speakQ.active = false;
    const fromVoice = speakQ.fromVoice;
    reportSpeaking(false);                // 全部念完才报 false
    if (fromVoice && micOn) showListenHint();
  }

  /* 停止播放（内部）。report 控制是否通知服务端：
   * 新一轮 speakStart 复用同一 true 状态时不需要先 false 再 true 抖动。 */
  function speakStopInternal(report) {
    speakQ.active = false;
    speakQ.done = false;
    speakQ.queue = [];
    speakQ.pending = '';
    speakQ.playing = false;
    speakQ.fetching = false;
    if (speakQ.cur) { try { speakQ.cur.pause(); } catch (_) {} speakQ.cur = null; }
    // 已预取但没播的 Blob URL 必须回收，否则打断频繁时会泄漏内存
    for (const it of (speakQ.ready || [])) { try { URL.revokeObjectURL(it.url); } catch (_) {} }
    speakQ.ready = [];
    if (report) reportSpeaking(false);
  }

  /** 朗读一段完整文本（非流式调用点的兼容入口，例如页面内单句试播）。 */
  async function speak(text, opts = {}) {
    if (!speakOn || !text) {
      if (opts.fromVoice && micOn) showListenHint();
      return;
    }
    speakStart(!!opts.fromVoice);
    speakFeed(text);
    speakEnd();
  }

  function stopSpeaking() {
    cancelWakeAck();
    speakStopInternal(true);
    stopFiller();
  }

  /* ══════════ 垫场语（filler）══════════
   *
   * 查数据的问题要等"模型决定调工具(~7s) + 取数 + 模型组织回答(~3s)"，
   * 这段时间完全静音，体感就是"憋半天"。真人助手这时会说"我查一下"。
   *
   * 垫场语是一条**独立短音频**，不进 speakQ 主队列：
   *   · 只在语音轮、且当前没在念正文时播；
   *   · 正文第一句 delta 到来立刻撤（stopFiller），不与正文叠播；
   *   · 一句回复里多个 tool_call 只垫一次（fillerSaid 去重）；
   *   · 不调 reportSpeaking —— 它只是过渡，打断判定仍由主朗读状态负责，
   *     避免垫句把 speaking 状态搅乱。 */
  let fillerAudio = null, fillerSaid = false;
  const FILLERS = ['我查一下，稍等。', '好，我看一下数据。', '等我查一下。'];

  function maybeVoiceFiller(/*toolName*/) {
    if (!currentTurnVoice || !speakOn) return;
    if (fillerSaid) return;
    // 正文已经在念（多轮工具时）就不必垫了
    if (speakQ.active || fillerAudio) return;
    fillerSaid = true;
    const line = FILLERS[Math.floor(Math.random() * FILLERS.length)];
    try {
      fillerAudio = new Audio('/api/voice/speak/stream?text=' + encodeURIComponent(line));
      const done = () => { if (fillerAudio) fillerAudio = null; };
      fillerAudio.addEventListener('ended', done);
      fillerAudio.addEventListener('error', done);
      fillerAudio.play().catch(done);
    } catch (_) { fillerAudio = null; }
  }
  function stopFiller() {
    if (fillerAudio) { try { fillerAudio.pause(); } catch (_) {} fillerAudio = null; }
  }

  /* ══════════ 唤醒应答（wake ack）══════════
   *
   * 用户喊"贾维斯"后必须有个回应，否则他不知道：到底听见没？现在该不该说？
   * 视觉上 enterAwake 已显示"贾维斯在听…"，这里补一声短应答（"在呢"），
   * 让耳朵也确认。
   *
   * 关键时序：唤醒有两种——
   *   ① 只喊名字（纯唤醒）：该出声说"在呢"；
   *   ② "贾维斯帮我看XX"一口气说（lead）：voice_wake 后紧接着就来
   *      voice_speech/正文，这时不能答"在呢"（会和回答叠、还多等一下）。
   * 所以唤醒后先挂一个短延迟（ACK_DELAY_MS），这期间若命令/正文到达
   * 就撤掉应答。打断（barge-in）也不答——那是让人闭嘴，不是新对话。
   *
   * 应答要正确上报 speaking 状态：否则回声能量起音可能把这声"在呢"
   * 当成用户插话而自我打断。 */
  let ackTimer = null, ackAudio = null;
  const ACK_LINES = ['在呢。', '嗯，说。', '我在。', '在呢，你说。'];
  function scheduleWakeAck() {
    if (!speakOn) return;                 // 关了朗读就只用视觉"在听…"提示
    cancelWakeAck();
    ackTimer = setTimeout(playWakeAck, 320);
  }
  function playWakeAck() {
    ackTimer = null;
    if (!speakOn || speakQ.active || fillerAudio) return;  // 已有内容在念就别插话
    const line = ACK_LINES[Math.floor(Math.random() * ACK_LINES.length)];
    try {
      reportSpeaking(true);
      ackAudio = new Audio('/api/voice/speak/stream?text=' + encodeURIComponent(line));
      const done = () => {
        if (ackAudio) ackAudio = null;
        reportSpeaking(false);
      };
      ackAudio.addEventListener('ended', done);
      ackAudio.addEventListener('error', done);
      ackAudio.play().catch(done);
    } catch (_) {
      ackAudio = null;
      reportSpeaking(false);
    }
  }
  function cancelWakeAck() {
    if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
    if (ackAudio) {
      try { ackAudio.pause(); } catch (_) {}
      ackAudio = null;
      reportSpeaking(false);
    }
  }

  /* 朗读状态上报。用 fire-and-forget —— 这是辅助信号，
   * 失败了不该影响朗读本身，所以不 await 也不报错。 */
  let _lastSpeakingReport = null;
  function reportSpeaking(on) {
    // 任何 TTS（主回复/垫场/唤醒应答"在呢"）开始与结束 → 晶核 speak/idle
    coreSetState(on ? 'speak' : (awake ? 'listen' : 'idle'));
    if (_lastSpeakingReport === on) return;   // 去重，避免同一状态反复打服务器
    _lastSpeakingReport = on;
    fetch('/api/voice/speaking?on=' + (on ? '1' : '0'), { method: 'POST' })
      .catch(() => {});
  }

  spkBtn.onclick = () => {
    speakOn = !speakOn;
    localStorage.setItem('jarvis_speak', speakOn ? '1' : '0');
    if (!speakOn) stopSpeaking();
    syncBtns();
  };

  micBtn.onclick = async () => {
    micOn = !micOn;
    // 持久化 —— 否则刷新页面后前端不连 SSE，麦克风开着却没人接收事件
    localStorage.setItem('jarvis_mic', micOn ? '1' : '0');
    if (micOn) connectVoice();
    else {
      // 通知服务端关麦，并断开 SSE（服务端没订阅者也会自动关）
      try { await fetch('/api/voice/mic?on=0', { method: 'POST' }); } catch (_) {}
      if (voiceES) { voiceES.close(); voiceES = null; }
      awake = false;
      if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
    }
    syncBtns();
  };

  function enterAwake() {
    awake = true;
    amp = 0.45;                 // 声纹进入聆听态（中幅）
    coreSetState('listen');     // 晶核进入聆听态
    syncBtns();
    showDoing('贾维斯在听…');
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => { awake = false; amp = 0.12; coreSetState('idle'); syncBtns(); }, AWAKE_WINDOW_MS);
  }

  /* ── 语音回复后的"可以继续说"提示 ──
   *
   * 解决"问一句答一句"的另一半：30 秒连续对话窗口后端一直开着，
   * 但用户看不见，不知道答完不用再喊唤醒词，于是每句都重新喊。
   *
   * 做一个带倒计时的常驻提示条，只在语音轮出现；说话(被打断/新输入)
   * 或倒计时结束时消失。纯 UI，不改任何语音判定。 */
  let listenHintEl = null, listenHintTimer = null, listenHintTick = null;
  function showListenHint() {
    if (!micOn) return;                 // 没用语音就别提示
    if (!listenHintEl) {
      listenHintEl = document.createElement('div');
      listenHintEl.id = 'listenHint';
      listenHintEl.className = 'listen-hint';
      document.body.appendChild(listenHintEl);
    }
    let remain = Math.round(CONTINUE_WINDOW_MS / 1000);
    const paint = () => {
      listenHintEl.textContent = '🎙 不用再喊，直接说就行 · ' + remain + ' 秒';
      listenHintEl.classList.add('on');
    };
    paint();
    clearInterval(listenHintTick);
    listenHintTick = setInterval(() => {
      remain--;
      if (remain <= 0) hideListenHint();
      else paint();
    }, 1000);
    clearTimeout(listenHintTimer);
    listenHintTimer = setTimeout(hideListenHint, CONTINUE_WINDOW_MS);
  }
  function hideListenHint() {
    if (listenHintEl) listenHintEl.classList.remove('on');
    clearInterval(listenHintTick); listenHintTick = null;
    clearTimeout(listenHintTimer); listenHintTimer = null;
  }

  function connectVoice() {
    if (voiceES) return;
    // 打开前先确保服务端允许开麦（上次可能被手动关过）
    fetch('/api/voice/mic?on=1', { method: 'POST' }).catch(() => {});
    try { voiceES = new EventSource('/api/voice/listen'); }
    catch (_) { return; }

    voiceES.addEventListener('voice_status', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      micOn = !!d.listening;
      syncBtns();
    });

    /* 真实麦克风声压（约 10Hz）→ 晶核能量。服务端已归一化 level 0..1。
       只在聆听窗口用真实声压；朗读中（speak）走合成能量，避免收到 TMS 回声。 */
    voiceES.addEventListener('voice_level', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (vcState !== 'speak' && typeof d.level === 'number') coreMicLevel(d.level);
    });

    // 唤醒词命中 → 进入"等指令"状态
    voiceES.addEventListener('voice_wake', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      stopSpeaking();          // 用户开口就停止朗读，别抢话
      enterAwake();
      // 喊完名字给一声"在呢"；若马上跟了命令（lead），voice_speech 会撤掉它
      scheduleWakeAck();
    });

    /* ── 打断（barge-in）──
     * 服务端判定「朗读中被唤醒 / 被说话截住」时推这个事件。
     * 必须立刻停播 —— 喇叭还在响的话麦克风会收到自己的声音，
     * 变成自问自答。这是调研外部项目时发现我们缺的核心体验之一。 */
    voiceES.addEventListener('voice_interrupt', () => {
      cancelWakeAck();         // 打断是让人闭嘴，用户已在说话，不要再答"在呢"抢话
      stopSpeaking();
      showDoing('贾维斯在听…（打断后）');
      enterAwake();
    });

    /* ── 连续对话窗口关闭 ──
     * 用户说了"结束/没事了"，回到需要唤醒词的状态。 */
    voiceES.addEventListener('voice_convo', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d && d.open === false) {
        awake = false;
        amp = 0.12;             // 声纹回待机
        coreSetState('idle');   // 晶核回待命
        hideListenHint();       // 窗口关了，"可以继续说"提示也撤
        cancelWakeAck();        // 对话结束，别再"在呢"
        if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
        syncBtns();
        showDoing('贾维斯对话结束');
      }
    });

    /* ── 没听清 ──
     * 置信度太低，服务端没发给模型。
     * 显示出来比完全没反应好 —— 让用户知道麦克风活着，只是没听懂。
     *
     * ══ 修复：已唤醒时不覆盖 ══
     * 唤醒成功后服务端会推 voice_wake → enterAwake() → 显示"在听…"
     * 但 System.Speech 同时会把背景噪声识别成乱码（conf 0.007），
     * 触发 voice_unclear → showDoing('没听清…')，把"在听…"覆盖了。
     * 用户看到"没听清"以为唤醒失败，实际上已成功。
     * 所以：awake=true 时忽略 unclear，避免 race condition。 */
    voiceES.addEventListener('voice_unclear', () => {
      if (awake) return;
      showDoing('贾维斯没听清…');
    });

    /* 窄带麦低置信，服务端正用 whisper 二次辨认 —— 别停在"没听清" */
    voiceES.addEventListener('voice_rescuing', () => {
      showDoing('贾维斯在辨认…');
    });

    /* base 识别置信度低，正用更准但更慢的 small 模型精识别（约几秒）。
     * 给用户明确预期，避免以为卡死。 */
    voiceES.addEventListener('voice_whisper_verifying', () => {
      showDoing('贾维斯在仔细辨认上一句…', 9000);
    });

    /* ── 唤醒失败的可视化（2026-09-13）──
     * 之前喊了没反应是完全静默的，无法判断卡在哪。
     * 现在把 whisper 救命链路的结果透出来，只做轻提示，不刷屏。 */
    voiceES.addEventListener('voice_whisper_wake_miss', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      // whisper 确实听到了，但没听成唤醒词 → 多半是发音/距离/噪声
      showDoing('听到声音但没认出唤醒词' + (d.heard ? '（听成：' + d.heard + '）' : ''), 2600);
    });
    voiceES.addEventListener('voice_whisper_wake_skip', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      const why = {
        no_speech: '没采到人声（靠近点 / 大点声 / 换本机麦克风）',
        cooldown: '辨认冷却中，请稍等再喊',
        ring_not_running: '录音未运行',
        ring_not_filled: '缓冲还没录满',
        length: '语音长度异常',
        busy: '正在辨认上一句',
      }[d.why] || ('未辨认（' + d.why + '）');
      showDoing(why, 2600);
    });
    voiceES.addEventListener('voice_whisper_wake_failed', e => {
      showDoing('语音辨认组件出错了', 2600);
    });
    voiceES.addEventListener('voice_wake_via_whisper', () => {
      // 窄带麦被救命通道救活，enterAwake 由 voice_wake 处理；这里无需额外动作
    });

    /* 听写结果。
     *
     * 关键设计：**只在已唤醒状态下才当成指令**。
     * 常听会把房间里所有中文都识别出来（听写语法是自由文本），
     * 不加这道门就会把电视声、旁人对话直接发给模型。
     * 实测唤醒词对近音词有 25% 误触发，所以唤醒本身也不足以信任 ——
     * 还要求识别文本有一定长度，过滤掉零碎音节。 */
    /* 听写结果。
     *
     * ══════ 门禁已上移到服务端 ══════
     * 原来这里要求 `if (!awake) return`，也就是每说一句都必须先喊唤醒词。
     * 现在服务端的 Listener 维护 30 秒**连续对话窗口**：
     *   窗口内的语音才会推送 voice_speech（带 convo:true）
     *   窗口外的直接丢弃，根本不推
     * 所以前端不能再拦 —— 否则连续对话等于没做（唤醒后 awake 就被清掉了）。
     *
     * 服务端已经做了置信度 + 最短字数过滤，这里只保留一道兜底长度检查。
     * 双重门禁的教训：两处都判断状态，很容易一边放开另一边还拦着。 */
    voiceES.addEventListener('voice_speech', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      const t = (d.text || '').trim();
      if (t.length < 2) return;              // 兜底：太短多半是误识别
      /* 服务端带了 convo 标记就信任它（它才知道窗口是否开着）；
       * 没有标记时退回旧逻辑，兼容老服务端。 */
      if (d.convo !== true && !awake) return;
      // "贾维斯帮我看XX"一口气说：命令紧跟着唤醒到了，撤掉"在呢"应答，别叠播
      cancelWakeAck();
      awake = false;
      hideListenHint();         // 用户又开口了，旧的倒计时提示撤掉（答完会再弹）
      if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
      syncBtns();
      inp.value = t;
      voiceOrigin = true;      // 标记这一轮是说话进来的，submit 会据此换语音规则
      submit();
    });

    voiceES.addEventListener('voice_error', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      console.warn('[voice]', d.msg);
    });

    voiceES.onerror = () => {
      if (voiceES) { voiceES.close(); voiceES = null; }
      if (micOn) setTimeout(connectVoice, 4000);   // 断线重连
    };
  }

  syncBtns();

  /* ══════════ 恢复上次的麦克风状态 ══════════
   *
   * 这是「喊了贾维斯不能唤醒」那个 bug 的另一半修复。
   * 光把 micOn 从 localStorage 读回来不够 —— 还必须真的重连 SSE，
   * 否则按钮显示"开着"但事件流没建立，等于假开。
   *
   * 延迟 300ms 让 loadStatus 先跑完；
   * 如果后端其实没在监听，connectVoice 里的 fetch(on=1) 会把它拉起来。 */
  if (micOn) {
    setTimeout(() => {
      connectVoice();
      showDoing('贾维斯正在恢复语音监听…');
    }, 300);
  }

  /* ══════════ 星图点击 → 记忆详情卡 ══════════
   *
   * 星图之前是纯展示：一堆匿名光点，点了没反应，记忆内容完全看不到。
   * 现在点节点弹卡片，显示内容、权重、衰减状态、合并历史。
   */
  const mcEl   = document.getElementById('memcard');
  const mcCat  = document.getElementById('mc-cat');
  const mcId   = document.getElementById('mc-id');
  const mcBody = document.getElementById('mc-body');
  const graphEl = document.getElementById('graph');

  const DECAY_CN = { fresh: '新鲜', normal: '正常', fading: '正在变淡' };
  const CAT_CN   = { person:'人物', place:'地点', event:'事件',
                     interest:'兴趣', project:'项目' };

  /* 点击时直接读 loadStarmap 缓存的数据，不重复请求。
   * 记忆内容已经在 /api/starmap 里返回了，没必要为一次点击再打一趟服务器。 */
  const starMems = () => (window.__starData && window.__starData.memories) || [];

  function hideCard() {
    mcEl.classList.remove('on');
    if (window.STAR) STAR.select(-1);
  }
  document.getElementById('mc-x').addEventListener('click', hideCard);
  document.getElementById('mc-x').addEventListener('keydown', e => { if (e.key === 'Enter') hideCard(); });

  /** 卡片定位：跟着点击位置，但不出屏 */
  function placeCard(px, py) {
    const w = 286, pad = 12;
    let x = px + 16, y = py + 14;
    if (x + w + pad > window.innerWidth)  x = px - w - 16;
    if (x < pad) x = pad;
    // 高度未知（内容可变），用估算值避免底部溢出
    const hEst = mcEl.offsetHeight || 200;
    if (y + hEst + pad > window.innerHeight) y = Math.max(pad, py - hEst - 14);
    mcEl.style.left = x + 'px';
    mcEl.style.top  = y + 'px';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function showMemoryCard(memId, px, py) {
    const local = starMems().find(m => m.id === memId);
    if (!local) return;

    mcCat.textContent = CAT_CN[local.category] || local.category || '记忆';
    mcId.textContent  = '#' + memId + (local.entity ? ' · ' + local.entity : '');

    const pct = Math.round((local.retention == null ? 1 : local.retention) * 100);
    const ds  = local.decayState || 'fresh';

    // 先用本地数据立刻渲染，合并历史再异步补 —— 避免点击后卡半秒才出内容
    mcBody.innerHTML = `
      <div class="mc-txt">${esc(local.content)}</div>
      <div class="mc-meta">
        <span class="mc-tag ${ds}">${DECAY_CN[ds] || ds}</span>
        <span class="mc-tag">权重 <b>${(local.weight ?? 0).toFixed(2)}</b></span>
        <span class="mc-tag">读过 <b>${local.readCount || 0}</b> 次</span>
        <span class="mc-tag">${local.ageDays ?? 0} 天前</span>
        ${local.mergedCount ? `<span class="mc-tag">吞并 <b>${local.mergedCount}</b> 条</span>` : ''}
      </div>
      <div class="mc-bar"><i style="width:${pct}%"></i></div>
      <div class="mc-cap">时间留存 ${pct}% · 检索强度 ${((local.strength ?? 0)*100).toFixed(0)}%</div>
      ${local.mergedCount ? '<div class="mc-merge" id="mc-mg"><div class="mc-hint mc-empty">读取合并历史…</div></div>' : ''}
    `;
    placeCard(px, py);
    mcEl.classList.add('on');

    if (!local.mergedCount) return;

    /* 拉合并历史。
     * 这是唯一能看到"被删掉的原文"的地方 —— memory_merges 表存着它，
     * 因为合并是不可逆操作，必须留证据可追溯。 */
    try {
      const r = await fetch('/api/memory/' + memId);
      const d = await r.json();
      const box = document.getElementById('mc-mg');
      if (!box) return;
      const ms = d.merges || [];
      box.innerHTML = '<div class="mc-mh">整理痕迹 · MERGES</div>' + (ms.length
        ? ms.map(m => `
          <div class="mc-mrow">
            <span class="d">${esc(m.dropped_text)}</span>
            <span class="w">相似度 ${(m.similarity||0).toFixed(3)} ·
              ${m.decided_by === 'model' ? '模型判定' : '相似度判定'}${m.reason ? ' · ' + esc(m.reason) : ''} ·
              ${esc(String(m.created_at||'').slice(5,16))}</span>
          </div>`).join('')
        : '<div class="mc-empty">无记录</div>');
    } catch (_) {
      const box = document.getElementById('mc-mg');
      if (box) box.innerHTML = '<div class="mc-empty">合并历史读取失败</div>';
    }
  }

  let _hoverT = 0;
  graphEl.addEventListener('pointermove', (ev) => {
    if (!window.STAR || !STAR.hover) return;
    const now = performance.now();
    if (now - _hoverT < 60) return;   // 60ms ????????????????????
    _hoverT = now;
    const rect = graphEl.getBoundingClientRect();
    STAR.hover(ev.clientX - rect.left, ev.clientY - rect.top);
  });
  graphEl.addEventListener('pointerleave', () => {
    if (window.STAR && STAR.hover) STAR.hover(-1, -1);
  });

  graphEl.addEventListener('click', (ev) => {
    if (!window.STAR || !STAR.pick) return;
    const rect = graphEl.getBoundingClientRect();
    const hit = STAR.pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!hit || hit.memId == null) { hideCard(); if (STAR.unfocus) STAR.unfocus(); return; }
    STAR.select(hit.nodeIndex);
    if (STAR.focus) STAR.focus(hit.nodeIndex);
    showMemoryCard(hit.memId, ev.clientX, ev.clientY);
  });

  // 点空白处关卡片；Esc 也关
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideCard(); if (window.STAR && STAR.unfocus) STAR.unfocus(); } });

  /* 首屏加载占位：避免 #galaxies 在数据到达前显示"还没有记忆"的假空态、
     #chat 一片黑。成功渲染后被整体替换；history 失败则静默移除骨架。 */
  galEl.innerHTML = skeleton(SK_GAL);
  chat.innerHTML = skeleton(SK_CHAT);
  loadHistory(); loadStarmap(); loadStatus();
  connectMind();
  inp.focus();

/* ════════════════════════════════════════════════
   声波粒子喷泉 + 遥测面板（globe / radar / spark）

   在 app.js IIFE 内部：直接读 amp（真实语音振幅）与
   stateEl 的状态 class，全部来自既有状态机，无模拟。
   ════════════════════════════════════════════════ */
  (function () {
    'use strict';
    // reduceMotion 复用模块级判定（§4），此处不再重复 matchMedia
    const fxStateEl = stateEl;
    const dprF = () => Math.min(2, devicePixelRatio || 1);
    const resizeTo = (cv, w, h) => {
      cv.width  = Math.floor(w * dprF());
      cv.height = Math.floor(h * dprF());
      const c = cv.getContext('2d');
      c.setTransform(dprF(), 0, 0, dprF(), 0, 0);
      return c;
    };

    /* ── 粒子喷泉 ── */
    const fc = document.getElementById('fountain');
    let fx = null;
    let fW = 0, fH = 0;
    if (fc) {
      fW = fc.clientWidth || 600;
      fH = fc.clientHeight || 130;
      fx = resizeTo(fc, fW, fH);
    }
    /* 状态 → 粒子主色（聆听冷蓝 / 思考暖橙 / 说话翠绿）*/
    const STATE_COLOR = {
      idle:  [63, 208, 255],
      listen:[63, 208, 255],
      think: [255, 159, 28],
      speak: [63, 212, 138],
      tool:  [150, 170, 220],
      alert: [255, 92, 92],
    };
    const MAX_P = 256;
    const parts = [];
    function spawnParticle(energy) {
      const cx = fW / 2;
      let p = null;
      for (let i = 0; i < parts.length; i++) { if (parts[i].done) { p = parts[i]; break; } }
      if (!p) { if (parts.length >= MAX_P) return; p = {}; parts.push(p); }
      p.done = false;
      p.x = cx + (Math.random() - 0.5) * fW * 0.24;
      p.y = fH + 2;
      p.vx = (Math.random() - 0.5) * (0.6 + energy * 1.4);
      p.vy = -1.2 - Math.random() * (1.0 + energy * 3.2);
      p.life = 1;
      p.sz  = 0.8 + Math.random() * (1.0 + energy * 2.0);
    }
    function updateParts(dt, energy, col) {
      const want = Math.round(6 + energy * 40);
      for (let i = 0; i < want; i++) spawnParticle(energy);
      const g = 0.16 * (fH / 130);
      const drag = 0.985;
      for (const p of parts) {
        if (p.done) continue;
        p.vx *= drag;
        p.vy += g * (1 + energy * 0.25);
        p.x += p.vx;
        p.y += p.vy;
        p.life -= dt * (0.7 + energy * 0.7);
        if (p.life <= 0 || p.y > fH + 6 || p.x < -6 || p.x > fW + 6) { p.done = true; continue; }
        const a = Math.min(1, p.life * 1.5) * (0.25 + energy * 0.5);
        fx.beginPath();
        fx.arc(p.x, p.y, p.sz * (0.4 + p.life * 0.6), 0, 6.2832);
        fx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + a.toFixed(3) + ')';
        fx.fill();
      }
    }

    /* ── 线框地球仪（节点球）── */
    const gc = document.getElementById('globe');
    let gx = null; let gW = 0, gH = 0;
    let globeRot = 0;
    if (gc) {
      gW = gc.clientWidth || 180;
      gH = gc.clientHeight || 120;
      gx = resizeTo(gc, gW, gH);
    }
    const CAT_COL = { person:[113,236,187], project:[104,211,196],
      interest:[95,188,208], place:[87,165,218], event:[80,144,226], ent:[255,189,87] };
    let globePts = [];
    function refreshGlobePts() {
      const sd = window.__starData;
      if (!sd || !Array.isArray(sd.entities) || !sd.entities.length) { globePts = []; return; }
      globePts = sd.entities.slice(0, 60).map(e => {
        const gidx = (e.id * 47 + e.name.length * 13) % 1000;
        return {
          lat: (gidx % 18) * 10 - 85,
          lon: ((gidx * 13) % 360) - 180,
          hot: Math.min(1, (e.memCount || 0) / 8 + 0.2),
          col: CAT_COL[e.category] || [150, 170, 220],
        };
      });
    }
    function drawGlobe(ts) {
      if (!gx) return;
      gx.clearRect(0, 0, gW, gH);
      const cx = gW / 2, cy = gH / 2, R = Math.min(gW, gH) * 0.44;
      globeRot += 0.008;
      /* 纬线 */
      gx.strokeStyle = 'rgba(120,160,220,.30)';
      gx.lineWidth = 1;
      for (let i = 0; i <= 6; i++) {
        const lat = (i - 3) * 30;
        const rr = Math.cos(lat * Math.PI / 180) * R;
        const yy = cy - Math.sin(lat * Math.PI / 180) * R;
        gx.beginPath(); gx.ellipse(cx, yy, Math.abs(rr), Math.abs(rr) * 0.38, 0, 0, 6.2832); gx.stroke();
      }
      /* 经线（旋转）*/
      for (let i = 0; i < 10; i++) {
        const lon = (i / 10) * 360 + globeRot * 57.3;
        gx.beginPath();
        for (let k = 0; k <= 32; k++) {
          const lat = (k / 32) * 180 - 90;
          const th = lat * Math.PI / 180, ph = lon * Math.PI / 180;
          const x = cx + Math.cos(ph) * Math.cos(th) * R;
          const y = cy - Math.sin(th) * R;
          k ? gx.lineTo(x, y) : gx.moveTo(x, y);
        }
        gx.stroke();
      }
      /* 实体光点 */
      if (!globePts.length && window.__starData) refreshGlobePts();
      for (const p of globePts) {
        const ph = p.lon * Math.PI / 180 + globeRot;
        const th = p.lat * Math.PI / 180;
        const px = cx + Math.cos(ph) * Math.cos(th) * R;
        const py = cy - Math.sin(th) * R;
        if (Math.cos(ph) < -0.1) continue;
        const hot = p.hot * (0.6 + 0.4 * Math.sin(ts * 0.002 + p.lon));
        gx.beginPath();
        gx.arc(px, py, 1 + Math.min(3, hot * 1.8), 0, 6.2832);
        gx.fillStyle = 'rgba(' + p.col[0] + ',' + p.col[1] + ',' + p.col[2] + ',' + Math.min(1, hot).toFixed(3) + ')';
        gx.fill();
      }
      /* 发光外环 */
      gx.beginPath(); gx.arc(cx, cy, R + 2, 0, 6.2832);
      gx.strokeStyle = 'rgba(63,208,255,.5)';
      gx.lineWidth = 1.4; gx.stroke();
    }

    /* ── 雷达 ── */
    const rc = document.getElementById('radar');
    const radarStat = document.getElementById('radar-stat');
    let rx = null; let rW = 0, rH = 0;
    if (rc) {
      rW = rc.clientWidth || 180;
      rH = rc.clientHeight || 110;
      rx = resizeTo(rc, rW, rH);
    }
    let sweep = 0;
    const blips = [];
    function drawRadar(ts, energy) {
      if (!rx) return;
      rx.clearRect(0, 0, rW, rH);
      const cx = rW / 2, cy = rH / 2, R = Math.min(rW, rH) * 0.42;
      sweep += 0.02 + energy * 0.012;
      /* 圈 + 十字 */
      rx.strokeStyle = 'rgba(100,150,210,.22)'; rx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) { rx.beginPath(); rx.arc(cx, cy, R * i / 3, 0, 6.2832); rx.stroke(); }
      rx.beginPath();
      rx.moveTo(cx - R, cy); rx.lineTo(cx + R, cy);
      rx.moveTo(cx, cy - R); rx.lineTo(cx, cy + R);
      rx.stroke();
      /* 扫掠扇形 */
      const a0 = sweep;
      rx.beginPath(); rx.moveTo(cx, cy);
      rx.arc(cx, cy, R, a0, a0 + 0.55);
      rx.closePath();
      rx.fillStyle = 'rgba(63,208,255,.09)'; rx.fill();
      rx.beginPath(); rx.moveTo(cx, cy);
      rx.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
      rx.strokeStyle = 'rgba(63,208,255,.55)'; rx.lineWidth = 1.2; rx.stroke();
      /* 声波触发新亮点 */
      if (Math.random() < 0.02 + energy * 0.12) {
        blips.push({ a: Math.random() * 6.2832, r: R * (0.2 + Math.random() * 0.7),
          life: 1, sz: 1.5 + Math.random() * 2 });
      }
      for (let i = blips.length - 1; i >= 0; i--) {
        const b = blips[i];
        b.life -= 0.02;
        if (b.life <= 0) { blips.splice(i, 1); continue; }
        const bx = cx + Math.cos(b.a) * b.r, by = cy + Math.sin(b.a) * b.r;
        rx.beginPath(); rx.arc(bx, by, b.sz * b.life, 0, 6.2832);
        rx.fillStyle = 'rgba(63,208,255,' + (b.life * 0.8).toFixed(3) + ')';
        rx.fill();
      }
      if (radarStat) {
        const sd = window.__starData;
        if (sd && sd.entities && sd.entities.length) {
          radarStat.textContent = sd.entities.length + ' 节点';
        } else if (!sd) {
          radarStat.textContent = '…';
        }
      }
    }

    /* ── 活跃度折线图 ── */
    const sc = document.getElementById('spark');
    const sparkStat = document.getElementById('spark-stat');
    let sx = null; let sW = 0, sH = 0;
    if (sc) {
      sW = sc.clientWidth || 180;
      sH = sc.clientHeight || 90;
      sx = resizeTo(sc, sW, sH);
    }
    const HST = 90;
    let hist = new Array(HST).fill(0.12);
    function drawSpark(energy) {
      if (!sx) return;
      hist.push(energy); if (hist.length > HST) hist.shift();
      if (sparkStat) {
        sparkStat.textContent = (energy >= 0.9 ? '高活跃' : energy > 0.3 ? '聆听中' : '待机');
      }
      sx.clearRect(0, 0, sW, sH);
      const pad = 3, w = sW - pad * 2, h = sH - pad * 2;
      const col = energy >= 0.9 ? [63,212,138] : energy > 0.3 ? [255,159,28] : [63,208,255];
      sx.beginPath();
      hist.forEach((v, i) => {
        const x = pad + (i / (HST - 1)) * w;
        const y = pad + h - Math.min(1, v / 1.05) * h;
        i ? sx.lineTo(x, y) : sx.moveTo(x, y);
      });
      sx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.9)';
      sx.lineWidth = 1.6; sx.stroke();
      sx.lineTo(pad + w, pad + h); sx.lineTo(pad, pad + h); sx.closePath();
      sx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.12)';
      sx.fill();
      const lx = pad + ((hist.length - 1) / (HST - 1)) * w;
      const ly = pad + h - Math.min(1, energy / 1.05) * h;
      sx.beginPath(); sx.arc(lx, ly, 2.4, 0, 6.2832);
      sx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)';
      sx.fill();
    }

    /* ── 总循环（读真实 amp，不模拟）── */
    if (fx || gx || rx || sx) {
      let last = performance.now();
      // 纯渲染体：一帧只画四个视口，不负责排帧
      function renderFx(ts) {
        const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
        last = ts;
        let energy = amp;
        let key = fxStateEl ? (fxStateEl.className.match(/st-(\w+)/) || [])[1] : 'idle';
        let col = STATE_COLOR[key] || STATE_COLOR.idle;

        if (fx) {
          fx.clearRect(0, 0, fW, fH);
          fx.globalCompositeOperation = 'lighter';
          updateParts(dt, energy, col);
          fx.globalCompositeOperation = 'source-over';
        }
        if (gx) drawGlobe(ts);
        if (rx) drawRadar(ts, energy);
        if (sx) drawSpark(energy);
      }
      // §4：prefers-reduced-motion 时画一帧静态终态即止；否则挂闸门，失焦/切后台全部停
      if (reduceMotion) renderFx(performance.now());
      else AnimGate.gatedLoop(renderFx);
    }
  })();

  /* ══════════════ 设置面板 ══════════════
   *
   * 存在的理由：用户在方舟后台换 Key 之后，改 .env 还不够 ——
   * 运行中的进程握着启动时读入的旧 Key，表现成"配置对了却连不上"。
   * 这里保存后后端会 llm.reload()，当场生效。
   *
   * 安全约束：
   *   · Key 只在提交时上行，界面永远只显示掩码，不回填明文
   *   · 留空 = 不修改，避免"想改模型名却把 Key 清空"
   *   · 后端限定只能写 .env 里那四个键，并先备份
   */
  (function settings() {
    const mask = document.getElementById('setmask');
    const btn = document.getElementById('btnSettings');
    if (!mask || !btn) return;

    const $s = id => document.getElementById(id);
    const msgEl = $s('setMsg');
    let presets = [];

    function msg(text, kind) {
      if (!msgEl) return;
      msgEl.textContent = text || '';
      msgEl.className = 'set-msg' + (kind ? ' ' + kind : '');
    }

    function open() {
      mask.classList.add('show');
      msg('');
      loadAll();
      setTimeout(() => { const k = $s('setKey'); if (k) k.focus(); }, 50);
    }
    function close() { mask.classList.remove('show'); }

    btn.addEventListener('click', open);
    const closeBtn = $s('setClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && mask.classList.contains('show')) close();
    });

    /* 标签页切换 */
    document.querySelectorAll('.st-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.st-tab').forEach(t => t.classList.remove('on'));
        document.querySelectorAll('.set-pane').forEach(p => p.classList.remove('on'));
        tab.classList.add('on');
        const pane = document.querySelector('.set-pane[data-pane="' + tab.dataset.tab + '"]');
        if (pane) pane.classList.add('on');
      });
    });

    async function loadAll() {
      try {
        const d = await (await fetch('/api/settings')).json();
        const c = d.llm || {};
        const now = $s('setKeyNow');
        if (now) {
          now.textContent = c.hasKey
            ? '当前已配置：' + c.keyMask + '　（留空则不修改）'
            : '⚠ 尚未配置 API Key，贾维斯无法对话。';
          now.style.color = c.hasKey ? '' : '#ff9b9b';
        }
        if ($s('setBase')) $s('setBase').value = c.baseUrl || '';
        if ($s('setModel')) $s('setModel').value = c.model || '';
        if ($s('setEmbed')) $s('setEmbed').value = c.embedModel || '';

        presets = d.presets || [];
        const sel = $s('setPreset');
        if (sel && sel.options.length <= 1) {
          presets.forEach((p, i) => {
            const o = document.createElement('option');
            o.value = String(i); o.textContent = p.name;
            sel.appendChild(o);
          });
        }
        renderAbout(d);
      } catch (e) { msg('读取设置失败：' + e.message, 'bad'); }

      /* 技能与任务并行拉，任一失败不影响另一个。
       * 侧栏面板与弹窗内容各自独立更新 —— 早先写成
       * `if (!box) return;` 挡在最前面，一旦弹窗节点缺失，
       * 侧栏就永远停在"读取中"，而且不报错，很难查。 */
      fetch('/api/tools').then(r => r.json()).then(d => {
        const list = d.tools || [];
        const box = $s('setTools');
        if (box) {
          box.innerHTML = '<div class="set-note" style="margin-bottom:8px">共 <b>'
            + d.count + '</b> 个工具</div>'
            + list.map(t => '<div class="set-row"><span class="nm">' + esc(t.name)
              + '</span><span class="ds">' + esc(t.description || '') + '</span></div>').join('');
        }
        /* 左栏工具面板也用同一份真实数据 */
        const side = $s('toolbox');
        if (side) {
          side.innerHTML = list.slice(0, 8).map(t =>
            '<div class="trow"><span class="dn">' + esc(t.name)
            + '</span><span class="st ok"></span></div>').join('')
            + '<div class="empty" style="text-align:left;padding:6px 2px 0">共 '
            + d.count + ' 个工具 · 本轮调用 ' + (d.calledThisRound || 0) + ' 次</div>';
        }
      }).catch(e => {
        /* 不吞异常：静默 catch 会让面板永远停在"读取中"，
           看起来像在加载，其实早就失败了。 */
        const side = $s('toolbox');
        if (side) side.innerHTML = '<div class="empty">工具列表读取失败：' + esc(e.message) + '</div>';
        const box = $s('setTools');
        if (box) box.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
      });

      fetch('/api/tasks').then(r => r.json()).then(d => {
        const rows = (d.tasks || []).map(t =>
          '<div class="set-row"><span class="ds" style="color:var(--dim)">' + esc(t.label)
          + '</span><span class="tag ' + (t.ready ? 'tag-ok' : 'tag-cd') + '">'
          + (t.ready ? '就绪' : '冷却 ' + fmtSec(t.readyInSec)) + '</span></div>').join('');
        const box = $s('setTasks');
        if (box) box.innerHTML = rows || '<div class="empty">暂无任务</div>';
        const side = $s('taskbox');
        if (side) {
          const waiting = (d.tasks || []).filter(t => !t.ready);
          side.innerHTML = (d.tasks || []).slice(0, 5).map(t =>
            '<div class="set-row" style="background:none;padding:3px 0"><span class="ds">'
            + esc(t.label) + '</span><span class="tag ' + (t.ready ? 'tag-ok' : 'tag-cd')
            + '">' + (t.ready ? '就绪' : fmtSec(t.readyInSec)) + '</span></div>').join('')
            + '<div class="empty" style="text-align:left;padding:5px 2px 0">'
            + (d.tasks || []).length + ' 项 · ' + waiting.length + ' 项冷却中</div>';
        }
      }).catch(e => {
        const side = $s('taskbox');
        if (side) side.innerHTML = '<div class="empty">任务状态读取失败：' + esc(e.message) + '</div>';
        const box = $s('setTasks');
        if (box) box.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
      });
    }

    function renderAbout(d) {
      const box = $s('setAbout');
      if (!box) return;
      const c = d.llm || {};
      const rows = [
        ['当前模型', c.model || '—'],
        ['接口地址', c.baseUrl || '—'],
        ['向量模型', c.embedModel || '（未配置）'],
        ['工具数量', (d.toolCount != null ? d.toolCount : '—') + ' 个'],
        ['唤醒词', (d.voice && d.voice.wakeWords || []).join('、') || '—'],
      ];
      box.innerHTML = rows.map(r =>
        '<div class="set-row"><span class="ds" style="color:var(--dim);flex:0 0 78px">'
        + r[0] + '</span><span class="ds" style="color:var(--txt)">' + esc(String(r[1]))
        + '</span></div>').join('');
    }

    function fmtSec(s) {
      s = Number(s) || 0;
      if (s < 60) return s + ' 秒';
      if (s < 3600) return Math.round(s / 60) + ' 分';
      return (s / 3600).toFixed(1) + ' 小时';
    }
    function esc(t) {
      return String(t == null ? '' : t).replace(/[&<>"]/g,
        m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
    }

    /* 预设填充：只改地址与模型名，绝不动 Key */
    const sel = $s('setPreset');
    if (sel) sel.addEventListener('change', () => {
      const p = presets[Number(sel.value)];
      const note = $s('setPresetNote');
      if (!p) { if (note) note.textContent = ''; return; }
      if ($s('setBase')) $s('setBase').value = p.baseUrl || '';
      if ($s('setModel')) $s('setModel').value = p.model || '';
      if ($s('setEmbed')) $s('setEmbed').value = p.embedModel || '';
      if (note) note.textContent = p.note || '';
      msg('已填入模板，请确认后保存。API Key 不会被模板改动。', 'wait');
    });

    /* 保存 */
    const saveBtn = $s('setSave');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const payload = {};
      const key = ($s('setKey') || {}).value || '';
      if (key.trim()) payload.ARK_API_KEY = key.trim();
      const b = ($s('setBase') || {}).value || '';
      const m = ($s('setModel') || {}).value || '';
      const em = ($s('setEmbed') || {}).value || '';
      if (b.trim()) payload.ARK_BASE_URL = b.trim();
      if (m.trim()) payload.ARK_MODEL = m.trim();
      if (em.trim()) payload.ARK_EMBED_MODEL = em.trim();

      if (!Object.keys(payload).length) { msg('没有要保存的改动。', 'bad'); return; }

      saveBtn.disabled = true; msg('保存中…', 'wait');
      try {
        const r = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok || d.error) { msg('保存失败：' + (d.error || r.status), 'bad'); }
        else {
          msg('已保存并生效（无需重启）。模型：' + (d.applied && d.applied.model || '—'), 'ok');
          if ($s('setKey')) $s('setKey').value = '';   // 不在界面留存明文
          loadAll();
          if (typeof loadStatus === 'function') loadStatus();
        }
      } catch (e) { msg('保存失败：' + e.message, 'bad'); }
      finally { saveBtn.disabled = false; }
    });

    /* 测试连接：真打一次模型，如实回报 */
    const testBtn = $s('setTest');
    if (testBtn) testBtn.addEventListener('click', async () => {
      testBtn.disabled = true; msg('正在连接模型…（最长约 60 秒）', 'wait');
      try {
        const d = await (await fetch('/api/settings/test', { method: 'POST' })).json();
        if (d.ok) msg('✓ 连接正常 · ' + d.model + ' · 耗时 ' + d.ms + 'ms · 回复「' + d.reply + '」', 'ok');
        else msg('✗ 连接失败：' + (d.reason || '未知原因'), 'bad');
      } catch (e) { msg('✗ 测试失败：' + e.message, 'bad'); }
      finally { testBtn.disabled = false; }
    });

    /* 首屏也填一次左栏的工具/任务面板，不必等用户打开设置 */
    loadAll();

    /* 便于排查：访问 /#settings 直接打开设置页 */
    if (location.hash === '#settings') open();
  })();
})();
