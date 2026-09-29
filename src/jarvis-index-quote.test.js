'use strict';
/* jarvis-index-quote.test.js —— 实时指数分时行解析 + 交易时段判定（纯函数，不联网）
 * 与 run-tests.js 套件约定一致：自定义 test harness + 末尾自报「通过/失败」。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const mb = require('./tools/market_board');

/* ───────────── parseMinuteLine ───────────── */

test('分时行：解析 HHMM 价 量 额', () => {
  const r = mb.parseMinuteLine('0930 3816.15 3341162 5096891255.90');
  assert.equal(r.t, '0930');
  assert.equal(r.price, 3816.15);
  assert.equal(r.volume, 3341162);
  assert.equal(r.amount, 5096891255.9);
});

test('分时行：量/额缺失时为 null，不编 0', () => {
  const r = mb.parseMinuteLine('0931 3821.49');
  assert.equal(r.t, '0931');
  assert.equal(r.price, 3821.49);
  assert.equal(r.volume, null);
  assert.equal(r.amount, null);
});

test('分时行：非法/空行返回 null', () => {
  assert.equal(mb.parseMinuteLine(''), null);
  assert.equal(mb.parseMinuteLine(null), null);
  assert.equal(mb.parseMinuteLine('abc 12.3'), null);
  assert.equal(mb.parseMinuteLine('0930 x'), null);
});

/* ───────────── deriveIsOpen ───────────── */

test('isOpen：同一工作日盘中 09:35 = true', () => {
  assert.equal(mb.deriveIsOpen('20260929093500', new Date(2026, 8, 29, 9, 35)), true);
});

test('isOpen：15:00 整点已收盘 = false', () => {
  assert.equal(mb.deriveIsOpen('20260929150000', new Date(2026, 8, 29, 15, 0)), false);
});

test('isOpen：盘前 09:15 = false', () => {
  assert.equal(mb.deriveIsOpen('20260929091500', new Date(2026, 8, 29, 9, 15)), false);
});

test('isOpen：周末 = false（即便时间落在盘中）', () => {
  assert.equal(mb.deriveIsOpen('20260927100000', new Date(2026, 8, 27, 10, 0)), false);
});

test('isOpen：行情时间戳与当前非同一天 = false', () => {
  assert.equal(mb.deriveIsOpen('20260928100000', new Date(2026, 8, 29, 10, 0)), false);
});

test('isOpen：null / 过短时间戳 = null（无法判定，不臆断）', () => {
  assert.equal(mb.deriveIsOpen(null), null);
  assert.equal(mb.deriveIsOpen('20260929'), null);
});

/* ───────────── 导出面 ───────────── */

test('导出：quote/fetchMinute 为函数', () => {
  assert.equal(typeof mb.quote, 'function');
  assert.equal(typeof mb.fetchMinute, 'function');
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
