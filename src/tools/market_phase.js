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

  /* 2) 情绪快照 + 崩溃冰点
   * 情绪源间歇失败：第一次若抛错或拿不到 sentiment（se），
   * 短暂退避后重试一次 —— 单次抖动不该让整帧退化成"样本0/情绪未知"。 */
  let snap = null;
  try { snap = await deps.snapshot(); }
  catch (e) {
    errors.push('情绪快照失败:' + e.message);
    await new Promise(r => setTimeout(r, 1200));
    try { snap = await deps.snapshot(); errors.push('重试后恢复'); }
    catch (e2) { errors.push('情绪快照重试仍失败:' + e2.message); }
  }
  if (snap && !(snap.sentiment)) {
    await new Promise(r => setTimeout(r, 1200));
    try { const s2 = await deps.snapshot(); if (s2 && s2.sentiment) snap = s2; }
    catch (e) { /* 保留原 snap，下面如实判 unknown */ }
  }
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
      if (r.sh_volume == null && b != null && b.volume != null) r.sh_volume = b.volume;
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
    let oos = null, oosConfirmed = null;
    try {
      const wf = require('./walkforward');
      oos = wf.walkForward(enriched, { trainWindow: 90 });
      oosConfirmed = wf.evaluateConfirmed(enriched);
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
          signalMin: oos.signalMin, note: oos.note,
          confirmed: oosConfirmed ? oosConfirmed.confirmed : [] }
      : null;
  } catch (e) { sentimentMulti = { error: e.message }; }

  /* 2.7) 大盘时机总开关：结构阶段 × 情绪温度 → 当前窗口 + 样本外成绩单 */
  let marketWindow = null;
  try {
    const mwin = require('./market_window');
    const smod = require('./sentiment_model');
    const chn = require('./chan');
    /* 复用上面的 enriched（已含 fwd_d1/3/5）；重建以保证本块自洽 */
    const closeMap = new Map(barsDay.map(b => [b.date, b.close]));
    const d0 = (history || []).map(r => Object.assign({}, r));
    let enr = smod.enrichDaily(d0, barsDay, null);
    enr = enr.map(r => {
      const b = closeMap.get(r.date);
      if (r.sh_close == null && b != null) r.sh_close = b;
      if (r.sh_volume == null && b != null && b.volume != null) r.sh_volume = b.volume;
      return r;
    });
    enr = enr.map(r => {
      const idx = barsDay.findIndex(b => b.date === r.date);
      if (idx >= 0) for (const k of [1, 3, 5]) {
        if (idx + k < barsDay.length)
          r['fwd_d' + k] = +((barsDay[idx + k].close - barsDay[idx].close) / barsDay[idx].close * 100).toFixed(2);
      }
      return r;
    });

    /* phaseAt/scoreAt 严格只用截至 i 的信息 */
    const phaseAt = i => {
      try { return chn.analyzeMarket({ day: barsDay.slice(0, i + 1) }).phase; }
      catch (e) { return null; }
    };
    const scoreAt = i => {
      try {
        const train = enr.slice(Math.max(0, i - 90), i);
        const c = smod.calibrate(train);
        return smod.weightedScore(smod.factors(enr[i], enr.slice(0, i)), c.weights);
      } catch (e) { return null; }
    };

    const report3 = mwin.backtestWindows(enr, { phaseAt, scoreAt }, { minIndex: 40, fwdKey: 'fwd_d3' });
    const report5 = mwin.backtestWindows(enr, { phaseAt, scoreAt }, { minIndex: 40, fwdKey: 'fwd_d5' });

    /* 当前窗口：用今天的结构阶段 + 今日多因子分（若有） */
    const curPhase = market ? market.phase : (barsDay.length ? phaseAt(barsDay.length - 1) : null);
    const curScore = sentimentMulti && sentimentMulti.score != null ? sentimentMulti.score : null;
    const cur = mwin.windowOf(curPhase, curScore);

    const findRep = (rep, code) => rep.windows.find(w => w.code === code) || null;
    marketWindow = {
      window: cur.window, code: cur.code, reason: cur.reason,
      phase: curPhase, score: curScore,
      evidence: {
        d3: findRep(report3, cur.code),
        d5: findRep(report5, cur.code),
        allD3: report3.windows,
      },
    };
  } catch (e) { marketWindow = { error: e.message }; }

  /* 2.8) 板块方向：当前主线候选 + 样本外成绩单（方法论后半句"板块定方向"） */
  let sectorMainline = null;
  try {
    const dbm = require('../db');
    const sml = require('./sector_mainline');
    const dates = dbm.sectorDailyDates();
    if (!dates.length) {
      sectorMainline = { status: 'empty', candidates: [], note: '板块每日数据尚未开始积累' };
    } else {
      /* 当前主线：用截至最新日全部行选出 */
      const acc = [];
      for (const d of dates) acc.push(...dbm.sectorDailyAt(d));
      const cur = sml.selectAsOf(acc, dates).filter(x => x.mainline).slice(0, 5)
        .map(x => ({ code: x.code, name: x.name, kind: x.kind,
          streak: x.streak, totalYi: x.totalYi, rangePct: x.rangePct }));
      /* 样本外状态（T+1 目前事件最多；都不足时如实说明） */
      const bt1 = sml.backtest(dates, d => dbm.sectorDailyAt(d), { fwdKey: 'fwd_d1' });
      const bt3 = sml.backtest(dates, d => dbm.sectorDailyAt(d), { fwdKey: 'fwd_d3' });
      sectorMainline = {
        status: 'ok', days: dates.length,
        candidates: cur,
        oos: {
          d1: { n: bt1.withFwd, winRate: bt1.stats.winRate, reliable: bt1.reliable },
          d3: { n: bt3.withFwd, winRate: bt3.stats.winRate, reliable: bt3.reliable },
          note: bt3.reliable ? bt3.note
            : `板块主线样本外事件不足（T+1 ${bt1.withFwd}/T+3 ${bt3.withFwd}，需≥${sml.MIN_ML_EVENTS}），胜率暂不采信，继续积累交易日`,
        },
      };
    }
  } catch (e) { sectorMainline = { error: e.message }; }

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
    marketWindow,                // 时机总开关：{window,code,reason,evidence{d3,d5}}
    sectorMainline,              // 板块方向：{candidates,oos{d1,d3,note}}
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
