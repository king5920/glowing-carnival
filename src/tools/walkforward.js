'use strict';
/**
 * walkforward.js —— 滚动【样本外】验证，杜绝过拟合。
 * ─────────────────────────────────────────────────────
 * 旧 calibrate 在全样本上算权重、又在同批数据上看胜率 = 样本内，会偏乐观。
 * 本模块对每个测试点 i：
 *   - 只用 i 之前、最近 trainWindow 行 calibrate 权重（绝不看 i 及以后）；
 *   - 用该权重给 i 算分；i 的真实前向收益只在【事后汇总】时才用。
 * 汇总的胜率因此是严格的 out-of-sample。
 *
 * 过滤器：同一批样本外预测，再按"当日可在不看未来的前提下得知"的条件分组
 * （趋势=上证相对MA、量能、RSI等），比较各组胜率，判断哪种环境下信号才有效。
 * 过滤器判定只依赖当日及以前字段（filterCtx(row,past)），同样无未来函数。
 *
 * 纯函数、null 安全；样本不够给 unknown，不硬凑。红线：不给"可以买"。
 */

const sm = require('./sentiment_model');

/* 过滤器"确认"门槛：必须样本足够、胜率明显高于50、均值为正 */
const CONFIRM_WINRATE = 0.60;
const CONFIRM_MIN_N = 15;

/* 移动平均（取最近 n 行可得收盘；不足返回 null） */
function ma(closes, n) {
  const xs = closes.filter(x => x != null && isFinite(x));
  const tail = xs.slice(-n);
  if (tail.length < n) return null;
  return tail.reduce((a, b) => a + b, 0) / n;
}

/* ───────────── 过滤器定义 ─────────────
 * 每个过滤器给出【该日的分组标签】（不看未来），或 null（无法判定）。 */
const FILTERS = {
  trend20: {
    label: '上证相对MA20',
    group: (r, past) => {
      const closes = past.map(p => p.sh_close).concat([r.sh_close]);
      const m = ma(closes, 20);
      if (m == null || r.sh_close == null) return null;
      return r.sh_close >= m ? 'MA20上方(回踩)' : 'MA20下方(接刀)';
    },
  },
  trend60: {
    label: '上证相对MA60',
    group: (r, past) => {
      const closes = past.map(p => p.sh_close).concat([r.sh_close]);
      const m = ma(closes, 60);
      if (m == null || r.sh_close == null) return null;
      return r.sh_close >= m ? 'MA60上方' : 'MA60下方';
    },
  },
  volume: {
    label: '量能(当日/MA20量)',
    group: (r, past) => {
      const vols = past.map(p => p.sh_volume).concat([r.sh_volume]);
      const m = ma(vols, 20);
      if (m == null || r.sh_volume == null) return null;
      const ratio = r.sh_volume / m;
      return ratio < 0.8 ? '缩量(<0.8)' : ratio > 1.3 ? '放量(>1.3)' : '平量(0.8–1.3)';
    },
  },
  rsiRegime: {
    label: '上证RSI档',
    group: r => {
      if (r.sh_rsi14 == null) return null;
      return r.sh_rsi14 < 35 ? 'RSI<35 深度超跌' : r.sh_rsi14 < 50 ? 'RSI35–50 弱势' : 'RSI≥50';
    },
  },
  scoreLevel: {
    label: '信号强度',
    group: (r, past, pred) => {
      if (pred == null) return null;
      return pred >= 60 ? '高分(≥60)' : pred >= 40 ? '中分(40–59)' : '低分(<40)';
    },
  },
};

function winStats(items) {
  const n = items.length;
  if (!n) return { n: 0, winRate: null, avgFwd: null };
  const wins = items.filter(x => x.fwd > 0).length;
  return {
    n,
    winRate: +(wins / n).toFixed(3),
    avgFwd: +(items.reduce((a, b) => a + b.fwd, 0) / n).toFixed(2),
  };
}

/**
 * 滚动样本外回测。
 * @param daily 升序全样本，每行需能算因子；fwd 由调用方放 fwd_d3；技术面来自 enrichDaily
 * @param opt {trainWindow=90 训练窗(交易日), minTrain=40 起评所需最少历史,
 *             signalMin=40 只对样本外分数≥此值的预测计入"信号胜率"}
 */
function walkForward(daily, opt = {}) {
  const rows = daily || [];
  const trainWindow = opt.trainWindow || 90;
  const minTrain = opt.minTrain || 40;
  const signalMin = opt.signalMin != null ? opt.signalMin : 40;

  const preds = [];   // {i,score, fwd, groups}
  for (let i = 0; i < rows.length; i++) {
    if (i < minTrain) continue;
    const train = rows.slice(Math.max(0, i - trainWindow), i);
    let calib;
    try { calib = sm.calibrate(train); } catch (e) { continue; }
    const f = sm.factors(rows[i], rows.slice(0, i));
    const score = sm.weightedScore(f, calib.weights);
    if (score == null) continue;

    const past = rows.slice(0, i);
    const groups = {};
    for (const [fk, def] of Object.entries(FILTERS)) {
      groups[fk] = def.group(rows[i], past, score);
    }
    preds.push({ i, date: rows[i].date, score, fwd: rows[i].fwd_d3, groups });
  }

  const withFwd = preds.filter(p => p.fwd != null);

  /* 基准：所有"信号分≥signalMin"的样本外胜率 */
  const signalPreds = withFwd.filter(p => p.score >= signalMin);
  const baseline = winStats(signalPreds);

  /* 全部预测（含低分）做对照 */
  const allStats = winStats(withFwd);

  /* 各过滤器分组胜率 */
  const filterReport = {};
  for (const [fk, def] of Object.entries(FILTERS)) {
    const byGroup = new Map();
    for (const p of signalPreds) {
      const g = p.groups[fk];
      if (g == null) continue;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    filterReport[fk] = {
      label: def.label,
      groups: [...byGroup.entries()].map(([g, items]) => ({ group: g, ...winStats(items) })),
    };
  }

  return {
    n: withFwd.length,
    signalMin,
    all: allStats,
    signal: baseline,
    filters: filterReport,
    predictions: withFwd,
    note: baseline.n === 0
      ? `样本不足：无分数≥${signalMin} 且带前向收益的样本外预测`
      : `样本外：分数≥${signalMin} 共 ${baseline.n} 次，T+3 胜率 ${(baseline.winRate * 100).toFixed(0)}%、均值 ${baseline.avgFwd}%`,
  };
}

/**
 * 跨训练窗稳健性评估：只确认在【多个窗口】都满足门槛的过滤组。
 * 这样把"换个窗口胜率就跳"的偶然结果自动剔除，无需人工挑选。
 *
 * @returns {confirmed:[{filter,label,group,n,winRate,avgFwd}], evaluated:窗口数, note}
 */
function evaluateConfirmed(rows, opt = {}) {
  const windows = opt.windows || [60, 90, 120];
  const signalMin = opt.signalMin || 40;
  const runs = windows.map(tw => {
    const r = walkForward(rows, Object.assign({}, opt, { trainWindow: tw, signalMin }));
    const m = new Map();
    for (const [fk, rep] of Object.entries(r.filters)) {
      for (const g of rep.groups) {
        m.set(fk + '|' + g.group, g);
      }
    }
    return m;
  });

  /* 候选 = 第一个窗口里达标的组，再要求在其余每个窗口也都达标 */
  const strong = g =>
    g.n >= CONFIRM_MIN_N && g.winRate >= CONFIRM_WINRATE && g.avgFwd > 0;

  const confirmed = [];
  for (const [key, g] of runs[0]) {
    if (!strong(g)) continue;
    let allOk = true;
    for (let k = 1; k < runs.length; k++) {
      const o = runs[k].get(key);
      if (!o || !strong(o)) { allOk = false; break; }
    }
    if (allOk) {
      const [fk, group] = key.split('|');
      confirmed.push({ filter: fk, label: FILTERS[fk].label, group,
        n: g.n, winRate: g.winRate, avgFwd: g.avgFwd });
    }
  }

  return {
    confirmed,
    evaluated: windows.length,
    note: confirmed.length
      ? `跨 ${windows.length} 个训练窗稳健达标的过滤组 ${confirmed.length} 个（仍非买入指令）`
      : `跨 ${windows.length} 个训练窗，没有任何过滤组同时满足 n≥${CONFIRM_MIN_N}、胜率≥${(CONFIRM_WINRATE * 100).toFixed(0)}%、均值为正——过滤器暂不确认，维持原观察口径`,
  };
}

module.exports = { walkForward, evaluateConfirmed, FILTERS, ma, winStats,
  CONFIRM_WINRATE, CONFIRM_MIN_N };
