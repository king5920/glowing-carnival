'use strict';
/**
 * §6 情景抽屉验证（C2-A 基础层）
 *
 * 断言：
 *   1. #drawerPanel + #drawerBackdrop DOM 存在，默认 aria-hidden=true
 *   2. window.Drawer 暴露 open/close/isOpen/register
 *   3. 点击 .lrow → 抽屉打开（aria-hidden=false，backdrop opacity=1）
 *   4. hash 写入 #drawer=leader:<code>
 *   5. 焦点在抽屉内（#drawerTitle 或 #drawerClose 或 #drawerBody 内）
 *   6. Esc 关闭 → 抽屉关闭（aria-hidden=true）
 *   7. 遮罩点击关闭
 *   8. × 按钮关闭
 *   9. 关闭后焦点还给 .lrow
 *  10. 刷新页面（hash 仍在）→ 抽屉自动打开
 *  11. 截图 _shots/drawer-verify.png
 *
 * 注：closescan API 首次调用需从东财抓数据（~13s），
 *     为避免验证超时，scanbox 为空时手动注入 mock 数据。
 *
 * CDP 端口 9339（9335=contrast, 9336=tbmenu, 9337=starmap-plus, 9338=charts, 9339=drawer）
 */
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9339;
const URL = 'http://127.0.0.1:3800/';
const OUT = 'D:/jarvis/_shots/drawer-verify.png';
const VP = { w: 1440, h: 900 };

const READY = `(() => {
  try {
    return JSON.stringify({
      panel: !!document.getElementById('drawerPanel'),
      backdrop: !!document.getElementById('drawerBackdrop'),
      drawer: typeof window.Drawer === 'object',
      drawerFns: typeof window.Drawer === 'object' ? {
        open: typeof window.Drawer.open,
        close: typeof window.Drawer.close,
        isOpen: typeof window.Drawer.isOpen,
        register: typeof window.Drawer.register,
      } : null,
    });
  } catch(e) { return 'ERR:'+e.message; }
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

/* 检查 scanbox 是否有内容，没有则注入 mock 数据 */
const INJECT_MOCK = `(() => {
  const scanbox = document.getElementById('scanbox');
  const hasContent = scanbox && !scanbox.querySelector('.empty');
  if (hasContent) return JSON.stringify({ injected: false, reason: 'scanbox has content' });
  if (typeof window.__renderLeaders !== 'function') return JSON.stringify({ injected: false, reason: '__renderLeaders not defined' });
  const mockData = {
    dataTime: '13:00:00',
    sectors: [
      {
        name: '人工智能', kind: 'concept', grade: '主线候选', score: 95,
        leader: '肯特催化', leaderCode: '603120', leaderPct: 10.03,
        mainPct: 3.5, d10Yi: 12.5, d5Yi: 6.8, todayYi: 2.1,
        upCount: 45, downCount: 12, dataTs: '13:00:00',
        reasons: ['龙头涨停(10.03%)', '10日主力+12.5亿', '板块普涨(75%)'],
        volumeOk: true,
      },
      {
        name: '半导体', kind: 'concept', grade: '强势板块', score: 78,
        leader: '中芯国际', leaderCode: '688981', leaderPct: 6.5,
        mainPct: 2.1, d10Yi: 8.2, d5Yi: 4.1, todayYi: 1.5,
        upCount: 30, downCount: 8, dataTs: '13:00:00',
        reasons: ['龙头强势(+6.5%)', '10日主力+8.2亿'],
        volumeOk: true,
      },
    ],
    timing: { stance: '积极', reason: '测试数据', detail: [] },
    coverage: { industry: { got: 496, total: 496, complete: true } },
    coverageComplete: true,
    staleWarning: null,
  };
  window.__renderLeaders(mockData);
  return JSON.stringify({ injected: true, sectors: mockData.sectors.length });
})()`;

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

  /* 清除上一轮测试留下的 hash */
  await cdp.send('Page.navigate', { url: URL });
  await sleep(2000);

  /* 等页面就绪 */
  const t0 = Date.now();
  for (;;) {
    const r = await cdp.send('Runtime.evaluate', { expression: READY, returnByValue: true });
    const raw = r.result && r.result.value;
    if (typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：' + raw);
    const s = raw ? JSON.parse(raw) : null;
    if (s && s.panel && s.backdrop && s.drawer) break;
    if (Date.now() - t0 > 30000) die(3, '等待超时（Drawer/DOM 未就绪）');
    await sleep(500);
  }

  /* 等 scanbox 加载（最多 5s），然后注入 mock 数据（如果仍为空） */
  await sleep(5000);
  const injectResult = await cdp.send('Runtime.evaluate', { expression: INJECT_MOCK, returnByValue: true });
  const injectD = JSON.parse(injectResult.result.value);
  console.log('  scanbox 状态: ' + (injectD.injected ? '已注入 mock (' + injectD.sectors + ' sectors)' : injectD.reason));
  await sleep(500);

  const results = [];
  function assert(label, cond, detail) {
    results.push({ label, pass: !!cond, detail: detail || '' });
    console.log('  ' + (cond ? '✓' : '✗') + ' ' + label + (detail ? ' — ' + detail : ''));
  }

  /* ═══ 断言 1: DOM 存在 ═══ */
  const r1 = await cdp.send('Runtime.evaluate', { expression:
    `(() => {
      const p = document.getElementById('drawerPanel');
      const b = document.getElementById('drawerBackdrop');
      return JSON.stringify({
        panelExists: !!p,
        backdropExists: !!b,
        panelAriaHidden: p ? p.getAttribute('aria-hidden') : null,
        backdropAriaHidden: b ? b.getAttribute('aria-hidden') : null,
      });
    })()`,
    returnByValue: true,
  });
  const d1 = JSON.parse(r1.result.value);
  assert('1. #drawerPanel 存在', d1.panelExists);
  assert('1. #drawerBackdrop 存在', d1.backdropExists);
  assert('1. 默认 panel aria-hidden=true', d1.panelAriaHidden === 'true', '实际: ' + d1.panelAriaHidden);
  assert('1. 默认 backdrop aria-hidden=true', d1.backdropAriaHidden === 'true');

  /* ═══ 断言 2: Drawer 模块 API ═══ */
  const r2 = await cdp.send('Runtime.evaluate', { expression:
    `(() => {
      return JSON.stringify({
        open: typeof window.Drawer.open,
        close: typeof window.Drawer.close,
        isOpen: typeof window.Drawer.isOpen,
        register: typeof window.Drawer.register,
        isOpenVal: window.Drawer.isOpen(),
      });
    })()`,
    returnByValue: true,
  });
  const d2 = JSON.parse(r2.result.value);
  assert('2. Drawer.open 是 function', d2.open === 'function');
  assert('2. Drawer.close 是 function', d2.close === 'function');
  assert('2. Drawer.isOpen 是 function', d2.isOpen === 'function');
  assert('2. Drawer.register 是 function', d2.register === 'function');
  assert('2. 初始 isOpen=false', d2.isOpenVal === false);

  /* ═══ 断言 3: 找到 .lrow 并点击 ═══ */
  let d3 = { found: false };
  const lrowDeadline = Date.now() + 10000;
  while (Date.now() < lrowDeadline) {
    const r3 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        const row = document.querySelector('.lrow');
        if (!row) return JSON.stringify({ found: false });
        return JSON.stringify({
          found: true,
          code: row.getAttribute('data-code'),
          name: row.getAttribute('data-name'),
        });
      })()`,
      returnByValue: true,
    });
    d3 = JSON.parse(r3.result.value);
    if (d3.found) break;
    await sleep(1000);
  }
  assert('3. 找到 .lrow', d3.found, d3.found ? 'code=' + d3.code + ' name=' + d3.name : '无 .lrow');

  if (d3.found) {
    /* 点击 .lrow */
    await cdp.send('Runtime.evaluate', { expression:
      `(document.querySelector('.lrow')).click()`,
    });
    await sleep(1000); // 等 slide-in 动画 (320ms) + setTimeout(80) + CSS transition

    /* 断言 4: 抽屉打开 */
    const r4 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        const p = document.getElementById('drawerPanel');
        const b = document.getElementById('drawerBackdrop');
        return JSON.stringify({
          panelOpen: p.classList.contains('open'),
          panelAriaHidden: p.getAttribute('aria-hidden'),
          backdropOpen: b.classList.contains('open'),
          backdropOpacity: getComputedStyle(b).opacity,
          bodyDrawerOpen: document.body.classList.contains('drawer-open'),
          isOpen: window.Drawer.isOpen(),
          hash: location.hash,
          activeElId: document.activeElement ? document.activeElement.id : null,
          activeElTag: document.activeElement ? document.activeElement.tagName : null,
          activeInPanel: p.contains(document.activeElement),
          titleText: document.getElementById('drawerTitle') ? document.getElementById('drawerTitle').textContent : null,
          bodyHTML: document.getElementById('drawerBody') ? document.getElementById('drawerBody').innerHTML.length : 0,
        });
      })()`,
      returnByValue: true,
    });
    const d4 = JSON.parse(r4.result.value);
    assert('4. 点击后 panel.open=true', d4.panelOpen);
    assert('4. 点击后 panel aria-hidden=false', d4.panelAriaHidden === 'false');
    assert('4. 点击后 backdrop.open=true', d4.backdropOpen);
    assert('4. 点击后 backdrop opacity=1', d4.backdropOpacity === '1', '实际: ' + d4.backdropOpacity);
    assert('4. 点击后 body.drawer-open=true', d4.bodyDrawerOpen);
    assert('4. 点击后 Drawer.isOpen()=true', d4.isOpen === true);
    assert('4. hash 含 #drawer=leader:', d4.hash.includes('leader:'), 'hash=' + d4.hash);
    assert('4. 焦点在抽屉内', d4.activeInPanel, 'active=' + d4.activeElId + ' ' + d4.activeElTag);
    assert('4. 标题已设置', d4.titleText && d4.titleText.length > 0, 'title=' + d4.titleText);
    assert('4. body 内容已渲染', d4.bodyHTML > 10, 'HTML 长度=' + d4.bodyHTML);

    /* ═══ 断言 5: Tab 焦点循环 ═══ */
    const r5 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        const p = document.getElementById('drawerPanel');
        p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        const after = document.activeElement;
        return JSON.stringify({
          afterId: after ? after.id : null,
          afterTag: after ? after.tagName : null,
          afterInPanel: p.contains(after),
        });
      })()`,
      returnByValue: true,
    });
    const d5 = JSON.parse(r5.result.value);
    assert('5. Tab 后焦点仍在抽屉内', d5.afterInPanel, 'after=' + d5.afterId + ' ' + d5.afterTag);

    /* ═══ 断言 6: Esc 关闭 ═══ */
    await cdp.send('Runtime.evaluate', { expression:
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    });
    await sleep(1000); // 等 close 动画 + setTimeout(80) 还焦

    const r6 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        const p = document.getElementById('drawerPanel');
        const b = document.getElementById('drawerBackdrop');
        return JSON.stringify({
          panelOpen: p.classList.contains('open'),
          panelAriaHidden: p.getAttribute('aria-hidden'),
          backdropOpen: b.classList.contains('open'),
          isOpen: window.Drawer.isOpen(),
          hash: location.hash,
          bodyDrawerOpen: document.body.classList.contains('drawer-open'),
          activeIsLrow: document.activeElement ? document.activeElement.classList.contains('lrow') : false,
          activeElId: document.activeElement ? document.activeElement.id : null,
        });
      })()`,
      returnByValue: true,
    });
    const d6 = JSON.parse(r6.result.value);
    assert('6. Esc 后 panel.open=false', !d6.panelOpen);
    assert('6. Esc 后 panel aria-hidden=true', d6.panelAriaHidden === 'true');
    assert('6. Esc 后 backdrop.open=false', !d6.backdropOpen);
    assert('6. Esc 后 Drawer.isOpen()=false', d6.isOpen === false);
    assert('6. Esc 后 hash 清空', d6.hash === '', 'hash=' + d6.hash);
    assert('6. Esc 后 body.drawer-open=false', !d6.bodyDrawerOpen);
    assert('6. Esc 后焦点还给 .lrow', d6.activeIsLrow, 'active=' + d6.activeElId);

    /* ═══ 断言 7: 遮罩点击关闭 ═══ */
    await cdp.send('Runtime.evaluate', { expression:
      `(document.querySelector('.lrow')).click()`,
    });
    await sleep(1000); // 等 close 动画 + setTimeout(80) 还焦
    await cdp.send('Runtime.evaluate', { expression:
      `document.getElementById('drawerBackdrop').click()`,
    });
    await sleep(1000); // 等 close 动画 + setTimeout(80) 还焦

    const r7 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        return JSON.stringify({
          isOpen: window.Drawer.isOpen(),
          panelOpen: document.getElementById('drawerPanel').classList.contains('open'),
        });
      })()`,
      returnByValue: true,
    });
    const d7 = JSON.parse(r7.result.value);
    assert('7. 遮罩点击后关闭', d7.isOpen === false && !d7.panelOpen);

    /* ═══ 断言 8: × 按钮关闭 ═══ */
    await cdp.send('Runtime.evaluate', { expression:
      `(document.querySelector('.lrow')).click()`,
    });
    await sleep(1000); // 等 close 动画 + setTimeout(80) 还焦
    await cdp.send('Runtime.evaluate', { expression:
      `document.getElementById('drawerClose').click()`,
    });
    await sleep(1000); // 等 close 动画 + setTimeout(80) 还焦

    const r8 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        return JSON.stringify({
          isOpen: window.Drawer.isOpen(),
          panelOpen: document.getElementById('drawerPanel').classList.contains('open'),
        });
      })()`,
      returnByValue: true,
    });
    const d8 = JSON.parse(r8.result.value);
    assert('8. × 按钮后关闭', d8.isOpen === false && !d8.panelOpen);

    /* ═══ 断言 9: hash 还原 ═══ */
    await cdp.send('Runtime.evaluate', { expression:
      `location.hash = '#drawer=leader:' + (document.querySelector('.lrow').getAttribute('data-code') || 'test')`,
    });
    await sleep(300);

    const rHash = await cdp.send('Runtime.evaluate', { expression: `location.hash`, returnByValue: true });
    console.log('  (设置 hash=' + rHash.result.value + '，刷新页面)');

    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(6000); // 等页面完全加载 + drawer 还原

    const r9 = await cdp.send('Runtime.evaluate', { expression:
      `(() => {
        const p = document.getElementById('drawerPanel');
        return JSON.stringify({
          panelExists: !!p,
          panelOpen: p ? p.classList.contains('open') : null,
          panelAriaHidden: p ? p.getAttribute('aria-hidden') : null,
          isOpen: window.Drawer ? window.Drawer.isOpen() : null,
          hash: location.hash,
        });
      })()`,
      returnByValue: true,
    });
    const d9 = JSON.parse(r9.result.value);
    assert('9. 刷新后 panel 存在', d9.panelExists);
    assert('9. 刷新后 hash 仍在', d9.hash.includes('leader:'), 'hash=' + d9.hash);
    assert('9. 刷新后抽屉自动打开', d9.isOpen === true, 'isOpen=' + d9.isOpen);
    assert('9. 刷新后 panel.open=true', d9.panelOpen === true);
  }

  /* ═══ 断言 10: 小屏 <1400px 底部全屏上滑（C2-D） ═══ */
  /* 切换到 1300x800 视口，CSS @media(max-width:1400px) 应生效 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1300, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);

  /* 重新注入 mock 数据（test 9 的 Page.reload 会丢失之前的注入） */
  await cdp.send('Runtime.evaluate', { expression: INJECT_MOCK, returnByValue: true });
  await sleep(500);

  /* 关闭可能已打开的抽屉 */
  await cdp.send('Runtime.evaluate', { expression: `window.Drawer.close()` });
  await sleep(500);

  /* 检查 CSS 是否切换为底部上滑 */
  const r10a = await cdp.send('Runtime.evaluate', { expression:
    `(() => {
      const p = document.getElementById('drawerPanel');
      const s = getComputedStyle(p);
      return JSON.stringify({
        position: s.position,
        top: s.top,
        bottom: s.bottom,
        left: s.left,
        right: s.right,
        width: s.width,
        height: s.height,
        transform: s.transform,
        borderRadius: s.borderRadius,
        borderWidth: s.borderLeftWidth + '/' + s.borderTopWidth,
      });
    })()`,
    returnByValue: true,
  });
  const d10a = JSON.parse(r10a.result.value);
  console.log('  (1300 视口 CSS: ' + JSON.stringify(d10a) + ')');
  assert('10. 1300 视口 panel top 非 0（底部定位）', d10a.top !== '0px', '实际 top=' + d10a.top);
  assert('10. 1300 视口 panel bottom=0', d10a.bottom === '0px', '实际 bottom=' + d10a.bottom);
  assert('10. 1300 视口 panel left=0', d10a.left === '0px', '实际 left=' + d10a.left);
  assert('10. 1300 视口 panel right=0', d10a.right === '0px', '实际 right=' + d10a.right);
  assert('10. 1300 视口 panel 圆角顶部', d10a.borderRadius.startsWith('16px'), '实际 borderRadius=' + d10a.borderRadius);
  assert('10. 1300 视口 panel 关闭态有 transform（非 none）',
    d10a.transform !== 'none', '实际 transform=' + d10a.transform);

  /* 打开抽屉，验证从底部滑入 */
  await cdp.send('Runtime.evaluate', { expression:
    `(document.querySelector('.lrow')).click()`,
  });
  await sleep(1000);

  const r10c = await cdp.send('Runtime.evaluate', { expression:
    `(() => {
      const p = document.getElementById('drawerPanel');
      const s = getComputedStyle(p);
      return JSON.stringify({
        open: p.classList.contains('open'),
        isOpen: window.Drawer.isOpen(),
        transform: s.transform,
        height: s.height,
        panelVisible: p.getBoundingClientRect().bottom > 0,
      });
    })()`,
    returnByValue: true,
  });
  const d10c = JSON.parse(r10c.result.value);
  console.log('  (1300 视口打开态: ' + JSON.stringify(d10c) + ')');
  assert('10. 1300 视口打开后 panel.open=true', d10c.open === true);
  assert('10. 1300 视口打开后 Drawer.isOpen()=true', d10c.isOpen === true);
  assert('10. 1300 视口打开后 transform 为 none 或包含 0（底部滑入）',
    d10c.transform === 'none' || d10c.transform === 'matrix(1, 0, 0, 1, 0, 0)', '实际 transform=' + d10c.transform);
  assert('10. 1300 视口打开后 panel 可见', d10c.panelVisible === true);

  /* 恢复 1440x900 视口 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(300);

  /* ═══ 截图 ═══ */
  const rShot = await cdp.send('Runtime.evaluate', { expression:
    `(() => {
      const row = document.querySelector('.lrow');
      if (row) { row.click(); return 'clicked'; }
      return 'no row';
    })()`,
    returnByValue: true,
  });
  await sleep(1000);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  const kb = (require('fs').statSync(OUT).size / 1024).toFixed(1);
  console.log('  截图 → ' + OUT + ' (' + kb + ' KB)');

  cdp.close();

  /* ═══ 汇总 ═══ */
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log('\n═══════════════════════════════════════');
  console.log('§6 抽屉验证: ' + passed + ' 通过, ' + failed + ' 失败');
  console.log('═══════════════════════════════════════');

  if (failed > 0) {
    results.filter(r => !r.pass).forEach(r => console.log('  ✗ ' + r.label + (r.detail ? ' — ' + r.detail : '')));
    die(1, '验证未通过');
  }
  die(0);
}

main().catch(e => die(1, '验证失败: ' + e.message));
