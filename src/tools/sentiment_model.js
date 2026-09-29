'use strict';
/**
 * sentiment_model.js —— 经历史【前向收益标定】的多因子情绪模型。
 * ─────────────────────────────────────────────────────────────
 * 旧模型 sentiment_score 用 3 个先验权重（跌停.45/炸板.40/RSI.15），从未被验证。
 * 本模块做两件事：
 *   1) factors(row, pastRows)：把一行 alert_samples 转成多个【0–1 连续因子】，
 *      分位只用【该行之前】的样本（expanding percentile），杜绝未来函数；
 *   2) calibrate(samples)：用已回填的前向收益，算每个因子与 T+3 收益的相关（IC），
 *      据 IC 定权重（符号取反向：因子越大→越恐慌→后市越可能反弹，权重取负相关方向），
 *      样本不足或不显著 → 回退先验权重并标 calibrated:false。
 *
 * 全部纯函数、null 安全：缺因子跳过，绝不当 0；样本不够给 unknown，不硬算。
 * 红线：不输出"可以买"，只给情绪分与标定口径；阈值仍未最终标定。
 */

const MIN_CAL_DAYS = 30;      // 多因子标定最少（且要有回填前向收益）
const MIN_FWD_ROWS = 20;      // 至少这么多行带 fwd_d3 才允许数据标定
const EDGE_MIN_WINRATE = 0.55; // 高恐慌段历史 T+3 胜率门槛（低于此=无可靠反向边缘）
const EDGE_MIN_IC = 0.05;      // 至少一个因子 IC 要负到这个程度（反向预测力下限）

/* ───────────── 基础统计 ───────────── */

/** expanding 分位：v 在【过去样本 past】中的 ≤占比（不含当日，避免未来信息） */
function expPercentile(past, v) {
  if (v == null) return null;
  const xs = (past || []).filter(x => x != null && isFinite(x));
  if (!xs.length) return null;
  let leq = 0;
  for (const x of xs) if (x <= v) leq++;
  return leq / xs.length;
}

/** RSI→超跌 0–1（与 sentiment_score 一致）：≤30→1，≥50→0 */
function rsiPart(rsi) {
  if (rsi == null) return null;
  if (rsi <= 30) return 1;
  if (rsi >= 50) return 0;
  return (50 - rsi) / 20;
}

/** 连板高度连续化：最高板越低越恐慌。高度 h → (5-h)/4 截断 0–1；h≥5→0 */
function ladderPart(h) {
  if (h == null) return null;
  const x = (5 - h) / 4;
  return Math.max(0, Math.min(1, x));
}

/** 当日跌幅（%）→ 冲击 0–1：跌0%→0，跌≥4%→1 */
function dropPart(changePct) {
  if (changePct == null) return null;
  const x = Math.min(0, changePct) / -4;
  return Math.max(0, Math.min(1, x));
}

/** 封板资金：用【相对过去的萎缩程度】。给历史 seal 与今日 seal，
 * 今日越低（资金越不愿封板）→ 因子越高。直接对"今日 seal 分位"取 1-pct。 */
function sealWeakPart(pastPct) {
  if (pastPct == null) return null;
  return 1 - pastPct;     // seal 处于低分位 = 弱
}

/** Pearson 相关；返回 null（样本不足/零方差） */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (!vx || !vy) return null;
  return cov / Math.sqrt(vx * vy);
}

/* ───────────── 因子表 ─────────────
 * 每个因子 {key, label, get(row,ctx)}，输出 0–1 或 null。
 * ctx.past = 该行之前的历史行（daily 口径，升序）。 */
const FACTOR_DEFS = [
  { key: 'limitDown', label: '跌停家数分位',
    get: (r, c) => expPercentile(c.past.map(p => p.limit_down), r.limit_down) },
  { key: 'brokenRate', label: '炸板率分位',
    get: (r, c) => expPercentile(c.past.map(p => p.broken_rate), r.broken_rate) },
  { key: 'shRsi', label: '上证RSI超跌',
    get: r => rsiPart(r.sh_rsi14) },
  { key: 'cybRsi', label: '创业板RSI超跌',
    get: r => rsiPart(r.cyb_rsi14) },
  { key: 'ladder', label: '连板高度（连续）',
    get: r => ladderPart(r.ladder_height) },
  { key: 'shDrop', label: '上证当日跌幅冲击',
    get: r => dropPart(shChange(r)) },
  { key: 'sealWeak', label: '封板资金萎缩',
    get: (r, c) => sealWeakPart(expPercentile(c.past.map(p => p.seal_fund_yi), r.seal_fund_yi)) },
];

/* 上证当日涨跌%：用 sh_close 无法直接得到（要前一天收盘）。
 * ctx 提供 prevClose 时才算，否则 null。 */
function shChange(r) { return r.__shChange != null ? r.__shChange : null; }

/**
 * 计算单日因子值。
 * @param row 当日 daily 行（可注入 __shChange）
 * @param past 该行之前的 daily 行
 * @returns {key: 0–1|null}
 */
function factors(row, past) {
  const ctx = { past: past || [] };
  const out = {};
  for (const f of FACTOR_DEFS) out[f.key] = f.get(row, ctx);
  return out;
}

/** 先验权重（标定前的起点）：在旧3因子基础上把新增广度因子给较小权重，合计=1 */
const PRIOR_WEIGHTS = {
  limitDown: 0.24, brokenRate: 0.20, shRsi: 0.12, cybRsi: 0.10,
  ladder: 0.10, shDrop: 0.14, sealWeak: 0.10,
};

/**
 * 用前向收益标定权重（IC 法）。
 * @param daily 全部 daily 行（升序）；每行需已能算出因子且带 fwd_d3
 * @returns {weights, calibrated, usedRows, ics, winRateTopQuartile|null, note}
 */
function calibrate(daily) {
  const rows = daily || [];
  const dataRows = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.fwd_d3 == null) continue;
    const f = factors(r, rows.slice(0, i));
    dataRows.push({ f, fwd: r.fwd_d3 });
  }

  if (dataRows.length < MIN_FWD_ROWS || rows.length < MIN_CAL_DAYS) {
    return {
      weights: PRIOR_WEIGHTS, calibrated: false, effective: false, usedRows: dataRows.length,
      ics: {}, topQuartile: null,
      note: `带前向收益样本 ${dataRows.length} < ${MIN_FWD_ROWS}，沿用先验权重·未标定`,
    };
  }

  // 每个因子的 IC = corr(factor, fwd_d3)
  const ics = {};
  for (const fd of FACTOR_DEFS) {
    const xs = [], ys = [];
    for (const d of dataRows) {
      if (d.f[fd.key] != null) { xs.push(d.f[fd.key]); ys.push(d.fwd); }
    }
    ics[fd.key] = pearson(xs, ys);
  }

  // 前向收益符号约定：T+3 收益【为正=反弹】。恐慌因子高、日后反弹 → IC 为【正】。
  // 用 max(0,+IC) 取有正向（反向抄底）预测力的因子，归一化为权重。
  // 若全部 IC≤0（恐慌后只跌不弹）→ 回退先验并标记未支持。
  const raw = {};
  let sum = 0;
  for (const fd of FACTOR_DEFS) {
    const ic = ics[fd.key];
    const strength = ic == null ? 0 : Math.max(0, ic);
    raw[fd.key] = strength; sum += strength;
  }
  if (sum <= 1e-9) {
    return {
      weights: PRIOR_WEIGHTS, calibrated: false, usedRows: dataRows.length, ics,
      topQuartile: null,
      note: '各因子与T+3收益未呈预期负相关，数据未支持恐慌反向假设，沿用先验权重',
    };
  }
  const weights = {};
  for (const fd of FACTOR_DEFS) weights[fd.key] = +(raw[fd.key] / sum).toFixed(4);

  // 高恐慌四分位（用标定分数）的历史 T+3 胜率——给界面一个"信号到底准不准"的硬数字
  const scored = dataRows.map(d => ({ s: weightedScore(d.f, weights), fwd: d.fwd }))
    .filter(x => x.s != null);
  scored.sort((a, b) => b.s - a.s);
  const q = scored.slice(0, Math.max(5, Math.floor(scored.length / 4)));
  const wins = q.filter(x => x.fwd > 0).length;
  const topQuartile = {
    n: q.length, winRate: q.length ? +(wins / q.length).toFixed(3) : null,
    avgFwd: q.length ? +(q.reduce((a, b) => a + b.fwd, 0) / q.length).toFixed(2) : null,
  };

  /* ── 信号闸门：IC 权重不等于"有可交易的反向边缘"。
   * 必须高恐慌段历史 T+3 胜率 ≥ EDGE_MIN_WINRATE 且 至少一个因子 IC ≤ -EDGE_MIN_IC，
   * 才认定【已标定且有效】；否则权重算出但标记 effective:false、整体 calibrated:false，
   * 界面看到胜率证据却不被诱导去接飞刀。 */
  const bestPosIc = Math.max(...Object.values(ics).filter(v => v != null));
  const edge = topQuartile.winRate >= EDGE_MIN_WINRATE && bestPosIc >= EDGE_MIN_IC;
  if (!edge) {
    return {
      weights, calibrated: false, effective: false, usedRows: dataRows.length, ics,
      topQuartile,
      note: `数据标定显示高恐慌段 T+3 胜率仅 ${(topQuartile.winRate * 100).toFixed(0)}%、最强正向IC ${bestPosIc.toFixed(2)}，`
        + '近一年恐慌不构成可靠反弹边缘——保持观察，不据此出手',
    };
  }

  return {
    weights, calibrated: true, effective: true, usedRows: dataRows.length, ics, topQuartile,
    note: `已用 ${dataRows.length} 个样本标定，高恐慌${topQuartile.n}次 T+3 胜率 ${(topQuartile.winRate * 100).toFixed(0)}%（仍非买入指令）`,
  };
}

/** 因子值 × 权重合成 0–100；忽略 null 并对可用权重【重归一化】（缺失≠0） */
function weightedScore(f, weights) {
  let sumW = 0, acc = 0;
  for (const k of Object.keys(weights)) {
    if (f[k] != null) { sumW += weights[k]; acc += f[k] * weights[k]; }
  }
  if (!sumW) return null;
  return Math.round((acc / sumW) * 100);
}

/**
 * 组装当日多因子情绪结果（给 market_phase / 网页）。
 * @param today 当日 daily 行（可注入 __shChange）
 * @param past 之前 daily 行
 * @param calib calibrate() 的结果
 */
function scoreTodayMulti(today, past, calib) {
  const f = factors(today, past);
  const score = weightedScore(f, calib.weights);
  return {
    score,
    label: score == null ? '情绪未知'
      : score >= 70 ? '恐慌冰点' : score >= 40 ? '情绪警戒' : '情绪平静',
    state: score == null ? 'unknown'
      : score >= 70 ? 'panic' : score >= 40 ? 'watch' : 'calm',
    factors: f,
    weights: calib.weights,
    calibrated: calib.calibrated,
    effective: calib.effective,
    evidence: calib.calibrated ? calib.topQuartile : null,
  };
}

/* ───────────── 前向收益回填 ───────────── */

/**
 * 用【日期→上证收盘】映射回填 fwd_d1/d3/d5（按后续第1/3/5个交易日）。
 * 历史 backfill 行自存 sh_close 多为 NULL，因此收盘从可靠指数K线（腾讯）取，按日期对齐。
 * 末尾不够天数留 NULL（不猜）。幂等可重复跑。
 *
 * @param db 注入数据库
 * @param daily alertSamplesDaily()（提供 date+slot+limit_down...）
 * @param closeByDate Map<date, close>；缺省回退到行自存 sh_close
 */
function backfillAlertForward(db, daily, closeByDate) {
  const closeOf = r =>
    (closeByDate && closeByDate.get(r.date) != null) ? closeByDate.get(r.date)
    : (r.sh_close != null ? r.sh_close : null);
  const rows = (daily || []).map(r => ({ r, c: closeOf(r) }))
    .filter(x => x.c != null && x.c > 0);
  if (rows.length < 2) return { filled: 0, note: '可用于回填的行不足（日期对齐不到指数收盘）' };
  const pct = (from, to) => Math.round(((to - from) / from) * 10000) / 100;
  let filled = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].r;
    const f = k => (i + k < rows.length ? rows[i + k].c : null);
    const c1 = f(1), c3 = f(3), c5 = f(5);
    if (c1 == null) continue;
    const d1 = pct(rows[i].c, c1);
    const d3 = c3 != null ? pct(rows[i].c, c3) : null;
    const d5 = c5 != null ? pct(rows[i].c, c5) : null;
    db.updateAlertFwd(r.date, r.slot, d1, d3, d5);
    filled++;
  }
  return { filled, note: `回填 ${filled} 行 fwd_d1/d3/d5（按日期对齐指数收盘）` };
}

/* ───────────── 历史技术面增强 ───────────── */

/** Wilder RSI14：从收盘序列（旧→新）返回每日 RSI（前14根不足→null） */
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = 100 - 100 / (1 + (loss === 0 ? 100 : gain / loss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (loss === 0 ? 100 : gain / loss));
  }
  return out;
}

/**
 * 把 alert daily 行与指数K线按日期合并，补齐历史可得的技术字段：
 *   __shChange（上证当日%）、sh_rsi14；传入 cybBars 则补 cyb_rsi14。
 * 不覆盖行里已有的非空值。返回新数组（升序），仍是 daily 行（加了字段）。
 */
function enrichDaily(daily, shBars, cybBars) {
  const sh = shBars || [];
  const shRsi = rsiSeries(sh.map(b => b.close));
  const shByDate = new Map(sh.map((b, i) => [b.date, { b, rsi: shRsi[i] }]));
  let cybByDate = null;
  if (cybBars && cybBars.length) {
    const cybRsi = rsiSeries(cybBars.map(b => b.close));
    cybByDate = new Map(cybBars.map((b, i) => [b.date, cybRsi[i]]));
  }
  return daily.map(r => {
    const e = shByDate.get(r.date);
    const out = Object.assign({}, r);
    if (e) {
      const idx = sh.findIndex(b => b.date === r.date);
      if (idx > 0) out.__shChange = (e.b.close - sh[idx - 1].close) / sh[idx - 1].close * 100;
      if (out.sh_rsi14 == null && e.rsi != null) out.sh_rsi14 = +e.rsi.toFixed(1);
    }
    if (cybByDate) {
      const cv = cybByDate.get(r.date);
      if (out.cyb_rsi14 == null && cv != null) out.cyb_rsi14 = +cv.toFixed(1);
    }
    return out;
  });
}

module.exports = {
  factors, calibrate, scoreTodayMulti, weightedScore, backfillAlertForward,
  enrichDaily, rsiSeries,
  expPercentile, rsiPart, ladderPart, dropPart, pearson,
  FACTOR_DEFS, PRIOR_WEIGHTS, MIN_CAL_DAYS, MIN_FWD_ROWS, EDGE_MIN_WINRATE, EDGE_MIN_IC,
};
