'use strict';
/**
 * C4 §10 星图增强验证（补齐后回归）
 * 3 项断言：
 *   1. STAR.pulseWrite / STAR.pulseRecall 存在且可调用（缺口① 主验证）
 *   2. hover / focus / unfocus 触发不抛错（STAGE1/2 主体回归）
 *   3. 星图数据正常加载（就绪判定，见 DESIGN.md §12）
 *
 * fov 轻推 -3° 属于 shader 内视觉变化，无法从外部数值验证，
 * 只能靠 CDP 截图 + 人眼确认；本脚本不尝试数值断言。
 */
const { spawn } = require('child_process');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9337;
const URL = 'http://127.0.0.1:3800/';
const OUT = 'D:/jarvis/_shots/starmap-plus-verify.png';

const PROBE = `(() => {
  try {
    if (!window.STAR) return 'ERR:STAR 未初始化';
    if (!window.__starData) return 'ERR:星图数据未加载';
    const d = window.__starData;
    const s = STAR.stats();

    const out = {
      starData: { memories: d.memories ? d.memories.length : 0,
                  entities: d.entities ? d.entities.length : 0,
                  counts: d.counts },
      starStats: s,
      starPlus: !!window.STARPLUS,

      pulseWriteType: typeof STAR.pulseWrite,
      pulseRecallType: typeof STAR.pulseRecall,
      hoverType: typeof STAR.hover,
      focusType: typeof STAR.focus,
      unfocusType: typeof STAR.unfocus,

      sampleEntity: d.entities && d.entities.length ? d.entities[0].name : null,
      callLog: [],
    };

    /* 逐个调用 —— 每个 API 都独立 try/catch，一个失败不影响后续 */
    function safe(name, fn) {
      try { const r = fn(); out.callLog.push({ name, ok: true, ret: typeof r }); }
      catch(e) { out.callLog.push({ name, ok: false, err: e.message }); }
    }

    if (out.sampleEntity) {
      safe('pulseWrite', () => STAR.pulseWrite(out.sampleEntity));
      safe('pulseRecall', () => STAR.pulseRecall(out.sampleEntity));
    }

    /* hover 用 canvas 中心附近 —— starfield 的 hover 接受相对坐标 */
    const cv = document.getElementById('graph');
    const rect = cv.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    safe('hover-center', () => STAR.hover(W * 0.5, H * 0.5));
    safe('hover-left', () => STAR.hover(W * 0.3, H * 0.4));
    safe('hover-right', () => STAR.hover(W * 0.7, H * 0.6));
    safe('hover-outside', () => STAR.hover(-1, -1));   // 离开态

    /* focus / unfocus 走节点索引 */
    if (s.nodes > 5) {
      safe('focus-3', () => STAR.focus(3));
      safe('focus-10', () => STAR.focus(Math.min(10, s.nodes - 1)));
      safe('unfocus', () => STAR.unfocus());
    }

    /* pick 是拾取的公开接口，走一遍确认无错 */
    safe('pick-center', () => STAR.pick(W * 0.5, H * 0.5));

    /* stats 再读一次，看 hover/focus 有没有让节点计数变化（不该变） */
    out.starStatsAfter = STAR.stats();

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
  console.log('启动 msedge headless（CDP 端口 '+CDP_PORT+'）…');
  child = spawn(EDGE, [
    '--headless=new','--disable-extensions','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port='+CDP_PORT,'--remote-debugging-address=127.0.0.1',
    '--window-size=1600,1000','--force-device-scale-factor=2','--hide-scrollbars', URL,
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

  /* 等 __starData 出现 + STAR.stats().memories > 0（DESIGN.md §12 就绪判定） */
  const READY = `(() => {
    try {
      return JSON.stringify({
        data: !!window.__starData,
        star: !!window.STAR,
        mems: window.STAR && window.STAR.stats ? (STAR.stats().memories || 0) : 0,
        plus: !!window.STARPLUS,
      });
    } catch(e) { return 'ERR:'+e.message; }
  })()`;
  const t0 = Date.now();
  for(;;){
    const r = await cdp.send('Runtime.evaluate', { expression: READY, returnByValue: true });
    const raw = r.result && r.result.value;
    if(typeof raw === 'string' && raw.startsWith('ERR:')) die(2, '页面抛错：'+raw);
    const s = raw ? JSON.parse(raw) : null;
    if(s && s.data && s.star && s.mems > 0) break;
    if(Date.now()-t0 > 60000) die(3, '等待超时（数据未就绪）');
    await sleep(500);
  }
  console.log('就绪：星图数据已加载');
  await sleep(2000);   // 让开场波播完

  const r2 = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
  const raw2 = r2.result && r2.result.value;
  if(typeof raw2 === 'string' && raw2.startsWith('ERR:')) die(2, 'PROBE 抛错：'+raw2);
  const out = JSON.parse(raw2);

  /* 截图 */
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x:0, y:0, width: 1600, height: 1000, scale: 1 },
  });
  require('fs').writeFileSync(OUT, Buffer.from(shot.data,'base64'));
  const kb = (require('fs').statSync(OUT).size/1024).toFixed(1);

  cdp.close();

  console.log('\n── C4 §10 星图增强验证 ──');
  console.log('截图 → '+OUT+' ('+kb+' KB)');
  console.log('starplus.js 加载：'+(out.starPlus?'✓':'✗'));
  console.log('星图规模：'+out.starStats.nodes+' 节点 / '+out.starStats.edges+' 边 / '+
    out.starStats.memories+' 记忆 / filler='+out.starStats.filler);
  console.log('API 暴露：pulseWrite='+out.pulseWriteType+
    '  pulseRecall='+out.pulseRecallType+
    '  hover='+out.hoverType+
    '  focus='+out.focusType+
    '  unfocus='+out.unfocusType);
  if (out.sampleEntity) console.log('样本实体：'+out.sampleEntity);

  const fail = [];

  /* 缺口① pulseWrite 暴露并可调用 */
  if(out.pulseWriteType !== 'function') fail.push('STAR.pulseWrite 未暴露');
  if(out.pulseRecallType !== 'function') fail.push('STAR.pulseRecall 未暴露');

  /* 全部调用不抛错 */
  const errs = out.callLog.filter(l => !l.ok);
  errs.forEach(l => fail.push('STAR.'+l.name+' 抛错：'+l.err));
  console.log('\nAPI 调用日志（'+out.callLog.length+' 次）：');
  out.callLog.forEach(l => {
    const mark = l.ok ? '✓' : '✗';
    console.log('  '+mark+' '+l.name+(l.ok?'':'  → '+l.err));
  });

  /* 节点计数没因 hover/focus 漂移（回归保护） */
  const sA = out.starStats, sB = out.starStatsAfter;
  if (sA.nodes !== sB.nodes || sA.edges !== sB.edges)
    fail.push('hover/focus 后节点/边计数漂移：'+sA.nodes+'→'+sB.nodes);

  console.log('\n── 判定 ──');
  if(fail.length){
    fail.forEach(f => console.log('  ✗ '+f));
    console.log('  失败 '+fail.length+' 项');
    process.exit(1);
  }
  console.log('  ✓ STAR.pulseWrite / pulseRecall 均暴露（缺口① 已接）');
  console.log('  ✓ 全部 '+out.callLog.length+' 次 API 调用零抛错');
  console.log('  ✓ hover / focus / unfocus / pick 回归通过');
  console.log('  ✓ 星图规模未因交互漂移');
  console.log('  （fov 轻推 -3° 属 shader 内视觉变化，需人眼目检 '+OUT+'）');
  process.exit(0);
}

main().catch(e => die(1, '验证失败：'+e.message));
