'use strict';
/* jarvis-ths-board.test.js —— 同花顺行业板块备胎（解析纯函数，不联网）
 * 与 run-tests.js 套件约定一致：自定义 test harness + 末尾自报「通过/失败」。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const ths = require('./tools/ths_board');

/* 仿同花顺 thshy 一行（td 顺序：序号 名称 涨幅 指数 成交额 换手 涨家 跌家 均价 领涨名 领涨现价 领涨涨幅） */
function rowHtml(code, name, pct, up, down, leader, lpct) {
  return `<tr>
    <td>1</td><td><a href="/thshy/detail/code/${code}/">${name}</a></td>
    <td>${pct}</td><td>1532.25</td><td>402.20</td><td>12.52</td>
    <td>${up}</td><td>${down}</td><td>26.25</td>
    <td><a>${leader}</a></td><td>18.18</td><td>${lpct}</td>
  </tr>`;
}
function page(rows) {
  return `<table><tbody>${rows.join('')}</tbody></table>`;
}

test('同花顺：解析出板块行情字段', () => {
  const html = page([
    rowHtml('881175', '医疗服务', '5.10', '55', '1', '诺禾致源', '20.00'),
    rowHtml('881140', '化学制药', '-4.67', '4', '154', '峆一药业', '-1.20'),
  ]);
  const rows = ths.parseBoardHtml(html, 'industry');
  assert.equal(rows.length, 2);

  const a = rows[0];
  assert.equal(a.code, '881175');
  assert.equal(a.name, '医疗服务');
  assert.equal(a.changePct, 5.1);
  assert.equal(a.amountYi, 402.2);
  assert.equal(a.upCount, 55);
  assert.equal(a.downCount, 1);
  assert.equal(a.leader, '诺禾致源');
  assert.equal(a.leaderPct, 20);
  assert.equal(a.kind, 'industry');
  assert.equal(a.boardSource, 'ths.board');

  const b = rows[1];
  assert.equal(b.changePct, -4.67);
  assert.equal(b.upCount, 4);
  assert.equal(b.downCount, 154);
});

test('同花顺：东财多日主力字段必须为 null（不能编0）', () => {
  const rows = ths.parseBoardHtml(
    page([rowHtml('881175', '医疗服务', '5.10', '55', '1', '诺禾致源', '20.00')]));
  const r = rows[0];
  assert.equal(r.todayYi, null);
  assert.equal(r.d5Yi, null);
  assert.equal(r.d10Yi, null);
  assert.equal(r.mainPct, null);
  assert.equal(r.leaderCode, null);
});

test('同花顺：缺 tbody / 行字段不足时不产出', () => {
  assert.deepEqual(ths.parseBoardHtml('<table></table>', 'industry'), []);
  /* 只有链接但 td 不足12，跳过（不抛错） */
  const html = page([`<tr><td>1</td><td><a href="/thshy/detail/code/881175/">医疗服务</a></td></tr>`]);
  assert.deepEqual(ths.parseBoardHtml(html, 'industry'), []);
});

test('同花顺：模块导出 industryBoards/SOURCE', () => {
  assert.equal(typeof ths.industryBoards, 'function');
  assert.equal(ths.SOURCE, 'ths.board');
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
