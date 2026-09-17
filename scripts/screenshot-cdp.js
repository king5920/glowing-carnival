'use strict';
/**
 * 零依赖 CDP 截图：等数据真的进了星图再拍，绕开 --virtual-time-budget 的死等
 *
 * 为什么需要这个文件（而不是直接用 msedge --screenshot）：
 *   --screenshot 是"启动后定时拍一帧"，星图的数据来自 /api/starmap 的异步 fetch，
 *   定时刻度早于数据落地，拍出来是空骨架（只有 filler 占位节点），
 *   看不出任何一块数据驱动的图。而 --virtual-time-budget 在本页会挂死
 *   （无限 rAF 永远到不了静默），所以只能走 CDP 自己等信号。
 *
 * 依赖：Node 25 的全局 WebSocket（未加 flag 即可用），不用 ws / puppeteer / playwright。
 *   项目只允许 better-sqlite3 一个生产依赖，这里是 dev 侧工具脚本，不写进 package.json deps。
 *
 * 就绪信号：app.js 在 fetch('/api/starmap') 解析后写 window.__starData，
 *   随后调 STAR.build(d)。所以 __starData 存在且 STAR.stats().memories > 0
 *   就是"真数据已上屏"，而不是"没连上服务器、退回空骨架"。
 *   这两者必须分开——空骨架也能画出一个满屏的星图，
 *   拍回来看着正常，其实是假的可用（DESIGN.md 的核心纪律）。
 *
 * 用法：
 *   node scripts/screenshot-cdp.js [url] [输出png] [等待秒数] [视口列表]
 *
 *   视口列表：'WxH' 单档（默认 1720x1040），或多档
 *   '375x812,768x1024,1024x768,1440x900'（DESIGN.md §8 #8 的四档）。
 *   多档时每档各存一张 <输出名>-<W>x<H>.png，并逐档检测横向滚动；
 *   任一档溢出则退出码 4，可直接当 CI 断言用。
 */

const { spawn } = require('child_process');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9333;
const URL = process.argv[2] || 'http://127.0.0.1:3800/';
const OUT = process.argv[3] ||
  'D:/jarvis/scripts/_shots/starmap-data-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
const WAIT_S = Number(process.argv[4]) || 25;
const SETTLE_MS = 3500;          // 数据到位后再等，让苏醒波播完、布局稳定
const POLL_MS = 500;

/* ── 视口。多档用于 DESIGN.md §8 #8「375/768/1024/1440 无横向滚动」。 ── */
const VPORT_SPEC = process.argv[5] || '1720x1040';
const VIEWPORTS = VPORT_SPEC.split(',').map(s => {
  const parts = s.trim().split(/x/i).map(Number);
  return { w: parts[0] || 0, h: parts[1] || 0 };
}).filter(v => v.w > 0 && v.h > 0);
if (!VIEWPORTS.length) {
  console.log('视口参数无效：' + VPORT_SPEC + '，应为 WxH 或 WxH,WxH,...');
  process.exit(1);
}
const MAX_W = Math.max(...VIEWPORTS.map(v => v.w));
const MAX_H = Math.max(...VIEWPORTS.map(v => v.h));
/* 截图命名：单档保留原名；多档把 -WxH 插进扩展名前。 */
const outName = (vp) => {
  if (VIEWPORTS.length === 1) return OUT;
  return OUT.replace(/(\.[^.]+)?$/, `-${vp.w}x${vp.h}$1`);
};

/* 就绪判定表达式。返回 JSON 字符串，避免 CDP 对返回值做二次序列化时丢结构。 */
const READY_EXPR = `(() => {
  try {
    const s = window.STAR ? STAR.stats() : null;
    return JSON.stringify({
      data: !!window.__starData,
      star: !!window.STAR,
      stats: s,
      webgl: !!document.getElementById('graph'),
    });
  } catch (e) { return 'ERR:' + e.message; }
})()`;

/* 横向滚动检测（DESIGN.md §8 #8）。两个口径都报：
 *   horizontal —— 页面级 documentElement.scrollWidth > clientWidth，即真会横向滚动；
 *   clipped —— 元素已画到视口外、只是被某祖先 overflow:hidden 裁掉了。
 * 后者页面不会滚，但用户看到的是被切掉的内容，同样算布局缺陷，所以单独列出来。
 * 用 getBoundingClientRect 扫全部元素，才能发现 scrollWidth 看不见的裁切。 */
const SCROLL_EXPR = `(() => {
  try {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const list = document.querySelectorAll('*');
    let over = 0, who = '';
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      const r = el.getBoundingClientRect();
      if (r.right - vw > over + 0.5) {
        over = r.right - vw;
        const cl = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).join('.') : '';
        who = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cl ? '.' + cl : '');
      }
    }
    return JSON.stringify({
      vw: vw,
      scrollWidth: de.scrollWidth,
      horizontal: de.scrollWidth > vw + 1,
      clippedRight: Math.round(over),
      clippedEl: who,
    });
  } catch (e) { return 'ERR:' + e.message; }
})()`;

let child = null;
function die(code, msg) {
  if (msg) console.log(msg);
  killEdge();
  process.exit(code);
}
function killEdge() {
  try { if (child && !child.killed) child.kill('SIGTERM'); } catch (_) {}
}
process.on('exit', killEdge);
process.on('SIGINT', () => die(130));

/* ── 极简 CDP 客户端：id 计数 + pending 映射 ── */
function open(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('close', () => reject(new Error('CDP 连接关闭')));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 错误')));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve: rs, reject: rj } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rj(new Error(m.error.message)) : rs(m.result);
      } else if (m.method) events.push(m);
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
  const req = require('http').get(`http://127.0.0.1:${CDP_PORT}${path}`, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(2000, () => req.destroy(new Error('CDP HTTP 超时 ' + path)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 轮询一个 HTTP 端点直到 fn 返回真值或超时 */
async function pollHTTP(path, fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await getJSON(path);
      const v = fn(j);
      if (v) return v;
    } catch (_) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(300);
  }
}

async function main() {
  fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
  console.log('启动 msedge headless（CDP 端口 ' + CDP_PORT + '）…');
  child = spawn(EDGE, [
    '--headless=new',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--window-size=${MAX_W},${MAX_H}`,
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
    URL,
  ], { stdio: 'ignore', detached: false });

  /* 浏览器就绪 */
  await pollHTTP('/json/version', (j) => (j.webSocketDebuggerUrl ? true : false), 20000, 'CDP /json/version');
  /* 页面 target 就绪（命令行传的 URL 会开成一个 page） */
  const target = await pollHTTP('/json/list', (j) => {
    return (j || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
  }, 20000, '页面 target');
  console.log('已连接页面:', target.url);

  const cdp = await open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* ── 等真数据上屏。数据是页面级的、与视口无关，只在这里等一次；
     视口逐档切换在数据到位之后做，避免在数据还没落地时就开始拍。 ── */
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', { expression: READY_EXPR, returnByValue: true });
    const raw = r.result && r.result.value;
    if (typeof raw === 'string' && raw.startsWith('ERR:')) {
      die(2, '页面抛错：' + raw);
    }
    last = raw ? JSON.parse(raw) : null;
    const ok = last && last.data && last.stats && last.stats.memories > 0;
    if (ok) {
      console.log('数据已上屏：' + JSON.stringify(last.stats));
      break;
    }
    if (Date.now() - t0 > WAIT_S * 1000) {
      die(3, '等待数据超时。最后状态：' + JSON.stringify(last) +
        '\n    若服务器未启动，/api/starmap 会失败，星图退回空骨架 —— 这正是本脚本要挡住的情形。');
    }
    await sleep(POLL_MS);
  }

  /* ── 逐档拍。切换视口后重排需要时间，所以每档都要再稳定一段。
     无限 rAF 不影响 CDP 截图 —— CDP 不需要静默，这是不用 --virtual-time-budget 的原因。 ── */
  const results = [];
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: false,
    });
    await sleep(SETTLE_MS);

    const sc = await cdp.send('Runtime.evaluate', { expression: SCROLL_EXPR, returnByValue: true });
    const sraw = sc.result && sc.result.value;
    let sinfo;
    if (typeof sraw === 'string' && sraw.startsWith('ERR:')) {
      die(2, '滚动检测抛错：' + sraw);
    }
    sinfo = JSON.parse(sraw);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = outName(vp);
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    results.push({ vp: vp.w + 'x' + vp.h, ...sinfo, out, kb });
    console.log(`  ${vp.w}x${vp.h}  横向滚动=${sinfo.horizontal ? '是' : '否'}  ` +
      `裁切溢出=${sinfo.clippedRight}px(${sinfo.clippedEl || '—'})  →  ${out} (${kb} KB)`);
  }

  cdp.close();
  die(results.some(r => r.horizontal) ? 4 : 0);
}

main().catch((e) => die(1, '截图失败：' + e.message));
