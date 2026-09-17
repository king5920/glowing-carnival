'use strict';
/**
 * 持续选股（stock_pool）+ 买卖点条件式提示（stock_signal）—— 行为测试
 *
 * 用户 2026-09-12：「在这个工作区里已经有盯盘功能，现在缺的是选股和提示买卖点」。
 * 这套测试守的纪律（AGENTS.md 里的坑都踩过一轮，写在这里）：
 *   1. 构造数据必须先验证能触发目标信号再写断言（探针先行，防「测试通过但根本没测到」）
 *   2. 锁意图不锁具体值（断言"出现了买入信号"，不锁分数位数的巧合值）
 *   3. 静态扫描剥注释（注释里陈述"不该那么写"的句子可能被误判成违规）
 *   4. 失误的边界：K线不足要给 error，不能拿 null 当 0 算分
 */
const assert = require('assert');
const fs = require('fs');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

process.env.JARVIS_QUIET = '1';
const sentiment = require('./tools/sentiment');
const alerts = require('./tools/alerts');
const pool = require('./tools/stock_pool');
const signal = require('./tools/stock_signal');
const registry = require('./tools/registry');

/* ── 构造工具 ── */
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
function withVol(kl, vols) {
  return kl.map((k, i) => ({ ...k, volume: vols[i] != null ? vols[i] : k.volume }));
}
/* 静态扫描必须剥注释：注释里解释"为什么不该这么写"的句子，不剥就会误判成违规 */
function codeOnly(src) {
  return src
    .replace(/(^|\n)\s*\/\/.*$/gm, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/* ══════════ 选股：secid 映射 ══════════ */

test('secidOf：6/9 开头归沪、4/8 开头归北、其余归深（东财实测口径）', () => {
  assert.strictEqual(pool.secidOf('600519'), 'sh600519');
  assert.strictEqual(pool.secidOf('688981'), 'sh688981');
  assert.strictEqual(pool.secidOf('900901'), 'sh900901');
  assert.strictEqual(pool.secidOf('000001'), 'sz000001');
  assert.strictEqual(pool.secidOf('300750'), 'sz300750');
  assert.strictEqual(pool.secidOf('830799'), 'bj830799');
  assert.strictEqual(pool.secidOf('430047'), 'bj430047');
});

/* ══════════ 选股：候选去重 ══════════ */

test('dedupCandidates：同 code 只留第一优先来源（主线领涨 > 强势领涨 > 连板池）', () => {
  const list = [
    { code: '600001', name: 'A', source: 'leader_mainline', sector: '主线A' },
    { code: '600001', name: 'A', source: 'leader_strong', sector: '强势B' },
    { code: '300001', name: 'C', source: 'zt_ladder' },
  ];
  const out = pool.dedupCandidates(list);
  assert.strictEqual(out.length, 2, '重复 code 必须合并');
  assert.strictEqual(out[0].source, 'leader_mainline', '主线身份优先于强势身份');
  assert.strictEqual(out[0].sector, '主线A');
});

/* ══════════ 选股：四维评分 ══════════ */

test('scoreStock：K线不足 20 日给 error，不给瞎分', () => {
  const r = pool.scoreStock(klFromCloses([1, 2, 3]));
  assert.strictEqual(r.error, 'K线不足20日');
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.close, null, '数据不足不许给价格，防下游误用');
});

test('scoreStock：强势股回踩缩量 → 高分且四维理由全部可追溯', () => {
  // 12 日爬升 + 11 日温和回踩（贴 MA20、RSI 降温），近 3 日缩量 —— 探针实测四维合计 ≥70
  const closes = [];
  for (let i = 0; i < 12; i++) closes.push(10 + i * 0.5);
  const peak = closes[closes.length - 1];
  for (let i = 0; i < 11; i++) closes.push(peak - i * 0.15);
  const vols = closes.map((_, i) => (i >= closes.length - 3 ? 400 : 2200));
  const r = pool.scoreStock(withVol(klFromCloses(closes), vols));
  assert.strictEqual(r.error, undefined);
  assert(r.score >= 60, '强势回踩形态应得高分，实际 ' + r.score);
  // 每维一行理由，理由里的 +N 加总必须等于总分（分分可追溯、可复现）
  const bonus = r.reasons.map(x => /\+(\d+):/.exec(x)).filter(Boolean)
    .reduce((s, m) => s + Number(m[1]), 0);
  assert.strictEqual(bonus, r.score, '理由分数加总须等于总分；reasons=' + r.reasons.join(' | '));
  assert(r.reasons.some(x => /趋势/.test(x)) && r.reasons.some(x => /位置/.test(x))
    && r.reasons.some(x => /强势/.test(x)) && r.reasons.some(x => /量价/.test(x)),
    '四维都要有理由行');
});

test('scoreStock：连跌走坏的股票得低分（不到 50 进不了池）', () => {
  const down = Array.from({ length: 20 }, (_, i) => 20 - i * 0.5);
  const r = pool.scoreStock(klFromCloses(down));
  assert(r.score < 50, '趋势走坏应低分，实际 ' + r.score);
  assert(pool.MIN_SCORE === 50, 'MIN_SCORE 门槛必须是 50（宁严勿松）');
});

/* ══════════ 买卖点：MA20 斜率 ══════════ */

test('ma20Slope：上升中为正，深跌为 0/负，K线不足返回 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 10 + i * 0.4);
  assert(signal.ma20Slope(klFromCloses(up)) > 0, '上升序列斜率应为正');
  const down = Array.from({ length: 30 }, (_, i) => 30 - i * 0.4);
  assert(signal.ma20Slope(klFromCloses(down)) <= 0, '下跌序列斜率应 ≤0');
  assert.strictEqual(signal.ma20Slope(klFromCloses([1, 2, 3])), 0, 'K线不足不许瞎算');
});

/* ══════════ 买卖点：5 类信号判定 ══════════ */

test('buy_near_support：强势回踩贴 MA20 缩量 + RSI 降温 → 出现企稳关注信号', () => {
  // 探针实测：up12/dn11 序列 state=near_support、RSI≈50、relMA20≈-1.3%（±3% 内贴支撑）
  const closes = [];
  for (let i = 0; i < 12; i++) closes.push(10 + i * 0.5);
  const peak = closes[closes.length - 1];
  for (let i = 0; i < 11; i++) closes.push(peak - i * 0.15);
  const vols = closes.map((_, i) => (i >= closes.length - 3 ? 400 : 2200));
  const kl = withVol(klFromCloses(closes), vols);
  const pb = alerts.judgeLeaderPullback(kl);
  assert.strictEqual(pb.state, 'near_support', '先验证构造确实贴近支撑，实际 ' + pb.state);
  assert(pb.rsi14 >= 40 && pb.rsi14 <= 55, '构造的 RSI 必须在降温区间，实际 ' + pb.rsi14);
  const sigs = signal.judgeSignals(kl);
  assert(sigs.some(s => s.sigType === 'buy_near_support'), '应出回踩企稳信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
  const sig = sigs.find(s => s.sigType === 'buy_near_support');
  assert(sig.triggerDesc && sig.refPrice > 0, '信号必须带触发描述和参照价');
  /* 多空分水岭：价格位于 MA20 下方 2% 内时，企稳机会与破位风险本就并存，
   * 两种信号同时出现是真实行为（贴支撑但也在均线下方），不是 bug */
});

test('buy_near_support：回踩但 RSI 仍在超买区（>55）→ 不给企稳信号（追不得）', () => {
  // 探针实测：up14/dn6 回撤仅 -6.4%、RSI=81.6，虽 near_support 但热度未降
  const closes = [];
  for (let i = 0; i < 14; i++) closes.push(10 + i * 0.5);
  const peak = closes[closes.length - 1];
  for (let i = 0; i < 6; i++) closes.push(peak - i * 0.18);
  const vols = closes.map((_, i) => (i >= closes.length - 3 ? 500 : 2000));
  const kl = withVol(klFromCloses(closes), vols);
  const pb = alerts.judgeLeaderPullback(kl);
  assert.strictEqual(pb.state, 'near_support', '构造必须是 near_support 才能检验 RSI 闸门');
  assert(pb.rsi14 > 55, '构造确认 RSI 超买');
  const sigs = signal.judgeSignals(kl);
  assert(!sigs.some(s => s.sigType === 'buy_near_support'),
    '超买区的回踩不许发企稳信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
});

test('buy_breakout：放量 + 收盘创阶段新高 → 突破信号（参照不能含当日高点）', () => {
  // 19 日窄幅横盘 + 末根放量(量比>1.5)大阳 —— 探针实测触发
  const closes = [];
  for (let i = 0; i < 19; i++) closes.push(10 + (i % 4) * 0.05);
  closes.push(11.2);
  const vols = closes.map((_, i) => (i === 19 ? 8000 : 1500));
  const sigs = signal.judgeSignals(withVol(klFromCloses(closes), vols));
  assert(sigs.some(s => s.sigType === 'buy_breakout'),
    '应出放量突破信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
  const sig = sigs.find(s => s.sigType === 'buy_breakout');
  assert(/放量突破/.test(sig.triggerDesc), '突破描述必须点出放量，实际 ' + sig.triggerDesc);
});

test('buy_golden_cross：MACD 金叉当根恰好站上 MA20 → 趋势转多信号', () => {
  // 28 日阴跌 + 连续 2 根大阳：金叉刚好发生在最后一根且收盘站上 MA20 —— 探针实测触发
  const closes = Array.from({ length: 28 }, (_, i) => 5000 - i * 22);
  for (let i = 0; i < 2; i++) closes.push(closes[closes.length - 1] + 90 + i * 108);
  const last = sentiment.indexTechnicals(klFromCloses(closes));
  const macd = sentiment.macd(closes);
  assert.strictEqual(macd.cross, 'golden', '构造必须让金叉发生在最后一根');
  assert.strictEqual(last.aboveMa20, true, '构造必须让收盘站上 MA20');
  const sigs = signal.judgeSignals(klFromCloses(closes));
  assert(sigs.some(s => s.sigType === 'buy_golden_cross'),
    '应出金叉信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
});

test('sell_broken_ma20：深跌破 MA20 且均线走平/向下 → 破位警惕（且不是贴支撑形态）', () => {
  // 15 日上涨 + 8 日深跌 —— 探针实测：只出 sell_broken_ma20，价格距 MA20 远超 3%
  const closes = [];
  for (let i = 0; i < 15; i++) closes.push(10 + i * 0.6);
  for (let i = 0; i < 8; i++) closes.push(19 - i * 0.9);
  const kl = klFromCloses(closes);
  const sigs = signal.judgeSignals(kl);
  assert(sigs.some(s => s.sigType === 'sell_broken_ma20'),
    '深跌应出破位信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
  assert(!sigs.some(s => s.sigType === 'buy_near_support'),
    '破位形态不许同时说回踩企稳（价格不在支撑±3%内）');
});

test('sell_overbought：RSI≥80 + 高位放量滞涨（收阴）→ 过热警惕', () => {
  // 20 日连涨(RSI→100) + 末根放量收阴 —— 探针实测触发
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(10 + i * 0.6);
  closes.push(closes[closes.length - 1] - 0.2);
  const vols = closes.map((_, i) => (i === closes.length - 1 ? 9000 : 2000));
  const kl = withVol(klFromCloses(closes), vols);
  const t = sentiment.indexTechnicals(kl);
  assert(t.rsi14 >= 80, '构造必须超买，实际 RSI ' + t.rsi14);
  const sigs = signal.judgeSignals(kl);
  assert(sigs.some(s => s.sigType === 'sell_overbought'),
    '应出超买信号，实际 ' + JSON.stringify(sigs.map(s => s.sigType)));
});

test('judgeSignals：K线不足 20 根不判任何信号', () => {
  assert.deepStrictEqual(signal.judgeSignals(klFromCloses([1, 2, 3])), []);
  assert.deepStrictEqual(signal.judgeSignals(null), []);
});

/* ══════════ 红线静态扫描（剥注释后）══════════ */

test('stock_pool：评分不足不进池 + calibrated:false + 只落库不吹结果', () => {
  const src = codeOnly(fs.readFileSync(__dirname + '/tools/stock_pool.js', 'utf8'));
  assert(/score\s*<\s*MIN_SCORE/.test(src), '必须有评分门槛过滤（宁严勿松）');
  assert(/MIN_SCORE\s*=\s*50/.test(src), '门槛值必须是 50');
  assert(/saveStockPool\(date,\s*pool\)/.test(src), '必须落库候选池');
  assert(/calibrated:\s*false/.test(src), '阈值未标定必须如实标注');
  assert(/规则打分可追溯|不构成交易建议|宁严勿松/.test(src), '描述必须讲清是规则打分不是荐股');
});

test('stock_signal：买点受大盘闸门、卖点恒报；worthReporting 恒 false', () => {
  const src = codeOnly(fs.readFileSync(__dirname + '/tools/stock_signal.js', 'utf8'));
  assert(/marketOk:\s*isBuy\s*\?\s*market\.buy\s*:\s*true/.test(src),
    '买点必须受大盘买入窗口闸门，卖点不受限');
  assert(/worthReporting:\s*false/.test(src), '提醒默认只在网页展示，不主动打扰');
  assert(/条件式触发描述|非确定性买卖建议/.test(src), '输出必须声明是条件式而非指令');
});

test('patrol：选股/信号已接入调度（收盘后选股、盘中判信号、绕过窗口门禁）', () => {
  const patrol = require('./patrol');
  assert.strictEqual(typeof patrol.runStockPool, 'function');
  assert.strictEqual(typeof patrol.runStockSignal, 'function');
  const src = codeOnly(fs.readFileSync(__dirname + '/patrol.js', 'utf8'));
  assert(/stock_pool:\s*20\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src), '选股冷却 20 小时（一天最多一次）');
  assert(/stock_signal:\s*20\s*\*\s*60\s*\*\s*1000/.test(src), '信号冷却 20 分钟（盘中轮询）');
  assert(/task\s*!==\s*'close_scan'\s*&&\s*task\s*!==\s*'stock_pool'/.test(src),
    'stock_pool 与 close_scan 一样绕过非主动窗口门禁（收盘后也必须能跑）');
});

test('registry：两只读工具已注册且入参有 JSON Schema', () => {
  const names = registry.listForModel().map(x => (x.function || x).name);
  assert(names.includes('stock_pool_status'), 'stock_pool_status 未注册');
  assert(names.includes('stock_signal_status'), 'stock_signal_status 未注册');
});

/* 异步用例放进结尾 IIFE：先等 Promise 完成再输出统计，否则 process.exit 会截断未完成的 await */
(async () => {
  try {
    const r = await signal.run({ pool: [], checkMarket: false });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.poolEmpty, true);
    assert.strictEqual(r.didSomething, false);
    assert.strictEqual(r.worthReporting, false);
    console.log('  ✓ stock_signal.run：池子为空时安全返回 poolEmpty，不碰大盘与网络');
    pass++;
  } catch (e) {
    console.log('  ✗ stock_signal.run：池子为空时安全返回 poolEmpty\n      ' + e.message);
    fail++;
  }

  console.log('\n通过: ' + pass + ' | 失败: ' + fail);
  process.exit(fail ? 1 : 0);
})();