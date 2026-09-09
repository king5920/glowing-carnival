/**
 * app.js —— 前端逻辑：SSE 对话 + 星图联动
 * 诚实标注：本文件里所有显示的数字都来自后端真实数据，无硬编码假值。
 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
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

  function setState(s) {
    stateEl.textContent = s.toUpperCase();
    if (window.STAR) STAR.setState(s);
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

  /* ── 顶栏波形（说话时活跃） ── */
  const wc = $('#wave'), wx = wc.getContext('2d');
  wc.width = 52 * 2; wc.height = 14 * 2; wx.scale(2, 2);
  let amp = 0.12, wt = 0;
  (function wave() {
    requestAnimationFrame(wave);
    wt += 0.08;
    wx.clearRect(0, 0, 52, 14);
    wx.strokeStyle = 'rgba(255,159,28,.85)'; wx.lineWidth = 1;
    wx.beginPath();
    for (let x = 0; x < 52; x++) {
      const y = 7 + Math.sin(x * 0.42 + wt) * 5 * amp * (0.6 + 0.4 * Math.sin(x * 0.13 + wt * 0.7));
      x ? wx.lineTo(x, y) : wx.moveTo(x, y);
    }
    wx.stroke();
  })();

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
        const el = document.getElementById('mesh');
        if (el) el.textContent = `CLUSTER · ${s.nodes}节点 ${s.edges}边`;
      }
    } catch (e) { /* 静默 */ }
  }

  async function loadStatus() {
    try {
      const d = await (await fetch('/api/status')).json();
      const u = d.usage || {};
      metaEl.textContent = `${d.model} · ${d.counts.memories} 记忆 · ${u.calls || 0} 次调用 · ${(u.promptTokens || 0) + (u.completionTokens || 0)} tokens`;
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
    } catch (e) { /* 静默 */ }
  }

  async function loadHistory() {
    try {
      const d = await (await fetch('/api/history')).json();
      (d.messages || []).forEach(m => {
        if (m.role === 'user') bubble('u', m.content);
        else if (m.role === 'assistant') bubble('a', m.content, 'JARVIS');
      });
    } catch (e) { /* 静默 */ }
  }

  /* ── 发送 ── */
  let busy = false;
  async function submit() {
    const text = inp.value.trim();
    if (!text || busy) return;
    busy = true; send.disabled = true; inp.value = '';
    bubble('u', text);
    setState('listen');
    recEl.innerHTML = '<div class="empty">检索中…</div>';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
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
      bubble('e', '请求失败：' + e.message);
      setState('alert');
    }
    busy = false; send.disabled = false; inp.focus();
  }

  function handle(ev, d) {
    if (ev === 'state') { setState(d.state); amp = d.state === 'speak' ? 1 : 0.12; }
    else if (ev === 'recall') {
      const hits = d.hits || [];
      if (!hits.length) { recEl.innerHTML = '<div class="empty">本轮无相关记忆</div>'; return; }
      recEl.innerHTML = hits.map(h => `
        <div class="it hot">${h.content}
          <div class="meta">${GAL_CN[h.category] || h.category}${h.entity ? ' · ' + h.entity : ''} · 分 ${h.score}</div>
        </div>`).join('');
      // 真实命中 → 点亮星图节点（优先按记忆 id，精确到单条记忆）
      hits.forEach(h => {
        if (!window.STAR) return;
        if (h.id != null) STAR.activateMemory(h.id, 1.0);
        if (h.entity) STAR.activate(h.entity, 0.9);
      });
    }
    else if (ev === 'reply') { bubble('a', d.text, 'JARVIS'); amp = 0.12; speak(d.text); }
    /* 工具调用：显示"正在查…"，拿到结果后原地更新成结论。
     * 不用新气泡，避免一次对话里刷出好几条噪音。 */
    else if (ev === 'tool_call') {
      const el = bubble('t', TOOL_CN[d.name] || d.name, '调用工具');
      el.dataset.toolId = d.id;
      const argStr = fmtToolArgs(d.name, d.args);
      if (argStr) el.appendChild(Object.assign(document.createElement('div'),
        { className: 'targs', textContent: argStr }));
      toolEls[d.id] = el;
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
        bubble('a', '已记住 ' + ms.length + ' 条：\n' + ms.map(m => '· ' + m.content).join('\n'), '新记忆');
        loadStarmap();      // 星图重建，新星出现
      }
    }
    else if (ev === 'error') { bubble('e', '出错：' + d.error); setState('alert'); }
    else if (ev === 'done') {
      const u = d.usage || {};
      metaEl.textContent = `${d.counts.memories} 记忆 · ${d.counts.entities} 实体 · ${u.calls || 0} 次调用 · ${(u.promptTokens || 0) + (u.completionTokens || 0)} tokens`;
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
  }

  async function loadSources() {
    try {
      const r = await fetch('/api/health/sources');
      if (!r.ok) return;
      renderSources(await r.json());
    } catch (_) { /* 静默：健康灯本身不该导致界面报错 */ }
  }

  loadSources();
  // 5 分钟刷一次。读的是已记录状态，不产生真实请求，所以频率无成本
  setInterval(loadSources, 5 * 60 * 1000);

  /* ════════════════════════════════════════════════
     主动意识联动（/api/mind SSE 长连接）
     ════════════════════════════════════════════════ */

  const mindBox = $('#mindbox'), moodEl = $('#mood'), doingEl = $('#doing');

  // 五轴定义：双极轴范围 -1~1，单极轴 0~1
  const AXES = [
    { k: '警觉', bipolar: false, hi: '#4f8cff' },
    { k: '从容', bipolar: true,  hi: '#8f7fff' },
    { k: '心境', bipolar: true,  hi: '#3fd48a' },
    { k: '唤醒', bipolar: true,  hi: '#ff9f1c' },
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
  function showDoing(text) {
    if (!doingEl) return;
    doingEl.textContent = text;
    doingEl.classList.add('on');
    clearTimeout(showDoing._t);
    showDoing._t = setTimeout(() => doingEl.classList.remove('on'), 6000);
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
      const el = bubble('a pro', d.text, label);
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
  let audio = null;               // 当前播放的音频，用于打断

  /* 唤醒后多久没说话就回到"只听唤醒词"状态。
     太短会来不及说指令，太长会把无关对话当成指令。 */
  /* 唤醒后多久没说话就回到"只听唤醒词"状态。
   *
   * ⚠ 必须和服务端的 CONVO_WINDOW_MS（30 秒）对齐。
   * 原来这里是 8 秒 —— 服务端窗口还开着，前端按钮已经变灰，
   * 用户会以为"又要重新喊唤醒词了"，于是重复喊，反而更乱。
   * 真正的门禁在服务端，这里只是显示状态，但显示错了一样误导人。 */
  const AWAKE_WINDOW_MS = 30000;

  function syncBtns() {
    spkBtn.classList.toggle('on', speakOn);
    micBtn.classList.toggle('on', micOn && !awake);
    micBtn.classList.toggle('awake', awake);
    micBtn.title = !micOn ? '语音输入（点击开启常听）'
      : awake ? '已唤醒，请说指令…'
      : '常听中 · 说「贾维斯」唤醒';
  }

  /** 朗读一段文本。会打断上一句，避免多句叠着念。 */
  async function speak(text) {
    if (!speakOn || !text) return;
    stopSpeaking();
    try {
      audio = new Audio('/api/voice/speak?text=' + encodeURIComponent(text));
      /* ══ 必须告知服务端"正在朗读" ══
       * 打断功能完全依赖这个状态：服务端要知道喇叭在响，
       * 才能把唤醒词判定成**打断**而不是新一轮对话。
       * 不上报的话打断就是死代码。 */
      reportSpeaking(true);
      audio.addEventListener('ended', () => reportSpeaking(false));
      audio.addEventListener('error', () => reportSpeaking(false));
      audio.play().catch(() => { reportSpeaking(false); });
    } catch (_) { reportSpeaking(false); }
  }

  function stopSpeaking() {
    if (audio) { try { audio.pause(); } catch (_) {} audio = null; }
    reportSpeaking(false);
  }

  /* 朗读状态上报。用 fire-and-forget —— 这是辅助信号，
   * 失败了不该影响朗读本身，所以不 await 也不报错。 */
  let _lastSpeakingReport = null;
  function reportSpeaking(on) {
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
    syncBtns();
    showDoing('贾维斯在听…');
    if (awakeTimer) clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => { awake = false; syncBtns(); }, AWAKE_WINDOW_MS);
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

    // 唤醒词命中 → 进入"等指令"状态
    voiceES.addEventListener('voice_wake', e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      stopSpeaking();          // 用户开口就停止朗读，别抢话
      enterAwake();
    });

    /* ── 打断（barge-in）──
     * 服务端判定「朗读中被唤醒 / 被说话截住」时推这个事件。
     * 必须立刻停播 —— 喇叭还在响的话麦克风会收到自己的声音，
     * 变成自问自答。这是调研外部项目时发现我们缺的核心体验之一。 */
    voiceES.addEventListener('voice_interrupt', () => {
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
        if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
        syncBtns();
        showDoing('贾维斯对话结束');
      }
    });

    /* ── 没听清 ──
     * 置信度太低，服务端没发给模型。
     * 显示出来比完全没反应好 —— 让用户知道麦克风活着，只是没听懂。 */
    voiceES.addEventListener('voice_unclear', () => {
      showDoing('贾维斯没听清…');
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
      awake = false;
      if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
      syncBtns();
      inp.value = t;
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

  graphEl.addEventListener('click', (ev) => {
    if (!window.STAR || !STAR.pick) return;
    const rect = graphEl.getBoundingClientRect();
    const hit = STAR.pick(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!hit || hit.memId == null) { hideCard(); return; }
    STAR.select(hit.nodeIndex);
    showMemoryCard(hit.memId, ev.clientX, ev.clientY);
  });

  // 点空白处关卡片；Esc 也关
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCard(); });

  loadHistory(); loadStarmap(); loadStatus();
  connectMind();
  inp.focus();
})();
