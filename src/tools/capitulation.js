'use strict';
/**
 * capitulation.js —— 引擎B：散户崩溃冰点（情绪反向信号）
 * ─────────────────────────────────────────────────────────
 * 用户方法论（2026-09-13 定）：「当散户崩溃的时候，就是考虑出手的时候。」
 * 规则冻结见 docs/大盘判定升级-设计基线.md §2。这是【左侧/反向】信号，
 * 与 alerts.judgeMarket 的【右侧/顺势】信号相反，两者独立，绝不混成一个"买入"。
 *
 * 三料（零新增数据源，来自情绪三池，已在 sentiment.js 按主板+创业板白名单过滤）：
 *   ① 跌停家数          处于历史高分位（恐慌宣泄）
 *   ② 炸板率            处于历史高分位（资金不敢封板）
 *   ③ 连板高度断层      最高板≤1，或 ≥3 板家数=0（赚钱效应的高度崩了）
 * ≥2 项进入极端区 = 崩溃共振；再用上证 RSI14 极低 / 显著低于 MA20 做超跌确认。
 *
 * 两级：
 *   - 普通冰点：必须缠论阶段处于 退潮期末端/磨底期 才放行（阶段当上下文开关），
 *     避免"刚开始跌第一天就接飞刀"。
 *   - 极端恐慌（左侧越级）：三料全中 + 各项≥P_EXTREME 分位 + RSI极端超卖，
 *     即使缠论未确认也提示，但强标 side:'left' + 未标定。
 *
 * 诚实红线：
 *   - 分位用真实历史样本算；样本 < MIN_CAL_DAYS 一律 calibrated:false、"未标定·仅供观察"；
 *   - 任何一料缺数据 → 该项 unknown，绝不把 null 当 0；缺到无法判断就 tier:'unknown'；
 *   - 绝不说"可以买"，措辞只用 恐慌冰点 / 回踩支撑 / 值得关注；不做个股建议。
 */

const MIN_CAL_DAYS = 15;      // 标定最少交易日（与 alerts 一致）
const P_EXTREME = 0.95;       // 左侧越级：各项≥95分位
const P_INGREDIENT = 0.80;    // 单料"进入极端区"的临时分位门槛（未标定前的保守值）
const RSI_OVERSOLD = 30;      // RSI14 极端超卖（教科书常识级临时值）
const RSI_LOW = 40;           // 普通冰点的偏弱确认

/* 允许普通冰点放行的缠论阶段（下跌末端/磨底；绝不允许在主升/启动里把恐慌当买点，
   退潮期中段也不放行——必须末端或磨底）。phase 由 chan.phaseOf 给出。 */
const FEAR_ALLOWED_PHASES = ['磨底期', '退潮期'];

/**
 * 经验分位数（percentile rank）：当前值在历史样本中的"≤占比"。
 * 高分位（如跌停多、炸板率高）→ 返回接近 1。忽略 null/undefined。
 * @returns {number|null} 0~1，样本为空返回 null
 */
function percentile(value, history) {
  if (value == null || !Array.isArray(history)) return null;
  const xs = history.filter(x => x != null && isFinite(x));
  if (!xs.length) return null;
  let leq = 0;
  for (const x of xs) if (x <= value) leq++;
  return leq / xs.length;
}

/**
 * 连板高度断层（第三料）。
 * @param {object} se sentiment.sentiment：{ladderHeight, ladder:{板数:家数}}
 * @returns {broken:boolean|null, detail}
 *   断层 = 最高板 ≤ 1，或 ≥3 板家数为 0。数据缺失给 null，不猜。
 */
function ladderBreak(se) {
  if (!se || se.ladderHeight == null) return { broken: null, detail: '无连板数据' };
  const ladder = se.ladder || {};
  const highBoardCount = Object.keys(ladder)
    .filter(k => Number(k) >= 3)
    .reduce((s, k) => s + (Number(ladder[k]) || 0), 0);
  const broken = se.ladderHeight <= 1 || highBoardCount === 0;
  return {
    broken,
    detail: `最高${se.ladderHeight}板，≥3板共${highBoardCount}家`,
    ladderHeight: se.ladderHeight, highBoardCount,
  };
}

/* 取历史样本里某字段（跌停/炸板率），供分位计算 */
function histField(history, key) {
  return (history || []).map(h => (h && h[key] != null ? h[key] : null));
}

/**
 * 崩溃冰点评估（纯函数，便于离线单测）。
 *
 * @param {object} se   sentiment.snapshot() 的 sentiment 字段（白名单口径）
 * @param {object} sh   snapshot.indexes['上证']（含 rsi14/aboveMa20/close/ma20）
 * @param {Array}  history  历史 alert_samples 行（含 limit_down/broken_rate/ladder_height）
 * @param {object} [chanPhase] 缠论阶段 {phase:'磨底期'...}，由 chan.analyzeMarket 给出
 * @param {object} [opt] {now:Date}（预留）
 * @returns 结构化结果（不做任何 I/O）
 */
function evaluate(se, sh, history = [], chanPhase = null, opt = {}) {
  if (!se) {
    return base(false, '情绪快照缺失，无法判断崩溃冰点', null, null);
  }
  const sampleN = (history || []).filter(h => h && (h.limit_down != null || h.broken_rate != null)).length;
  const calibrated = sampleN >= MIN_CAL_DAYS;

  /* ── 三料：每一料给 {hit, pct, detail}；数据缺失 unknown，不当 0 ── */
  const pLD = percentile(se.limitDownCount, histField(history, 'limit_down'));
  const pBR = percentile(se.brokenRate, histField(history, 'broken_rate'));
  const lb = ladderBreak(se);

  // 分位阈值：标定后仍以 0.8/0.95 为共振/越级门槛（后续可被真实分布复核），
  // 未标定时门槛照用但整体盖 calibrated:false。
  const ing1 = Object.assign(mkIngredient('跌停家数高分位',
    se.limitDownCount != null && pLD != null && pLD >= P_INGREDIENT,
    se.limitDownCount == null ? null : pLD,
    se.limitDownCount == null ? '无跌停数据'
      : pLD == null ? `跌停${se.limitDownCount}家，无历史分布可算分位`
      : `跌停${se.limitDownCount}家，分位${(pLD * 100).toFixed(0)}%`),
    { unknown: se.limitDownCount == null || pLD == null });
  const ing2 = Object.assign(mkIngredient('炸板率高分位',
    se.brokenRate != null && pBR != null && pBR >= P_INGREDIENT,
    se.brokenRate == null ? null : pBR,
    se.brokenRate == null ? '无炸板率数据'
      : pBR == null ? `炸板率${se.brokenRate.toFixed(1)}%，无历史分布可算分位`
      : `炸板率${se.brokenRate.toFixed(1)}%，分位${(pBR * 100).toFixed(0)}%`),
    { unknown: se.brokenRate == null || pBR == null });
  const ing3 = mkIngredient('连板高度断层', lb.broken === true, null, lb.detail);
  ing3.unknown = lb.broken === null;

  const known = [ing1, ing2, ing3].filter(x => !x.unknown);
  const hits = known.filter(x => x.hit);
  const resonance = hits.length >= 2;      // ≥2 料极端 = 崩溃共振

  /* ── 超跌确认：上证 RSI 极低 / 显著低于 MA20 ── */
  const rsi = sh && sh.rsi14 != null ? sh.rsi14 : null;
  const belowMa20 = sh && sh.aboveMa20 === false;
  const rsiExtreme = rsi != null && rsi <= RSI_OVERSOLD;
  const rsiWeak = rsi == null ? null : (rsi <= RSI_LOW || !!belowMa20);
  const oversold = {
    hit: rsiExtreme || (rsiWeak === true),
    extreme: rsiExtreme,
    detail: (rsi == null ? '无RSI' : `RSI14=${rsi.toFixed(1)}`) + (belowMa20 ? '，低于MA20' : ''),
  };

  /* ── 阶段开关 ── */
  const phase = chanPhase && chanPhase.phase;
  const phaseAllowed = phase ? FEAR_ALLOWED_PHASES.includes(phase) : null;

  /* 数据不足以判断：三料里有2项以上 unknown */
  const unknownCnt = [ing1, ing2, ing3].filter(x => x.unknown).length;
  if (unknownCnt >= 2) {
    return {
      tier: 'unknown', fear: false, resonance: false, calibrated, sampleN,
      ingredients: [ing1, ing2, ing3], oversold, phase,
      side: null, label: '无法判断·数据不足',
      reason: '崩溃三料缺失过多，无法判断冰点（绝不拿缺失误判为安全或恐慌）',
    };
  }

  /* ── 极端恐慌（左侧越级）：三料全中 + 已知料分位≥95% + RSI极端超卖 ── */
  const allHit = hits.length === known.length && known.length === 3;
  const pcts = [pLD, pBR].filter(p => p != null);
  const allExtremePct = pcts.length >= 2 && pcts.every(p => p >= P_EXTREME);
  if (allHit && allExtremePct && rsiExtreme) {
    return out('extreme', true, true, calibrated, sampleN, [ing1, ing2, ing3], oversold, phase,
      '左侧·未标定·情绪极值',
      `三料全部极端（跌停/炸板率≥95分位、连板高度断层）且RSI≤${RSI_OVERSOLD}，散户恐慌宣泄到极值；即便缠论尚未确认，也列入左侧观察（不代表立刻买）`);
  }

  /* ── 普通冰点：共振 + 超跌确认 + 缠论阶段在磨底/退潮 ── */
  if (resonance && oversold.hit && phaseAllowed === true) {
    return out('normal', true, true, calibrated, sampleN, [ing1, ing2, ing3], oversold, phase,
      calibrated ? '恐慌冰点·值得关注' : '恐慌冰点·未标定·仅供观察',
      `崩溃共振(${hits.length}/3)+超跌确认，且缠论处于「${phase}」；散户情绪崩溃，列入反向关注（措辞为关注，非买入建议）`);
  }

  /* 共振但阶段不对（例如刚开始跌/主升途中）→ 只记录，不放行普通冰点 */
  if (resonance) {
    return out('watch', true, true, calibrated, sampleN, [ing1, ing2, ing3], oversold, phase,
      '恐慌共振但阶段不符·只观察',
      phaseAllowed === false
        ? `情绪已现崩溃共振(${(hits.map(x => x.name)).join('、')})，但缠论阶段为「${phase}」，非磨底/退潮末端，不接飞刀，仅观察`
        : '情绪出现崩溃共振，但缠论阶段缺失，无法放行普通冰点，仅观察');
  }

  /* 无共振 */
  return out('none', false, false, calibrated, sampleN, [ing1, ing2, ing3], oversold, phase,
    '无崩溃共振',
    `三料中仅${hits.length}项极端，散户尚未到崩溃点`);
}

function mkIngredient(name, hit, pct, detail) {
  return { name, hit: !!hit, unknown: false, pct: pct == null ? null : +pct, detail };
}

function base(fear, reason, label, tier) {
  return { tier: tier || 'unknown', fear, resonance: false, calibrated: false, sampleN: 0,
    ingredients: [], oversold: { hit: false, detail: '无数据' }, phase: null, side: null,
    label: label || '无法判断', reason };
}

function out(tier, fear, resonance, calibrated, sampleN, ingredients, oversold, phase, label, reason) {
  return {
    tier, fear, resonance, calibrated, sampleN, ingredients, oversold, phase,
    side: tier === 'extreme' ? 'left' : (tier === 'normal' ? 'right' : null),
    label, reason,
  };
}

/* ─────────────────── 有效性裁判：前向收益 ─────────────────── */

/**
 * 统计"冰点触发后上证 fwd_d1/fwd_d3 是否反转上涨"。
 * @param {Array} rows 历史样本行，每行需含 {date, fwd_d1, fwd_d3, fear_tier?, ...情绪字段}
 *   两种用法：
 *   A) 行里已有 fear_tier（落库时算过）→ 直接筛 extreme/normal；
 *   B) 行里只有情绪字段 → 传 judgeRow(row, rowsBefore) 由调用方先打标，这里只统计。
 *   这里只负责统计给定行集（已被调用方判定为触发的行）的胜率。
 * @returns {count, winD1, winRateD1, avgD1, winD3, winRateD3, avgD3}，样本不足给 null。
 */
function evaluateFear(triggerRows) {
  const rows = (triggerRows || []).filter(r => r && (r.fwd_d1 != null || r.fwd_d3 != null));
  const stat = (key) => {
    const xs = rows.map(r => r[key]).filter(x => x != null && isFinite(x));
    if (!xs.length) return { n: 0, wins: null, winRate: null, avg: null };
    const wins = xs.filter(x => x > 0).length;
    return { n: xs.length, wins, winRate: wins / xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length };
  };
  const d1 = stat('fwd_d1'), d3 = stat('fwd_d3');
  return {
    count: rows.length,
    d1: { n: d1.n, wins: d1.wins, winRate: d1.winRate == null ? null : +d1.winRate.toFixed(3), avg: d1.avg == null ? null : +d1.avg.toFixed(2) },
    d3: { n: d3.n, wins: d3.wins, winRate: d3.winRate == null ? null : +d3.winRate.toFixed(3), avg: d3.avg == null ? null : +d3.avg.toFixed(2) },
    verdict: (d1.n + d3.n) === 0 ? '尚无已回填前向收益的样本，无法裁判'
      : (d3.winRate != null && d3.winRate >= 0.6) ? '前向3日胜率≥60%，信号暂时有效（继续攒样本）'
      : (d3.winRate != null && d3.winRate < 0.45) ? '前向3日胜率偏低，该信号可能无效，需考虑砍掉或改条件'
      : '胜率中性，继续观察',
  };
}

module.exports = {
  evaluate, evaluateFear, percentile, ladderBreak,
  MIN_CAL_DAYS, P_EXTREME, P_INGREDIENT, RSI_OVERSOLD, RSI_LOW, FEAR_ALLOWED_PHASES,
};
