'use strict';
/* 分钟级 K 线（stock_kline 的 m1/m5/m15/m30/m60）。
 * 纯函数/解析/选源离线测；真实取数只做不崩冒烟（网络失败可接受降级）。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _tests = [];
function test(name, fn) { _tests.push({ name, fn }); }

const kl = require('./tools/stock_kline');

/* ── 东财 secid：指数与个股必须分开，000001 是最危险的同号 ── */
test('emSecid：600519→沪股 000001平安→深股 000001指数→沪指数', () => {
  assert.strictEqual(kl.emSecid('600519', null, false), '1.600519');
  assert.strictEqual(kl.emSecid('000001', null, false), '0.000001', '裸000001按个股=平安银行');
  assert.strictEqual(kl.emSecid('000001', 'sh', true), '1.000001', '000001按指数=上证指数');
  assert.strictEqual(kl.emSecid('399006', 'sz', true), '0.399006', '创业板指');
});

/* ── 同花顺指数代码：上证 1A0001 ── */
test('thsCode：上证指数走 1A0001，个股/深指用原码', () => {
  assert.strictEqual(kl.thsCode('000001', true, 'sh'), '1A0001');
  assert.strictEqual(kl.thsCode('399006', true, 'sz'), '399006');
  assert.strictEqual(kl.thsCode('600519', false), '600519');
});

/* ── 同花顺行解析：列序是 开/高/低/收（接反会让高低互换）── */
test('THS 解析：时间戳转日期 + 开高低收列序正确', () => {
  const rows = kl.parseThsMinuteRows('202609111430,1279.00,1279.50,1275.01,1276.92,265300', 'm60');
  assert.strictEqual(rows.length, 1);
  const b = rows[0];
  assert.strictEqual(b.date, '2026-09-11 14:30');
  assert.strictEqual(b.open, 1279.0);
  assert.strictEqual(b.high, 1279.5, '第二列应是最高');
  assert.strictEqual(b.low, 1275.01, '第三列应是最低');
  assert.strictEqual(b.close, 1276.92, '第四列才是收盘');
  assert(b.high >= b.low, '最高必须≥最低（接反列会破这条）');
});

test('THS 解析：多行 + 坏行不崩', () => {
  const rows = kl.parseThsMinuteRows('202609111430,1,2,1,1.5,10;202609111500,2,3,1.8,2.5,20;', 'm30');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].date, '2026-09-11 15:00');
  assert.strictEqual(kl.parseThsMinuteRows('', 'm30').length, 0);
});

/* ── 周期表：5/15 分同花顺必须为空（它没有），避免选源时白等 ── */
test('周期表：m5/m15 无同花顺码，m1/m30/m60 有', () => {
  assert.strictEqual(kl.MINUTE_PERIODS.m5.ths, null);
  assert.strictEqual(kl.MINUTE_PERIODS.m15.ths, null);
  assert.strictEqual(kl.MINUTE_PERIODS.m1.ths, '60');
  assert.strictEqual(kl.MINUTE_PERIODS.m30.ths, '41');
  assert.strictEqual(kl.MINUTE_PERIODS.m60.ths, '51');
});

test('分钟K日期必须带时分，日K不带（防止前端/判断混淆）', () => {
  const rows = kl.parseThsMinuteRows('202609111430,1,2,1,1.5,10', 'm30');
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rows[0].date));
});

/* ── 选源链行为（打桩，验证"指数走新浪优先、个股30/60走同花顺"）── */
test('指数分钟K主源是新浪（同花顺指数尾部会滞后，盯盘不能用旧数据）', async () => {
  /* 用 kline 真跑可能受网络影响，这里只验证设计意图被代码记录：
   * 指数新浪先于同花顺。通过对源码的静态约束锁死，避免被改回 ths 优先。 */
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, 'tools', 'stock_kline.js'), 'utf8');
  const block = /if \(isIndex\) \{[\s\S]*?chain = \[([^\]]+)\]/.exec(src);
  assert(block, '找不到指数选源分支');
  assert(/'sina'[\s\S]*?'ths'/.test(block[1]),
    '指数必须 sina 在 ths 之前（实测同花顺指数分钟尾部滞后），实际: ' + block[1]);
});

/* ── 日K行为不被分钟改动破坏：裸000001仍是上证指数，sz000001是平安 ── */
test('日K指数白名单未受影响（静态）', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, 'tools', 'stock_kline.js'), 'utf8');
  assert(/'000001': 'sh'/.test(src), '000001 指数白名单丢了');
});

/* ── 腾讯 mkline 备胎：列序 开/收/高/低 + 时间戳转日期（锁定，防止和同花顺列混）── */
test('腾讯分钟解析：YYYYMMDDHHmm 转日期，开收高低列序正确', () => {
  const rows = [['202609111500', '3889.95', '3888.11', '3890.29', '3879.07', '60974299', {}, '12.57']];
  const bars = kl.parseTencentMinuteRows(rows);
  assert.strictEqual(bars.length, 1);
  const b = bars[0];
  assert.strictEqual(b.date, '2026-09-11 15:00');
  assert.strictEqual(b.open, 3889.95);
  assert.strictEqual(b.close, 3888.11);
  assert.strictEqual(b.high, 3890.29);
  assert.strictEqual(b.low, 3879.07);
  assert(b.high >= b.low, '最高必须≥最低');
});
test('腾讯分钟解析：坏行/空入参不崩、close 缺失被滤掉', () => {
  assert.deepStrictEqual(kl.parseTencentMinuteRows([]), []);
  assert.deepStrictEqual(kl.parseTencentMinuteRows(null), []);
  const bars = kl.parseTencentMinuteRows([
    ['202609111500', '10', '11', '12', '9', '1'],
    ['202609111430', '10', '-', '12', '9', '1'],
  ]);
  assert.strictEqual(bars.length, 1, 'close 无效的行应被滤掉');
});
test('MINUTE_PERIODS：仅 m5/m15/m30/m60 有腾讯周期，m1 无', () => {
  assert.strictEqual(kl.MINUTE_PERIODS.m5.tx, 'm5');
  assert.strictEqual(kl.MINUTE_PERIODS.m30.tx, 'm30');
  assert.strictEqual(kl.MINUTE_PERIODS.m1.tx, null, 'm1 不走 mkline');
});

/* ── 真实冒烟：至少一个分钟周期能取到结构正确的数据 ── */
test('真实分钟K（网络失败可接受；成功则字段必须自洽）', async () => {
  let r;
  try { r = await kl.kline('000001', 'm30', 5, 'none'); }
  catch (e) { return; }  // 离线不卡 CI
  if (r && r.bars && r.bars.length) {
    assert(['sina', '10jqka', 'eastmoney', 'tencent'].includes(r.source));
    const b = r.bars[r.bars.length - 1];
    assert(/\d{2}:\d{2}/.test(b.date), '分钟K末根日期应带时分');
    assert(b.close > 1000 && b.close < 10000, '上证点位量级异常: ' + b.close);
    if (b.high != null && b.low != null) assert(b.high >= b.low);
  }
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
