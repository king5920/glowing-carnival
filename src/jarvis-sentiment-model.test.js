'use strict';
/* sentiment_model 多因子情绪模型测试：因子计算/expanding分位/RSI/标定闸门/缺失安全。 */
const tests=[];
const test=(n,fn)=>tests.push([n,fn]);
let pass=0,fail=0;
const eq=(a,b,m)=>{if(a!==b)throw new Error((m||'')+`期望 ${b} 实得 ${a}`);};
const ok=(a,m)=>{if(!a)throw new Error(m||'断言失败');};
const approx=(a,b,t=0.06)=>{if(Math.abs(a-b)>t)throw new Error(`约等失败 ${a} vs ${b}`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const sm=require('./tools/sentiment_model');

/* 构造 N 行 daily，limit_down 在某日拉高，便于分位 */
function mkRows(n,opts={}){
  const rows=[];
  for(let i=0;i<n;i++){
    rows.push({
      date:'2026-'+String(i+1).padStart(2,'0')+'-01',
      slot:'backfill',
      limit_down: opts.ldAt===i?40: (i%7===0?8:2),
      broken_rate: opts.brAt===i?70: (i%5===0?30:12),
      ladder_height: opts.ladAt===i?1:3,
      seal_fund_yi: 50+(i%9)*5,
      sh_rsi14:null, cyb_rsi14:null, sh_close:null,
      fwd_d3:null,
    });
  }
  return rows;
}

test('expPercentile 只用过去、不含当日',()=>{
  const p=sm.expPercentile([1,2,3,4],5);
  eq(p,1,'当前最大应=1分位：');
  const p2=sm.expPercentile([10,20],5);
  eq(p2,0,'当前最小应=0分位：');
  eq(sm.expPercentile([],5),null,'空过去应null：');
  eq(sm.expPercentile([1,2],null),null,'v缺失应null：');
});

test('rsiPart/ladderPart/dropPart 边界',()=>{
  eq(sm.rsiPart(30),1);eq(sm.rsiPart(50),0);approx(sm.rsiPart(40),0.5);
  eq(sm.rsiPart(null),null);
  eq(sm.ladderPart(1),1);eq(sm.ladderPart(5),0);eq(sm.ladderPart(null),null);
  eq(sm.dropPart(-4),1);eq(sm.dropPart(0),0);eq(sm.dropPart(2),0);eq(sm.dropPart(null),null);
});

test('factors: 当日因子 + null安全',()=>{
  const rows=mkRows(40,{ldAt:39});
  const f=sm.factors(rows[39],rows.slice(0,39));
  eq(f.limitDown,1,'拉高跌停当日应满分位：');
  ok(f.brokenRate!=null);
  // 缺技术字段的行：RSI 因子为 null，不被当0
  eq(f.shRsi,null);eq(f.cybRsi,null);eq(f.shDrop,null);
});

test('weightedScore 缺失因子重归一化（null≠0）',()=>{
  const w={a:0.5,b:0.5};
  eq(sm.weightedScore({a:1,b:null},w),100,'只有a时应=100：');
  eq(sm.weightedScore({a:null,b:null},w),null,'全null应null：');
});

test('calibrate 样本不足→未标定/先验',()=>{
  const rows=mkRows(10);
  const c=sm.calibrate(rows);
  eq(c.calibrated,false);eq(c.effective,false);eq(c.weights,sm.PRIOR_WEIGHTS);
});

test('calibrate 闸门：反向边缘不足不宣称有效',()=>{
  // 手工构造：恐慌日（跌停多/连板低）之后继续大跌 → 因子与fwd正相关，无反向边缘
  const rows=[];
  for(let i=0;i<50;i++){
    const panic=i%5===0;
    rows.push({
      date:'d'+i,slot:'b',
      limit_down: panic?35:2, broken_rate: panic?60:10, ladder_height: panic?1:4,
      seal_fund_yi: panic?10:80, sh_rsi14:null,cyb_rsi14:null,sh_close:null,
      fwd_d3: panic?-3:+1.5,
    });
  }
  const c=sm.calibrate(rows);
  eq(c.calibrated,false,'恐慌后更跌=无反向边缘：');
  ok(!c.topQuartile || c.topQuartile.winRate<sm.EDGE_MIN_WINRATE,
    '高恐慌段胜率应低于门槛（或证据不足null）');
});

test('calibrate 有效：高恐慌后显著反弹→标定通过',()=>{
  const rows=[];
  for(let i=0;i<60;i++){
    const panic=i%5===0;
    rows.push({
      date:'e'+i,slot:'b',
      limit_down: panic?35:2, broken_rate: panic?60:10, ladder_height: panic?1:4,
      seal_fund_yi: panic?10:80, sh_rsi14:null,cyb_rsi14:null,sh_close:null,
      fwd_d3: panic?4:+0.2,
    });
  }
  const c=sm.calibrate(rows);
  ok(c.topQuartile,'应给胜率证据');
  eq(c.calibrated,true,'恐慌后显著反弹应标定：');
  ok(c.topQuartile.winRate>=sm.EDGE_MIN_WINRATE);
});

test('rsiSeries 长度与前导null',()=>{
  const closes=Array.from({length:30},(_,i)=>100+Math.sin(i/3)*5+i*0.1);
  const r=sm.rsiSeries(closes);
  eq(r.length,30);eq(r[0],null,'前期不足应null：');ok(r[15]>=0&&r[15]<=100);
});

test('enrichDaily 用K线补RSI/当日涨跌',()=>{
  const rows=mkRows(20).map((r,i)=>({...r,date:'2026-01-'+String(i+1).padStart(2,'0')}));
  const bars=rows.map((r,i)=>({date:r.date,close:100+(i%4===0?-3:i)}));
  const out=sm.enrichDaily(rows,bars,null);
  eq(out.filter(x=>x.__shChange!=null).length,19,'除首日外都应有当日涨跌：');
  ok(out[19].sh_rsi14==null||typeof out[19].sh_rsi14==='number');
});

(async()=>{
  for(const [n,fn] of tests){
    try{await fn();console.log('  ✓ '+n);pass++;}
    catch(e){console.log('  ✗ '+n+' :: '+e.message);fail++;}
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail?1:0);
})();
