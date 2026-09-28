'use strict';
/* sentiment_score 单测：锁意图（null安全/方向/重归一化/序列），不锁会变的展示数以外的口径。 */
let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); console.log('  ✓ ' + n); pass++; } catch (e) { console.log('  ✗ ' + n + ' :: ' + e.message); fail++; } };
const eq = (a, b) => { if (a !== b) throw new Error(`期望 ${b} 实得 ${a}`); };
const ok = (a) => { if (!a) throw new Error('断言失败'); };
const approx = (a, b, d = 0.5) => { if (Math.abs(a - b) > d) throw new Error(`期望≈${b} 实得 ${a}`); };

const ss = require('./tools/sentiment_score');

console.log('── RSI 超跌映射 ──');
test('RSI≤30→1', () => eq(ss.rsiOversoldPart(28), 1));
test('RSI≥50→0', () => eq(ss.rsiOversoldPart(55), 0));
test('RSI=40→0.5', () => approx(ss.rsiOversoldPart(40), 0.5));
test('RSI null→null（null≠0）', () => eq(ss.rsiOversoldPart(null), null));

console.log('── 分位 ──');
test('最低点分位接近0', () => { const p = ss.percentileOf([1, 5, 20], 1); ok(p >= 0 && p < 0.2); });
test('最高点分位高', () => { const p = ss.percentileOf([1, 5, 20], 20); ok(p > 0.8); });
test('null值→null', () => eq(ss.percentileOf([1, 2], null), null));
test('空数组→null', () => eq(ss.percentileOf([], 3), null));

console.log('── 当日合成 ──');
test('全0分位→0 平静', () => {
  const r = ss.scoreToday({ limitDownPct: 0, brokenRatePct: 0, rsi: 55 });
  eq(r.score, 0); eq(r.label, '情绪平静'); eq(r.state, 'calm');
});
test('高分位→恐慌冰点', () => {
  const r = ss.scoreToday({ limitDownPct: 0.98, brokenRatePct: 0.95, rsi: 28 });
  ok(r.score >= 70); eq(r.state, 'panic'); eq(r.label, '恐慌冰点');
});
test('缺跌停分位→unknown（不用0顶）', () => {
  const r = ss.scoreToday({ limitDownPct: null, brokenRatePct: 0.5, rsi: 40 });
  eq(r.score, null); eq(r.state, 'unknown');
});
test('无RSI时两料重归一化仍可算', () => {
  const r = ss.scoreToday({ limitDownPct: 0.8, brokenRatePct: 0.6, rsi: null });
  ok(r.score >= 60); ok(r.parts.rsiPart === null);
});
test('calibrated恒false（诚实）', () => eq(ss.scoreToday({limitDownPct:0,brokenRatePct:0,rsi:50}).calibrated, false));

console.log('── 序列 ──');
test('序列长度=days', () => {
  const daily = Array.from({length:20},(_,i)=>({date:'2026-09-0'+(i%9)+i,limit_down:i,broken_rate:i}));
  const s = ss.series(daily,null,20);
  eq(s.length,20);
});
test('有RSI的日子 hasRsi=true', () => {
  const daily = [{date:'d1',limit_down:1,broken_rate:1},{date:'d2',limit_down:2,broken_rate:2}];
  const m = new Map([['d1',null],['d2',30]]);
  const s = ss.series(daily,m,20);
  eq(s[0].hasRsi,false); eq(s[1].hasRsi,true);
});
test('回填日无指数→hasRsi=false但仍有score', () => {
  const daily = [{date:'d1',limit_down:1,broken_rate:1},{date:'d2',limit_down:2,broken_rate:2}];
  const s = ss.series(daily,null,20);
  ok(s[1].score != null); eq(s[1].hasRsi,false);
});
test('空daily→空序列', () => eq(ss.series([],null,20).length,0));

console.log(`\n通过: ${pass} | 失败: ${fail}`);
process.exit(fail ? 1 : 0);
