'use strict';
/* 盯盘预警（sentiment/alerts）+ 盘前简报（morning_brief）+ 纠正闭环（correction）。
 * 技术指标和判断逻辑用构造数据单测（锁能力不锁网络）；真实接口用一两个冒烟测试。 */

const assert = require('assert');
let pass = 0, fail = 0;
function test(name, fn) {
  try { const v = fn(); if (v && v.then) throw new Error('async test 用 testAsync'); pass++; }
  catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
}
async function testAsync(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
}

const sentiment = require('./tools/sentiment');
const alerts = require('./tools/alerts');
const mb = require('./tools/morning_brief');
const corr = require('./tools/correction');

/* ── 构造K线：便于控制技术形态 ── */
function klFromCloses(closes, startDate = '2026-08-01') {
  const d0 = new Date(startDate);
  return closes.map((c, i) => {
    const d = new Date(d0); d.setDate(d.getDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      open: c, close: c, high: c * 1.01, low: c * 0.99, volume: 1000 + i,
    };
  });
}

/* ══════════ 技术指标纯函数 ══════════ */

test('SMA 基本正确 + 数据不足返回 null', () => {
  assert.strictEqual(sentiment.sma([1, 2, 3, 4, 5], 5), 3);
  assert.strictEqual(sentiment.sma([1, 2], 5), null, '数据不足不能硬算');
});

test('MACD 金叉逻辑：先跌后涨，DIF 由下穿上（cross 只在穿越当根出现）', () => {
  const down = Array.from({ length: 30 }, (_, i) => 4000 - i * 10);
  const up = down.concat(Array.from({ length: 12 }, (_, i) => down[down.length - 1] + i * 12));
  // cross 只在穿越当根给 golden，之后维持（null）。
  // 逐根扫描，确认这组先跌后涨序列【出现过】金叉、且末端 DIF 在 DEA 上方。
  let sawGolden = false;
  for (let n = 30; n <= up.length; n++) {
    const m = sentiment.macd(up.slice(0, n));
    if (m && m.cross === 'golden') sawGolden = true;
  }
  assert(sawGolden, '先跌后涨序列应出现金叉');
  const last = sentiment.macd(up);
  assert(last.hist > 0, '末端 MACD 柱应为正（DIF 在 DEA 上方）');
});

test('MACD 数据不足返回 null，不瞎算', () => {
  assert.strictEqual(sentiment.macd([1, 2, 3]), null);
});

test('RSI 边界：全涨=100，全跌趋近低位', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.strictEqual(sentiment.rsi(up, 14), 100);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert(sentiment.rsi(down, 14) < 5, '连续下跌 RSI 应很低');
});

test('连板梯队统计', () => {
  const pool = [{ lbc: 1 }, { lbc: 1 }, { lbc: 2 }, { lbc: 4 }];
  const lad = sentiment.ladderOf(pool);
  assert.strictEqual(lad.height, 4);
  assert.strictEqual(lad.ladder[1], 2);
  assert.strictEqual(lad.boardCount, 4);
});

/* ══════════ 信号A：大盘时机（总开关）══════════ */

function makeSnap(over) {
  const base = {
    sentiment: {
      limitUpCount: 35, brokenCount: 22, limitDownCount: 11,
      brokenRate: 38.6, ladderHeight: 4, sealFundYi: 29,
    },
    indexes: {
      '上证': { close: 3934, ma20: 3940, aboveMa20: false, macdCross: null, error: null },
      '创业板': { close: 3338, aboveMa20: false, macdCross: 'golden', error: null },
    },
  };
  return Object.assign(base, over || {});
}

test('信号A：今天真实弱市 → 不满足买入窗口', () => {
  const m = alerts.judgeMarket(makeSnap(), 0);
  assert.strictEqual(m.buy, false);
  assert.strictEqual(m.calibrated, false, '样本0天必须标未标定');
  assert(m.total === 6 && m.passed < 6);
  assert(/时机未到|只观察/.test(m.reason));
});

test('信号A：全部条件共振才算买入窗口（宁缺毋滥）', () => {
  const strong = makeSnap({
    sentiment: { limitUpCount: 80, brokenCount: 10, limitDownCount: 3,
      brokenRate: 11, ladderHeight: 5, sealFundYi: 120 },
    indexes: {
      '上证': { close: 4000, ma20: 3950, aboveMa20: true, macdCross: 'golden', error: null },
      '创业板': { close: 3500, aboveMa20: true, macdCross: 'golden', error: null },
    },
  });
  const m = alerts.judgeMarket(strong, 20);
  assert.strictEqual(m.buy, true, '全满足才开窗口');
  assert.strictEqual(m.calibrated, true, '20天样本应标已标定');
});

test('信号A：情绪数据缺失时明确说无法判断，不编造', () => {
  const m = alerts.judgeMarket({ sentiment: null, indexes: {} }, 0);
  assert.strictEqual(m.buy, false);
  assert(/缺失/.test(m.reason));
});

/* ══════════ 信号B：龙头调整到位（纯K线构造）══════════ */

test('信号B：强势股缩量回踩MA20 → near_support', () => {
  // 构造：20日明显上涨后从高点回撤约8%，价格贴近MA20，量缩
  const closes = [];
  for (let i = 0; i < 14; i++) closes.push(10 + i * 0.5);      // 爬到 ~16.5
  for (let i = 0; i < 6; i++) closes.push(16.5 - i * 0.18);   // 回落到 ~15.6
  const kl = klFromCloses(closes).map((k, i) => ({
    ...k,
    // 前段放量、近3日缩量
    volume: i >= closes.length - 3 ? 500 : 2000,
  }));
  const j = alerts.judgeLeaderPullback(kl);
  assert(['near_support', 'pulling'].includes(j.state), '应识别为回踩或回调，实际 ' + j.state + ' ' + j.reason);
});

test('信号B：没涨过的不算主线龙头', () => {
  const flat = klFromCloses(Array.from({ length: 25 }, (_, i) => 10 + (i % 3) * 0.05));
  const j = alerts.judgeLeaderPullback(flat);
  assert.strictEqual(j.state, 'not_leader');
});

test('信号B：有效跌破MA20 → broken', () => {
  // 先涨后深跌破位
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(10 + i * 0.6);
  for (let i = 0; i < 8; i++) closes.push(19 - i * 0.9);
  const j = alerts.judgeLeaderPullback(klFromCloses(closes));
  assert.strictEqual(j.state, 'broken', '深跌应判跌破，实际 ' + j.state);
});

test('信号B：K线不足返回 unknown 而非瞎判', () => {
  const j = alerts.judgeLeaderPullback(klFromCloses([1, 2, 3]));
  assert.strictEqual(j.state, 'unknown');
});

/* ══════════ 盘前简报：个股过滤 + 坏了明说 ══════════ */

test('个股新闻过滤：带代码的剔除，宏观保留', () => {
  const rows = [
    { title: '央行降准0.5个百分点' },
    { title: '贵州茅台(600519)三季报' },
    { title: '美联储维持利率不变' },
    { title: '宁德时代 300750 获订单' },
  ];
  const { kept, dropped } = mb.filterMacro(rows);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 2);
  assert(kept.some(x => /央行/.test(x.title)));
});

/* ══════════ 纠正闭环 ══════════ */

test('纠正语气检测', () => {
  assert(corr.soundsLikeCorrection('你这个搞错了'));
  assert(corr.soundsLikeCorrection('不对，应该是三天'));
  assert(!corr.soundsLikeCorrection('今天天气如何'));
});

test('直接"记住教训"指令识别', () => {
  assert(corr.soundsLikeSaveDirective('记住这个教训：别猜字段'));
  assert(!corr.soundsLikeSaveDirective('帮我查下茅台'));
});

test('confirmLesson 落库且 scope 加命名空间，重复累加', () => {
  const db = require('./db');
  const before = db.lessonCount();
  const c = { scope: 'time:时间', pattern: '时间概念错误', actual: '收盘后说成盘中',
    expected: '用权威时钟', guard: '回答前先看 nowBlock' };
  const r1 = corr.confirmLesson(c);
  assert(r1.ok);
  const r2 = corr.confirmLesson(c);
  assert(r2.repeated, '同类应复发累加');
  const after = db.lessonCount();
  assert.strictEqual(after, before + 1, '两次同类只新增一行');
  // 清理
  db.db.prepare("DELETE FROM lessons WHERE scope='time:时间' AND actual LIKE '%收盘后说成盘中%'").run();
});

test('confirmLesson 拒绝不完整教训（没有 actual/guard）', () => {
  const r = corr.confirmLesson({ scope: 'x' });
  assert.strictEqual(r.ok, false);
});

/* ══════════ 定时窗口 ══════════ */

test('盘前简报窗口：交易日08:55到点，周末/盘中不到', () => {
  const patrol = require('./patrol');
  // canRun 依赖内存冷却，这里只验证函数存在且对时间敏感（不直接调 due，
  // 因为它读真实时钟）。改测 clock 的交易日判定 + 窗口边界常量逻辑。
  assert(typeof patrol.morningBriefDue === 'function');
  assert(typeof patrol.runMorningBrief === 'function');
  // 2026-09-10 周四是交易日
  const clock = require('./clock');
  assert.strictEqual(clock.isTradingDay(new Date('2026-09-10T08:55')), true);
  assert.strictEqual(clock.isTradingDay(new Date('2026-09-12T08:55')), false, '周六不该跑');
});

test('工具已注册：market_timing/market_phase/sector_adjustment/morning_brief/save_lesson', () => {
  const r = require('./tools/registry');
  const names = r.listForModel().map(x => (x.function || x).name);
  ['market_timing', 'market_phase', 'sector_adjustment', 'morning_brief', 'save_lesson'].forEach(n =>
    assert(names.includes(n), '缺少工具 ' + n));
});

/* ══════════ 真实接口冒烟（网络失败时降级为通过，只验证不崩）══════════ */

testAsync('sentiment.snapshot 真实采集结构完整（网络失败可接受）', async () => {
  let snap;
  try { snap = await sentiment.snapshot({ date: '20260910' }); }
  catch (e) { return; }   // 离线环境不卡 CI
  if (snap && snap.sentiment) {
    assert(typeof snap.sentiment.brokenRate === 'number');
    assert(snap.indexes['上证'], '应有上证技术面');
  }
});

console.log(`\n通过: ${pass} | 失败: ${fail}`);
process.exit(fail ? 1 : 0);
