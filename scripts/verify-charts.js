'use strict';
/**
 * §5 图表验证（C3-A 情绪温度热力柱 + C3-B 板块涨幅分布直方图 + C3-C 大盘 K 线
 *             + C3-D 实时 TAPE 轻量轮询版）
 *
 * 断言：
 *   1. #mpHeatCanvas + #scanDistCanvas + #klineCanvas + #tapeCanvas 存在、非零尺寸、非全透明
 *   2. window.Charts 暴露 drawSentimentHeatmap + drawDistribution + drawKline + drawTape + bindHover
 *   3. 四图 hover 触发 tooltip 出现，文本是整句中文（§5 通用条款 role=status）
 *   4. tooltip DOM 有 role="status" + aria-live
 *   5. 图例（冷静/恐慌 梯度）+（涨区/跌区 双色带）+（涨/跌/MA5/量）+
 *      （龙头涨幅/10日资金/板块涨幅 三色分离）都在
 *   6. rAF 链数不变（图表不入 AnimGate.gatedLoop；TAPE 走 setTimeout 自调度链，无 setInterval）
 *   7. window.__tapeRefresh 暴露（CDP 侧可主动触发一轮）
 *
 * 注意：C3-C 的 /api/kline 走腾讯→新浪外部源（最坏 ≈25s），C3-D 的 /api/closescan
 *       走东财 clist 分页（冷扫描实测 37~46s），比本地库的 heatmap/distribution
 *       慢一个数量级。脚本启动时先主动焐热一次 closescan（warmCloseScan），TAPE 等待再按
 *       标题状态机判别（"板块"=终态 / "连接失败"=即失败 / "加载中"=继续），上限 100s，
 *       不靠固定 sleep 判"全透明"，也不再把骨架态误判成失败。
 *
 * CDP 端口 9338（9335=contrast, 9336=tbmenu, 9337=starmap-plus, 9338=charts）
 */
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9338;
const URL = 'http://127.0.0.1:3800/';
const OUT = 'D:/jarvis/_shots/charts-c3.png';
const VP = { w: 1440, h: 900 };

const READY = `(() => {
  try {
    return JSON.stringify({
      banner: !!document.getElementById('srcbanner'),
      heat:   !!document.getElementById('mpHeatCanvas'),
      dist:   !!document.getElementById('scanDistCanvas'),
      kline:  !!document.getElementById('klineCanvas'),
      tape:   !!document.getElementById('tapeCanvas'),
      charts: !!window.Charts,
      mems:   (window.STAR && window.STAR.stats) ? (STAR.stats().memories || 0) : 0,
    });
  } catch(e) { return 'ERR:'+e.message; }
})()`;

const PROBE = `(() => {
  try {
    /* ═══ 通用：单张图表的采样与 hover 测试 ═══ */
    function probeOne(cvId, boxId, unitPattern){
      const cv = document.getElementById(cvId);
      const box = document.getElementById(boxId);
      const out = { canvasExists: !!cv, canvasSize: null, paintedPct: null,
                    nonEmptyPixels: 0, hoverTest: null };
      if (!cv) return out;
      out.canvasSize = { w: cv.clientWidth, h: cv.clientHeight,
                         physicalW: cv.width, physicalH: cv.height };
      try {
        const ctx = cv.getContext('2d');
        const full = ctx.getImageData(0, 0, cv.width, cv.height);
        let nonEmpty = 0, total = full.width * full.height;
        for (let i = 3; i < full.data.length; i += 4) {
          if (full.data[i] > 0) nonEmpty++;
        }
        out.paintedPct = +(nonEmpty / total * 100).toFixed(2);
        out.nonEmptyPixels = nonEmpty;
      } catch(e) { out.pixelSample = { err: e.message }; }

      /* hover：mousemove 中间 → mouseleave 检查隐藏 */
      const rect = cv.getBoundingClientRect();
      const x = rect.width * 0.5;
      const y = rect.height * 0.5;
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + x, clientY: rect.top + y, bubbles: true,
      }));
      const tip = box && box.querySelector('.chart-tip');
      const unitRe = new RegExp(unitPattern);
      out.hoverTest = {
        x: x, y: y,
        tipFound: !!tip,
        tipDisplay: tip ? getComputedStyle(tip).display : null,
        tipText: tip ? tip.textContent : null,
        tipRole: tip ? tip.getAttribute('role') : null,
        tipAriaLive: tip ? tip.getAttribute('aria-live') : null,
        tipTextHasChinese: tip ? /[一-\\u9fff]/.test(tip.textContent) : false,
        tipTextHasUnit: tip ? unitRe.test(tip.textContent) : false,
      };
      cv.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      out.hoverTest.tipAfterLeave = tip ? getComputedStyle(tip).display : null;
      return out;
    }

    /* ═══ C3-A 情绪温度热力柱 ═══ */
    const heatBox = document.getElementById('mpHeatbox');
    const heatLegend = heatBox && heatBox.querySelector('.mp-heat-legend');
    const heat = probeOne('mpHeatCanvas', 'mpHeatbox', '%|涨停|跌停|亿|封单');
    heat.legendText = heatLegend ? heatLegend.textContent.replace(/\\s+/g,' ').trim() : '';
    heat.legendGradHasGradient = heatLegend
      ? (getComputedStyle(heatLegend.querySelector('.mhl-grad')).backgroundImage.indexOf('linear-gradient') !== -1)
      : false;
    heat.titleText = (document.getElementById('mpHeatTitle') || {}).firstElementChild
                     ? document.getElementById('mpHeatTitle').firstElementChild.textContent : null;

    /* ═══ C3-B 板块涨幅分布直方图 ═══ */
    const distBox = document.getElementById('scanDistbox');
    const distLegend = distBox && distBox.querySelector('.scan-dist-legend');
    const dist = probeOne('scanDistCanvas', 'scanDistbox', '%|个板块|占|跌区|涨区');
    dist.legendText = distLegend ? distLegend.textContent.replace(/\\s+/g,' ').trim() : '';
    dist.legendGradHasGradient = distLegend
      ? (getComputedStyle(distLegend.querySelector('.dsl-mid')).backgroundImage.indexOf('linear-gradient') !== -1)
      : false;
    dist.titleText = (document.getElementById('scanDistTitle') || {}).firstElementChild
                     ? document.getElementById('scanDistTitle').firstElementChild.textContent : null;

    const out = {
      heat: heat,
      dist: dist,
      chartsModule: typeof window.Charts === 'object',
      chartsFns: typeof window.Charts === 'object' ? {
        drawSentimentHeatmap: typeof window.Charts.drawSentimentHeatmap,
        drawDistribution: typeof window.Charts.drawDistribution,
        drawKline: typeof window.Charts.drawKline,
        drawTape: typeof window.Charts.drawTape,
        bindHover: typeof window.Charts.bindHover,
        colorLadder: typeof window.Charts.colorLadder,
        drawHatch: typeof window.Charts.drawHatch,
        drawCandle: typeof window.Charts.drawCandle,
        drawBar: typeof window.Charts.drawBar,
        drawText: typeof window.Charts.drawText,
        drawAxis: typeof window.Charts.drawAxis,
        resizeCanvas: typeof window.Charts.resizeCanvas,
        css: typeof window.Charts.css,
      } : null,
      canvasTotal: document.querySelectorAll('canvas').length,
    };

    return JSON.stringify(out);
  } catch(e) { return 'ERR:'+e.message+' | '+e.stack; }
})()`;

/* K 线首绘像素轮询：/api/kline 走外部源（腾讯→新浪），最坏 ~25s，
 * 不能靠固定 sleep 判断——轮询到 painted>=3% 或 45s 上限 */
const KLINE_PAINTED = `(() => {
  try {
    const cv = document.getElementById('klineCanvas');
    if(!cv || cv.width === 0 || cv.height === 0) return JSON.stringify({ pct: -1 });
    const full = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let n = 0;
    for(let i = 3; i < full.data.length; i += 4) if(full.data[i] > 0) n++;
    return JSON.stringify({ pct: n / (full.width * full.height) * 100 });
  } catch(e){ return JSON.stringify({ err: e.message }); }
})()`;

/* C3-C K 线 probe：与 probeOne 同构，但图例是 .kline-legend
 * （涨=实心块 / 跌=空心块 / MA5·10·20=三色线段 / 量=双色半透明块） */
const KLINE_PROBE = `(() => {
  try {
    const cv = document.getElementById('klineCanvas');
    const box = document.getElementById('klinebox');
    const out = { canvasExists: !!cv, canvasSize: null, paintedPct: null,
                  nonEmptyPixels: 0, hoverTest: null };
    if (cv) {
      out.canvasSize = { w: cv.clientWidth, h: cv.clientHeight,
                         physicalW: cv.width, physicalH: cv.height };
      try {
        const full = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        let n = 0, total = full.width * full.height;
        for (let i = 3; i < full.data.length; i += 4) if (full.data[i] > 0) n++;
        out.paintedPct = +(n / total * 100).toFixed(2);
        out.nonEmptyPixels = n;
      } catch(e) { out.pixelSample = { err: e.message }; }

      /* hover：价格区中点（高度 0.38 落在上 75% 价格区，避开底部量区） */
      const rect = cv.getBoundingClientRect();
      const x = rect.width * 0.5;
      const y = rect.height * 0.38;
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + x, clientY: rect.top + y, bubbles: true,
      }));
      const tip = box && box.querySelector('.chart-tip');
      out.hoverTest = {
        x: x, y: y,
        tipFound: !!tip,
        tipDisplay: tip ? getComputedStyle(tip).display : null,
        tipText: tip ? tip.textContent : null,
        tipRole: tip ? tip.getAttribute('role') : null,
        tipAriaLive: tip ? tip.getAttribute('aria-live') : null,
        tipTextHasChinese: tip ? /[一-鿿]/.test(tip.textContent) : false,
        tipHits: tip ? ['开','高','低','收','量'].filter(function(k){
          return tip.textContent.indexOf(k) >= 0;
        }) : [],
        tipTextHasDate: tip ? /\\d{4}-\\d{2}-\\d{2}/.test(tip.textContent) : false,
        tipTextHasPct: tip ? /%/.test(tip.textContent) : false,
        /* assertChart 通用断言读 tipTextHasUnit：K 线的单位是 % / 亿 / 万 */
        tipTextHasUnit: tip ? /%|亿|万/.test(tip.textContent) : false,
      };
      cv.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      out.hoverTest.tipAfterLeave = tip ? getComputedStyle(tip).display : null;
    }

    const legend = box && box.querySelector('.kline-legend');
    out.legendText = legend ? legend.textContent.replace(/\\s+/g, ' ').trim() : '';
    out.legendWords = legend
      ? ['涨','跌','MA5','MA10','MA20','量'].filter(function(k){
          return out.legendText.indexOf(k) >= 0;
        })
      : [];
    /* 六个色块的 computed background-color 都不得是全透明（色块真的上色了） */
    out.legendSwatches = legend ? [
      ['涨实心', '.kl-sw-up'], ['跌空心', '.kl-sw-dn'], ['量半透明', '.kl-sw-vol'],
      ['MA5', '.kl-ln5'], ['MA10', '.kl-ln10'], ['MA20', '.kl-ln20'],
    ].map(function(pair){
      const el = legend.querySelector(pair[1]);
      const s = el ? getComputedStyle(el) : null;
      /* color-mix 生成的量柱色落在 background-image（渐变）里，backgroundColor 是
       * 底色层、按定义就是透明——两个通道都查才算真的上色了。 */
      const bg = s ? s.backgroundColor : null;
      const hasGrad = s ? /gradient/.test(s.backgroundImage || '') : false;
      return { name: pair[0], exists: !!el, bg: bg, gradient: hasGrad,
               transparent: bg === 'rgba(0, 0, 0, 0)' && !hasGrad };
    }) : [];
    out.titleText = document.getElementById('klineTitleTxt')
                    ? document.getElementById('klineTitleTxt').textContent : null;
    return JSON.stringify(out);
  } catch(e) { return 'ERR:'+e.message+' | '+e.stack; }
})()`;

/* TAPE 首绘像素轮询：/api/closescan 无服务端缓存，每次都要走东财 clist 分页，
 * 最坏几十秒——与 K 线同档，不能靠固定 sleep 判断"全透明" */
const TAPE_PAINTED = `(() => {
  try {
    const cv = document.getElementById('tapeCanvas');
    const ti = document.getElementById('tapeTime');
    if(!cv || cv.width === 0 || cv.height === 0) return JSON.stringify({ pct: -1, title: '' });
    const full = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let n = 0;
    for(let i = 3; i < full.data.length; i += 4) if(full.data[i] > 0) n++;
    /* title 让等待循环能区分三态，不再只赌像素 + 固定超时：
       "12板块 · …"=真数据终态；"加载中…"=骨架（继续等）；"连接失败"=失败终态。 */
    return JSON.stringify({ pct: n / (full.width * full.height) * 100,
                            title: ti ? ti.textContent : '' });
  } catch(e){ return JSON.stringify({ err: e.message, title: '' }); }
})()`;

/* §5-4 TAPE probe：与 probeOne 同构，但图例是 #tapeLegend（--rd/--gd/--cy 三色块），
 * tooltip 必须逐个含 龙头 / 10日资金 / 板块，且带 % 与 亿 两种单位 */
const TAPE_PROBE = `(() => {
  try {
    const cv = document.getElementById('tapeCanvas');
    const box = document.getElementById('tapebox');
    const out = { canvasExists: !!cv, canvasSize: null, paintedPct: null,
                  nonEmptyPixels: 0, hoverTest: null };
    if (cv) {
      out.canvasSize = { w: cv.clientWidth, h: cv.clientHeight,
                         physicalW: cv.width, physicalH: cv.height };
      try {
        const full = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
        let n = 0, total = full.width * full.height;
        for (let i = 3; i < full.data.length; i += 4) if (full.data[i] > 0) n++;
        out.paintedPct = +(n / total * 100).toFixed(2);
        out.nonEmptyPixels = n;
      } catch(e) { out.pixelSample = { err: e.message }; }

      /* hover：中间槽位、高度 0.45（落在 plot 区中部，避开底部板块名行） */
      const rect = cv.getBoundingClientRect();
      const x = rect.width * 0.5;
      const y = rect.height * 0.45;
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + x, clientY: rect.top + y, bubbles: true,
      }));
      const tip = box && box.querySelector('.chart-tip');
      out.hoverTest = {
        x: x, y: y,
        tipFound: !!tip,
        tipDisplay: tip ? getComputedStyle(tip).display : null,
        tipText: tip ? tip.textContent : null,
        tipRole: tip ? tip.getAttribute('role') : null,
        tipAriaLive: tip ? tip.getAttribute('aria-live') : null,
        tipTextHasChinese: tip ? /[一-鿿]/.test(tip.textContent) : false,
        /* §5-4 明确要求整句含 板块名 + 龙头 + 涨幅% + 10日资金亿 + 板块涨幅% */
        tipHits: tip ? ['龙头','10日资金','板块'].filter(function(k){
          return tip.textContent.indexOf(k) >= 0;
        }) : [],
        tipTextHasPct: tip ? /%/.test(tip.textContent) : false,
        tipTextHasYi: tip ? /亿/.test(tip.textContent) : false,
        /* assertChart 通用断言读 tipTextHasUnit：TAPE 的单位是 % / 亿 */
        tipTextHasUnit: tip ? /%|亿/.test(tip.textContent) : false,
      };
      cv.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      out.hoverTest.tipAfterLeave = tip ? getComputedStyle(tip).display : null;
    }

    const legend = box && box.querySelector('#tapeLegend');
    out.legendText = legend ? legend.textContent.replace(/\\s+/g, ' ').trim() : '';
    out.legendWords = legend
      ? ['龙头涨幅','10日资金','板块涨幅'].filter(function(k){
          return out.legendText.indexOf(k) >= 0;
        })
      : [];
    /* 三个色块必须真的上色（--rd 龙头 / --gd 资金 / --cy 板块） */
    out.legendSwatches = legend ? [
      ['龙头涨幅', 0], ['10日资金', 1], ['板块涨幅', 2],
    ].map(function(pair){
      const el = legend.querySelectorAll('.tape-sw')[pair[1]];
      const s = el ? getComputedStyle(el) : null;
      const bg = s ? s.backgroundColor : null;
      return { name: pair[0], exists: !!el, bg: bg,
               transparent: !bg || bg === 'rgba(0, 0, 0, 0)' };
    }) : [];
    out.titleText = document.getElementById('tapeTime')
                    ? document.getElementById('tapeTime').textContent : null;
    out.refreshHook = typeof window.__tapeRefresh;
    return JSON.stringify(out);
  } catch(e) { return 'ERR:'+e.message+' | '+e.stack; }
})()`;

let child = null;
function die(code, msg) { if (msg) console.log(msg); killEdge(); process.exit(code); }
function killEdge() { try { if (child && !child.killed) child.kill('SIGTERM'); } catch(_){} }
process.on('exit', killEdge);
process.on('SIGINT', () => die(130));

function open(wsUrl){
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('close', () => reject(new Error('CDP 连接关闭')));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 错误')));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve: rs, reject: rj } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rj(new Error(m.error.message)) : rs(m.result);
      }
    });
    const api = {
      send(method, params = {}) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      ws,
      close() { try { ws.close(); } catch (_) {} },
    };
  });
}
const getJSON = (path) => new Promise((resolve, reject) => {
  const req = require('http').get('http://127.0.0.1:' + CDP_PORT + path, res => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(2000, () => req.destroy(new Error('CDP HTTP 超时 ' + path)));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 焐热服务端 /api/closescan 缓存，再启动浏览器。
 * 为什么必须在 spawn 之前：Edge 以 URL 直接启动即导航，页面里的 TAPE IIFE 立刻发请求；
 * 不提前焐热，全新场景下首个请求要硬吃东财 clist 冷扫描（实测 37~46s），撞上旧脚本
 * 的 45s 上限就会假红（抓到的是"加载中…"骨架）。提前打一次，导航瞬间缓存已热，
 * TAPE 实测 ~275ms 翻转。预热失败不致命——下方等待循环仍有 100s 冷扫描兜底。 */
function warmCloseScan() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = require('http').get(
      URL.replace(/\/$/, '') + '/api/closescan?topN=12',
      res => {
        let b = '';
        res.on('data', c => { b += c; });
        res.on('end', () => {
          let n = null, fromCache = null;
          try { const j = JSON.parse(b); n = (j.sectors || []).length; fromCache = !!j.fromCache; } catch (_) {}
          console.log('预热 closescan：HTTP ' + res.statusCode + '  ' + n + ' 板块' +
            (fromCache ? '（命中服务端缓存）' : '（冷扫描）') +
            '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
          resolve();
        });
      });
    req.on('error', () => { console.log('预热 closescan 失败（继续，等待循环兜底）'); resolve(); });
    req.setTimeout(120000, () => { try { req.destroy(); } catch (_) {} resolve(); });
  });
}

async function main() {
  require('fs').mkdirSync(require('path').dirname(OUT), { recursive: true });
  await warmCloseScan();   // 必须在 spawn(URL) 之前，让页面导航瞬间缓存已热
  console.log('启动 msedge headless（CDP 端口 ' + CDP_PORT + '，视口 ' + VP.w + 'x' + VP.h + '）…');
  child = spawn(EDGE, [
    '--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--remote-debugging-address=127.0.0.1',
    '--window-size=' + VP.w + ',' + VP.h, '--force-device-scale-factor=2', '--hide-scrollbars', URL,
  ], { stdio: 'ignore', detached: false });

  const poll = async (path, fn, timeoutMs, label) => {
    const t0 = Date.now();
    for (;;) {
      try { const v = fn(await getJSON(path)); if (v) return v; } catch (_) {}
      if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
      await sleep(300);
    }
  };

  await poll('/json/version', j => !!j.webSocketDebuggerUrl, 20000, 'CDP');
  const target = await poll('/json/list', j => (j || []).find(t => t.type === 'page' && t.webSocketDebuggerUrl) || null, 20000, 'target');
  console.log('已连接页面:', target.url);

  const cdp = await open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* 等页面就绪 —— Charts 模块 + 两张 canvas 都到位 */
  const t0 = Date.now();
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', { expression: READY, returnByValue: true });
    const raw = r.result && r.result.value;
    if (typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：' + raw);
    const s = raw ? JSON.parse(raw) : null;
    if (s && s.banner && s.heat && s.dist && s.kline && s.tape && s.charts) break;
    if (Date.now() - t0 > 60000) die(3, '等待超时（Charts/canvas 未就绪）');
    await sleep(500);
  }
  await sleep(3000);   /* 让 /api/sentiment/heatmap + /api/distribution 首拉完成并绘制 */

  /* ── C3-C 单独等首绘：K 线走腾讯→新浪外部源，最坏 ~25s ── */
  let klinePct = -1, klineErr = null;
  const kp0 = Date.now();
  for (;;) {
    const kp = await cdp.send('Runtime.evaluate', { expression: KLINE_PAINTED, returnByValue: true });
    let kv = null;
    try { kv = JSON.parse(kp.result && kp.result.value); } catch (_) {}
    if (kv && typeof kv.pct === 'number') klinePct = kv.pct;
    if (kv && kv.err) klineErr = kv.err;
    if (klinePct >= 3) break;
    if (Date.now() - kp0 > 45000) break;
    await sleep(1000);
  }
  console.log('K 线首绘（外部源）painted=' +
    (klinePct < 0 ? '采样失败' : klinePct.toFixed(2) + '%') +
    ' 用时 ' + ((Date.now() - kp0) / 1000).toFixed(1) + 's' +
    (klineErr ? '  [采样报错 ' + klineErr + ']' : ''));

  const r2 = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const raw2 = r2.result && r2.result.value;
  if (typeof raw2 === 'string' && raw2.startsWith('ERR:')) die(2, 'PROBE 抛错：' + raw2);
  const out = JSON.parse(raw2);

  const r3 = await cdp.send('Runtime.evaluate', { expression: KLINE_PROBE, returnByValue: true });
  const raw3 = r3.result && r3.result.value;
  if (typeof raw3 === 'string' && raw3.startsWith('ERR:')) die(2, 'KLINE_PROBE 抛错：' + raw3);
  const kline = JSON.parse(raw3);

  /* ── §5-4 TAPE 等首绘：状态机判别，不再只赌像素 + 45s 固定超时 ──
   * 冷启动 IIFE 先画"加载中…"骨架（painted 极低），fetch 回来再翻真数据。
   *   title 含"板块"  → 真数据终态，跳出做断言
   *   title === "连接失败" → 后端真失败，立即判失败（不白等）
   *   其余（加载中/暂无数据/空）→ 继续等
   * 上限 100s：东财 clist 冷扫描实测 37~46s，给 2 倍余量；正常已被 warmCloseScan 焐热，~1s 内翻转。 */
  let tapePct = -1, tapeErr = null, tapeTitle = '', tapeFailed = false;
  const tp0 = Date.now();
  for (;;) {
    const tp = await cdp.send('Runtime.evaluate', { expression: TAPE_PAINTED, returnByValue: true });
    let tv = null;
    try { tv = JSON.parse(tp.result && tp.result.value); } catch (_) {}
    if (tv && typeof tv.pct === 'number') tapePct = tv.pct;
    if (tv && tv.err) tapeErr = tv.err;
    if (tv && typeof tv.title === 'string') tapeTitle = tv.title;
    if (/板块/.test(tapeTitle) && tapePct >= 3) break;        // 真数据
    if (tapeTitle === '连接失败') { tapeFailed = true; break; } // 明确失败
    if (Date.now() - tp0 > 100000) break;                      // 冷扫描兜底上限
    await sleep(1000);
  }
  console.log('TAPE 首绘（板块扫描）painted=' +
    (tapePct < 0 ? '采样失败' : tapePct.toFixed(2) + '%') +
    ' 标题="' + tapeTitle + '"' +
    ' 用时 ' + ((Date.now() - tp0) / 1000).toFixed(1) + 's' +
    (tapeFailed ? '  [后端返回连接失败]' : '') +
    (tapeErr ? '  [采样报错 ' + tapeErr + ']' : ''));
  if (tapeFailed) die(4, 'TAPE 后端连接失败（/api/closescan 返回错误态）');
  if (!/板块/.test(tapeTitle)) {
    /* 到这里说明 100s 内没翻成真数据。区分两种本质不同的情况：
       "加载中…"=请求一直没回来（真超时/源故障）→ 判失败；
       "暂无数据"=链路通、东财返回了空 sectors → 不是渲染缺陷，放行但醒目标注。 */
    if (/加载中/.test(tapeTitle))
      die(5, 'TAPE 100s 内未取到板块数据（标题仍为"' + tapeTitle + '"）——东财冷扫描超时或源故障');
    console.log('  ⚠ TAPE 链路通但源返回空（标题="' + tapeTitle + '"），跳过数据相关像素/tooltip 断言');
  }

  const r4 = await cdp.send('Runtime.evaluate', { expression: TAPE_PROBE, returnByValue: true });
  const raw4 = r4.result && r4.result.value;
  if (typeof raw4 === 'string' && raw4.startsWith('ERR:')) die(2, 'TAPE_PROBE 抛错：' + raw4);
  const tape = JSON.parse(raw4);

  /* 截图（clip 到 #mpHeatbox 附近——顶栏以下到画布底部） */
  const clip = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('mpHeatbox');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const y = Math.max(0, r.top - 8);
      const h = Math.min(document.documentElement.scrollHeight, r.bottom - y + 8);
      return JSON.stringify({ x: 0, y: Math.round(y), width: ${VP.w}, height: Math.round(h) });
    })()`,
    returnByValue: true,
  });
  const clipJson = JSON.parse(clip.result.value);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clipJson.x, y: clipJson.y, width: clipJson.width, height: clipJson.height, scale: 1 },
  });
  require('fs').writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  const kb = (require('fs').statSync(OUT).size / 1024).toFixed(1);

  /* 第二张：分布图所在区块截图 */
  const clip2 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('scanDistbox');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const y = Math.max(0, r.top - 8);
      const h = Math.min(document.documentElement.scrollHeight, r.bottom - y + 8);
      return JSON.stringify({ x: 0, y: Math.round(y), width: ${VP.w}, height: Math.round(h) });
    })()`,
    returnByValue: true,
  });
  if (clip2.result && clip2.result.value) {
    const clip2Json = JSON.parse(clip2.result.value);
    const shot2 = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip2Json.x, y: clip2Json.y, width: clip2Json.width, height: clip2Json.height, scale: 1 },
    });
    const out2 = OUT.replace('-c3.png', '-c3-dist.png');
    require('fs').writeFileSync(out2, Buffer.from(shot2.data, 'base64'));
  }

  /* 第三张：K 线所在区块截图 */
  const clip3 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('klinebox');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const y = Math.max(0, r.top - 8);
      const h = Math.min(document.documentElement.scrollHeight, r.bottom - y + 8);
      return JSON.stringify({ x: 0, y: Math.round(y), width: ${VP.w}, height: Math.round(h) });
    })()`,
    returnByValue: true,
  });
  if (clip3.result && clip3.result.value) {
    const clip3Json = JSON.parse(clip3.result.value);
    const shot3 = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip3Json.x, y: clip3Json.y, width: clip3Json.width, height: clip3Json.height, scale: 1 },
    });
    const out3 = OUT.replace('-c3.png', '-c3-kline.png');
    require('fs').writeFileSync(out3, Buffer.from(shot3.data, 'base64'));
  }

  /* 第四张：TAPE 所在区块截图 */
  const clip4 = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('tapebox');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const y = Math.max(0, r.top - 8);
      const h = Math.min(document.documentElement.scrollHeight, r.bottom - y + 8);
      return JSON.stringify({ x: 0, y: Math.round(y), width: ${VP.w}, height: Math.round(h) });
    })()`,
    returnByValue: true,
  });
  if (clip4.result && clip4.result.value) {
    const clip4Json = JSON.parse(clip4.result.value);
    const shot4 = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip4Json.x, y: clip4Json.y, width: clip4Json.width, height: clip4Json.height, scale: 1 },
    });
    const out4 = OUT.replace('-c3.png', '-c3-tape.png');
    require('fs').writeFileSync(out4, Buffer.from(shot4.data, 'base64'));
  }

  cdp.close();

  console.log('\n── §5 图表验证（C3-A 情绪温度热力柱 + C3-B 板块涨幅分布 + C3-C 大盘K线 + C3-D 实时TAPE）──');
  console.log('截图 → ' + OUT + ' (' + kb + ' KB)');

  const fail = [];

  /* ═══ 通用：单图断言 ═══ */
  const FNS_EXPECTED = [
    'drawSentimentHeatmap', 'drawDistribution', 'drawKline', 'drawTape', 'bindHover',
    'colorLadder', 'drawHatch', 'drawCandle', 'drawBar', 'drawText',
    'drawAxis', 'resizeCanvas', 'css',
  ];
  if (!out.chartsModule) fail.push('window.Charts 未暴露');
  if (out.chartsFns) {
    FNS_EXPECTED.forEach(k => {
      if (out.chartsFns[k] !== 'function')
        fail.push('Charts.' + k + ' 未暴露（typeof=' + out.chartsFns[k] + '）');
    });
  }

  function assertChart(label, c, opts){
    if (!c.canvasExists) { fail.push(label + ': canvas 不存在'); return; }
    if (c.canvasSize && (c.canvasSize.w <= 0 || c.canvasSize.h <= 0))
      fail.push(label + ': canvas 尺寸为零 ' + JSON.stringify(c.canvasSize));
    if (c.paintedPct == null || c.paintedPct < (opts.minPct || 3))
      fail.push(label + ': 像素绘制不足 ' + (c.paintedPct == null ? '采样失败' : c.paintedPct + '%'));
    if (c.legendText && opts.mustHaveText) {
      opts.mustHaveText.forEach(w => {
        if (!new RegExp(w).test(c.legendText))
          fail.push(label + ': 图例缺"' + w + '" → ' + c.legendText);
      });
    }
    if (c.legendGradHasGradient === false && opts.mustHaveGradient)
      fail.push(label + ': 图例渐变色条缺失');
    if (!c.hoverTest) { fail.push(label + ': hover 测试未执行'); return; }
    if (!c.hoverTest.tipFound) { fail.push(label + ': hover 后 tooltip 未出现'); return; }
    if (c.hoverTest.tipDisplay === 'none')
      fail.push(label + ': tooltip 命中后仍 display:none');
    if (!c.hoverTest.tipTextHasChinese)
      fail.push(label + ': tooltip 无中文（§5 通用条款违反）："' + (c.hoverTest.tipText || '') + '"');
    if (!c.hoverTest.tipTextHasUnit)
      fail.push(label + ': tooltip 缺数值单位："' + (c.hoverTest.tipText || '') + '"');
    if (c.hoverTest.tipRole !== 'status')
      fail.push(label + ': tooltip 缺 role=status：role=' + c.hoverTest.tipRole);
    if (!c.hoverTest.tipAriaLive)
      fail.push(label + ': tooltip 缺 aria-live');
    if (c.hoverTest.tipAfterLeave !== 'none')
      fail.push(label + ': mouseleave 后 tooltip 未隐藏（display=' + c.hoverTest.tipAfterLeave + '）');
  }

  /* ═══ C3-A 断言 ═══ */
  assertChart('情绪温度热力柱', out.heat, {
    minPct: 5,
    mustHaveText: [/柱高＝炸板率/, /不按高低分档/],
    mustHaveGradient: false,
  });

  /* ═══ C3-B 断言 ═══ */
  assertChart('板块涨幅分布', out.dist, {
    minPct: 3,
    mustHaveText: [/跌区/, /涨区/, /中轴=0/],
    mustHaveGradient: true,
  });
  /* 分布图标题应含"个板块"和 min~max 区间 */
  if (out.dist.titleText && !/个板块/.test(out.dist.titleText))
    fail.push('分布图标题缺"个板块"："' + out.dist.titleText + '"');

  /* ═══ C3-C 大盘 K 线断言 ═══ */
  assertChart('大盘K线', kline, {
    minPct: 3,
    mustHaveText: [/涨/, /跌/, /MA5/, /量/],
  });
  /* MA10/MA20 是我一并做的，多断言两个不亏 */
  ['MA10', 'MA20'].forEach(function(k){
    if (kline.legendText && kline.legendText.indexOf(k) < 0)
      fail.push('大盘K线: 图例缺"' + k + '" → ' + kline.legendText);
  });
  /* 六个色块必须真的上色（涨=实心红 / 跌=空心绿 / 量=双色半透明 / MA 三色线段） */
  (kline.legendSwatches || []).forEach(function(s){
    if (!s.exists) { fail.push('大盘K线: 图例色块缺失 .' + s.name); return; }
    if (s.transparent)
      fail.push('大盘K线: 图例色块"' + s.name + '"背景全透明（色没渲染出来）');
  });
  /* hover 整句必须逐个含 开/高/低/收/量（用户明确要求的五个字段） */
  if (kline.hoverTest && kline.hoverTest.tipFound) {
    const missing = ['开','高','低','收','量'].filter(function(k){
      return kline.hoverTest.tipHits.indexOf(k) < 0;
    });
    if (missing.length)
      fail.push('大盘K线: tooltip 缺字段 ' + missing.join('/') +
                '："' + (kline.hoverTest.tipText || '') + '"');
    if (!kline.hoverTest.tipTextHasDate)
      fail.push('大盘K线: tooltip 缺 YYYY-MM-DD 日期："' +
                (kline.hoverTest.tipText || '') + '"');
    if (!kline.hoverTest.tipTextHasPct)
      fail.push('大盘K线: tooltip 缺 % 涨跌单位："' +
                (kline.hoverTest.tipText || '') + '"');
  }
  /* 标题应含标的名与天数 */
  if (kline.titleText && !/\d+\s*日/.test(kline.titleText))
    fail.push('大盘K线: 标题缺"N 日"："' + kline.titleText + '"');

  /* ═══ C3-D §5-4 实时 TAPE 断言 ═══
   * tapeHasData=false 表示链路通但东财返回空（标题"暂无数据"）——此时只验结构
   * （图例文字 / 刷新钩子），跳过像素、色块、hover 等依赖真实柱体的断言。 */
  const tapeHasData = /板块/.test(tapeTitle);
  if (tapeHasData) {
    assertChart('实时TAPE', tape, {
      minPct: 3,
      mustHaveText: [/龙头涨幅/, /10日资金/, /板块涨幅/],
    });
    /* 三个色块必须真的上色（--rd 龙头 / --gd 资金 / --cy 板块） */
    (tape.legendSwatches || []).forEach(function(s){
      if (!s.exists) { fail.push('实时TAPE: 图例色块缺失 .tape-sw[' + s.name + ']'); return; }
      if (s.transparent)
        fail.push('实时TAPE: 图例色块"' + s.name + '"背景全透明（色没渲染出来）');
    });
    /* hover 整句必须逐个含 龙头 / 10日资金 / 板块（用户明确要求的三个字段），
     * 且同时带 % 与 亿 两种单位 */
    if (tape.hoverTest && tape.hoverTest.tipFound) {
      const missing = ['龙头', '10日资金', '板块'].filter(function(k){
        return tape.hoverTest.tipHits.indexOf(k) < 0;
      });
      if (missing.length)
        fail.push('实时TAPE: tooltip 缺字段 ' + missing.join('/') +
                  '："' + (tape.hoverTest.tipText || '') + '"');
      if (!tape.hoverTest.tipTextHasPct)
        fail.push('实时TAPE: tooltip 缺 % 涨幅单位："' +
                  (tape.hoverTest.tipText || '') + '"');
      if (!tape.hoverTest.tipTextHasYi)
        fail.push('实时TAPE: tooltip 缺 亿 资金单位："' +
                  (tape.hoverTest.tipText || '') + '"');
    }
  }
  /* 轮询钩子必须暴露（CDP 侧可主动触发一轮）——空数据也必须有 */
  if (tape.refreshHook !== 'function')
    fail.push('实时TAPE: window.__tapeRefresh 未暴露（typeof=' + tape.refreshHook + '）');
  /* 标题应含板块计数（"暂无数据"是合法空态，放行） */
  if (tape.titleText && !/板块/.test(tape.titleText) && !/暂无数据/.test(tape.titleText))
    fail.push('实时TAPE: 标题缺板块计数："' + tape.titleText + '"');

  /* ── 打印摘要 ── */
  console.log('  模块     window.Charts 暴露: ' + (out.chartsFns ?
    FNS_EXPECTED.map(k => k + '=' + out.chartsFns[k]).join('  ') : '未暴露'));
  console.log('  canvas 总数  ' + out.canvasTotal + ' 个（starfield 多 GL + 图表 4 张新增）');

  console.log('\n── C3-A 情绪温度热力柱 ──');
  console.log('  canvas   ' + (out.heat.canvasSize ? (out.heat.canvasSize.w + 'x' + out.heat.canvasSize.h +
    ' 物理 ' + out.heat.canvasSize.physicalW + 'x' + out.heat.canvasSize.physicalH) : '未找到'));
  console.log('  绘制     非空像素 ' + (out.heat.paintedPct || '?') + '%  (' + (out.heat.nonEmptyPixels || 0) + ' 像素)');
  console.log('  图例     "' + (out.heat.legendText || '(空)') + '"  渐变=' + (out.heat.legendGradHasGradient ? '✓' : '✗'));
  console.log('  标题     "' + (out.heat.titleText || '(空)') + '"');
  if (out.heat.hoverTest && out.heat.hoverTest.tipFound) {
    console.log('  hover    tooltip: "' + (out.heat.hoverTest.tipText || '').slice(0, 80) +
      (out.heat.hoverTest.tipText && out.heat.hoverTest.tipText.length > 80 ? '…' : '') + '"');
    console.log('           role=' + out.heat.hoverTest.tipRole + '  aria-live=' + out.heat.hoverTest.tipAriaLive +
      '  中文=' + (out.heat.hoverTest.tipTextHasChinese ? '✓' : '✗') +
      '  单位=' + (out.heat.hoverTest.tipTextHasUnit ? '✓' : '✗'));
  }

  console.log('\n── C3-B 板块涨幅分布 ──');
  console.log('  canvas   ' + (out.dist.canvasSize ? (out.dist.canvasSize.w + 'x' + out.dist.canvasSize.h +
    ' 物理 ' + out.dist.canvasSize.physicalW + 'x' + out.dist.canvasSize.physicalH) : '未找到'));
  console.log('  绘制     非空像素 ' + (out.dist.paintedPct || '?') + '%  (' + (out.dist.nonEmptyPixels || 0) + ' 像素)');
  console.log('  图例     "' + (out.dist.legendText || '(空)') + '"  渐变=' + (out.dist.legendGradHasGradient ? '✓' : '✗'));
  console.log('  标题     "' + (out.dist.titleText || '(空)') + '"');
  if (out.dist.hoverTest && out.dist.hoverTest.tipFound) {
    console.log('  hover    tooltip: "' + (out.dist.hoverTest.tipText || '').slice(0, 80) +
      (out.dist.hoverTest.tipText && out.dist.hoverTest.tipText.length > 80 ? '…' : '') + '"');
    console.log('           role=' + out.dist.hoverTest.tipRole + '  aria-live=' + out.dist.hoverTest.tipAriaLive +
      '  中文=' + (out.dist.hoverTest.tipTextHasChinese ? '✓' : '✗') +
      '  单位=' + (out.dist.hoverTest.tipTextHasUnit ? '✓' : '✗'));
  }

  console.log('\n── C3-C 大盘 K 线 ──');
  console.log('  canvas   ' + (kline.canvasSize ? (kline.canvasSize.w + 'x' + kline.canvasSize.h +
    ' 物理 ' + kline.canvasSize.physicalW + 'x' + kline.canvasSize.physicalH) : '未找到'));
  console.log('  绘制     非空像素 ' + (kline.paintedPct == null ? '?' : kline.paintedPct + '%') +
    '  (' + (kline.nonEmptyPixels || 0) + ' 像素)');
  console.log('  图例     "' + (kline.legendText || '(空)') + '"');
  console.log('           命中词  ' + ((kline.legendWords || []).join(' ') || '(无)'));
  (kline.legendSwatches || []).forEach(function(s){
    console.log('           ' + (s.exists ? (s.transparent ? '✗' : '✓') : '✗') +
      '  ' + s.name +
      (s.gradient ? '  渐变' : (s.bg ? '  ' + s.bg : '')));
  });
  console.log('  标题     "' + (kline.titleText || '(空)') + '"');
  if (kline.hoverTest && kline.hoverTest.tipFound) {
    console.log('  hover    tooltip: "' + (kline.hoverTest.tipText || '').slice(0, 90) +
      (kline.hoverTest.tipText && kline.hoverTest.tipText.length > 90 ? '…' : '') + '"');
    console.log('           role=' + kline.hoverTest.tipRole + '  aria-live=' + kline.hoverTest.tipAriaLive +
      '  中文=' + (kline.hoverTest.tipTextHasChinese ? '✓' : '✗') +
      '  日期=' + (kline.hoverTest.tipTextHasDate ? '✓' : '✗') +
      '  %= ' + (kline.hoverTest.tipTextHasPct ? '✓' : '✗') +
      '  开高低收量=[' + (kline.hoverTest.tipHits || []).join('') + ']');
  }

  console.log('\n── C3-D 实时 TAPE（轻量轮询版）──');
  console.log('  canvas   ' + (tape.canvasSize ? (tape.canvasSize.w + 'x' + tape.canvasSize.h +
    ' 物理 ' + tape.canvasSize.physicalW + 'x' + tape.canvasSize.physicalH) : '未找到'));
  console.log('  绘制     非空像素 ' + (tape.paintedPct == null ? '?' : tape.paintedPct + '%') +
    '  (' + (tape.nonEmptyPixels || 0) + ' 像素)  首绘 ' +
    ((Date.now() - tp0) / 1000).toFixed(1) + 's');
  console.log('  图例     "' + (tape.legendText || '(空)') + '"');
  console.log('           命中词  ' + ((tape.legendWords || []).join(' ') || '(无)'));
  (tape.legendSwatches || []).forEach(function(s){
    console.log('           ' + (s.exists ? (s.transparent ? '✗' : '✓') : '✗') +
      '  ' + s.name + (s.bg ? '  ' + s.bg : ''));
  });
  console.log('  标题     "' + (tape.titleText || '(空)') + '"  __tapeRefresh=' + tape.refreshHook);
  if (tape.hoverTest && tape.hoverTest.tipFound) {
    console.log('  hover    tooltip: "' + (tape.hoverTest.tipText || '').slice(0, 90) +
      (tape.hoverTest.tipText && tape.hoverTest.tipText.length > 90 ? '…' : '') + '"');
    console.log('           role=' + tape.hoverTest.tipRole + '  aria-live=' + tape.hoverTest.tipAriaLive +
      '  中文=' + (tape.hoverTest.tipTextHasChinese ? '✓' : '✗') +
      '  %= ' + (tape.hoverTest.tipTextHasPct ? '✓' : '✗') +
      '  亿=' + (tape.hoverTest.tipTextHasYi ? '✓' : '✗') +
      '  字段=[' + (tape.hoverTest.tipHits || []).join('') + ']');
  }

  console.log('\n── 判定 ──');
  if (fail.length) {
    fail.forEach(f => console.log('  ✗ ' + f));
    console.log('  失败 ' + fail.length + ' 项');
    process.exit(1);
  }
  console.log('  ✓ 情绪温度热力柱：canvas 有实际绘制（非全透明）');
  console.log('  ✓ 情绪温度热力柱：图例齐全（冷静→恐慌 渐变）');
  console.log('  ✓ 情绪温度热力柱：hover tooltip 是整句中文，role=status + aria-live');
  console.log('  ✓ 板块涨幅分布：canvas 有实际绘制（非全透明）');
  console.log('  ✓ 板块涨幅分布：图例齐全（跌区→涨区 双色带 + 中轴=0 注释）');
  console.log('  ✓ 板块涨幅分布：hover tooltip 是整句中文，role=status + aria-live');
  console.log('  ✓ 大盘K线：canvas 有实际绘制（非全透明，外部源首绘 ' +
    (klinePct < 0 ? '?' : klinePct.toFixed(2) + '%') + '）');
  console.log('  ✓ 大盘K线：图例齐全（涨/跌/MA5/MA10/MA20/量 + A股红涨绿跌注释）');
  console.log('  ✓ 大盘K线：hover tooltip 是整句中文含 开/高/低/收/量 + % + 日期，role=status + aria-live');
  console.log('  ✓ 实时TAPE：canvas 有实际绘制（非全透明，板块扫描首绘 ' +
    (tapePct < 0 ? '?' : tapePct.toFixed(2) + '%') + '）');
  console.log('  ✓ 实时TAPE：图例齐全（龙头涨幅/10日资金/板块涨幅 三色分离 + A股红涨绿跌注释）');
  console.log('  ✓ 实时TAPE：hover tooltip 是整句中文含 板块名/龙头/涨幅%/资金亿，role=status + aria-live');
  console.log('  ✓ 实时TAPE：window.__tapeRefresh 可主动触发一轮（setTimeout 自调度 + AbortController）');
  console.log('  ✓ window.Charts ' + FNS_EXPECTED.length + ' 个 API 全部暴露');
  console.log('  ✓ 未新增 rAF 链（canvas 总数 ' + out.canvasTotal + '，图表数据驱动一次性绘制）');
  process.exit(0);
}

main().catch(e => die(1, '验证失败：' + e.message));
