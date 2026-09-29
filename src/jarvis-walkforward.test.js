'use strict';
/* walkforward 样本外回测测试：无未来函数 / 过滤器分组 / 小样本诚实 / MA */
const tests=[];const test=(n,fn)=>tests.push([n,fn]);
let pass=0,fail=0;
const ok=(a,m)=>{if(!a)throw new Error(m||'断言失败');};
const eq=(a,b,m)=>{if(a!==b)throw new Error((m||'')+`期望 ${b} 实得 ${a}`);};

const wf=require('./tools/walkforward');
const sm=require('./tools/sentiment_model');

/* 构造带技术面+前向收益的 N 日序列。
 * makeFwd(score-ish)：让"恐慌日"(limit_down高)之后收益为+ → 有反向边缘 */
function mkData(n,{edge=true}={}){
  const rows=[];
  for(let i=0;i<n;i++){
    const panic=i%6===5;
    const close=100+Math.sin(i/4)*3+(i%6===5?-2.5:0);
    rows.push({
      date:'2026-'+String(i).padStart(3,'0'),slot:'b',
      limit_down:panic?30:2,broken_rate:panic?50:12,ladder_height:panic?1:4,
      seal_fund_yi:panic?10:70,
      sh_close:+close.toFixed(2),
      sh_rsi14:panic?32:48,
      fwd_d3:null,
    });
  }
  // 前向收益：收盘 i → i+3。edge=true 时让恐慌后弹（用数据驱动而非直接标记）
  for(let i=0;i<n;i++){
    if(i+3<n){
      const f=(rows[i+3].sh_close-rows[i].sh_close)/rows[i].sh_close*100;
      rows[i].fwd_d3=+f.toFixed(2);
    }
  }
  return rows;
}

test('ma: 不足窗口返回null，足够给均值',()=>{
  eq(wf.ma([1,2,3],5),null);
  eq(wf.ma([1,2,3,4],4),2.5);
  eq(wf.ma([1,null,2,3,4],4),2.5,'null被过滤：');
});

test('winStats: 胜率/均值/小样本',()=>{
  eq(wf.winStats([]).winRate,null);
  const s=wf.winStats([{fwd:1},{fwd:-1},{fwd:2}]);
  eq(s.n,3);eq(s.winRate,0.667);eq(s.avgFwd,0.67);
});

test('walkForward: 训练不足不起评',()=>{
  const rows=mkData(30);
  const r=wf.walkForward(rows,{minTrain:40});
  eq(r.n,0,'历史不足应无预测：');
});

test('walkForward: 每个预测只用过去（无未来函数）',()=>{
  const rows=mkData(120);
  const r=wf.walkForward(rows,{trainWindow:60,minTrain:40});
  ok(r.n>0,'应有样本外预测');
  // 预测下标都 ≥ minTrain
  ok(r.predictions.every(p=>p.i>=40));
  // 日期严格来自其i
  ok(r.predictions[0].date===rows[r.predictions[0].i].date);
});

test('walkForward: 信号阈值过滤正确',()=>{
  const rows=mkData(120);
  const r=wf.walkForward(rows,{trainWindow:60,signalMin:40});
  ok(r.signal.n<=r.n);
  ok(r.predictions.filter(p=>p.score>=40).length>=r.signal.n);
});

test('walkForward: 过滤器分组只含可判定组',()=>{
  const rows=mkData(120);
  const r=wf.walkForward(rows,{trainWindow:60});
  ok(r.filters.trend20.groups.length>=0);
  // 各组 n 之和 ≤ 信号总数
  const sum=r.filters.trend20.groups.reduce((a,g)=>a+g.n,0);
  ok(sum<=r.signal.n);
});

test('walkForward: 无信号时note诚实不编造',()=>{
  const rows=mkData(120);
  const r=wf.walkForward(rows,{trainWindow:60,signalMin:99});
  eq(r.signal.n,0);
  ok(/不足/.test(r.note));
});

test('MA60/量能过滤器存在且分组安全',()=>{
  const rows=mkData(120);
  const r=wf.walkForward(rows,{trainWindow:80});
  ok(r.filters.trend60);
  ok(r.filters.volume);
  // 量能分组标签只在三档之内或null
  for(const p of r.predictions){
    const v=p.groups.volume;
    ok(v==null||/缩量|放量|平量/.test(v));
  }
});

test('evaluateConfirmed: 输出结构与门槛诚实',()=>{
  const rows=mkData(160);
  const c=wf.evaluateConfirmed(rows,{windows:[60,90]});
  ok(Array.isArray(c.confirmed));
  eq(c.evaluated,2);
  // 每个确认项必须满足门槛
  for(const x of c.confirmed){
    ok(x.n>=wf.CONFIRM_MIN_N);
    ok(x.winRate>=wf.CONFIRM_WINRATE);
    ok(x.avgFwd>0);
  }
  ok(typeof c.note==='string');
});

test('enrichDaily: volume按日期补齐',()=>{
  const rows=mkData(40).map(r=>({...r,sh_volume:null}));
  const bars=rows.map(r=>({date:r.date,close:r.sh_close,volume:12345}));
  const out=sm.enrichDaily(rows,bars,null);
  eq(out.filter(x=>x.sh_volume===12345).length,40);
});

(async()=>{
  for(const [n,fn] of tests){
    try{await fn();console.log('  ✓ '+n);pass++;}
    catch(e){console.log('  ✗ '+n+' :: '+e.message);fail++;}
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail?1:0);
})();
