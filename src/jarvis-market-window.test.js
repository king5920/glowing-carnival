'use strict';
/* market_window 时机总开关测试：窗口规则 / null安全 / 样本外backtest */
const tests=[];const test=(n,fn)=>tests.push([n,fn]);
let pass=0,fail=0;
const ok=(a,m)=>{if(!a)throw new Error(m||'断言失败');};
const eq=(a,b,m)=>{if(a!==b)throw new Error((m||'')+`期望 ${b} 实得 ${a}`);};

const mw=require('./tools/market_window');

test('退潮期+恐慌=回补观察；+警戒=回避',()=>{
  const a=mw.windowOf('退潮期',75);
  eq(a.code,'cap_watch','高恐慌应回补观察：');ok(/观察/.test(a.window));
  const b=mw.windowOf('退潮期',50);
  eq(b.code,'risk_off','警戒应回避：');
  const c=mw.windowOf('退潮期',20);
  eq(c.code,'risk_off','退潮即使情绪平也回避：');
});

test('主升期+情绪稳=参与；+恐慌=观察',()=>{
  eq(mw.windowOf('主升期',30).code,'engage');
  eq(mw.windowOf('主升期',80).code,'cap_watch');
});

test('启动期+不恐慌=参与；高位震荡=持有；磨底+稳=等待',()=>{
  eq(mw.windowOf('启动期',35).code,'engage');
  eq(mw.windowOf('高位震荡期',40).code,'hold');
  eq(mw.windowOf('磨底期',30).code,'wait');
  eq(mw.windowOf('磨底期',60).code,'cap_watch');
});

test('null安全：未知阶段/缺情绪=unknown（不默认）',()=>{
  eq(mw.windowOf('不存在阶段',30).code,'unknown');
  eq(mw.windowOf('主升期',null).code,'unknown');
  eq(mw.windowOf(null,30).code,'unknown');
});

test('backtest: 缺注入函数抛错',()=>{
  let threw=false;try{mw.backtestWindows([],{});}catch(e){threw=true;}
  ok(threw);
});

test('backtest: 只汇总带fwd、且下标≥minIndex的样本外窗口',()=>{
  // 60行；phase恒主升，score<40 → engage
  const daily=[];
  for(let i=0;i<60;i++)daily.push({date:'d'+i,fwd_d3:i%2?1:-1});
  const phaseAt=()=>'主升期';
  const scoreAt=()=>30;
  const r=mw.backtestWindows(daily,{phaseAt,scoreAt},{minIndex:40,fwdKey:'fwd_d3'});
  eq(r.n,20,'下标40..59共20：');
  eq(r.windows.length,1);
  eq(r.windows[0].window,'参与窗口');
  // 胜率：i%2 在40..59 → 10正10负 = 50%
  eq(r.windows[0].winRate,0.5);
});

test('backtest: phase或score为null的日跳过',()=>{
  const daily=[];for(let i=0;i<50;i++)daily.push({date:'d'+i,fwd_d3:1});
  let calls=0;
  const r=mw.backtestWindows(daily,{phaseAt:()=>null,scoreAt:()=>30},{minIndex:40});
  eq(r.n,0,'phase全null应0：');
});

(async()=>{
  for(const [n,fn] of tests){
    try{await fn();console.log('  ✓ '+n);pass++;}
    catch(e){console.log('  ✗ '+n+' :: '+e.message);fail++;}
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail?1:0);
})();
