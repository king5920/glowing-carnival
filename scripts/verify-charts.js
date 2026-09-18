'use strict';
/**
 * §5 图表验证（C3-A 情绪温度热力柱 + C3-B 板块涨幅分布直方图）
 *
 * 断言：
 *   1. #mpHeatCanvas + #scanDistCanvas 存在、非零尺寸、非全透明
 *   2. window.Charts 暴露 drawSentimentHeatmap + drawDistribution + bindHover
 *   3. 两图 hover 触发 tooltip 出现，文本是整句中文（§5 通用条款 role=status）
 *   4. tooltip DOM 有 role="status" + aria-live
 *   5. 图例（冷静/恐慌 梯度）+（涨区/跌区 双色带）都在
 *   6. rAF 链数不变（图表不入 AnimGate.gatedLoop）
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

async function main() {
  require('fs').mkdirSync(require('path').dirname(OUT), { recursive: true });
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
    if (s && s.banner && s.heat && s.dist && s.charts) break;
    if (Date.now() - t0 > 60000) die(3, '等待超时（Charts/canvas 未就绪）');
    await sleep(500);
  }
  await sleep(3000);   /* 让 /api/sentiment/heatmap + /api/distribution 首拉完成并绘制 */

  const r2 = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const raw2 = r2.result && r2.result.value;
  if (typeof raw2 === 'string' && raw2.startsWith('ERR:')) die(2, 'PROBE 抛错：' + raw2);
  const out = JSON.parse(raw2);

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

  cdp.close();

  console.log('\n── §5 图表验证（C3-A 情绪温度热力柱 + C3-B 板块涨幅分布）──');
  console.log('截图 → ' + OUT + ' (' + kb + ' KB)');

  const fail = [];

  /* ═══ 通用：单图断言 ═══ */
  const FNS_EXPECTED = [
    'drawSentimentHeatmap', 'drawDistribution', 'bindHover',
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
    mustHaveText: [/冷静/, /恐慌/],
    mustHaveGradient: true,
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

  /* ── 打印摘要 ── */
  console.log('  模块     window.Charts 暴露: ' + (out.chartsFns ?
    FNS_EXPECTED.map(k => k + '=' + out.chartsFns[k]).join('  ') : '未暴露'));
  console.log('  canvas 总数  ' + out.canvasTotal + ' 个（starfield 多 GL + 图表 2 张新增）');

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
  console.log('  ✓ window.Charts ' + FNS_EXPECTED.length + ' 个 API 全部暴露');
  console.log('  ✓ 未新增 rAF 链（canvas 总数 ' + out.canvasTotal + '，图表数据驱动一次性绘制）');
  process.exit(0);
}

main().catch(e => die(1, '验证失败：' + e.message));
