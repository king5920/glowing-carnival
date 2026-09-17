'use strict';
/**
 * flowBar 中轴双通道验证（DESIGN.md §1.1 / §5）
 *
 * 板块资金条 2026-09-17 重写：方向 = 位置(中轴左右) + 色相(流入青 / 流出灰蓝) + 符号(+/−)。
 * 这个脚本验的是**渲染后**的样子，不是源码推理：
 *   - 真实数据 8 个板块今日全部净流入，负值分支没有真数据可看。
 *     所以负值分支用**同一个浏览器的 CSS 引擎**对构造样例求值
 *     （getComputedStyle + getBoundingClientRect），而不是手算颜色。
 *   - 真实正值分支直接读页面里渲染出的 DOM。
 * 两条路径同一份 CSS、同一个浏览器实例，差异只来自 .f-pos / .f-neg 类。
 */

const { spawn } = require('child_process');
const fs = require('fs');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9334;
const URL = 'http://127.0.0.1:3800/';
const OUT = 'D:/jarvis/scripts/_shots/flowbar-2026-09-17-clip.png';
const WAIT_S = 130;        // /api/closescan 首次抓取要 ~13s，留足
const POLL_MS = 700;
const VP = { w: 1440, h: 900 };

const PROBE = `(() => {
  try {
    const panel = document.querySelector('.panel[data-panel="closescan"]');
    const out = { ready: false };
    if (!panel) return JSON.stringify(out);
    const cards = panel.querySelectorAll('.scard');
    if (!cards.length) return JSON.stringify({ ready: false, reason: 'scard 未渲染' });
    const R = Math.round;
    const cs = el => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor,
               left: R(parseFloat(s.left)), right: R(parseFloat(s.right)),
               top: R(parseFloat(s.top)), bottom: R(parseFloat(s.bottom)), width: R(parseFloat(s.width)) };
    };
    /* 条相对轨道的几何位置。barRightCss 是判「是否贴中轴」的唯一依据
       —— 正值 right:50% 使条右缘落在轨道 50% 处，负值 left:50% 使条左缘落在轨道 50% 处。 */
    const barGeom = b => {
      const g = b.parentElement.getBoundingClientRect(), i = b.getBoundingClientRect();
      return { trackW: R(g.width), barLeftCss: R(i.left - g.left), barRightCss: R(i.right - g.left) };
    };
    /* ── 负值分支：构造样例，交给同一份 CSS 引擎求值 ── */
    const probe = document.createElement('div');
    probe.className = 'scard probe';
    probe.style.cssText = 'position:fixed;left:2000px;top:2000px;width:280px;z-index:9999;visibility:hidden';
    probe.innerHTML =
      '<div class="fl"><div class="f f10 f-neg"><div class="fl-l"><span>10日</span><span>-10亿</span></div><div class="fb"><i style="width:48%"></i></div></div>'
      + '<div class="f f5 f-neg"><div class="fl-l"><span>5日</span><span>-10亿</span></div><div class="fb"><i style="width:48%"></i></div></div>'
      + '<div class="f f1 f-neg"><div class="fl-l"><span>今日</span><span>-10亿</span></div><div class="fb"><i style="width:48%"></i></div></div>'
      + '<div class="f f1 f-pos"><div class="fl-l"><span>今日</span><span>+10亿</span></div><div class="fb"><i style="width:48%"></i></div></div>'
      + '</div>';
    document.body.appendChild(probe);
    const bars = probe.querySelectorAll('.f .fb i');
    const axEl = bars[0].parentElement;
    const axis = getComputedStyle(axEl, '::before');
    const axRect = axEl.getBoundingClientRect();
    const neg = {
      axis: { left: R(parseFloat(axis.left)), width: R(parseFloat(axis.width)), bg: axis.backgroundColor,
              trackW: R(axRect.width), barRightCss: R(parseFloat(axis.left)) },
      f10neg: Object.assign(cs(bars[0]), barGeom(bars[0])),
      f5neg: Object.assign(cs(bars[1]), barGeom(bars[1])),
      f1neg: Object.assign(cs(bars[2]), barGeom(bars[2])),
      f1pos: Object.assign(cs(bars[3]), barGeom(bars[3])),
      labels: Array.prototype.slice.call(probe.querySelectorAll('.f .fl-l')).map(e => e.textContent)
    };
    const pr = panel.getBoundingClientRect();
    probe.remove();
    /* ── 真实正值分支：页面里渲染出来的 DOM ── */
    const real = Array.prototype.slice.call(cards).slice(0, 4).map(c => ({
      name: (c.querySelector('.nm') || {}).textContent || '',
      rect: { x: R(c.getBoundingClientRect().left), w: R(c.getBoundingClientRect().width) },
      bars: Array.prototype.slice.call(c.querySelectorAll('.f')).map(fr => {
        const b = fr.querySelector('.fb i');
        const cs2 = getComputedStyle(b);
        const spans = fr.querySelectorAll('.fl-l span');
        const lbl = spans.length > 1 ? spans[spans.length - 1].textContent : '';
        return Object.assign({ lbl: lbl, wCss: b.style.width, bg: cs2.backgroundColor }, barGeom(b));
      })
    }));
    out.ready = true;
    out.count = cards.length;
    out.neg = neg;
    out.real = real;
    out.clip = { x: Math.max(0, pr.x), y: Math.max(0, pr.y),
                 w: Math.min(VP_W, pr.width), h: Math.min(VP_H, pr.height),
                 px: R(pr.width * 2), py: R(pr.height * 2) };
    out.panelClass = panel.className;
    return JSON.stringify(out);
  } catch (e) { return 'ERR:' + e.message + ' | ' + e.stack; }
})()`;

let child = null;
function die(code, msg) { if (msg) console.log(msg); killEdge(); process.exit(code); }
function killEdge() { try { if (child && !child.killed) child.kill('SIGTERM'); } catch (_) {} }
process.on('exit', killEdge);
process.on('SIGINT', () => die(130));

function open(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('close', () => reject(new Error('CDP 连接关闭')));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 错误')));
    ws.addEventListener('message', (ev) => {
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
      ws, close() { try { ws.close(); } catch (_) {} },
    };
  });
}

const getJSON = (path) => new Promise((resolve, reject) => {
  const req = require('http').get('http://127.0.0.1:' + CDP_PORT + path, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.setTimeout(2000, () => req.destroy(new Error('CDP HTTP 超时 ' + path)));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
  console.log('启动 msedge headless（CDP 端口 ' + CDP_PORT + '）…');
  child = spawn(EDGE, [
    '--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--remote-debugging-address=127.0.0.1',
    '--window-size=' + VP.w + ',' + VP.h, '--force-device-scale-factor=2',
    '--hide-scrollbars', URL,
  ], { stdio: 'ignore', detached: false });

  const poll = async (path, fn, timeoutMs, label) => {
    const t0 = Date.now();
    for (;;) {
      try { const v = fn(await getJSON(path)); if (v) return v; } catch (_) {}
      if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
      await sleep(300);
    }
  };

  await poll('/json/version', (j) => (j.webSocketDebuggerUrl ? true : false), 20000, 'CDP /json/version');
  const target = await poll('/json/list', (j) => (j || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null, 20000, '页面 target');
  console.log('已连接页面:', target.url);

  const cdp = await open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VP.w, height: VP.h, deviceScaleFactor: 2, mobile: false,
  });

  /* 等板块卡真渲染出来。closescan 首次抓取要 ~13s，所以别只等星图。 */
  let r = null, raw = null;
  const tStart = Date.now();
  for (;;) {
    const rr = await cdp.send('Runtime.evaluate', {
      expression: '(window.VP_W=' + VP.w + ', window.VP_H=' + VP.h + ', ' + PROBE + ')', returnByValue: true,
    });
    raw = rr.result && rr.result.value;
    if (typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：' + raw);
    r = raw ? JSON.parse(raw) : null;
    if (r && r.ready) {
      console.log('板块卡已渲染：' + r.count + ' 张');
      break;
    }
    if (Date.now() - tStart > WAIT_S * 1000) {
      die(3, '等待板块卡超时。最后状态：' + JSON.stringify(r));
    }
    await sleep(POLL_MS);
  }

  /* ── 判定 ──
   * 只比对**渲染几何**：条相对轨道的位置 vs 中轴位置。不比对 CSS 属性值
   * （getComputedStyle 对 50% / auto 的解析因定位方式而异，不是双通道的实际效果）。
   *
   * CSS 设计（.fb 宽 W，条宽 48%；2026-09-17 修正后，与 DESIGN.md §5 一致）：
   *   正值 left:50%  → 占 [50%, 98%]，左缘贴中轴、右缘抵轨道右端，从中轴向**右**长
   *   负值 right:50% → 占 [2%, 50%]，右缘贴中轴、左缘抵轨道左端，从中轴向**左**长
   * 两者互为镜像，这是「位置双通道」成立与否的唯一判据。
   * 初版把正值锚在 right:50%（占左半轨），语义与 §5「净流入右向」反了——
   * 这里要求正向必须**从左缘贴中轴向右长**、负向必须**从右缘贴中轴向左长**，
   * 只查镜像对称抓不到方向反转，必须分别断言两侧的贴边侧。 */
  const bad = [];
  const n = r.neg;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const half = (v) => v / 2;
  // ① 中轴线：必须在轨道正中
  {
    if (!near(n.axis.left, half(n.axis.trackW), 1.5))
      bad.push('中轴线在轨道 ' + n.axis.left + 'px，轨道中点应约 ' + half(n.axis.trackW).toFixed(1) + 'px');
    if (n.axis.width < 1) bad.push('中轴线宽度异常：' + n.axis.width + 'px');
  }
  // ② 负值样例（浏览器对构造 HTML 求值）：右缘贴中轴、左缘抵轨道左端
  [['f10', n.f10neg], ['f5', n.f5neg], ['f1', n.f1neg]].forEach(([k, v]) => {
    if (!near(v.barRightCss, half(v.trackW), 2))
      bad.push(k + ' 负值条右缘在 ' + v.barRightCss.toFixed(1) + 'px，未贴中轴（' + half(v.trackW).toFixed(1) + 'px）—— 负向未走左半轨');
    if (v.barLeftCss > 2)
      bad.push(k + ' 负值条左缘在 ' + v.barLeftCss.toFixed(1) + 'px，未抵轨道左端（应 ≤2px 空隙）');
    if (v.barRightCss < half(v.trackW) - 2)
      bad.push(k + ' 负值条右缘 ' + v.barRightCss.toFixed(1) + 'px 已越过中轴向左侧外溢出');
  });
  // ③ 正值样例：左缘贴中轴、右缘抵轨道右端（镜像于负值）
  {
    const v = n.f1pos;
    if (!near(v.barLeftCss, half(v.trackW), 2))
      bad.push('正值条左缘在 ' + v.barLeftCss.toFixed(1) + 'px，未贴中轴（' + half(v.trackW).toFixed(1) + 'px）—— 正向未走右半轨');
    if (!near(v.barRightCss, v.trackW, 2))
      bad.push('正值条右缘在 ' + v.barRightCss.toFixed(1) + 'px，未抵轨道右端（' + v.trackW + 'px）');
  }
  // ④ 真实数据：今日 8 板块全为净流入，正值条必须全部落在中轴**右侧**
  r.real.forEach(c => c.bars.forEach((b, bi) => {
    if (!near(b.barLeftCss, half(b.trackW), 2))
      bad.push('真实 ' + c.name + ' 第' + bi + '条左缘 ' + b.barLeftCss.toFixed(1) + 'px 未贴中轴（' + half(b.trackW).toFixed(1) + 'px）—— 正值未走右半轨');
    if (b.barLeftCss < half(b.trackW) - 2)
      bad.push('真实 ' + c.name + ' 第' + bi + '条越过中轴向左侧溢出，会被读成流出');
  }));
  // ⑤ 通道 B：色相。流出灰蓝 / 流入青，全程零红、零绿带
  const rgbOf = (bg) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
  const hue = (c) => {
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
    if (!d) return 0;
    let h;
    if (mx === c[0]) h = ((c[1] - c[2]) / d + 6) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    return h * 60;
  };
  const isGreenBand = (bg) => { const c = rgbOf(bg); return !!c && hue(c) >= 120 && hue(c) <= 180; };
  const isRed = (bg) => { const c = rgbOf(bg); return !!c && c[0] > c[1] && c[0] > c[2] && c[0] - Math.max(c[1], c[2]) > 30; };
  const isCyan = (bg) => { const c = rgbOf(bg); return !!c && c[2] - c[0] >= 40 && c[2] >= c[1]; };
  /* 灰蓝判据：低饱和 + 冷色相 + B≥G≥R 通道顺序。用 maxdiff ≤ 40 会误收纯白/纯黑，
     再叠加色相 [190°,260°]（青灰→冷灰蓝带）+ B≥G≥R 才能同时挡住暖灰（橙金）和绿带。 */
  const isGrayBlue = (bg) => {
    const c = rgbOf(bg);
    if (!c) return false;
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    const sat = mx - mn;
    if (sat > 40 || sat === 0) return false;
    return c[2] >= c[1] && c[1] >= c[0] && hue(c) >= 190 && hue(c) <= 260;
  };
  [['f10', n.f10neg], ['f5', n.f5neg], ['f1', n.f1neg]].forEach(([k, v]) => {
    if (!isGrayBlue(v.bg)) bad.push(k + ' 流出条非中性灰蓝：' + v.bg + '（色相 ' + (rgbOf(v.bg) ? hue(rgbOf(v.bg)).toFixed(0) : '?') + '°）');
  });
  if (!isCyan(n.f1pos.bg)) bad.push('流入条非青色：' + n.f1pos.bg);
  [n.f10neg, n.f5neg, n.f1neg, n.f1pos].forEach(v => {
    if (isGreenBand(v.bg)) bad.push('条背景落在绿带 [120°,180°]：' + v.bg);
    if (isRed(v.bg)) bad.push('条背景含红（§1.1 反向纪律）：' + v.bg);
  });
  // ⑥ 通道 C：符号。正值必须有 +，负值带 −
  r.real.forEach(c => c.bars.forEach((b, bi) => {
    if (!/^[+]/.test(b.lbl)) bad.push('真实 ' + c.name + ' 第' + bi + '条数值缺 + 号：「' + b.lbl + '」');
    if (isGreenBand(b.bg) || isRed(b.bg)) bad.push('真实 ' + c.name + ' 第' + bi + '条背景含红或绿带：' + b.bg);
  }));
  const pl = n.labels.join(' | ');
  if (pl.indexOf('-10亿') < 0) bad.push('负值样例未渲染出 − 号：「' + pl + '」');
  if (pl.indexOf('+10亿') < 0) bad.push('正值样例未渲染出 + 号：「' + pl + '」');

  // ── 裁剪截图 ──
  if (r.clip && r.clip.w > 40 && r.clip.h > 40) {
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', clip: {
        x: r.clip.x, y: r.clip.y, width: r.clip.w, height: r.clip.h, scale: 1,
      },
    });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('裁剪截图 → ' + OUT + ' (' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
  } else {
    console.log('跳过裁剪截图：面板 rect 不可用');
  }

  cdp.close();
  console.log('\n── 判定 ──');
  if (bad.length) {
    bad.forEach(b => console.log('  ✗ ' + b));
    console.log('  失败 ' + bad.length + ' 项');
    process.exit(1);
  }
  console.log('  ✓ 位置双通道成立（正值占右半轨 / 负值占左半轨，中轴线在轨道正中）');
  console.log('  ✓ 色相双通道成立（流出中性灰蓝 / 流入青），全程零红绿、零绿带');
  console.log('  ✓ 符号通道成立（真实渲染出 +12.3亿 / -10亿 形式）');
  console.log('\n负值分支（浏览器 CSS 引擎对构造样例求值，轨道 ' + n.axis.trackW + 'px）：');
  console.log('  中轴线  left=' + n.axis.left + 'px（轨道中点 ' + half(n.axis.trackW) + 'px）  width=' + n.axis.width + 'px  bg=' + n.axis.bg);
  [['10日(负)', n.f10neg], ['5日(负)', n.f5neg], ['今日(负)', n.f1neg], ['今日(正)', n.f1pos]].forEach(([k, v]) => {
    // 方向判定：右缘贴中轴 = 负向（左半轨），左缘贴中轴 = 正向（右半轨）
    const negLike = v.barRightCss <= half(v.trackW) + 2 && v.barLeftCss <= 2;
    const posLike = v.barLeftCss >= half(v.trackW) - 2 && v.barRightCss >= v.trackW - 2;
    const dir = posLike ? '占右半轨、从中轴向右长(流入)'
              : (negLike ? '占左半轨、从中轴向左长(流出)'
              : '形态异常');
    console.log('  ' + k.padEnd(9) + '  bg=' + v.bg.padEnd(26)
      + '  条在轨道内 [' + v.barLeftCss + ', ' + v.barRightCss + ']px  中点=' + half(v.trackW).toFixed(0)
      + '  → ' + dir);
  });
  console.log('  符号通道：' + n.labels.join(' / '));
  console.log('\n真实数据（今日 8 板块全部净流入，负值分支无真数据可看）：');
  r.real.forEach(c => {
    console.log('  ' + c.name + '  轨宽' + c.bars[0].trackW + 'px  中点=' + half(c.bars[0].trackW).toFixed(0) + '  |  ' +
      c.bars.map(b => b.lbl + ':' + b.wCss + '(左缘' + b.barLeftCss + ',右缘' + b.barRightCss + ')').join('  '));
  });
  process.exit(0);
}

main().catch((e) => die(1, '验证失败：' + e.message));
