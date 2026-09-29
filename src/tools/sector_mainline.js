'use strict';
/**
 * sector_mainline.js —— 板块主线候选的【纯函数】选择 + 样本外回测。
 * ────────────────────────────────────────────────────────────
 * sector_trend.trend() 直接读库、只看最近窗口，且 validate() 是样本内。
 * 这里把"在某个历史日、只用截至当日数据选出主线"做成纯函数，
 * 再用严格 walk-forward 方式给主线 T+N 的样本外胜率。
 *
 * 关键纪律（与全系统一致）：
 *   - 每个测试点 i 只用 dates[0..i] 的板块行，不看 i 之后；
 *   - 样本不足（天数不够/前向收益缺失）→ 记 unknown，绝不硬算胜率；
 *   - 只输出板块方向，不荐个股、不说"可以买"。
 */

const st = require('./sector_trend');

const MIN_LOOKBACK = 5;    // 识别主线至少要这么多交易日（与 sector_trend.MIN_TREND_DAYS 同口径）
const MIN_ML_EVENTS = 20;   // 主线样本外事件少于这个，胜率不采信

/**
 * 在某个历史日（asOfDate）只用截至当日的数据选出主线候选。
 * @param rows 截至 asOfDate(含) 的 sector_daily 行（任意多天）
 * @param dates 这些行覆盖的交易日（升序）
 * @returns [{code,name,kind,...analyze, ...grade}] 主线在最前（mainline=true）
 */
function selectAsOf(rows, dates) {
  const useDates = (dates || []).slice(-MIN_LOOKBACK);
  const since = useDates[0];
  const inWin = (rows || []).filter(r => r.date >= since);
  const byCode = new Map();
  for (const r of inWin) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const out = [];
  for (const [, series] of byCode) {
    series.sort((a, b) => a.date < b.date ? -1 : 1);
    const a = st.analyzeSeries(series, useDates);
    if (!a) continue;
    const g = st.gradeTrend(a);
    out.push(Object.assign({}, a, g));
  }
  out.sort((x, y) => (x.mainline !== y.mainline ? (x.mainline ? -1 : 1)
    : Math.abs(y.totalYi) - Math.abs(x.totalYi)));
  return out;
}

function wstats(items) {
  const n = items.length;
  if (!n) return { n: 0, winRate: null, avgFwd: null };
  const wins = items.filter(x => x.fwd > 0).length;
  return { n, winRate: +(wins / n).toFixed(3),
    avgFwd: +(items.reduce((a, b) => a + b.fwd, 0) / n).toFixed(2) };
}

/**
 * walk-forward 样本外回测。
 * @param allDates 全部交易日升序
 * @param rowsAt date -> sector_daily 行（每行带 fwd_d1/d3/d5）
 * @param opt {fwdKey='fwd_d3', startIndex 起评下标(默认MIN_LOOKBACK), topN 每天取前几个主线}
 */
function backtest(allDates, rowsAt, opt = {}) {
  const dates = allDates || [];
  const fwdKey = opt.fwdKey || 'fwd_d3';
  const startIndex = opt.startIndex != null ? opt.startIndex : MIN_LOOKBACK;
  const topN = opt.topN || 3;

  /* 预先把截至每天的累计行交给 selectAsOf（只用过去） */
  const acc = [];
  const events = [];
  for (let i = 0; i < dates.length; i++) {
    acc.push(...(rowsAt(dates[i]) || []));
    if (i < startIndex) continue;
    const candidates = selectAsOf(acc, dates.slice(0, i + 1));
    const mls = candidates.filter(x => x.mainline).slice(0, topN);
    for (const m of mls) {
      /* 该板块当日行的前向收益 */
      const today = (rowsAt(dates[i]) || []).find(r => r.code === m.code);
      const fwd = today ? today[fwdKey] : null;
      events.push({ date: dates[i], code: m.code, name: m.name, fwd });
    }
  }

  const withFwd = events.filter(e => e.fwd != null);
  const stats = wstats(withFwd);
  return {
    fwdKey,
    events: events.length,
    withFwd: withFwd.length,
    stats,
    reliable: withFwd.length >= MIN_ML_EVENTS,
    items: withFwd,
    note: withFwd.length < MIN_ML_EVENTS
      ? `主线样本外事件仅 ${withFwd.length} 个（需≥${MIN_ML_EVENTS}），胜率不采信；继续积累交易日`
      : `主线样本外 ${withFwd.length} 个，T+${fwdKey.slice(-1)} 胜率 ${(stats.winRate * 100).toFixed(0)}%、均值 ${stats.avgFwd}%（非买入指令）`,
  };
}

module.exports = { selectAsOf, backtest, MIN_LOOKBACK, MIN_ML_EVENTS };
