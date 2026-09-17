'use strict';
/**
 * 盘中板块资金异动盯盘 —— 行为测试
 *
 * 重点不是"能跑"，是守住三条底线：
 *   1. 没有基线时绝不编造异动（这是最容易出的错：
 *      拿到当前截面就说"流入 37.9 亿"，其实那是全天累计，不是异动）
 *   2. 资金逆势流入不能被静默丢弃（实测踩过：整个电子板块被滤没了）
 *   3. 未标定必须说未标定，且永不出现买卖建议措辞
 */
const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

process.env.JARVIS_QUIET = '1';
const sw = require('./tools/sector_watch');
const db = require('./db');

/* ── 时段判定 ── */
test('交易时段判定：周末一律不盯盘', () => {
  /* 2026-09-12 是周六，2026-09-13 是周日 —— 都不该盯盘 */
  assert.strictEqual(sw.isTradingNow(new Date('2026-09-12T10:30:00')), false, '周六不盯盘');
  assert.strictEqual(sw.isTradingNow(new Date('2026-09-13T10:30:00')), false, '周日不盯盘');
});

test('交易时段判定：午休与盘后不算盘中', () => {
  const d = s => new Date('2026-09-14T' + s);   // 周一
  assert.strictEqual(sw.isTradingNow(d('10:30:00')), true, '上午盘中');
  assert.strictEqual(sw.isTradingNow(d('14:30:00')), true, '下午盘中');
  assert.strictEqual(sw.isTradingNow(d('12:00:00')), false, '午休不算');
  assert.strictEqual(sw.isTradingNow(d('08:00:00')), false, '盘前不算');
  assert.strictEqual(sw.isTradingNow(d('16:00:00')), false, '盘后不算');
  assert.strictEqual(sw.isTradingNow(new Date('2026-09-13T10:30:00')), false, '周日不算');
});

test('slot 按 5 分钟向下取整', () => {
  assert.strictEqual(sw.toSlot(new Date('2026-09-14T10:32:47')), '10:30');
  assert.strictEqual(sw.toSlot(new Date('2026-09-14T10:35:00')), '10:35');
  assert.strictEqual(sw.toSlot(new Date('2026-09-14T09:07:59')), '09:05');
});

/* ── 底线一：没有基线不许报异动 ── */
test('第一优先：没有基线时必须返回 baseline，绝不报异动', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_watch.js', 'utf8');
  assert(/mode:\s*'baseline'/.test(src), '必须有 baseline 模式');
  assert(/不做任何异动结论|没有可比数据/.test(src),
    'baseline 文案必须明说"没有可比数据"，不能含糊带过');
  /* 关键：baseline 分支必须 moves 为空 */
  const m = src.match(/mode:\s*'baseline'[\s\S]{0,400}/);
  assert(m && /moves:\s*\[\]/.test(m[0]), 'baseline 分支的 moves 必须是空数组');
});

test('基线过期（>60分钟）必须拒绝做差，而不是硬算', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_watch.js', 'utf8');
  assert(/stale-baseline/.test(src), '必须有基线过期分支');
  assert(/maxSlotGapMin/.test(src), '必须有跨度上限常量');
  const m = src.match(/mode:\s*'stale-baseline'[\s\S]{0,400}/);
  assert(m && /moves:\s*\[\]/.test(m[0]), '过期分支不许输出异动');
  assert(/接近「?全天累计|失去异动含义/.test(src), '必须说明为什么跨度太大不能用');
});

/* ── 底线二：逆势流入不能被丢弃 ── */
test('第二优先：资金逆势流入单独归类，不被静默过滤', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_watch.js', 'utf8');
  assert(/divergent/.test(src), '必须有 divergent 分类');
  assert(/逆势流入/.test(src), '文案要有"逆势流入"');
  assert(/方向待确认|含义相反/.test(src),
    '必须点明这个信号方向不确定，不能让用户当成利好');
  /* 回归保护：不能退回"净流入且上涨才算"的旧写法 */
  assert(!/deltaYi\s*>=\s*GATE\.surgeYi\s*&&\s*upRatio\s*>=/.test(src),
    '不许把"上涨占比"作为报不报的硬条件 —— 会滤掉逆势流入');
});

/* ── 底线三：诚实措辞 ── */
test('第三优先：未标定必须声明，且不出现买卖建议', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_watch.js', 'utf8');
  assert(/MIN_CAL_DAYS/.test(src), '必须有标定天数门槛');
  assert(/仅供观察/.test(src), '未标定必须写"仅供观察"');
  assert(/不构成买卖依据|不是买卖建议/.test(src), '必须显式免责');
  /* 绝不能出现诱导性措辞。
   * 注意要排除注释里的"禁止"声明本身 —— 源码里写着
   * "绝不：把异动说成买点"，那是约束不是违规。
   * 第一版正则没排除，把自己的禁令当成了违规（同 lessons 那次误判）。 */
  const code = src.split('\n')
    .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))   // 去掉注释行
    .join('\n');
  assert(!/可以买|建议买入|该买了|抄底吧/.test(code), '不许出现买入建议措辞');
  assert(/大盘.*买入窗口|大盘定时机/.test(src), '必须体现"大盘定时机"的前置约束');
});

test('抓取失败时如实报错，不编造原因', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/sector_watch.js', 'utf8');
  assert(/不猜测原因|板块资金返回空/.test(src), '空数据要如实说，不能猜');
  assert(/health\.record\(SOURCE,\s*false/.test(src), '真失败要记健康表');
  assert(/health\.record\(SOURCE,\s*true/.test(src), '成功要记健康表');
});

/* ── 落库与做差 ── */
test('快照表结构完整，且预留前向收益字段', () => {
  const cols = db.db.prepare('PRAGMA table_info(sector_flow_snap)').all().map(c => c.name);
  ['date', 'slot', 'code', 'name', 'today_yi', 'd10_yi', 'level', 'up_count', 'down_count']
    .forEach(c => assert(cols.includes(c), '缺字段 ' + c));
  /* 没有前向收益就永远无法验证信号有效性 —— 和 alert_samples 同一条纪律 */
  assert(cols.includes('fwd_d1') && cols.includes('fwd_d3'),
    '必须预留 fwd_d1/fwd_d3，否则信号有效性永远验证不了');
});

test('同日同 slot 同板块覆盖写，不产生重复行', () => {
  const D = '1999-01-04', S = '10:00';
  db.db.prepare('DELETE FROM sector_flow_snap WHERE date=?').run(D);
  const row = { code: 'BK9999', name: '测试板块', kind: 'industry', level: 1000,
    changePct: 1, todayYi: 5, d5Yi: 10, d10Yi: 20, mainPct: 1,
    upCount: 10, downCount: 2, leader: '某股', leaderPct: 5, dataTs: '10:00:00' };
  db.saveSectorSnap(D, S, [row]);
  db.saveSectorSnap(D, S, [{ ...row, todayYi: 9 }]);
  const got = db.sectorSnapAt(D, S);
  assert.strictEqual(got.length, 1, '同键应覆盖而不是插入两行');
  assert.strictEqual(got[0].today_yi, 9, '应更新为最新值');
  db.db.prepare('DELETE FROM sector_flow_snap WHERE date=?').run(D);
});

test('做差逻辑：区间净额 = 本次累计 - 上次累计', () => {
  /* 用固定数据验证算术，不依赖实时行情 */
  const D = '1999-01-05';
  db.db.prepare('DELETE FROM sector_flow_snap WHERE date=?').run(D);
  const base = { code: 'BK8888', name: 'T', kind: 'industry', level: 100, changePct: 0,
    todayYi: 10, d5Yi: 50, d10Yi: 100, mainPct: 1, upCount: 8, downCount: 2,
    leader: 'L', leaderPct: 3, dataTs: '10:00:00' };
  db.saveSectorSnap(D, '10:00', [base]);
  db.saveSectorSnap(D, '10:20', [{ ...base, todayYi: 18 }]);
  const a = db.sectorSnapAt(D, '10:00')[0];
  const b = db.sectorSnapAt(D, '10:20')[0];
  assert.strictEqual(b.today_yi - a.today_yi, 8, '区间净流入应为 8 亿');
  db.db.prepare('DELETE FROM sector_flow_snap WHERE date=?').run(D);
});

test('工具已注册，描述里写明与 close_scan 的区别', () => {
  const src = require('fs').readFileSync(__dirname + '/tools/registry.js', 'utf8');
  assert(/register\('sector_watch'/.test(src), 'sector_watch 未注册');
  assert(/close_scan 看截面|看变化/.test(src),
    '描述要讲清和 close_scan 的分工，否则模型会用混');
});

test('已接入巡视调度，且未标定阶段不打扰', () => {
  const src = require('fs').readFileSync(__dirname + '/patrol.js', 'utf8');
  assert(/sector_watch:\s*15 \* 60 \* 1000/.test(src), '冷却应为 15 分钟');
  assert(/runSectorWatch/.test(src), '缺 runSectorWatch');
  // 断言顺序而非相邻：调度表里后来插入了 fear_scan / stock_signal，
  // 锁死 'market_alert', 'sector_watch' 的字面相邻会让测试在逻辑不变时误报失败。
  const order = src.split('\n').find(l => l.includes("'market_alert'") && l.includes("'sector_watch'"));
  assert(order, '巡视调度表里应同时含 market_alert 与 sector_watch');
  assert(order.indexOf("'market_alert'") < order.indexOf("'sector_watch'"),
    'sector_watch 应排在大盘时机之后（先看大盘方向再看板块资金）');
  const m = src.match(/async function runSectorWatch[\s\S]{0,2600}/);
  assert(m && /worthReporting: false/.test(m[0]), '未标定阶段必须 worthReporting=false');
});

console.log('\n通过: ' + pass + ' | 失败: ' + fail);
process.exit(fail ? 1 : 0);
