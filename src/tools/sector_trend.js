'use strict';
/**
 * sector_trend.js —— 板块跨日持续性追踪（主线识别）
 *
 * ══════ 为什么要有这个模块 ══════
 *
 * 用户 2026-09-12：「主线板块不是一天就能看出来的」。
 *
 * 现有两层都答不了这个问题：
 *   · close_scan      → 当日截面，算完就扔（它连 db 都没 require）
 *   · sector_watch    → 盘中分钟级异动，只在当天内做差，明天重建基线
 *
 * 结果是：「元件板块连续 8 天净流入」这种判断，系统永远答不出来。
 * 只能鹦鹉学舌重复东财给的 5日/10日累计 —— 那是别人算好的数，
 * 不可回溯、不可验证、也无法知道中间是不是断过。
 *
 * 这个模块基于自己攒的 sector_daily 序列，回答三件事：
 *   1. 持续性：连续几天净流入？中间断过没有？
 *   2. 趋势：资金在加速、衰竭，还是反复？
 *   3. 兑现度：资金进了，涨幅跟上没有？（只进不涨要警惕）
 *
 * ══════ 和 calibration.js 的分工（别搞混）══════
 *
 * calibration.js 也在每天存板块，但它**只存前 30 名**，
 * 目的是标定阈值（看分数分布、假阳性假阴性）。
 *
 * 实测那份数据的问题：4 天里出现过 70 个板块，
 * **只有 3 个全程在列，67 个中途断档** ——
 * 板块今天排 28 名、明天排 33 名，序列就断了。
 * 用它算"连续净流入天数"必然算错，而且是**低估**，
 * 恰好漏掉正在从低位爬上来的新主线 —— 最该抓的那种。
 *
 * 所以 sector_daily 存**全量 961 个板块**，一天一行。
 * 代价是每年约 23 万行（SQLite 完全扛得住），
 * 换来的是任何板块的连续性都不会因为排名波动而断档。
 *
 * ══════ 诚实纪律 ══════
 *
 * 样本不足时**必须明说**，不能用少量数据硬算出"主线"。
 * 历史数据从建表那天开始攒，不会凭空补齐 ——
 * 所以早期一律标 insufficient，并告知还差几天。
 * 前向收益回填后才谈得上"这套判断准不准"。
 */

const db = require('../db');

/* 判定主线需要的最少交易日。
 * 少于这个数只报"观察中"，不下主线结论 ——
 * 3 天净流入可能只是一次事件驱动，看不出持续性。 */
const MIN_TREND_DAYS = 5;
/* 完整评估（含趋势加速判断）希望有的天数 */
const FULL_TREND_DAYS = 10;

const TH = {
  inflowYi: 0.5,        // 单日净额超过这个才算"流入"，避免 ±0.1 亿的噪音算一天
  strongDayYi: 3,       // 单日强流入
  minTotalYi: 20,       // N 日累计门槛：低于此值不谈主线（体量不足）
  accelRatio: 1.2,      // 后半段日均 / 前半段日均 ≥ 此值算加速
  decayRatio: 0.6,      // ≤ 此值算衰竭
};

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * 算一个板块的持续性指标。
 * @param {Array} series 按日期正序的该板块每日行
 * @param {Array} allDates 全部交易日（正序）——用于识别断档
 */
function analyzeSeries(series, allDates) {
  if (!series.length) return null;
  const n = series.length;
  const flows = series.map(r => Number(r.today_yi) || 0);
  const total = Math.round(flows.reduce((a, b) => a + b, 0) * 10) / 10;

  /* ══ 断档检测（必须做，否则连续性全是假的）══
   *
   * 历史数据来自 calibration，每天只存前 30 名。
   * 实测：光通信模块有 09-09 和 09-12，但没有 09-10/09-11 ——
   * 它那两天掉出前 30 了。
   * 不检测断档就会把「9号流入 + 12号流入」算成"连续2天"，
   * 而中间两天到底是流入还是流出，我们根本不知道。
   *
   * 这种错误很危险：它系统性地**高估**不连续板块的持续性，
   * 又**低估**真正天天在榜的板块的相对优势。 */
  let gapDays = 0, contiguous = true;
  if (Array.isArray(allDates) && allDates.length) {
    const have = new Set(series.map(r => r.date));
    const firstIdx = allDates.indexOf(series[0].date);
    const lastIdx = allDates.indexOf(series[n - 1].date);
    if (firstIdx >= 0 && lastIdx >= firstIdx) {
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (!have.has(allDates[i])) gapDays++;
      }
      contiguous = gapDays === 0;
    }
  }

  /* 连续净流入天数：从最后一天往回数，断了就停。
   * 用 inflowYi 而不是 >0，避免 +0.05 亿这种噪音撑起"连续 10 天"。
   * 关键：遇到数据缺口也必须停 —— 缺的那天不知道是流入还是流出，
   * 不能当成"没断"继续往前数。 */
  let streak = 0;
  if (Array.isArray(allDates) && allDates.length) {
    const byDate = new Map(series.map(r => [r.date, Number(r.today_yi) || 0]));
    const lastIdx = allDates.indexOf(series[n - 1].date);
    for (let i = lastIdx; i >= 0; i--) {
      const v = byDate.get(allDates[i]);
      if (v === undefined) break;          // 缺口：停止，不猜
      if (v >= TH.inflowYi) streak++;
      else break;
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      if (flows[i] >= TH.inflowYi) streak++;
      else break;
    }
  }
  /* 净流出连续天数（同理，用于识别资金撤离） */
  let outStreak = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (flows[i] <= -TH.inflowYi) outStreak++;
    else break;
  }

  const inDays = flows.filter(f => f >= TH.inflowYi).length;
  const strongDays = flows.filter(f => f >= TH.strongDayYi).length;

  /* 趋势：后半段日均 vs 前半段日均。
   * 至少 4 天才有前后半段可比，否则不下趋势结论。 */
  let trend = 'unknown', accelRatio = null;
  if (n >= 4) {
    const mid = Math.floor(n / 2);
    const firstAvg = flows.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const lateAvg = flows.slice(mid).reduce((a, b) => a + b, 0) / (n - mid);
    if (Math.abs(firstAvg) > 0.01) {
      accelRatio = Math.round((lateAvg / firstAvg) * 100) / 100;
    }
    if (lateAvg > firstAvg && lateAvg > 0) {
      trend = (firstAvg > 0 && accelRatio >= TH.accelRatio) ? 'accelerating' : 'improving';
    } else if (lateAvg < firstAvg) {
      trend = (firstAvg > 0 && lateAvg > 0 && accelRatio <= TH.decayRatio) ? 'decaying' : 'weakening';
    } else trend = 'flat';
  }

  /* 兑现度：区间累计涨幅 vs 累计资金。
   * 资金持续进但价格不涨 —— 可能是主力在吸筹（好），
   * 也可能是资金在接盘出货（坏）。含义相反，只标记不定性。 */
  const first = series[0], last = series[n - 1];
  let rangePct = null;
  if (Number.isFinite(first.level) && Number.isFinite(last.level) && first.level > 0) {
    rangePct = Math.round(((last.level - first.level) / first.level) * 10000) / 100;
  }

  return {
    days: n, totalYi: total, streak, outStreak, inDays, strongDays,
    gapDays, contiguous,
    trend, accelRatio, rangePct,
    avgYi: Math.round((total / n) * 10) / 10,
    firstDate: first.date, lastDate: last.date,
    lastLevel: last.level, lastChangePct: last.change_pct,
    leader: last.leader, leaderPct: last.leader_pct,
    name: last.name, code: last.code, kind: last.kind,
    lastScore: last.score, lastGrade: last.grade,
  };
}

/** 给一个持续性结论打标签。标签必须可解释，不能是黑箱分数。 */
function gradeTrend(a) {
  const reasons = [];
  let grade = '观察', mainline = false;

  /* 数据有缺口时，一律降级为"数据不全"，不给主线结论。
   * 宁可说"不知道"，也不能拿断档序列冒充连续性 —— 那是编造。 */
  if (a.contiguous === false) {
    reasons.push(`⚠数据不连续：区间内缺 ${a.gapDays} 个交易日`
      + '（历史样本只存前30名，掉出榜单的日子没有记录），持续性无法确认');
    return { grade: '数据不全', mainline: false, reasons };
  }

  /* 数据太少也不能给持续性结论。
   * 只有 1 天数据时，"连续1天流入"「累计126亿」这种说法有误导性 ——
   * 那根本不是趋势，就是当天的截面数，close_scan 已经给过了。
   * 实测：5G概念只有 09-09 一天，却因为金额大排到第 4 位。 */
  if (a.days < 2) {
    reasons.push(`仅 ${a.days} 天数据，看不出持续性（当日净额 ${a.totalYi} 亿，属截面信息）`);
    return { grade: '数据不足', mainline: false, reasons };
  }

  if (a.totalYi >= TH.minTotalYi && a.streak >= 3) {
    reasons.push(`连续${a.streak}天净流入`);
    if (a.trend === 'accelerating') {
      grade = '主线候选（资金加速）'; mainline = true;
      reasons.push(`资金加速(后半段/前半段=${a.accelRatio})`);
    } else if (a.trend === 'decaying') {
      grade = '主线但资金衰竭';
      reasons.push(`资金衰竭(后半段/前半段=${a.accelRatio})`);
    } else {
      grade = '主线候选'; mainline = true;
    }
  } else if (a.totalYi >= TH.minTotalYi && a.inDays >= Math.ceil(a.days * 0.6)) {
    grade = '资金持续偏多';
    reasons.push(`${a.days}天中${a.inDays}天净流入，累计${a.totalYi}亿`);
  } else if (a.outStreak >= 3) {
    grade = '资金持续撤离';
    reasons.push(`连续${a.outStreak}天净流出`);
  } else if (a.totalYi < TH.minTotalYi && a.streak >= 3) {
    grade = '连续流入但体量不足';
    reasons.push(`连续${a.streak}天流入，但累计仅${a.totalYi}亿(<${TH.minTotalYi}亿)`);
  }

  /* 只进不涨 / 只涨不进，都要显式点出来 */
  if (a.rangePct != null && a.totalYi >= TH.minTotalYi) {
    if (a.rangePct <= 0) {
      reasons.push(`⚠资金累计${a.totalYi}亿但区间涨幅${a.rangePct}%（钱进了价没动，方向待确认）`);
    } else {
      reasons.push(`区间涨幅${a.rangePct}%`);
    }
  }
  return { grade, mainline, reasons };
}

/**
 * 跨日板块趋势总览。
 * @param {{days?:number, topN?:number, minDays?:number}} opts
 */
function trend(opts = {}) {
  const lookback = Math.max(2, Math.min(60, opts.days || FULL_TREND_DAYS));
  const topN = opts.topN || 12;

  const allDates = db.sectorDailyDates();
  if (!allDates.length) {
    return {
      ok: true, status: 'empty', haveDays: 0, needDays: MIN_TREND_DAYS, sectors: [],
      note: '还没有任何板块每日数据。sector_daily 从今天开始积累，'
        + '每个交易日收盘扫描后定格一行。跨日主线判断需要至少 '
        + MIN_TREND_DAYS + ' 个交易日 —— 历史数据无法凭空补齐，只能往后攒。',
    };
  }

  /* 只取 lookback 范围内实际存在的交易日 */
  const useDates = allDates.slice(-lookback);
  const since = useDates[0];
  const rows = db.sectorDailySince(since);

  /* 按板块聚合成序列 */
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }

  const haveDays = useDates.length;
  const sufficient = haveDays >= MIN_TREND_DAYS;

  const out = [];
  for (const [code, series] of byCode) {
    series.sort((a, b) => a.date < b.date ? -1 : 1);
    const a = analyzeSeries(series, useDates);
    if (!a) continue;
    const g = gradeTrend(a);
    out.push({ ...a, ...g });
  }

  /* 排序：主线优先，其次数据完整的优先，再次数据天数多的优先，
   * 最后才看累计资金。金额大但只有 1 天的，不该压过 4 天的真序列。 */
  out.sort((x, y) => {
    if (x.mainline !== y.mainline) return x.mainline ? -1 : 1;
    if (x.contiguous !== y.contiguous) return x.contiguous ? -1 : 1;
    const xa = x.days >= 2, ya = y.days >= 2;
    if (xa !== ya) return xa ? -1 : 1;
    return Math.abs(y.totalYi) - Math.abs(x.totalYi);
  });

  const mainlines = out.filter(x => x.mainline);

  return {
    ok: true,
    status: sufficient ? 'ok' : 'insufficient',
    haveDays, needDays: MIN_TREND_DAYS, lookback,
    dateRange: [useDates[0], useDates[useDates.length - 1]],
    totalSectors: out.length,
    mainlineCount: mainlines.length,
    sectors: out.slice(0, topN),
    thresholds: TH,
    note: sufficient
      ? `基于自建的 ${haveDays} 个交易日序列（${useDates[0]} ~ ${useDates[useDates.length - 1]}）。`
        + '连续性与趋势为规则计算，可追溯可复现。'
      : `⚠ 只有 ${haveDays} 个交易日数据，不足 ${MIN_TREND_DAYS} 天，`
        + '不下主线结论，仅列出当前资金分布供观察。'
        + '主线需要跨日验证 —— 一天的流入可能只是事件驱动。',
  };
}

/**
 * 回填前向收益（fwd_d1/d3/d5）。
 *
 * 为什么必须有：没有前向收益，"主线候选"这个标签就永远无法验证。
 * 系统可以连续三个月自信地给出主线，而没人知道它准不准 ——
 * 那不是分析工具，是随机数发生器配了个好看的界面。
 *
 * 算法：用 sector_daily 里自己存的板块指数点位做差。
 * 板块历史 K 线三个域名全部拿不到（push2his/push2 被 TCP 拦、
 * push2delay 返 0 行），所以这是唯一可行路径 —— 也正是
 * 当初 level 字段必须每天存下来的原因。
 *
 * 只回填已经有后续交易日数据的行，不够天数的留 NULL（不猜）。
 */
function backfillForward() {
  const dates = db.sectorDailyDates();
  if (dates.length < 2) {
    return { ok: true, filled: 0, note: '交易日不足 2 天，无法计算前向收益' };
  }
  /* 建立 日期 -> {code -> level} 索引，避免 N² 次查库 */
  const levelByDate = new Map();
  for (const d of dates) {
    const m = new Map();
    for (const r of db.sectorDailyAt(d)) {
      if (Number.isFinite(r.level)) m.set(r.code, r.level);
    }
    levelByDate.set(d, m);
  }

  const pct = (from, to) =>
    (Number.isFinite(from) && Number.isFinite(to) && from > 0)
      ? Math.round(((to - from) / from) * 10000) / 100
      : null;

  let filled = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const base = levelByDate.get(d);
    /* 第 i 天之后的第 1/3/5 个交易日（按实际存在的交易日数，不按自然日） */
    const nd = k => (i + k < dates.length ? levelByDate.get(dates[i + k]) : null);
    const m1 = nd(1), m3 = nd(3), m5 = nd(5);
    if (!m1) continue;                      // 连次日都没有，整天跳过

    for (const [code, lv] of base) {
      const d1 = m1.has(code) ? pct(lv, m1.get(code)) : null;
      const d3 = m3 && m3.has(code) ? pct(lv, m3.get(code)) : null;
      const d5 = m5 && m5.has(code) ? pct(lv, m5.get(code)) : null;
      if (d1 == null && d3 == null && d5 == null) continue;
      db.updateSectorFwd(d, code, d1, d3, d5);
      filled++;
    }
  }
  return { ok: true, filled, days: dates.length,
    note: `回填 ${filled} 行前向收益（基于自存的板块指数点位）` };
}

/**
 * 信号有效性回归：主线候选的次日/3日表现，和全样本比有没有优势。
 *
 * 这是唯一能回答"这套打分到底准不准"的东西。
 * 样本不足时**必须拒绝给结论** —— 5 天数据算出的"胜率 70%"毫无意义。
 */
function validate(minSamples = 30) {
  const dates = db.sectorDailyDates();
  const rows = [];
  for (const d of dates) {
    for (const r of db.sectorDailyAt(d)) {
      if (r.fwd_d1 != null) rows.push(r);
    }
  }
  if (rows.length < minSamples) {
    return {
      ok: true, status: 'insufficient', samples: rows.length, need: minSamples,
      note: `只有 ${rows.length} 条带前向收益的样本，不足 ${minSamples} 条，`
        + '不做有效性结论。样本不够时算出的胜率是噪音，不是证据。',
    };
  }
  const avg = a => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null;
  const winRate = a => a.length
    ? Math.round((a.filter(x => x > 0).length / a.length) * 1000) / 10 : null;

  const mainline = rows.filter(r => r.grade === '主线候选');
  const others = rows.filter(r => r.grade !== '主线候选');
  const mD1 = mainline.map(r => r.fwd_d1), oD1 = others.map(r => r.fwd_d1);

  return {
    ok: true, status: 'ok', samples: rows.length, days: dates.length,
    mainline: { n: mainline.length, avgD1: avg(mD1), winRateD1: winRate(mD1) },
    baseline: { n: others.length, avgD1: avg(oD1), winRateD1: winRate(oD1) },
    edge: (avg(mD1) != null && avg(oD1) != null)
      ? Math.round((avg(mD1) - avg(oD1)) * 100) / 100 : null,
    note: '正的 edge 表示主线候选次日平均跑赢其他板块。'
      + '注意这是样本内统计，不等于未来有效；且未扣除交易成本。',
  };
}

/** 单个板块的完整轨迹（用于追踪某个具体板块） */
function track(code, days = 30) {
  const rows = db.sectorDailyFor(code, days);
  if (!rows.length) {
    return { ok: false, code, error: '没有该板块的历史数据（可能是代码错误，或还未开始积累）' };
  }
  const series = rows.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const a = analyzeSeries(series, db.sectorDailyDates());
  const g = gradeTrend(a);
  return {
    ok: true, ...a, ...g,
    series: series.map(r => ({
      date: r.date, todayYi: r.today_yi, changePct: r.change_pct,
      level: r.level, score: r.score, grade: r.grade,
      fwdD1: r.fwd_d1, fwdD3: r.fwd_d3,
    })),
    note: series.length < MIN_TREND_DAYS
      ? `只有 ${series.length} 天数据，不足以判断持续性（需 ${MIN_TREND_DAYS} 天）`
      : `基于 ${series.length} 个交易日的自建序列`,
  };
}

/** 文本输出。没数据就说没数据，不硬凑。 */
function formatTrend(r) {
  if (!r.ok) return '【板块趋势】' + (r.error || '未知错误');
  if (r.status === 'empty') return '【板块跨日趋势】' + r.note;

  const L = [];
  L.push(`【板块跨日趋势】${r.dateRange[0]} ~ ${r.dateRange[1]}（${r.haveDays} 个交易日）`
    + `　监测 ${r.totalSectors} 个板块`);
  if (r.status === 'ok') {
    L.push(`主线候选 ${r.mainlineCount} 个`);
  }
  L.push('');
  r.sectors.forEach((s, i) => {
    L.push(`${i + 1}. ${s.name}(${s.kind === 'concept' ? '概念' : '行业'}) ${s.grade}`
      + ` | ${s.days}日累计${s.totalYi > 0 ? '+' : ''}${s.totalYi}亿`
      + (s.contiguous === false ? `（缺${s.gapDays}天）` : '')
      + (s.streak ? ` | 连续${s.streak}天流入` : '')
      + (s.rangePct != null ? ` | 区间${s.rangePct > 0 ? '+' : ''}${s.rangePct}%` : ''));
    if (s.reasons.length) L.push('   依据：' + s.reasons.join('；'));
    if (s.leader) L.push(`   当前龙头：${s.leader} ${s.leaderPct}%`);
  });
  const gapped = r.sectors.filter(s => s.contiguous === false).length;
  if (gapped) {
    L.push('');
    L.push(`注：${gapped} 个板块数据不连续 —— 历史样本（9/9~9/12）每天只存前 30 名，`
      + '掉出榜单的日子没有记录，所以无法确认这些板块的持续性。'
      + '从今天起改为每天存全部 961 个板块，后续不会再有这个问题。');
  }
  L.push('');
  L.push(r.note);
  L.push('说明：资金动向观察，不构成买卖建议；按"大盘定时机、板块定方向"，'
    + '大盘未到买入窗口时只观察不动手。');
  return L.join('\n');
}

module.exports = {
  trend, track, formatTrend, analyzeSeries, gradeTrend,
  backfillForward, validate,
  MIN_TREND_DAYS, FULL_TREND_DAYS, TH,
};
