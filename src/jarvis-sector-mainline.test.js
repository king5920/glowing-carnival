'use strict';
/* sector_mainline 主线选择+样本外回测测试（纯函数，自造行不联网） */
const tests=[];const test=(n,fn)=>tests.push([n,fn]);
let pass=0,fail=0;
const ok=(a,m)=>{if(!a)throw new Error(m||'断言失败');};
const eq=(a,b,m)=>{if(a!==b)throw new Error((m||'')+`期望 ${b} 实得 ${a}`);};

const ml=require('./tools/sector_mainline');

/* 造 days 天、sectors 个板块的行。
 * 某板块若 strong=true：每天净流入且金额大 → 应被识别为主线 */
function mkRows(days, sectors, { strongCode='A' }={}){
  const byDate = new Map();
  for(let di=0;di<days;di++){
    const date='2026-09-'+String(di+9).padStart(2,'0');
    const arr=[];
    for(let s=0;s<sectors;s++){
      const code=String.fromCharCode(65+s);
      const strong=code===strongCode;
      arr.push({
        date,code,name:'板块'+code,kind:'industry',
        today_yi: strong?6:(di%2?1:-1),
        level:100+di*(strong?2:0.1),change_pct:strong?3:0.2,
        leader:strong?'龙头X':null,leader_pct:strong?10:null,
        fwd_d1:strong?2:0,fwd_d3:strong?4:0,fwd_d5:strong?6:0,
      });
    }
    byDate.set(date,arr);
  }
  return byDate;
}

test('selectAsOf: 连续净流入且体量大的板块被识别为主线',()=>{
  const byDate=mkRows(6,8);
  const dates=[...byDate.keys()];
  const acc=[...byDate.values()].flat();
  const out=ml.selectAsOf(acc,dates);
  const a=out.find(x=>x.code==='A');
  ok(a,'板块A应在候选中');eq(a.mainline,true,'A应为主线：');
  // 主线排在最前
  eq(out[0].code,'A');
});

test('selectAsOf: 数据天数不足MIN_LOOKBACK也能返回但可能无主线',()=>{
  const byDate=mkRows(2,5);
  const dates=[...byDate.keys()];
  const out=ml.selectAsOf([...byDate.values()].flat(),dates);
  ok(Array.isArray(out));
  // 2天 < streak要求，难成主线
  ok(out.every(x=>x.mainline===false||x.days<5));
});

test('backtest: 样本外事件只在startIndex之后产生',()=>{
  const byDate=mkRows(8,6);
  const dates=[...byDate.keys()];
  const r=ml.backtest(dates,d=>byDate.get(d),{fwdKey:'fwd_d3',startIndex:5});
  // i=5,6,7 三天；每天A为主线 → 3事件
  eq(r.events,3);
});

test('backtest: 事件不足时reliable=false且note诚实',()=>{
  const byDate=mkRows(8,6);
  const dates=[...byDate.keys()];
  const r=ml.backtest(dates,d=>byDate.get(d),{fwdKey:'fwd_d3'});
  eq(r.reliable,false,'6以下事件不采信：');
  ok(/不采信/.test(r.note));
});

test('backtest: fwd缺失的事件被剔除（null≠0）',()=>{
  const byDate=mkRows(8,6);
  // 把所有 fwd_d3 置null
  for(const arr of byDate.values())for(const x of arr)x.fwd_d3=null;
  const dates=[...byDate.keys()];
  const r=ml.backtest(dates,d=>byDate.get(d),{fwdKey:'fwd_d3'});
  eq(r.withFwd,0);eq(r.stats.winRate,null);
});

(async()=>{
  for(const [n,fn] of tests){
    try{await fn();console.log('  ✓ '+n);pass++;}
    catch(e){console.log('  ✗ '+n+' :: '+e.message);fail++;}
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail?1:0);
})();
