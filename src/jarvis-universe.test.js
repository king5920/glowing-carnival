'use strict';
/* 可投资宇宙白名单（主板+创业板，剔 ST）。纯函数离线测。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

const U = require('./tools/universe');

/* ── 代码段：主板+创业板纳入 ── */
test('白名单前缀全部纳入', () => {
  for (const c of ['600519', '601318', '603259', '605588',
    '000001', '001872', '002594', '003816', '300750', '301269']) {
    assert(U.isBoardAllowed(c), '应纳入: ' + c);
  }
});

/* ── 科创板 / 北交所 排除 ── */
test('科创板 688/689 排除', () => {
  assert(!U.isBoardAllowed('688981'));
  assert(!U.isBoardAllowed('689009'));
});
test('北交所 4xx/8xx/920 排除', () => {
  for (const c of ['430047', '830799', '870866', '835174', '920002']) {
    assert(!U.isBoardAllowed(c), '应排除: ' + c);
  }
});

/* ── 非法代码不放行（宁漏勿错）── */
test('非6位/带杂码一律 false', () => {
  for (const c of ['', null, undefined, '60051', '6005199', 'sh', 'ABC519', '00000', '399001']) {
    assert.strictEqual(U.isBoardAllowed(c), false, '不该纳入: ' + c);
  }
});

/* ── 指数不是个股：深证成指 399001/创业板指 399006 前缀不在白名单 ──
 * 注意：沪深300 指数代码 000300 与深市主板股票前缀撞号，单看代码无法区分
 * （指数是 sh000300 / 东财 1.000300，深市股票是 0.000300，区别在市场前缀）。
 * 本模块契约是"只判断个股"，调用方不得把指数喂进来；normalize 会剥掉市场前缀，
 * 所以这里不假装能凭裸代码认出 000300 指数，只锁定 399xxx 深证系列指数被排除。 */
test('深证系列指数 399xxx 不在个股白名单', () => {
  assert(!U.inTradableUniverse({ code: '399001', name: '深证成指' }));
  assert(!U.inTradableUniverse({ code: '399006', name: '创业板指' }));
});

/* ── 市场前缀/后缀归一 ── */
test('normalizeCode 兼容 sh/sz/bj 前缀与 .SH 后缀', () => {
  assert.strictEqual(U.normalizeCode('sh600519'), '600519');
  assert.strictEqual(U.normalizeCode('SZ300750'), '300750');
  assert.strictEqual(U.normalizeCode('600519.SH'), '600519');
  assert.strictEqual(U.normalizeCode('bj430047'), '430047');
});
test('带前缀的白名单判定', () => {
  assert(U.inTradableUniverse({ code: 'sh600519', name: '贵州茅台' }));
  assert(U.inTradableUniverse({ code: '300750.SZ', name: '宁德时代' }));
  assert(!U.inTradableUniverse({ code: 'sh688981', name: '中芯国际' }));
  assert(!U.inTradableUniverse({ code: 'bj830799', name: '艾融软件' }));
});

/* ── ST / *ST / 退：即便代码在白名单段也一票否决 ── */
test('ST/*ST/退 名称一票否决', () => {
  assert(!U.inTradableUniverse({ code: '600221', name: 'ST海航' }));
  assert(!U.inTradableUniverse({ code: '000564', name: '*ST大集' }));
  assert(!U.inTradableUniverse({ code: '600225', name: '卓朗退' }));
  assert(U.isStName('st东网'));              // 小写也识别
  assert(U.isStName('*ST 美谷'));           // 带空格
  assert(!U.isStName('宁德时代'));
  assert(!U.isStName(''));
  assert(!U.isStName(null));
});
test('白名单代码 + 正常名称 通过', () => {
  assert(U.inTradableUniverse({ code: '600519', name: '贵州茅台' }));
  assert(U.inTradableUniverse({ code: '300750', name: '宁德时代' }));
});
test('无名称时只按代码判（不因缺名称误杀）', () => {
  assert(U.inTradableUniverse({ code: '600519' }));
  assert(!U.inTradableUniverse({ code: '688981' }));
});

/* ── 批量过滤：保留/剔除分桶 + 剔除原因 ── */
test('filterUniverse 分桶正确并给 reason', () => {
  const rows = [
    { code: '600519', name: '贵州茅台' },     // kept 主板
    { code: '300750', name: '宁德时代' },     // kept 创业板
    { code: '688981', name: '中芯国际' },     // board_excluded
    { code: '430047', name: '诺思兰德' },     // board_excluded 北交
    { code: '600221', name: 'ST海航' },       // st_or_delisting
    { code: '399006', name: '创业板指' },     // board_excluded（指数非个股）
    { code: '60051', name: '坏代码' },        // bad_code
  ];
  const { kept, dropped } = U.filterUniverse(rows);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 5);
  const reasons = dropped.map(d => d.reason).sort();
  assert.deepStrictEqual(reasons,
    ['bad_code', 'board_excluded', 'board_excluded', 'board_excluded', 'st_or_delisting']);
});

/* ── 口径白盒：纳入前缀集合不可被无意改动 ── */
test('白名单前缀冻结为 主板600/601/603/605 深主板000/001/002/003 创业300/301', () => {
  assert.deepStrictEqual(U.ALLOWED_PREFIXES.slice().sort(),
    ['000', '001', '002', '003', '300', '301', '600', '601', '603', '605'].sort());
});

async function main() {
  for (const { name, fn } of _tests) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_tests.length}）`);
  process.exit(fail ? 1 : 0);
}
main();
