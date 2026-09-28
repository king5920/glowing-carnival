'use strict';
/**
 * sentiment_score.js —— 把情绪三料合成一个【0–100 大盘情绪恐慌指数】。
 * ─────────────────────────────────────────────────────────
 * 为什么单独做：旧面板把笔/中枢/三料胶囊全摊出来，没有"一个数读情绪"。
 *   这里只做一件事——把已经算好的【分位】合成成一个主读数，并给近N日序列画曲线。
 *
 * 诚实口径：
 *   - 输入只用已经算好的分位（0–1），不新发明底层阈值；权重是展示合成，明确标"未标定"。
 *   - null≠0：任一必需分位缺失 → today 标 unknown（score=null），绝不用0顶上。
 *   - 历史回填日没有指数RSI，曲线只用跌停/炸板率两料并对权重重归一化；
 *     当日有RSI则三料。两种口径在 series 里带 hasRsi 标记，不混着当同一数。
 *
 * 分数方向：0=情绪平静/乐观，100=散户极度恐慌（冰点）。
 */

/* 展示权重（未标定）：跌停分位 / 炸板率分位 / RSI超跌 */
const W = { limitDown: 0.45, brokenRate: 0.40, rsi: 0.15 };
const RSI_OVERSOLD = 30, RSI_CALM = 50;

/** 分位（百分位，0–1）：v 在 arr 中的经验分位，null 安全 */
function percentileOf(arr, v) {
  const a = arr.filter(x => x != null);
  if (!a.length || v == null) return null;
  // 与 capitulation 同口径：(<v)+(=v)/2，再/N
  let below = 0, equal = 0;
  for (const x of a) { if (x < v) below++; else if (x === v) equal++; }
  return (below + equal / 2) / a.length;
}

/** RSI → 超跌分位（0–1）：RSI≤30→1，RSI≥50→0，线性 */
function rsiOversoldPart(rsi) {
  if (rsi == null) return null;
  if (rsi <= RSI_OVERSOLD) return 1;
  if (rsi >= RSI_CALM) return 0;
  return (RSI_CALM - rsi) / (RSI_CALM - RSI_OVERSOLD);
}

/**
 * 当日合成。
 * @param parts {limitDownPct,brokenRatePct,rsi} 分位(0-1)与RSI原值
 * @returns {score:0-100, label, calm|watch|panic, parts:{…}, calibrated:false}
 *   两料分位缺失→score null/unknown。
 */
function scoreToday(parts = {}) {
  const pld = parts.limitDownPct, pbr = parts.brokenRatePct, pr = rsiOversoldPart(parts.rsi);
  if (pld == null || pbr == null) {
    return { score: null, label: '情绪未知', state: 'unknown', calibrated: false,
      parts: { limitDownPct: pld, brokenRatePct: pbr, rsiPart: pr } };
  }
  const out = weighted(pld, pbr, pr);
  return { score: out.score, label: labelOf(out.score), state: stateOf(out.score),
    calibrated: false, parts: { limitDownPct: pld, brokenRatePct: pbr, rsiPart: pr } };
}

function weighted(pld, pbr, pr) {
  let score, used;
  if (pr == null) {
    // 无RSI：两料重归一化
    const wl = W.limitDown / (W.limitDown + W.brokenRate);
    used = { limitDown: wl, brokenRate: 1 - wl, rsi: 0 };
    score = pld * wl + pbr * (1 - wl);
  } else {
    used = W;
    score = pld * W.limitDown + pbr * W.brokenRate + pr * W.rsi;
  }
  return { score: Math.round(score * 100), used };
}

function stateOf(s) { return s >= 70 ? 'panic' : s >= 40 ? 'watch' : 'calm'; }
function labelOf(s) {
  if (s >= 70) return '恐慌冰点';
  if (s >= 40) return '情绪警戒';
  return '情绪平静';
}

/**
 * 近N日情绪序列（画曲线）。
 * @param daily alertSamplesDaily 行（升序），字段 limit_down,broken_rate
 * @param rsiByDate? Map<iso,rsi> 有则当日三料
 * @param days 默认20
 * @returns [{date,score,hasRsi}]
 */
function series(daily, rsiByDate, days = 20) {
  const rows = (daily || []).slice(-days);
  const ldArr = rows.map(r => r.limit_down), brArr = rows.map(r => r.broken_rate);
  return rows.map(r => {
    const pld = percentileOf(ldArr, r.limit_down);
    const pbr = percentileOf(brArr, r.broken_rate);
    const rsi = rsiByDate ? rsiByDate.get(r.date) : null;
    const pr = rsiOversoldPart(rsi);
    let score = null;
    if (pld != null && pbr != null) score = weighted(pld, pbr, pr).score;
    return { date: r.date, score, hasRsi: pr != null };
  });
}

module.exports = {
  scoreToday, series, percentileOf, rsiOversoldPart,
  labelOf, stateOf, W,
};
