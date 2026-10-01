'use strict';
/* 标定总账：锁三态门槛，锁「选股不进总账」，锁冰点回放不用未来样本。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const led = require('./tools/calibration_ledger');
const cap = require('./tools/capitulation');

let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

test('样本不够：14 次即使胜率 90% 也不叫有效', () => {
  const r = led.classifyRate({ n: 14, winRate: 0.9, avgFwd: 1.2 });
  assert.strictEqual(r.state, 'short');
  assert.strictEqual(r.label, '样本不够');
});

test('有效：15 次、胜率 60%、均值为正', () => {
  const r = led.classifyRate({ n: 15, winRate: 0.6, avgFwd: 0.4 });
  assert.strictEqual(r.state, 'pass');
  assert.strictEqual(r.label, '有效');
  assert(!/可以买/.test(r.detail));
});

test('无效：样本够且胜率低于 45%', () => {
  const r = led.classifyRate({ n: 20, winRate: 0.4, avgFwd: -0.8 });
  assert.strictEqual(r.state, 'fail');
  assert.strictEqual(r.label, '无效');
});

test('未标定：样本够、胜率停在 45% 到 60% 之间', () => {
  const r = led.classifyRate({ n: 18, winRate: 0.5, avgFwd: 0.2 });
  assert.strictEqual(r.state, 'open');
  assert.strictEqual(r.label, '未标定');
});

test('胜率过线但均值为负或缺失：不叫有效', () => {
  assert.strictEqual(led.classifyRate({ n: 15, winRate: 0.8, avgFwd: -0.1 }).state, 'open');
  assert.strictEqual(led.classifyRate({ n: 15, winRate: 0.8, avgFwd: null }).state, 'open');
});

test('板块主线 reliable=false 时即使 n 很大也是样本不够', () => {
  const book = led.build({
    sector: { d3: { n: 40, winRate: 0.7, avgFwd: 1, reliable: false } },
  });
  const row = book.items.find(x => x.id === 'sector_mainline');
  assert.strictEqual(row.state, 'short');
});

test('总账不含选股，并写明尚无策略', () => {
  const book = led.build({});
  assert.ok(book.items.every(x => x.id !== 'stock_pool' && x.id !== 'stock_signal'));
  assert.strictEqual(book.excluded[0].id, 'stock_pool');
  assert(/尚无选股策略/.test(book.excluded[0].reason));
  assert(!/可以买/.test(JSON.stringify(book)));
});

test('展示情绪分和缠论阶段固定未标定', () => {
  const book = led.build({
    sentimentOos: { n: 40, winRate: 0.8, avgFwd: 1 },
  });
  assert.strictEqual(book.items.find(x => x.id === 'display_score').state, 'open');
  assert.strictEqual(book.items.find(x => x.id === 'chan').state, 'open');
  assert.strictEqual(book.items.find(x => x.id === 'sentiment_oos').state, 'pass');
});

test('过滤组：有跨窗确认才叫有效，空着叫未标定', () => {
  const empty = led.build({ confirmed: [] });
  assert.strictEqual(empty.items.find(x => x.id === 'sentiment_filter').state, 'open');
  const hit = led.build({
    confirmed: [{ group: '上证在MA20下', n: 20, winRate: 0.65, avgFwd: 0.8 }],
  });
  const row = hit.items.find(x => x.id === 'sentiment_filter');
  assert.strictEqual(row.state, 'pass');
  assert(/上证在MA20下/.test(row.detail));
});

test('冰点回放：分位只用过去，单次跳变不够确认线', () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push({
      date: '2026-01-' + String(i).padStart(2, '0'),
      limit_down: 3, broken_rate: 12, ladder_height: 4, ladder: { 4: 2 },
      sh_rsi14: 55, sh_above_ma20: 1, fwd_d3: 0.1,
    });
  }
  rows.push({
    date: '2026-02-01',
    limit_down: 90, broken_rate: 80, ladder_height: 1, ladder: { 1: 4 },
    sh_rsi14: 22, sh_above_ma20: 0, fwd_d3: 1.5,
  });
  let seenPast = null;
  const judged = led.fearForward(rows, (row, i) => {
    if (row.date === '2026-02-01') seenPast = i;
    return '磨底期';
  });
  assert.strictEqual(seenPast, 20, '触发日的下标应是第 21 行之前的 20');
  assert.strictEqual(judged.triggerCount, 1);
  assert.strictEqual(judged.d3.n, 1);
  const book = led.build({ fearEval: judged });
  assert.strictEqual(book.items.find(x => x.id === 'fear').state, 'short');
});

test('冰点回放不把未来的低跌停数算进当天分位', () => {
  /* 当天跌停 40，过去 5 天都是 80：相对过去它不算极端。
   * 若把后面 40 天的跌停=1 混进分母，40 会被抬成高分位从而误触发。 */
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      date: 'past' + i, limit_down: 80, broken_rate: 80,
      ladder_height: 4, ladder: { 4: 2 },
      sh_rsi14: 22, sh_above_ma20: 0, fwd_d3: -1,
    });
  }
  rows.push({
    date: 'today', limit_down: 40, broken_rate: 40,
    ladder_height: 4, ladder: { 4: 2 },
    sh_rsi14: 22, sh_above_ma20: 0, fwd_d3: 1,
  });
  for (let i = 0; i < 40; i++) {
    rows.push({
      date: 'fut' + i, limit_down: 1, broken_rate: 1,
      ladder_height: 4, ladder: { 4: 2 },
      sh_rsi14: 60, sh_above_ma20: 1, fwd_d3: 0,
    });
  }
  const judged = led.fearForward(rows, (row) => row.date === 'today' ? '磨底期' : '主升期');
  assert.strictEqual(judged.triggerCount, 0, '未来样本不能把普通的一天抬成冰点，实际 ' + judged.triggerCount);
});

test('冰点只有 2 次且全胜时，不把「暂时有效」写进总账', () => {
  const ev = cap.evaluateFear([{ fwd_d3: 1.2 }, { fwd_d3: 0.4 }]);
  assert(/暂时有效/.test(ev.verdict));
  const row = led.build({ fearEval: ev }).items.find(x => x.id === 'fear');
  assert.strictEqual(row.state, 'short');
  assert(!/暂时有效|有效边缘/.test(row.detail));
});

test('evaluateFear 的 20 次负收益，总账标无效', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ fwd_d3: i % 5 === 0 ? 0.2 : -1.1 });
  const ev = cap.evaluateFear(rows);
  assert(ev.d3.n >= 15);
  assert(ev.d3.winRate < 0.45);
  const book = led.build({ fearEval: ev });
  assert.strictEqual(book.items.find(x => x.id === 'fear').state, 'fail');
});

test('大盘面板挂着总账，且写明选股未纳入', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  assert(/function ledgerHtml\(/.test(html));
  assert(/标定总账/.test(html));
  assert(/尚无选股策略/.test(html));
  assert(/class="led-box"/.test(html));
});

test('没有连板明细且高度>1 时，不把第三料猜成断层', () => {
  const se = led.sentimentFromRow({ ladder_height: 4, limit_down: 10, broken_rate: 20 });
  assert.strictEqual(se.ladderHeight, null);
  const low = led.sentimentFromRow({ ladder_height: 1, limit_down: 10, broken_rate: 20 });
  assert.strictEqual(low.ladderHeight, 1);
});

async function main() {
  for (const { name, fn } of _t) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + (e && e.stack || e)); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_t.length}）`);
  process.exit(fail ? 1 : 0);
}
main();
