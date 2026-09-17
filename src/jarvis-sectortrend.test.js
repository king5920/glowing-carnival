'use strict';
/**
 * 板块跨日持续性追踪 —— 行为测试
 *
 * 用户 2026-09-12：「主线板块不是一天就能看出来的」。
 * 这套测试守的是"跨日判断不能造假"：
 *   1. 数据有缺口时不许冒充连续（实测踩过：光通信模块缺 9/10、9/11）
 *   2. 只有 1 天数据不许说"趋势"（实测踩过：5G概念单日126亿排第4）
 *   3. 样本不足不许下主线结论
 *   4. 前向收益算术必须精确，否则有效性验证全是错的
 */
const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

process.env.JARVIS_QUIET = '1';
const st = require('./tools/sector_trend');
const db = require('./db');

const mk = (date, todayYi, level, extra = {}) => ({
  date, code: 'BKTEST', name: '测试板块', kind: 'industry',
  today_yi: todayYi, level, change_pct: 1, d5_yi: 0, d10_yi: 100,
  up_count: 10, down_count: 2, leader: 'L', leader_pct: 5,
  score: 90, grade: '主线候选', ...extra,
});

test('连续净流入天数：噪音级金额不算一天', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const s = [mk(dates[0], 5, 100), mk(dates[1], 0.1, 101), mk(dates[2], 5, 102), mk(dates[3], 6, 103)];
  const a = st.analyzeSeries(s, dates);
  /* 0.1 亿低于 inflowYi(0.5)，连续只能从后往前数到第 3 天 */
  assert.strictEqual(a.streak, 2, '0.1亿不该算作一天流入，应只连续2天');
});

test('第一优先：数据缺口必须检出，不许冒充连续', () => {
  /* 真实场景：光通信模块有 9/9 和 9/12，缺 9/10、9/11 */
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const s = [mk(dates[0], 10, 100), mk(dates[3], 12, 110)];   // 缺中间两天
  const a = st.analyzeSeries(s, dates);
  assert.strictEqual(a.contiguous, false, '必须识别为不连续');
  assert.strictEqual(a.gapDays, 2, '应检出缺 2 个交易日');
  const g = st.gradeTrend(a);
  assert.strictEqual(g.mainline, false, '数据不全绝不能评主线');
  assert.strictEqual(g.grade, '数据不全');
  assert(/不连续|缺 2 个交易日/.test(g.reasons.join('')), '必须把缺口如实写进依据');
});

test('缺口会中断 streak，不能跨着缺口继续数', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  const s = [mk(dates[0], 10, 100), mk(dates[2], 8, 105), mk(dates[3], 9, 110)];  // 缺 01-06
  const a = st.analyzeSeries(s, dates);
  assert.strictEqual(a.streak, 2, '只能数到缺口处，不能算成 3 天');
  assert.strictEqual(a.contiguous, false);
});

test('第二优先：只有 1 天数据不许说趋势', () => {
  const dates = ['2026-01-05'];
  const a = st.analyzeSeries([mk(dates[0], 126, 100)], dates);
  const g = st.gradeTrend(a);
  assert.strictEqual(g.mainline, false, '单日数据不能评主线');
  assert.strictEqual(g.grade, '数据不足');
  assert(/仅 1 天|看不出持续性/.test(g.reasons.join('')), '必须说明是截面不是趋势');
});

test('资金加速与衰竭能区分', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12'];
  const up = dates.map((d, i) => mk(d, [2, 3, 4, 6, 9, 13][i], 100 + i));
  const a1 = st.analyzeSeries(up, dates);
  assert.strictEqual(a1.trend, 'accelerating', '后段远大于前段应判加速');
  assert(st.gradeTrend(a1).mainline, '连续加速且体量够应评主线');

  const down = dates.map((d, i) => mk(d, [13, 9, 6, 4, 3, 2][i], 100 + i));
  const a2 = st.analyzeSeries(down, dates);
  assert.strictEqual(a2.trend, 'decaying', '后段远小于前段应判衰竭');
  assert(/衰竭/.test(st.gradeTrend(a2).grade), '衰竭要在标签里体现');
});

test('只进不涨必须显式警告（方向待确认）', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
  /* 资金持续进，但点位没涨 */
  const s = dates.map((d, i) => mk(d, 10, 100));
  const a = st.analyzeSeries(s, dates);
  const g = st.gradeTrend(a);
  assert(/钱进了价没动|方向待确认/.test(g.reasons.join('')),
    '资金进了价格没动必须点出来，这是吸筹还是接盘含义相反');
});

test('第三优先：样本不足必须拒绝下主线结论', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_trend.js', 'utf8');
  assert(/MIN_TREND_DAYS\s*=\s*5/.test(src), '应有 5 天门槛');
  assert(/insufficient/.test(src), '需有样本不足状态');
  assert(/不下主线结论/.test(src), '样本不足文案必须明说不下结论');
  assert(/历史数据无法凭空补齐|只能往后攒/.test(src),
    '必须说明历史补不齐，不能让用户以为能回溯');
});

test('前向收益回填：算术精确，无后续数据留 NULL', () => {
  const D = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04',
             '2026-02-05', '2026-02-08', '2026-02-09'];
  for (const d of D) db.db.prepare('DELETE FROM sector_daily WHERE date=?').run(d);
  let lv = 1000;
  D.forEach(d => {
    db.saveSectorDaily(d, [{
      code: 'BKFWD', name: 'T', kind: 'industry', level: Math.round(lv * 100) / 100,
      changePct: 10, todayYi: 5, d5Yi: 25, d10Yi: 50, mainPct: 1,
      upCount: 10, downCount: 1, leader: 'X', leaderCode: '1', leaderPct: 5,
      dataTs: '15:00:00', score: 90, grade: '主线候选',
    }]);
    lv *= 1.1;
  });
  st.backfillForward();
  const first = db.sectorDailyAt(D[0]).find(r => r.code === 'BKFWD');
  assert.strictEqual(first.fwd_d1, 10, '次日应为 +10%');
  assert.strictEqual(first.fwd_d3, 33.1, '3日应为 +33.1%');
  assert.strictEqual(first.fwd_d5, 61.05, '5日应为 +61.05%');
  const last = db.sectorDailyAt(D[6]).find(r => r.code === 'BKFWD');
  assert.strictEqual(last.fwd_d1, null, '最后一天没有次日数据，必须留 NULL 不许猜');
  for (const d of D) db.db.prepare('DELETE FROM sector_daily WHERE date=?').run(d);
});

test('有效性验证：样本不足时拒绝给胜率', () => {
  const v = st.validate(999999);
  assert.strictEqual(v.status, 'insufficient');
  assert(/不做有效性结论|噪音/.test(v.note), '必须说明少量样本的胜率是噪音');
  assert(v.mainline === undefined, '样本不足时不许输出胜率字段');
});

test('sector_daily 表存全量而非前 N（断档根因）', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/close_scan.js', 'utf8');
  assert(/saveSectorDaily\(date,\s*deduped\)/.test(src),
    '必须落全量 deduped；只落 top 会导致板块掉出榜单时序列断档');
  assert(/afterClose/.test(src), '必须只在收盘后落库，盘中落库会把中间态当成当日结果');
});

test('工具已注册，且说明了与其他两层的分工', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/registry.js', 'utf8');
  assert(/register\('sector_trend'/.test(src), 'sector_trend 未注册');
  assert(/register\('sector_validate'/.test(src), 'sector_validate 未注册');
  assert(/close_scan（当日截面）|sector_watch（盘中/.test(src),
    '描述要讲清三层分工，否则模型会用混');
});

console.log('\n通过: ' + pass + ' | 失败: ' + fail);
process.exit(fail ? 1 : 0);
