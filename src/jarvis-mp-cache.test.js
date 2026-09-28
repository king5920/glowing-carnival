'use strict';
/* mp_cache 行为测试：fresh/stale/SWR/冷启动/在途合并/失败保留旧值。 */
let pass=0,fail=0;
const eq=(a,b)=>{if(a!==b)throw new Error(`期望 ${b} 实得 ${a}`);};
const ok=a=>{if(!a)throw new Error('断言失败');};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tests=[];
const test=(n,fn)=>tests.push([n,fn]);

const {createCache}=require('./tools/mp_cache');

console.log('── 冷启动：首次 get 等 producer ──');
test('冷窗 get 拿到首帧',async()=>{
  const c=createCache(()=>sleep(20).then(()=>({v:1})),{ttlMs:1000});
  const h=await c.get();
  eq(h.value.v,1); eq(h.stale,false);
});
test('多个冷窗 get 合并为一次 producer',async()=>{
  let calls=0;
  const c=createCache(()=>{calls++;return sleep(30).then(()=>({v:9}));},{ttlMs:1000});
  const hs=await Promise.all([c.get(),c.get(),c.get()]);
  eq(calls,1); ok(hs.every(h=>h.value.v===9));
});

console.log('── 新鲜/过期 ──');
test('TTL内 fresh',async()=>{
  const c=createCache(()=>({v:1}),{ttlMs:300});
  await c.get();
  await sleep(50);
  const h=await c.get(); eq(h.stale,false);
});
test('过期 SWR：立即返回旧值并后台刷新',async()=>{
  let n=0;
  const c=createCache(()=>({v:++n}),{ttlMs:60});
  await c.get();                 // n=1
  await sleep(110);
  const s=Date.now();
  const h=await c.get();         // 立即返回旧值
  const elapsed=Date.now()-s;
  ok(elapsed<30,'SWR 不应阻塞，实得 '+elapsed);
  eq(h.value.v,1); eq(h.stale,true);
  await sleep(20);               // 后台刷新完成
  const h2=await c.get(); eq(h2.value.v,2); eq(h2.stale,false);
});

console.log('── 刷新失败 ──');
test('有旧值后刷新失败仍返回旧值（不清空）',async()=>{
  let throwNow=false,calls=0;
  const c=createCache(()=>{calls++;if(throwNow)throw new Error('boom');return {v:calls};},{ttlMs:50});
  await c.get();                 // v:1
  throwNow=true;
  await sleep(100);
  const h=await c.get();         // 过期→后台刷新失败，旧值还在
  eq(h.value.v,1); eq(h.stale,true);
});

console.log('── start 预温 ──');
test('start 后立即 get 命中（无需等待producer全程）',async()=>{
  const c=createCache(()=>sleep(40).then(()=>({v:7})),{ttlMs:1000});
  c.start();
  await sleep(70);
  const h=await c.get(); eq(h.value.v,7);
});

(async()=>{
  for(const [n,fn] of tests){
    try{await fn();console.log('  ✓ '+n);pass++;}
    catch(e){console.log('  ✗ '+n+' :: '+e.message);fail++;}
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail?1:0);
})();
