'use strict';
/* 两列数：分位只用该日之前的定型样本；缺数留空；盘中不回写。 */

const assert = require('assert');
const tape = require('./tools/sentiment_tape');

let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

test('没有此前样本时分位留空，不写 0', () => {
  const r = tape.buildTape([], {
    asOf: '2026-09-21',
    live: { limitDown: 12, brokenRate: 30 },
  });
  assert.strictEqual(r.intraday, true);
  assert.strictEqual(r.rows[0].value, 12);
  assert.strictEqual(r.rows[0].pct, null);
  assert.strictEqual(r.rows[0].n, 0);
  assert.strictEqual(r.rows[1].pct, null);
  assert.strictEqual(r.note, '未标定。这两列数给不出入场时机。');
});

test('原值缺失则该列整行留空，不用另一列顶上', () => {
  const rows = [
    { date: '2026-09-18', slot: 'close', limit_down: 10, broken_rate: 20 },
  ];
  const r = tape.buildTape(rows, {
    asOf: '2026-09-21',
    live: { limitDown: null, brokenRate: 40 },
  });
  assert.strictEqual(r.rows[0].value, null);
  assert.strictEqual(r.rows[0].pct, null);
  assert.strictEqual(r.rows[0].n, null);
  assert.strictEqual(r.rows[1].value, 40);
  assert.strictEqual(r.rows[1].n, 1);
  assert.strictEqual(r.rows[1].pct, 1);
});

test('分位只数此前定型日里小于等于今日的天数', () => {
  const rows = [
    { date: '2026-09-01', slot: 'backfill', limit_down: 10, broken_rate: 10 },
    { date: '2026-09-02', slot: 'backfill', limit_down: 30, broken_rate: 50 },
    { date: '2026-09-03', slot: 'backfill', limit_down: 20, broken_rate: 40 },
  ];
  const r = tape.buildTape(rows, { asOf: '2026-09-03' });
  assert.strictEqual(r.intraday, false);
  assert.strictEqual(r.rows[0].value, 20);
  assert.strictEqual(r.rows[0].n, 2);
  assert.strictEqual(r.rows[0].pct, 0.5);
  assert.strictEqual(r.rows[1].pct, 0.5);
});

test('同一天收盘压过开盘，盘中条不进入分位', () => {
  const rows = [
    { date: '2026-09-18', slot: 'close', limit_down: 50, broken_rate: 50 },
    { date: '2026-09-21', slot: 'open', limit_down: 1, broken_rate: 1 },
    { date: '2026-09-21', slot: 'close', limit_down: 40, broken_rate: 40 },
  ];
  const r = tape.buildTape(rows, {
    asOf: '2026-09-21',
    live: { limitDown: 100, brokenRate: 100 },
  });
  assert.strictEqual(r.intraday, false);
  assert.strictEqual(r.rows[0].value, 40);
  assert.strictEqual(r.rows[0].pct, 0);
  assert.strictEqual(r.rows[0].n, 1);
});

test('盘中读数用此前分布，不把今天未收盘的样本算进分母', () => {
  const rows = [
    { date: '2026-09-18', slot: 'close', limit_down: 50, broken_rate: 50 },
    { date: '2026-09-21', slot: 'open', limit_down: 1, broken_rate: 1 },
  ];
  const r = tape.buildTape(rows, {
    asOf: '2026-09-21',
    live: { limitDown: 40, brokenRate: 40 },
  });
  assert.strictEqual(r.intraday, true);
  assert.strictEqual(r.rows[0].value, 40);
  assert.strictEqual(r.rows[0].n, 1);
  assert.strictEqual(r.rows[0].pct, 0);
});

test('收盘后不再标盘中未定型', () => {
  const rows = [
    { date: '2026-09-18', slot: 'close', limit_down: 50, broken_rate: 50 },
    { date: '2026-10-01', slot: 'midday', limit_down: 1, broken_rate: 1 },
  ];
  const r = tape.buildTape(rows, {
    asOf: '2026-10-01',
    session: '收盘后',
    live: { limitDown: 8, brokenRate: 18 },
  });
  assert.strictEqual(r.intraday, false);
  assert.strictEqual(r.rows[0].value, 8);
  assert.strictEqual(r.rows[0].n, 1);
});

test('更晚的日子不能抬高今天的分位', () => {
  const rows = [
    { date: '2026-09-01', slot: 'backfill', limit_down: 80, broken_rate: 80 },
    { date: '2026-09-02', slot: 'backfill', limit_down: 40, broken_rate: 40 },
    { date: '2026-09-03', slot: 'backfill', limit_down: 1, broken_rate: 1 },
  ];
  const r = tape.buildTape(rows, { asOf: '2026-09-02' });
  assert.strictEqual(r.rows[0].value, 40);
  assert.strictEqual(r.rows[0].n, 1);
  assert.strictEqual(r.rows[0].pct, 0);
});

for (const { name, fn } of _t) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
}
console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_t.length}）`);
process.exit(fail ? 1 : 0);
