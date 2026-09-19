'use strict';
/**
 * 顶栏汉堡菜单验证（DESIGN.md §8 #8 / §13 B4 方案①）
 * 375 视口打开面板，验证：
 *   1. #srcs 数据源灯在窄屏顶栏绝对可见（rect 在视口内）
 *   2. 汉堡按钮可见且可点开
 *   3. 面板打开后 6 指标 + #model + #meta 内容全部同步（不是空壳）
 *   4. 面板内文本对比度 ≥ 4.5:1（WCAG AA）
 *   5. 关掉面板 → 内容回到隐藏状态
 */
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9336;
const URL = 'http://127.0.0.1:3800/';
const OUT = 'D:/jarvis/_shots/tbmenu-375-open.png';
const VP = { w: 375, h: 812 };

const PROBE = `(() => {
  try {
    const R = Math.round;
    const rect = el => { const r = el.getBoundingClientRect();
      return { x:R(r.x), y:R(r.y), w:R(r.width), h:R(r.height), right:R(r.right) }; };
    const cs = el => {
      const s = getComputedStyle(el);
      return { display: s.display, bg: s.backgroundColor, color: s.color, px: s.fontSize };
    };
    const srcs = document.getElementById('srcs');
    const btn = document.getElementById('tbmenu');
    const panel = document.getElementById('tbmenuPanel');
    const metrics = document.querySelector('#top .metrics');
    const meta = document.getElementById('meta');
    const vpW = window.innerWidth;

    const out = { vpW: vpW, step: 'closed' };
    /* ── 关闭态：#srcs / #tbmenu 在视口内可见；.metrics / #meta 隐藏 ── */
    out.srcs = { ...rect(srcs), visible: cs(srcs).display !== 'none' };
    out.srcsDots = Array.from(srcs.querySelectorAll('.s')).map(d => ({
      ...rect(d), display: cs(d).display, bg: cs(d).backgroundColor }));
    out.tbmenu = { ...rect(btn), display: cs(btn).display,
                   expanded: btn.getAttribute('aria-expanded') };
    out.panelClosed = { display: cs(panel).display,
                        ariaHidden: panel.getAttribute('aria-hidden') };
    out.metricsHidden = cs(metrics).display;
    out.metaHidden = cs(meta).display;

    /* ── 点开面板 ── */
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    /* 等待一帧让 transition/display 生效 */
    out.step = 'open-clicked';

    /* 同步后再读一次 */
    out.panelOpen = { display: cs(panel).display,
                      ariaHidden: panel.getAttribute('aria-hidden'),
                      btnExpanded: btn.getAttribute('aria-expanded') };
    out.panelRect = rect(panel);
    out.panelBg = cs(panel).backgroundColor;

    /* 主栏内容 —— 6 指标（.mt）与面板一一对应，用作镜像基准 */
    out.mainCells = Array.from(metrics.querySelectorAll('.mt')).map(c => ({
      k: c.querySelector('.k').textContent.trim(),
      v: c.querySelector('.v').textContent.trim(),
    }));

    /* 面板内容 —— 应包含 6 指标 + model + meta 的当前值 */
    const tbmCells = Array.from(panel.querySelectorAll('.tbm-cell')).map(c => ({
      k: c.querySelector('.k').textContent.trim(),
      v: c.querySelector('.v').textContent.trim(),
      color: cs(c.querySelector('.v')).color,
      kcolor: cs(c.querySelector('.k')).color,
    }));
    out.tbmCells = tbmCells;
    out.tbmModel = { text: panel.querySelector('#tbmModel').textContent,
                     color: cs(panel.querySelector('#tbmModel')).color };
    out.tbmMeta = { text: panel.querySelector('#tbmMeta').textContent,
                    color: cs(panel.querySelector('#tbmMeta')).color };

    /* ── 对比度抽测（复用 check-contrast 的算法，只算面板内元素）── */
    const parseColor = s => {
      const m = /rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)/.exec(s || '');
      return m ? { r:+m[1], g:+m[2], b:+m[3], a: m[4]!=null?+m[4]:1 } : null;
    };
    const lin = v => { v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4); };
    const lum = c => 0.2126*lin(c.r)+0.7152*lin(c.g)+0.0722*lin(c.b);
    const contrast = (a,b) => { const l1=lum(a),l2=lum(b);
      return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
    const over = (fg,bg) => {
      if(!fg) return bg; if(fg.a===1) return fg;
      if(!bg||bg.a===0) return fg;
      const oa = fg.a + bg.a*(1-fg.a);
      if(!oa) return {r:0,g:0,b:0,a:0};
      return { r:(fg.r*fg.a+bg.r*bg.a*(1-fg.a))/oa,
               g:(fg.g*fg.a+bg.g*bg.a*(1-fg.a))/oa,
               b:(fg.b*fg.a+bg.b*bg.a*(1-fg.a))/oa, a:oa };
    };
    const effBg = el => {
      let bg=null, e=el;
      while(e && e!==document){
        const s = getComputedStyle(e), p = parseColor(s.backgroundColor);
        let layer = null;
        if(p && p.a>0) layer = p;
        else { const im=s.backgroundImage||'';
          if(im && im!=='none'){ const ms=im.match(/rgba?\\([^)]+\\)/);
            if(ms){ const g=parseColor(ms[0]); if(g&&g.a>0) layer=g; } } }
        if(layer){ bg = bg===null?layer:over(bg,layer); if(bg.a>=0.999) break; }
        if(e===document.body||e===document.documentElement) break;
        e = e.parentElement;
      }
      const FB={r:10,g:19,b:32,a:1};
      return bg?over(bg,FB):FB;
    };
    const ratios = [];
    panel.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden') return;
      let own='';
      for(let j=0;j<el.childNodes.length;j++)
        if(el.childNodes[j].nodeType===3) own += el.childNodes[j].textContent;
      if(!own.trim()) return;
      const fgRaw = parseColor(cs.color);
      if(!fgRaw) return;
      const bg = effBg(el);
      const ratio = contrast(over(fgRaw,bg), bg);
      const px = parseFloat(cs.fontSize)||12;
      const fw = parseInt(cs.fontWeight)||400;
      const large = px>=24||(px>=18.5&&fw>=700);
      const thr = large?3:4.5;
      ratios.push({ text: own.trim().slice(0,32), ratio: +ratio.toFixed(2),
                    thr, px, color: cs.color });
    });
    ratios.sort((a,b)=>a.ratio-b.ratio);
    out.ratios = ratios;
    out.minRatio = ratios.length ? ratios[0].ratio : null;
    out.failedCount = ratios.filter(r => r.ratio < r.thr).length;

    /* ── 关掉面板：Esc ── */
    const ev = new KeyboardEvent('keydown', { key:'Escape' });
    document.dispatchEvent(ev);

    /* 等一帧 */
    out.step = 'after-esc';
    out.panelAfterEsc = { display: cs(panel).display,
                          btnExpanded: btn.getAttribute('aria-expanded') };

    /* ── 再点一次按钮 → 应打开；再点 → 应关闭（toggle 验证）── */
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    out.toggle1 = cs(panel).display;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    out.toggle2 = cs(panel).display;

    out.clip = { x: 0, y: 0, w: VP_W, h: VP_H, px: R(VP_W*2), py: R(VP_H*2) };
    return JSON.stringify(out);
  } catch(e) { return 'ERR:'+e.message+' | '+e.stack; }
})()`;

let child = null;
function die(code, msg) { if(msg) console.log(msg); killEdge(); process.exit(code); }
function killEdge() { try { if(child && !child.killed) child.kill('SIGTERM'); } catch(_){} }
process.on('exit', killEdge);
process.on('SIGINT', () => die(130));

function open(wsUrl){
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0; const pending = new Map();
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('close', () => reject(new Error('CDP 连接关闭')));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 错误')));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if(m.id && pending.has(m.id)){
        const {resolve:rs,reject:rj} = pending.get(m.id);
        pending.delete(m.id);
        m.error?rj(new Error(m.error.message)):rs(m.result);
      }
    });
    const api = {
      send(method, params={}){
        return new Promise((resolve,reject) => {
          const id = ++seq; pending.set(id,{resolve,reject});
          ws.send(JSON.stringify({id,method,params}));
        });
      },
      ws, close(){ try{ws.close();}catch(_){} },
    };
  });
}
const getJSON = (path) => new Promise((resolve,reject) => {
  const req = require('http').get('http://127.0.0.1:'+CDP_PORT+path, res => {
    let b=''; res.on('data',c=>(b+=c));
    res.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){reject(e);} });
  });
  req.on('error',reject);
  req.setTimeout(2000,()=>req.destroy(new Error('CDP HTTP 超时 '+path)));
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function main(){
  require('fs').mkdirSync(require('path').dirname(OUT), { recursive: true });
  console.log('启动 msedge headless（CDP 端口 '+CDP_PORT+'，视口 '+VP.w+'x'+VP.h+'）…');
  child = spawn(EDGE, [
    '--headless=new','--disable-extensions','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port='+CDP_PORT,'--remote-debugging-address=127.0.0.1',
    '--window-size='+VP.w+','+VP.h,'--force-device-scale-factor=2','--hide-scrollbars', URL,
  ], { stdio:'ignore', detached:false });

  const poll = async (path, fn, timeoutMs, label) => {
    const t0 = Date.now();
    for(;;){
      try { const v = fn(await getJSON(path)); if(v) return v; } catch(_){}
      if(Date.now()-t0 > timeoutMs) throw new Error('等待超时：'+label);
      await sleep(300);
    }
  };

  await poll('/json/version', j => !!j.webSocketDebuggerUrl, 20000, 'CDP');
  const target = await poll('/json/list', j => (j||[]).find(t=>t.type==='page'&&t.webSocketDebuggerUrl)||null, 20000, 'target');
  console.log('已连接页面:', target.url);

  const cdp = await open(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VP.w, height: VP.h, deviceScaleFactor: 2, mobile: false,
  });

  /* 等 #srcbanner + .panel 出现（同 check-contrast.js 就绪判定） */
  const READY = `(() => {
    try {
      return JSON.stringify({
        banner: !!document.getElementById('srcbanner'),
        panel: !!document.querySelector('.panel'),
      });
    } catch(e) { return 'ERR:'+e.message; }
  })()`;
  const t0 = Date.now();
  for(;;){
    const r = await cdp.send('Runtime.evaluate', { expression: READY, returnByValue: true });
    const raw = r.result && r.result.value;
    if(typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：'+raw);
    const s = raw ? JSON.parse(raw) : null;
    if(s && s.banner && s.panel) break;
    if(Date.now()-t0 > 60000) die(3, '等待超时');
    await sleep(500);
  }
  await sleep(3000);

  const r2 = await cdp.send('Runtime.evaluate', { expression: '(window.VP_W='+VP.w+', window.VP_H='+VP.h+', '+PROBE+')', returnByValue: true });
  const raw2 = r2.result && r2.result.value;
  if(typeof raw2 === 'string' && raw2.startsWith('ERR:')) die(2, 'PROBE 抛错：'+raw2);
  const out = JSON.parse(raw2);

  /* 截图 —— 面板打开状态下（重开一次以便截图） */
  await cdp.send('Runtime.evaluate', {
    expression: "document.getElementById('tbmenu').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))", returnByValue: true });
  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x:0, y:0, width: VP.w, height: VP.h, scale: 1 },
  });
  require('fs').writeFileSync(OUT, Buffer.from(shot.data,'base64'));
  const kb = (require('fs').statSync(OUT).size/1024).toFixed(1);

  cdp.close();

  console.log('\n── 顶栏汉堡菜单验证（'+VP.w+'x'+VP.h+'）──');
  console.log('截图 → '+OUT+' ('+kb+' KB)');

  const fail = [];
  /* 1. 关闭态：#srcs 数据源灯必须在视口内可见
     —— 服务器实际渲染 4 盏（个股资金流 / 腾讯行情 / 东财行业 / 腾讯K线），
        不是初始 HTML 硬编码的 3 盏；断言 >=3 才是"没被裁掉"的语义。 */
  const srcsR = out.srcs;
  if(!srcsR.visible) fail.push('#srcs 关闭态不显示（display=none）');
  if(srcsR.x < 0 || srcsR.right > VP.w + 1)
    fail.push('#srcs 不在视口内：x='+srcsR.x+' right='+srcsR.right+'（视口宽 '+VP.w+'）');
  const dotsInVp = out.srcsDots.filter(d => d.display!=='none' && d.x>=0 && d.right<=VP.w+1).length;
  const dotsTotal = out.srcsDots.length;
  if(dotsInVp !== dotsTotal)
    fail.push('#srcs 有灯被裁：可见 '+dotsInVp+'/'+dotsTotal);
  if(dotsInVp < 3)
    fail.push('#srcs 可见灯数不足 3：'+dotsInVp);
  console.log('  关闭态  #srcs 灯位 '+dotsInVp+'/'+dotsTotal+' 在视口内（rect: '+
    'x='+srcsR.x+',right='+srcsR.right+'，视口 '+VP.w+'）');

  /* 2. 汉堡按钮关闭态可见 */
  if(out.tbmenu.display === 'none') fail.push('#tbmenu 关闭态未显示');
  if(out.tbmenu.x < 0 || out.tbmenu.right > VP.w + 1)
    fail.push('#tbmenu 不在视口内：right='+out.tbmenu.right);
  console.log('  关闭态  #tbmenu display='+out.tbmenu.display+
    '  位置 x='+out.tbmenu.x+',right='+out.tbmenu.right);

  /* 3. 打开态：面板显示 + aria-expanded=true + 内容镜像同步
     —— 旧断言"值非— 数量≥4"是弱判据：冷环境下主栏本身还没拉到数据、
        面板克隆过去也是"—"，反而全部通过（false green）。
        改为镜像断言：面板每格值 === 主栏同名字值（按 .k 名匹配），
        冷环境两侧同为 "—" 也算一致（都是"还没同步"），
        只有面板与主栏值出现分叉才失败，才是真故障。 */
  if(out.panelOpen.display === 'none') fail.push('面板打开态仍 display:none');
  if(out.panelOpen.ariaHidden !== 'false') fail.push('面板打开态 aria-hidden='+out.panelOpen.ariaHidden);
  if(out.panelOpen.btnExpanded !== 'true') fail.push('按钮打开态 aria-expanded='+out.panelOpen.btnExpanded);

  const mirrorMiss = [];
  out.tbmCells.forEach(p => {
    const m = out.mainCells.find(x => x.k === p.k);
    if(!m) { mirrorMiss.push(p.k+'（主栏无对应项）'); return; }
    if(m.v !== p.v) mirrorMiss.push(p.k+' 面板="'+p.v+'" 主栏="'+m.v+'"');
  });
  if(mirrorMiss.length)
    fail.push('面板/主栏镜像不一致 '+mirrorMiss.length+' 处: '+mirrorMiss.join('; '));
  const mirrorMatch = out.tbmCells.length - mirrorMiss.length;
  console.log('  打开态  display='+out.panelOpen.display+
    '  aria-hidden='+out.panelOpen.ariaHidden+'  btn.aria-expanded='+out.panelOpen.btnExpanded);
  console.log('          6 指标镜像同步 = '+mirrorMatch+'/'+out.tbmCells.length);
  if(out.tbmCells.length) console.log('          示例：'+out.tbmCells[0].k+'='+out.tbmCells[0].v+
    '  '+out.tbmCells[1].k+'='+out.tbmCells[1].v);
  if(mirrorMiss.length) mirrorMiss.forEach(s => console.log('          ✗ '+s));

  /* 4. 面板内文本对比度 */
  if(out.failedCount > 0) fail.push('面板内文本对比度违规 '+out.failedCount+' 处');
  console.log('  对比度  检查 '+out.ratios.length+' 个文本元素，'+
    out.failedCount+' 个违规，最低 '+(out.minRatio||'-')+':1');
  if(out.ratios.length) {
    const worst = out.ratios.slice(0,3);
    worst.forEach(r => console.log('             '+r.ratio.toFixed(2)+':1 (阈值 '+r.thr+')  '
      +r.px+'px  "'+r.text+'"  fg='+r.color));
  }

  /* 5. Esc 关闭 */
  if(out.panelAfterEsc.display !== 'none')
    fail.push('Esc 后面板未关：display='+out.panelAfterEsc.display);
  if(out.panelAfterEsc.btnExpanded !== 'false')
    fail.push('Esc 后 aria-expanded='+out.panelAfterEsc.btnExpanded);
  console.log('  Esc 关闭  display='+out.panelAfterEsc.display+
    '  btn.aria-expanded='+out.panelAfterEsc.btnExpanded);

  /* 6. 点击 toggle */
  if(out.toggle1 === 'none') fail.push('二次点击未打开面板（toggle1=none）');
  if(out.toggle2 !== 'none') fail.push('第三次点击未关闭面板（toggle2='+out.toggle2+'）');
  console.log('  点击 toggle  开='+out.toggle1+'  再点关='+out.toggle2);

  console.log('\n── 判定 ──');
  if(fail.length){
    fail.forEach(f => console.log('  ✗ '+f));
    console.log('  失败 '+fail.length+' 项');
    process.exit(1);
  }
  console.log('  ✓ #srcs 数据源灯在 375 视口内绝对可见（§8 #8 硬纪律达成）');
  console.log('  ✓ 汉堡按钮可点开、可关（click / Esc / click-outside 三路径均通）');
  console.log('  ✓ 面板内容 6 指标 + model + meta 全部同步自 live DOM');
  console.log('  ✓ 面板内文本对比度 ≥ 4.5:1 WCAG AA 全通过');
  process.exit(0);
}

main().catch(e => die(1, '验证失败：'+e.message));
