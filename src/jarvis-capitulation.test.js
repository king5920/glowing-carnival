'use strict';
/* 散户崩溃冰点引擎（capitulation.js）纯函数单测。
 * 重点锁：分位、连板断层、共振、阶段开关（不接飞刀）、左侧越级、缺数据不编造、前向胜率。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const F = require('./tools/capitulation');

/* ── 分位数 ── */
test('percentile：当前值在历史中的≤占比', () => {
  const hist = [1, 2, 3, 4, 5];
  assert.strictEqual(F.percentile(5, hist), 1);        // 最大 → 100%
  assert.strictEqual(F.percentile(1, hist), 0.2);
  assert.strictEqual(F.percentile(3, hist), 0.6);
});
test('percentile：空历史/空值给 null，不当0', () => {
  assert.strictEqual(F.percentile(3, []), null);
  assert.strictEqual(F.percentile(null, [1, 2]), null);
  assert.strictEqual(F.percentile(3, [null, undefined]), null);
});

/* ── 连板高度断层 ── */
test('ladderBreak：最高板≤1 即断层', () => {
  assert.strictEqual(F.ladderBreak({ ladderHeight: 1, ladder: { 1: 40 } }).broken, true);
  assert.strictEqual(F.ladderBreak({ ladderHeight: 0 }).broken, true);
});
test('ladderBreak：最高板高但≥3板家数=0 也算断层', () => {
  // 最高2板，没有≥3板
  assert.strictEqual(F.ladderBreak({ ladderHeight: 2, ladder: { 1: 20, 2: 3 } }).broken, true);
});
test('ladderBreak：有≥3板则未断层', () => {
  assert.strictEqual(F.ladderBreak({ ladderHeight: 4, ladder: { 1: 20, 2: 5, 4: 1 } }).broken, false);
});
test('ladderBreak：无数据给 null 不猜', () => {
  assert.strictEqual(F.ladderBreak(null).broken, null);
  assert.strictEqual(F.ladderBreak({}).broken, null);
});

/* ── 造历史样本（白名单口径的 alert_samples 行）── */
function histRows(n, gen) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(gen(i));
  return rows;
}
const CAL_N = 20;
// 平静历史：跌停多在 0~6，炸板率 5~20%
const calmHist = histRows(CAL_N, i => ({ limit_down: (i % 7), broken_rate: 5 + (i % 16), ladder_height: 3 + (i % 3) }));

function snap(over = {}) {
  return Object.assign({
    limitUpCount: 20, brokenCount: 30, limitDownCount: 3,
    brokenRate: 15, ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 }, sealFundYi: 20,
  }, over);
}
const shOK = { rsi14: 35, aboveMa20: false, close: 3000, ma20: 3100 };

/* ── 无共振：平静快照不应触发 ── */
test('平静快照：无共振，tier=none', () => {
  const r = F.evaluate(snap(), shOK, calmHist, { phase: '退潮期' });
  assert.strictEqual(r.fear, false);
  assert.strictEqual(r.tier, 'none');
});

/* ── 普通冰点：两料极端+超跌+阶段磨底 ── */
test('普通冰点：跌停+炸板率共振、RSI超卖、磨底期 → normal/right', () => {
  const se = snap({
    limitDownCount: 60,            // 远超历史0~6 → 高分位
    brokenRate: 55,                // 远超历史5~20
    ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 },  // 第3料未断层
  });
  const r = F.evaluate(se, { rsi14: 28, aboveMa20: false }, calmHist, { phase: '磨底期' });
  assert.strictEqual(r.resonance, true);
  assert.strictEqual(r.tier, 'normal');
  assert.strictEqual(r.side, 'right');
  assert(/值得关注|未标定/.test(r.label));
});

/* ── 阶段开关：同样恐慌但在主升期 → 不放行（不接飞刀的镜像：高位不当冰点）── */
test('阶段开关：主升期出现共振也不放行普通冰点，降级 watch', () => {
  const se = snap({ limitDownCount: 60, brokenRate: 55, ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 } });
  const r = F.evaluate(se, { rsi14: 28, aboveMa20: false }, calmHist, { phase: '主升期' });
  assert.strictEqual(r.resonance, true);
  assert.notStrictEqual(r.tier, 'normal', '主升期不应放行普通冰点');
  assert(/阶段不符|只观察/.test(r.label + r.reason));
});

/* ── 刚开始跌（退潮初中段）也要防飞刀：这里退潮期在放行名单，但需超跌确认；
   RSI 不低时即便共振也不能 normal ── */
test('无超跌确认：共振但RSI不低 → 不发普通冰点', () => {
  const se = snap({ limitDownCount: 60, brokenRate: 55, ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 } });
  const r = F.evaluate(se, { rsi14: 55, aboveMa20: true }, calmHist, { phase: '磨底期' });
  assert.notStrictEqual(r.tier, 'normal');
});

/* ── 极端左侧越级：三料全中 + 分位≥95% + RSI极端 ── */
test('极端恐慌：三料全中+分位≥95%+RSI≤30 → extreme/left，缠论未确认也放行', () => {
  const se = snap({
    limitDownCount: 200, brokenRate: 80,
    ladderHeight: 1, ladder: { 1: 5 },        // 第3料断层
  });
  const r = F.evaluate(se, { rsi14: 22, aboveMa20: false }, calmHist, null);  // 无缠论阶段
  assert.strictEqual(r.tier, 'extreme');
  assert.strictEqual(r.side, 'left');
  assert(/左侧/.test(r.label));
});

/* ── 极端但RSI不够极端 → 不越级（左侧门槛必须严）── */
test('三料全中但RSI不极端、且阶段不符 → 不能越级成 extreme', () => {
  const se = snap({ limitDownCount: 200, brokenRate: 80, ladderHeight: 1, ladder: { 1: 5 } });
  const r = F.evaluate(se, { rsi14: 45, aboveMa20: true }, calmHist, { phase: '主升期' });
  assert.notStrictEqual(r.tier, 'extreme');
});

/* ── 缺数据不编造 ── */
test('情绪快照为 null → tier unknown', () => {
  const r = F.evaluate(null, shOK, calmHist, { phase: '磨底期' });
  assert.strictEqual(r.tier, 'unknown');
});
test('两料以上缺失 → unknown，不把缺失误判为安全', () => {
  // 只有连板数据，跌停和炸板率都没有
  const se = { limitDownCount: null, brokenRate: null, ladderHeight: 4, ladder: { 1: 10, 2: 3, 4: 1 } };
  const r = F.evaluate(se, shOK, [], { phase: '磨底期' });
  assert.strictEqual(r.tier, 'unknown');
});

/* ── 未标定：样本不足强制 calibrated:false ── */
test('样本<15天强制 calibrated:false', () => {
  const se = snap({ limitDownCount: 60, brokenRate: 55, ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 } });
  const r = F.evaluate(se, { rsi14: 28, aboveMa20: false }, calmHist.slice(0, 5), { phase: '磨底期' });
  assert.strictEqual(r.calibrated, false);
  assert(/未标定/.test(r.label));
});

/* ── 措辞红线：绝不出现"可以买" ── */
test('措辞红线：任何结果都不含"可以买"', () => {
  const cases = [
    F.evaluate(snap(), shOK, calmHist, { phase: '退潮期' }),
    F.evaluate(snap({ limitDownCount: 200, brokenRate: 80, ladderHeight: 1, ladder: { 1: 5 } }), { rsi14: 22, aboveMa20: false }, calmHist, null),
  ];
  for (const r of cases) assert(!/可以买|买入建议/.test(r.label + r.reason), '出现买入措辞: ' + r.label);
});

/* ── 前向胜率裁判 ── */
test('evaluateFear：统计 fwd_d1/d3 胜率与均值', () => {
  const rows = [
    { fwd_d1: 1.2, fwd_d3: 2.5 }, { fwd_d1: -0.5, fwd_d3: 1.1 },
    { fwd_d1: 0.8, fwd_d3: -0.3 }, { fwd_d1: null, fwd_d3: null },
  ];
  const r = F.evaluateFear(rows);
  assert.strictEqual(r.d1.n, 3);
  assert.strictEqual(r.d1.wins, 2);             // 1.2, 0.8 为正
  assert.strictEqual(r.d1.winRate, +(2 / 3).toFixed(3));
  assert.strictEqual(r.d3.n, 3);
});
test('evaluateFear：空/未回填 → 无法裁判，不编造胜率', () => {
  const r = F.evaluateFear([{ fwd_d1: null, fwd_d3: null }]);
  assert.strictEqual(r.d1.winRate, null);
  assert(/无法裁判/.test(r.verdict));
});
test('evaluateFear：3日胜率<45% 提示可能无效', () => {
  const rows = [{ fwd_d3: -1 }, { fwd_d3: -2 }, { fwd_d3: 0.4 }];  // 1/3 胜
  const r = F.evaluateFear(rows);
  assert(/无效/.test(r.verdict));
});

async function main() {
  for (const { name, fn } of _t) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_t.length}）`);
  process.exit(fail ? 1 : 0);
}
main();
