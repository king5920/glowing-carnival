'use strict';
/**
 * 标定总账：把已经算好的样本外数字收成结论。
 *
 * 不新写打分，不调权重，不把选股池算进策略（尚无选股策略）。
 *
 * 状态沿用现成门槛，不另起一套：
 *   pass  有效      样本够，且胜率 ≥ walkforward 的 60%，均值 > 0
 *   fail  无效      样本够，且胜率 < capitulation.evaluateFear 的 45%
 *   short 样本不够  次数低于确认线，不下胜率结论
 *   open  未标定    样本够，但既没过确认线，也没差到无效
 *
 * 板块主线的样本线用 sector_mainline.MIN_ML_EVENTS，不把不够的胜率写成有效。
 */

const wf = require('./walkforward');
const cap = require('./capitulation');
const sml = require('./sector_mainline');

const PASS_WIN = wf.CONFIRM_WINRATE;
const MIN_N = wf.CONFIRM_MIN_N;
const FAIL_WIN = 0.45;

function fmtAvg(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v + '%';
}

/**
 * @param {{n?:number, winRate?:number|null, avgFwd?:number|null}|null} stat
 * @param {{minN?:number, forceShort?:boolean, horizon?:string}} [opt]
 */
function classifyRate(stat, opt = {}) {
  const minN = opt.minN != null ? opt.minN : MIN_N;
  const horizon = opt.horizon || 'T+3';
  const n = stat && stat.n != null ? stat.n : 0;
  const winRate = stat && stat.winRate != null && isFinite(stat.winRate) ? stat.winRate : null;
  const avgFwd = stat && stat.avgFwd != null && isFinite(stat.avgFwd) ? stat.avgFwd : null;
  const base = { n, winRate, avgFwd, minN };

  if (opt.forceShort || n < minN || winRate == null) {
    return Object.assign(base, {
      state: 'short',
      label: '样本不够',
      detail: `带前向收益的样本 ${n} 个，确认线是 ${minN} 个，${horizon} 胜率先不下结论`,
    });
  }
  if (winRate >= PASS_WIN && avgFwd != null && avgFwd > 0) {
    return Object.assign(base, {
      state: 'pass',
      label: '有效',
      detail: `样本外 ${n} 次，${horizon} 胜率 ${(winRate * 100).toFixed(0)}%，均值 ${fmtAvg(avgFwd)}。这不是买入指令`,
    });
  }
  if (winRate < FAIL_WIN) {
    return Object.assign(base, {
      state: 'fail',
      label: '无效',
      detail: `样本外 ${n} 次，${horizon} 胜率 ${(winRate * 100).toFixed(0)}%，低于 45%。不要把它说成有效边缘`,
    });
  }
  const avgTxt = avgFwd == null ? '均值未带上' : `均值 ${fmtAvg(avgFwd)}`;
  return Object.assign(base, {
    state: 'open',
    label: '未标定',
    detail: `样本外 ${n} 次，${horizon} 胜率 ${(winRate * 100).toFixed(0)}%，${avgTxt}。没过 60% 且均值为正的确认线，维持未标定`,
  });
}

/** 历史行 → capitulation.evaluate 要的情绪形状。没有连板明细时，不把「高度>1」猜成断层。 */
function sentimentFromRow(r) {
  let ladder = null;
  if (r && r.ladder && typeof r.ladder === 'object') ladder = r.ladder;
  else if (r && typeof r.raw === 'string') {
    try {
      const o = JSON.parse(r.raw);
      if (o && o.sentiment && o.sentiment.ladder) ladder = o.sentiment.ladder;
    } catch (_) { ladder = null; }
  }
  const h = r && r.ladder_height != null ? r.ladder_height
    : (r && r.ladderHeight != null ? r.ladderHeight : null);
  const heightKnown = h != null && (ladder != null || h <= 1);
  return {
    limitDownCount: r && r.limit_down != null ? r.limit_down
      : (r && r.limitDownCount != null ? r.limitDownCount : null),
    brokenRate: r && r.broken_rate != null ? r.broken_rate
      : (r && r.brokenRate != null ? r.brokenRate : null),
    ladderHeight: heightKnown ? h : null,
    ladder: ladder || undefined,
  };
}

function shFromRow(r) {
  const rsi = r && r.sh_rsi14 != null ? r.sh_rsi14 : (r && r.rsi14 != null ? r.rsi14 : null);
  let above = null;
  if (r && (r.sh_above_ma20 === 0 || r.sh_above_ma20 === false)) above = false;
  else if (r && (r.sh_above_ma20 === 1 || r.sh_above_ma20 === true)) above = true;
  else if (r && (r.aboveMa20 === false || r.aboveMa20 === true)) above = r.aboveMa20;
  return { rsi14: rsi, aboveMa20: above };
}

/**
 * 用既有 evaluate 逐日回放冰点，分位只用当日之前的行，再交给 evaluateFear。
 * phaseAt(row, index) 由调用方提供「截至该日」的缠论阶段；给不出就传 null，普通冰点不会放行。
 */
function fearForward(rows, phaseAt) {
  const list = Array.isArray(rows) ? rows : [];
  const triggers = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    let phase = null;
    if (typeof phaseAt === 'function') {
      try { phase = phaseAt(r, i); } catch (_) { phase = null; }
    }
    const ev = cap.evaluate(
      sentimentFromRow(r), shFromRow(r), list.slice(0, i),
      phase ? { phase } : null,
    );
    if (!ev || (ev.tier !== 'normal' && ev.tier !== 'extreme')) continue;
    triggers.push({
      date: r.date || null,
      fwd_d1: r.fwd_d1 != null ? r.fwd_d1 : null,
      fwd_d3: r.fwd_d3 != null ? r.fwd_d3 : null,
      fear_tier: ev.tier,
    });
  }
  const judged = cap.evaluateFear(triggers);
  judged.triggerCount = triggers.length;
  return judged;
}

function fromFear(ev) {
  const d3 = (ev && ev.d3) || {};
  const n = d3.n || 0;
  if (!ev || n < MIN_N || d3.winRate == null) {
    /* evaluateFear 在两三次样本上也会写出「暂时有效」。总账不引用这句，
     * 否则面板会把样本不够和有效同时说出来。 */
    return {
      id: 'fear', name: '崩溃冰点', state: 'short', label: '样本不够',
      n, winRate: d3.winRate != null ? d3.winRate : null,
      avgFwd: d3.avg != null ? d3.avg : null, minN: MIN_N,
      detail: `已回填前向的冰点触发 ${n} 次，确认线 ${MIN_N}。次数未到确认线，原始胜率不作为结论`,
    };
  }
  const c = classifyRate({ n, winRate: d3.winRate, avgFwd: d3.avg }, { horizon: 'T+3' });
  return Object.assign({ id: 'fear', name: '崩溃冰点' }, c);
}

function build(src) {
  const s = src || {};
  const items = [];

  items.push({
    id: 'display_score',
    name: '展示情绪分',
    state: 'open',
    label: '未标定',
    detail: '跌停、炸板率、RSI 的展示权重 0.45/0.40/0.15 没有做过样本外验证，只用来看盘',
  });

  const oos = s.sentimentOos || null;
  items.push(Object.assign(
    { id: 'sentiment_oos', name: '多因子情绪样本外' },
    classifyRate(oos ? { n: oos.n, winRate: oos.winRate, avgFwd: oos.avgFwd } : null),
  ));

  const confirmed = Array.isArray(s.confirmed) ? s.confirmed : [];
  if (confirmed.length) {
    items.push({
      id: 'sentiment_filter',
      name: '情绪过滤组',
      state: 'pass',
      label: '有效',
      n: confirmed.length,
      detail: '跨训练窗同时过线的有 '
        + confirmed.map(c => `${c.group || c.label}（${c.n} 次，胜率 ${(Number(c.winRate) * 100).toFixed(0)}%）`).join('、')
        + '。这不是买入指令',
    });
  } else {
    items.push({
      id: 'sentiment_filter',
      name: '情绪过滤组',
      state: 'open',
      label: '未标定',
      detail: '跨训练窗没有同时满足样本、胜率和均值为正的过滤组',
    });
  }

  items.push(fromFear(s.fearEval));

  const wName = s.windowName || '当前窗口';
  items.push(Object.assign(
    { id: 'market_window', name: '大盘时机·' + wName },
    classifyRate(s.windowStat ? {
      n: s.windowStat.n, winRate: s.windowStat.winRate, avgFwd: s.windowStat.avgFwd,
    } : null),
  ));

  const sec = s.sector || {};
  const d3 = sec.d3 || {};
  items.push(Object.assign(
    { id: 'sector_mainline', name: '板块主线' },
    classifyRate(
      { n: d3.n, winRate: d3.winRate, avgFwd: d3.avgFwd },
      { minN: sml.MIN_ML_EVENTS, forceShort: d3.reliable === false },
    ),
  ));

  items.push({
    id: 'chan',
    name: '缠论阶段',
    state: 'open',
    label: '未标定',
    detail: '画法还在对图，没有前向胜率可以裁判',
  });

  return {
    items,
    excluded: [{ id: 'stock_pool', reason: '尚无选股策略，不纳入标定' }],
    note: '有效和无效都只描述已有样本外数字，不是买入指令。样本不够或未标定的，保持现在的观察口径。',
  };
}

module.exports = {
  classifyRate, fearForward, build, sentimentFromRow,
  PASS_WIN, FAIL_WIN, MIN_N,
};
