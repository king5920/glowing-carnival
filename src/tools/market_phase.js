'use strict';
/**
 * market_phase.js —— 把「缠论生命阶段」与「散户崩溃冰点」合成一个大盘状态。
 * ─────────────────────────────────────────────────────────────────────
 * 这是阶段3的装配层：
 *   chan.analyzeMarket(日/60/30)  → 结构阶段（大级别定方向）
 *   capitulation.evaluate(...)    → 情绪反向冰点（左/右侧开关）
 *   alerts.judgeMarket(...)       → 顺势买入窗口（右侧，已存在）
 *
 * 职责只是"取数 + 调纯函数 + 拼成给模型/网页读的一个对象"，不含任何阈值新定义。
 * 红线全部沿用底层：未标定标注、缺数据 unknown、绝不说"可以买"、不对个股给建议。
 *
 * 缠论按"只在收盘确认K判定"，因此本函数主要用日K；分钟级可选传入做 timing 细化，
 * 第一版装配只用日K出阶段，避免盘中未完成K造成闪烁。
 */

const chan = require('./chan');
const cap = require('./capitulation');
const ss = require('./sentiment_score');

/**
 * 计算当前大盘状态。
 * @param {object} deps 注入依赖，便于单测，也便于 patrol 复用一次 snapshot：
 *   - getBars(period)  => Promise<bars>   取上证K线（period: day/m60/m30）
 *   - snapshot()       => Promise<sentiment.snapshot() 结果>
 *   - alertSamples()   => alert_samples 行数组（分位历史）
 * @param {object} [opt] { withMinute:false }
 */
async function assess(deps, opt = {}) {
  const errors = [];

  /* 1) 缠论结构（日K定阶段；可选 60/30 做 timing） */
  let barsDay = null;
  try { barsDay = await deps.getBars('day'); } catch (e) { errors.push('日K获取失败:' + e.message); }

  const levels = {};
  let market = null;
  if (barsDay && barsDay.length) {
    if (opt.withMinute) {
      const [b60, b30] = await Promise.all([
        safe(() => deps.getBars('m60')), safe(() => deps.getBars('m30')),
      ]);
      market = chan.analyzeMarket({ day: barsDay, m60: b60, m30: b30 });
    } else {
      market = chan.analyzeMarket({ day: barsDay });
    }
    levels.day = summarizeLevel(market.levels && market.levels.day);
    if (market.levels) {
      levels.m60 = summarizeLevel(market.levels.m60);   // 缺失/失败级别 → null
      levels.m30 = summarizeLevel(market.levels.m30);
    }
  }

  /* 2) 情绪快照 + 崩溃冰点 */
  let snap = null;
  try { snap = await deps.snapshot(); } catch (e) { errors.push('情绪快照失败:' + e.message); }
  const history = (deps.alertSamples ? deps.alertSamples() : []) || [];
  const se = snap && snap.sentiment;
  const sh = snap && snap.indexes && snap.indexes['上证'];

  const fear = cap.evaluate(se, sh, history, market ? { phase: market.phase } : null);

  /* 2.5) 情绪主读数：0–100 恐慌指数（当日）+ 近20日序列（A+C） */
  const ing = {};
  if (fear && Array.isArray(fear.ingredients)) {
    fear.ingredients.forEach(i => {
      if (/跌停/.test(i.name)) ing.limitDownPct = i.pct;
      else if (/炸板/.test(i.name)) ing.brokenRatePct = i.pct;
    });
  }
  if (ing.limitDownPct == null || ing.brokenRatePct == null) {
    // 兜底：直接从当日三料与历史算分位（fear 在样本不足时可能不带pct）
    ing.limitDownPct = ss.percentileOf(history.map(h => h.limit_down), se && se.limitDownCount);
    ing.brokenRatePct = ss.percentileOf(history.map(h => h.broken_rate), se && (se.brokenRate == null ? null : +se.brokenRate.toFixed(1)));
  }
  const sentimentScore = ss.scoreToday({
    limitDownPct: ing.limitDownPct, brokenRatePct: ing.brokenRatePct,
    rsi: sh && sh.rsi14 != null ? sh.rsi14 : null,
  });
  // RSI 序列：历史回填无指数RSI，仅最新一天可能有（series 里只对当天三料）
  let rsiByDate = null;
  if (sh && sh.rsi14 != null && history.length) {
    const todayKey = lastDate(history);
    rsiByDate = new Map();
    history.slice(-20).forEach(r => rsiByDate.set(r.date, null));
    rsiByDate.set(todayKey, sh.rsi14);
  }
  const sentimentSeries = ss.series(history, rsiByDate, 20);

  /* 2.6) 多因子情绪（经前向收益标定）：在旧情绪分之上加一层"被历史验证过"的读数。
   * 用本函数已取到的日K（barsDay）补历史RSI/当日涨跌，无需新请求；
   * 前向收益从同一日K序列按日期对齐回填（仅内存计算，不在此写库）。 */
  let sentimentMulti = null;
  try {
    const sm = require('./sentiment_model');
    const closeByDate = new Map(barsDay.map(b => [b.date, b.close]));
    /* 组装与 alert_samples 同日期的 daily 行，并用日K增强技术字段；
     * fwd 由日K序列现算（避免依赖库里是否已回填）。 */
    const histDaily = (history || []).map(r => Object.assign({}, r, {
      sh_rsi14: r.sh_rsi14 != null ? r.sh_rsi14
        : (sh && sh.rsi14 != null ? sh.rsi14 : null),
      cyb_rsi14: r.cyb_rsi14 != null ? r.cyb_rsi14 : null,
    }));
    let enriched = sm.enrichDaily(histDaily, barsDay, null);
    /* 回填行 sh_close 多为空：用日K按日期补齐（walk-forward 的趋势/收益都要） */
    enriched = enriched.map(r => {
      const b = closeByDate.get(r.date);
      if (r.sh_close == null && b != null) r.sh_close = b;
      return r;
    });
    /* 现算 fwd_d3（日K按交易日对齐），供 calibrate */
    enriched = enriched.map(r => {
      const idx = barsDay.findIndex(b => b.date === r.date);
      if (idx >= 0 && idx + 3 < barsDay.length) {
        r.fwd_d3 = +((barsDay[idx + 3].close - barsDay[idx].close) / barsDay[idx].close * 100).toFixed(2);
      }
      return r;
    });
    const calib = sm.calibrate(enriched);
    /* 严格样本外：滚动只用过去窗口标定，给出可信的样本外胜率 */
    let oos = null;
    try {
      const wf = require('./walkforward');
      oos = wf.walkForward(enriched, { trainWindow: 90 });
    } catch (e) { oos = { error: e.message }; }
    /* 当日：优先用今天的实时行（含 limit_down/broken_rate/ladder），past=之前daily */
    const todayRow = enriched.length ? enriched[enriched.length - 1] : null;
    if (todayRow && todayRow.date === lastDate(history)) {
      sentimentMulti = sm.scoreTodayMulti(todayRow, enriched.slice(0, -1), calib);
    } else {
      sentimentMulti = { calibrated: calib.calibrated, effective: calib.effective,
        evidence: calib.topQuartile, note: calib.note, score: null };
    }
    sentimentMulti.calibrationNote = calib.note;
    sentimentMulti.oos = (oos && !oos.error)
      ? { n: oos.signal.n, winRate: oos.signal.winRate, avgFwd: oos.signal.avgFwd,
          signalMin: oos.signalMin, note: oos.note }
      : null;
  } catch (e) { sentimentMulti = { error: e.message }; }

  /* 3) 综合一句话（大白话，供模型/网页） */
  const phase = market ? market.phase : 'unknown';
  const summary = buildSummary(phase, fear, errors);

  return {
    ok: errors.length === 0,
    at: new Date().toISOString(),
    phase,                       // 缠论六阶段之一 / unknown
    chan: market ? {
      phase: market.phase,
      reason: market.reason,     // 大白话阶段理由（给网页/模型）
      combo: market.combo,
      levels,
      strokeCount: levels.day && levels.day.strokeCount,
      segZoneCount: levels.day && levels.day.segZoneCount,
      calibrated: false,         // 缠论画法待用户持续对图，默认未标定
    } : null,
    fear,                        // {tier, fear, resonance, side, label, ...}
    sentimentScore,              // {score 0-100, label, state, calibrated:false}
    sentimentMulti,              // 多因子（经前向收益标定）：{score,label,calibrated,effective,evidence,factors,weights}
    sentimentSeries,             // [{date,score,hasRsi}] 近20日情绪曲线
    shTechnical: sh && !sh.error ? {
      close: sh.close, rsi14: sh.rsi14, aboveMa20: sh.aboveMa20, macdCross: sh.macdCross,
    } : null,
    summary,
    calibrated: fear.calibrated === true,   // 阶段图未标定，整体仍以 false 为准
    errors: errors.length ? errors : undefined,
  };
}

function summarizeLevel(lv) {
  if (!lv) return null;
  return {
    trend: lv.trend, pricePos: lv.pricePos, pivot: lv.pivot,
    strokeCount: lv.strokeCount,
    segZoneCount: lv.pivotZoneCount != null ? lv.pivotZoneCount : (Array.isArray(lv.zones) ? lv.zones.length : 0),
    segmentCount: lv.segmentCount,
    pointCount: Array.isArray(lv.points) ? lv.points.length : 0,
    divergenceCount: Array.isArray(lv.divergences) ? lv.divergences.length : 0,
  };
}

function buildSummary(phase, fear, errors) {
  if (errors.length && phase === 'unknown' && fear.tier === 'unknown') {
    return '大盘状态无法判断：' + errors.join('；') + '（缺数据不编造）';
  }
  const parts = [`缠论阶段「${phase}」`];
  if (fear.tier === 'extreme') parts.push('情绪极端恐慌（左侧·未标定）');
  else if (fear.tier === 'normal') parts.push('出现恐慌冰点（' + (fear.calibrated ? '' : '未标定·') + '值得关注，非买入建议）');
  else if (fear.tier === 'watch') parts.push('情绪有恐慌共振但阶段不符，只观察不接飞刀');
  return parts.join('，') + '。';
}

async function safe(fn) { try { return await fn(); } catch (_) { return null; } }
function lastDate(history) { const r = (history || []).slice().sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0); return r.length ? r[r.length-1].date : null; }

module.exports = { assess, buildSummary, summarizeLevel };
