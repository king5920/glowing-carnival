'use strict';
/**
 * 零依赖 CDP 文字对比度抽测（DESIGN.md §8 #3）
 *
 * 为什么需要独立脚本（而不是复用 screenshot-cdp.js）：
 *   screenshot-cdp.js 是"等真数据上屏再拍一帧"，关心的是画面状态；
 *   本脚本关心的是**每个文字元素**的 fg/bg 对比度，需要遍历 DOM 求值，
 *   两者的就绪信号和输出物完全不同，混在一起只会让脚本变臃肿。
 *
 * 依赖：Node 25 全局 WebSocket（未加 flag 即可用），不用 ws / puppeteer / playwright。
 *   项目只允许 better-sqlite3 一个生产依赖，这里是 dev 侧工具脚本，不写进 package.json deps。
 *
 * 判定口径（WCAG 2.1）：
 *   相对亮度 L = 0.2126·R + 0.7152·G + 0.0722·B（RGB 先线性化）
 *   对比度 C = (max(L1,L2) + 0.05) / (min(L1,L2) + 0.05)
 *   正文（<24px 或 <18.5px 粗体）阈值 4.5:1（AA）
 *   大字（≥24px 或 ≥18.5px 且 ≥700）阈值 3:1（AA 大字豁免）
 *
 * 有效背景算法：
 *   从当前元素向上走祖先，每一层先取 solid backgroundColor；
 *   若 transparent（a=0），再尝试解析 background-image 里的 gradient 首个颜色；
 *   按 alpha 前向合成（a-over）直到不透明为止。
 *   最终若合成后仍半透明（祖先全用 gradient / 无 solid bg），
 *   兜底合成到 JARVIS 暗色主题 --bg #0A1320 上，避免把纯黑当默认。
 *   这样能正确处理 --panel rgba(24,38,58,.60) 与 --send 的 linear-gradient 金条。
 *
 * 已知限制：
 *   - gradient 只取首色，不积分多点。对线性渐变来说首色是"顶边"代表色，
 *     文本若在渐变带内，实际对比度可能介于首色和尾色之间。
 *     JARVIS 目前所有 gradient 都是单色相过渡（#send 金色渐变、body 深蓝渐变），
 *     首色判据足够准确。
 *   - 不处理 opacity: <1（祖先链上的整体不透明度）；同样不影响 JARVIS。
 *
 * 用法：node scripts/check-contrast.js [url] [等待秒数] [阈值]
 *   默认 url=http://127.0.0.1:3800/，等待 45s，阈值 4.5:1。
 *   任一元素不达标 → 退出码 5；工具本身出错 → 退出码 1/2/3；
 *   无元素达标也无元素不达标（全 pass）→ 退出码 0。
 */

const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9335;              // 避开 screenshot-cdp(9333) 与 verify-flowbar(9334)
const URL = process.argv[2] || 'http://127.0.0.1:3800/';
const WAIT_S = Number(process.argv[3]) || 45;
const THRESHOLD = Number(process.argv[4]) || 4.5;
const POLLS = 60;                   // 就绪判定轮询次数
const POLL_MS = 1000;

/* ── 就绪判定：等 #srcbanner 出现（表示首页主结构已渲染）+ 无 JS 错误 ── */
const READY_EXPR = `(() => {
  try {
    return JSON.stringify({
      banner: !!document.getElementById('srcbanner'),
      panel: !!document.querySelector('.panel'),
      txt: (document.body.innerText || '').length,
      err: window.__lastErr || null,
    });
  } catch (e) { return 'ERR:' + e.message; }
})()`;

/* ── 对比度求值表达式 ──
 * 走 DOM 找出所有"带自身文字、且视觉可见"的元素，逐个计算对比度。
 * 只看叶子文字（元素自身 textContent，而非 children 的拼接），
 * 避免"父节点也算、子节点也算"的重复计数。
 * 返回 JSON：{checked, failed, min, results: [...按 ratio 升序]}。
 * THRESHOLD 通过模板字符串在注入前替换成 Node 侧的具体数字。 */
const CONTRAST_EXPR = `(() => {
  try {
    const parseColor = (s) => {
      if (!s) return null;
      const m = /rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)/.exec(s);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
    };
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const contrast = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    /* 前向 alpha 合成：fg 盖在 bg 上。alpha 都是 1 时直接返回 fg。 */
    const over = (fg, bg) => {
      if (!fg) return bg;
      if (fg.a === 1) return fg;
      if (!bg || bg.a === 0) return fg;
      const oa = fg.a + bg.a * (1 - fg.a);
      if (oa === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / oa,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / oa,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / oa,
        a: oa,
      };
    };
    /* 从 el 向上走祖先链合成出有效背景。
       先取 el 自己的 backgroundColor；若 transparent（a=0），
       再退到 background-image 里 gradient 的首色。
       每一层用 a-over 前向合成，走到 body/html 或遇到完全不透明祖先为止。
       若最终仍半透明（祖先全是 gradient 或没设 solid bg），
       兜底合成到 --bg #0A1320（JARVIS 暗色主题底）上，避免把纯黑当默认。 */
    const effBg = (el) => {
      let bg = null;
      let e = el;
      while (e && e !== document) {
        const s = getComputedStyle(e);
        const p = parseColor(s.backgroundColor);
        let layer = null;
        if (p && p.a > 0) {
          layer = p;                                     /* solid 直取 */
        } else {
          /* 走 background-image：抓首个 rgba/rgb(...) 颜色 */
          const im = s.backgroundImage || '';
          if (im && im !== 'none') {
            const ms = im.match(/rgba?\\([^)]+\\)/);
            if (ms) {
              const g = parseColor(ms[0]);
              if (g && g.a > 0) layer = g;
            }
          }
        }
        if (layer) {
          bg = (bg === null) ? layer : over(bg, layer);
          if (bg.a >= 0.999) break;   // 已经完全不透明，再往上合成也不变
        }
        if (e === document.body || e === document.documentElement) break;
        e = e.parentElement;
      }
      /* 兜底：合成到 --bg 上。--bg 取 #0A1320，与 ui/index.html :root 一致。 */
      const FB = { r: 10, g: 19, b: 32, a: 1 };
      return bg ? over(bg, FB) : FB;
    };
    const all = document.querySelectorAll('*');
    let checked = 0, failed = 0, min = Infinity;
    const results = [];
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      /* 只看直接 text 子节点：跳过"父+子都算"的重复。 */
      let own = '';
      for (let j = 0; j < e.childNodes.length; j++) {
        if (e.childNodes[j].nodeType === 3) own += e.childNodes[j].textContent;
      }
      if (!own.trim()) continue;
      const rect = e.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const fgRaw = parseColor(cs.color);
      if (!fgRaw) continue;
      const bg = effBg(e);
      const fg = over(fgRaw, bg);
      const ratio = contrast(fg, bg);
      checked++;
      if (ratio < min) min = ratio;
      const px = parseFloat(cs.fontSize) || 12;
      const fw = parseInt(cs.fontWeight) || 400;
      const large = px >= 24 || (px >= 18.5 && fw >= 700);
      const thr = large ? 3 : ${THRESHOLD};
      if (ratio < thr) {
        failed++;
        results.push({
          ratio: +ratio.toFixed(2),
          thr: thr,
          tag: e.tagName.toLowerCase(),
          id: e.id,
          cls: typeof e.className === 'string' ? e.className : '',
          text: own.trim().slice(0, 60),
          fg: cs.color,
          bgRaw: bg.r + ',' + bg.g + ',' + bg.b,
          px: px,
        });
      }
    }
    results.sort((a, b) => a.ratio - b.ratio);
    return JSON.stringify({ checked, failed, min: min === Infinity ? null : +min.toFixed(2), threshold: ${THRESHOLD}, results });
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
  console.log('启动 msedge headless（CDP 端口 ' + CDP_PORT + '）…');
  child = spawn(EDGE, [
    '--headless=new', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT, '--remote-debugging-address=127.0.0.1',
    '--window-size=1440,900', '--force-device-scale-factor=2',
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
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });

  /* ── 等首页渲染完。#srcbanner 是主结构的一部分，出现即代表主 JS 已执行。
     再给 3s 让异步面板渲染，减少 false positive。 */
  let last = null;
  const t0 = Date.now();
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', { expression: READY_EXPR, returnByValue: true });
    const raw = r.result && r.result.value;
    if (typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：' + raw);
    last = raw ? JSON.parse(raw) : null;
    if (last && last.banner && last.panel) {
      console.log('首页已渲染：banner=' + last.banner + '  panel=' + last.panel +
        '  文本长度=' + last.txt + '  err=' + last.err);
      break;
    }
    if (Date.now() - t0 > WAIT_S * 1000) {
      die(3, '等待首页渲染超时。最后状态：' + JSON.stringify(last));
    }
    await sleep(POLL_MS);
  }
  /* 再等 3s，让异步面板尽量渲染出来（否则抽测会漏掉后加载的元素） */
  await sleep(3000);

  const r2 = await cdp.send('Runtime.evaluate', { expression: CONTRAST_EXPR, returnByValue: true });
  const raw2 = r2.result && r2.result.value;
  if (typeof raw2 === 'string' && raw2.startsWith('ERR:')) {
    cdp.close();
    die(2, '对比度求值抛错：' + raw2);
  }
  const c = JSON.parse(raw2);

  cdp.close();

  console.log('\n── 抽测结果（阈值 ' + c.threshold + ':1 正文 / 3:1 大字）──');
  console.log('  检查 ' + c.checked + ' 个文字元素，' + c.failed + ' 个不达标' +
    (c.min != null ? '，最低 ' + c.min + ':1' : ''));

  if (c.failed === 0) {
    console.log('  ✓ 全部通过 ' + c.threshold + ':1（或大字 3:1）');
    process.exit(0);
  }

  console.log('\n不达标清单（按对比度升序，最差在前）：');
  c.results.forEach((x, i) => {
    const loc = (x.id ? '#' + x.id : '') + (x.cls ? '.' + x.cls.trim().split(/\s+/).join('.') : '');
    console.log('  ' + String(i + 1).padStart(3) + '.  ' +
      x.ratio.toFixed(2) + ':1  (阈值 ' + x.thr + ')  ' +
      x.tag + loc + '  ' + x.px + 'px');
    console.log('        text: ' + JSON.stringify(x.text));
    console.log('        fg: ' + x.fg + '   bg(合成): ' + x.bgRaw);
  });

  process.exit(5);
}

main().catch((e) => die(1, '对比度抽测失败：' + e.message));
