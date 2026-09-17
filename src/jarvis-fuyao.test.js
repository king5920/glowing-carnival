'use strict';
/* fuyao 客户端纯逻辑单测（不发网络）：
 *  - Key 读取/注入
 *  - 上海时区零点毫秒戳 / Date→YYYYMMDD
 *  - 白名单过滤（主板+创业板，剔科创/北交/ST）
 *  - fearSnapshot 形状与炸板率/连板梯队/封单换算（注入 getJson/fetchPoolAll 替身）
 *  - 全0日 hasAnyData=false（回填必须跳过）
 */
const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
const test = (name, fn) => _t.push({ name, fn });

const fy = require('./tools/fuyao');

test('shMidnightMs：上海零点 = 前一日16:00 UTC', () => {
  assert.strictEqual(fy.shMidnightMs('20260914'), Date.UTC(2026, 8, 13, 16, 0, 0, 0));
  // 月初不串月
  assert.strictEqual(fy.shMidnightMs('20260901'), Date.UTC(2026, 7, 31, 16, 0, 0, 0));
});

test('ymdOf：按上海日历日取 YYYYMMDD', () => {
  // 2026-09-14 00:30 上海 = 09-13 16:30 UTC，仍应得 0914
  const d = new Date(Date.UTC(2026, 8, 13, 16, 30, 0));
  assert.strictEqual(fy.ymdOf(d), '20260914');
});

test('setApiKey/hasKey：可注入与清除', () => {
  fy.setApiKey('sk-test-123');
  assert.strictEqual(fy.apiKey(), 'sk-test-123');
  assert.strictEqual(fy.hasKey(), true);
  fy.setApiKey('');
  assert.strictEqual(fy.hasKey(), false);
  fy.setApiKey(null);   // 回落到 .env/环境
  assert.ok(typeof fy.hasKey() === 'boolean');
});

test('inTradableUniverse：白名单口径', () => {
  assert.strictEqual(fy.inTradableUniverse({ ticker: '600519', name: '贵州茅台' }), true);
  assert.strictEqual(fy.inTradableUniverse({ ticker: '300750', name: '宁德时代' }), true);
  assert.strictEqual(fy.inTradableUniverse({ ticker: '000001', name: '平安银行' }), true);
  assert.strictEqual(fy.inTradableUniverse({ ticker: '688981', name: '中芯国际' }), false); // 科创
  assert.strictEqual(fy.inTradableUniverse({ ticker: '830799', name: '某北交' }), false);   // 北交
  assert.strictEqual(fy.inTradableUniverse({ ticker: '600001', name: '*ST某股' }), false);  // ST
});

/* 注入式替身：fearSnapshot 通过 deps.fetchPool 取数，不发网络 */
async function withStub(pools, fn) {
  fy.setApiKey('sk-stub');
  const fetchPool = async kind => ({ total: pools[kind].length, items: pools[kind].slice() });
  try { return await fn(fetchPool); } finally { fy.setApiKey(null); }
}

test('fearSnapshot：白名单计数 + 炸板率 + 连板梯队 + 封单亿元', async () => {
  const pools = {
    up: [
      { ticker: '600001', name: '甲', continue_day_cnt: 3, seal_money: 1e8 * 20 },
      { ticker: '300002', name: '乙', continue_day_cnt: 1, seal_money: 1e8 * 5 },
      { ticker: '688003', name: '丙科创', continue_day_cnt: 5, seal_money: 1e8 * 99 }, // 剔
    ],
    break: [
      { ticker: '000004', name: '丁炸' },
      { ticker: '830005', name: '戊北交炸' }, // 剔
    ],
    down: [
      { ticker: '603006', name: '己跌停' },
    ],
  };
  const r = await withStub(pools, fetchPool => fy.fearSnapshot('20260914', { fetchPool }));
  assert.strictEqual(r.hasAnyData, true);
  const se = r.sentiment;
  assert.strictEqual(se.limitUpCount, 2);      // 科创被剔
  assert.strictEqual(se.brokenCount, 1);       // 北交被剔
  assert.strictEqual(se.limitDownCount, 1);
  assert.strictEqual(se.brokenRate, 1 / (2 + 1) * 100);
  assert.strictEqual(se.ladderHeight, 3);
  assert.deepStrictEqual(se.ladder, { 1: 1, 3: 1 });
  assert.ok(Math.abs(se.sealFundYi - 25) < 1e-9);   // 20亿+5亿，科创99亿不计
  assert.strictEqual(se.universe, 'main_chinext');
  assert.strictEqual(se.rawTotal.source, 'fuyao');
});

test('fearSnapshot：全0日 → hasAnyData=false（回填跳过，不写成真0）', async () => {
  const r = await withStub({ up: [], break: [], down: [] },
    fetchPool => fy.fearSnapshot('20260131', { fetchPool }));
  assert.strictEqual(r.hasAnyData, false);
  assert.strictEqual(r.sentiment.brokenRate, null);  // 不编 0%
  assert.strictEqual(r.sentiment.limitUpCount, 0);
});

test('fearSnapshot：无 Key 抛错', async () => {
  fy.setApiKey(null);
  // 清掉环境/.env 来源不可控，改为直接断言函数存在且 getJson 走鉴权失败路径不在这里测；
  // 至少保证 setApiKey 空串时一定抛错
  fy.setApiKey('');
  await assert.rejects(() => fy.fearSnapshot('20260914'), /FUYAO_API_KEY/);
  fy.setApiKey(null);
});

/* ── A/B 新增：isoDate / 异动 / 龙虎榜映射 ── */
test('isoDate：YYYYMMDD → YYYY-MM-DD', () => {
  assert.strictEqual(fy.isoDate('20260914'), '2026-09-14');
  assert.strictEqual(fy.isoDate('20260103'), '2026-01-03');
});

test('mapAnomaly：字段映射 + 关键词 + 白名单过滤标记', () => {
  const a = fy.mapAnomaly({
    thscode: '002912.SZ', stock_name: '中新赛克', tag_name: '涨停',
    keyword_list: ['AI安全', '网络安全'], analysis_content: '行业原因…',
  });
  assert.strictEqual(a.ticker, '002912');
  assert.strictEqual(a.tag, '涨停');
  assert.deepStrictEqual(a.keywords, ['AI安全', '网络安全']);
  assert.strictEqual(a.inUniverse, true);

  const star = fy.mapAnomaly({ thscode: '688001.SH', stock_name: '某科创', keyword_list: [] });
  assert.strictEqual(star.inUniverse, false);
});

test('mapDragonStock：元→亿、涨跌%放大100、概念展平', () => {
  const x = fy.mapDragonStock({
    thscode: '001232.SZ', ticker: '001232', name: '嘉立创', change: 0.083297,
    net_value: 436100574.33, buy_value: 916035943, sell_value: 479935368.67,
    org_net_value: 365154346.42, org_buy_num: 3, org_sell_num: 4,
    hot_money_net_value: 70946227.91, concept_list: [{ name: 'PCB概念' }, { name: '3D打印' }],
    limit_reason: 'PCB+3D打印', range_days: 3, hot_rank: 138,
  });
  assert.ok(Math.abs(x.netBuyYi - 4.361) < 0.01);
  assert.ok(Math.abs(x.orgNetYi - 3.652) < 0.01);
  assert.ok(Math.abs(x.changePct - 8.33) < 0.01);
  assert.deepStrictEqual(x.concepts, ['PCB概念', '3D打印']);
  assert.strictEqual(x.limitReason, 'PCB+3D打印');
  assert.strictEqual(x.orgBuyNum, 3);
  assert.strictEqual(x.inUniverse, true);
});

test('mapDragonStock：driver 分类（机构/游资/机构卖出）', () => {
  const org = fy.mapDragonStock({ ticker: '600001', name: '甲', org_net_value: 1e8, org_buy_num: 2, hot_money_net_value: 0 });
  assert.strictEqual(org.driver, '机构');
  const hm = fy.mapDragonStock({ ticker: '600002', name: '乙', org_net_value: null, hot_money_net_value: 5e7 });
  assert.strictEqual(hm.driver, '游资');
  const sell = fy.mapDragonStock({ ticker: '600003', name: '丙', org_net_value: -2e8, org_buy_num: 0, hot_money_net_value: 1e7 });
  assert.strictEqual(sell.driver, '机构卖出');
  // 科创板剔除
  assert.strictEqual(fy.mapDragonStock({ ticker: '688001', name: '科创' }).inUniverse, false);
});

async function main() {
  for (const { name, fn } of _t) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_t.length}）`);
  process.exit(fail ? 1 : 0);
}
main();
