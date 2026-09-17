'use strict';
/**
 * fear_backfill.js —— 用东财涨跌停/炸板【历史池】回填崩溃冰点基准。
 * ─────────────────────────────────────────────────────────
 * 背景：崩溃冰点（capitulation.js）要拿今天的跌停数、炸板率跟"平时"比，
 * 需要至少 15 个交易日分布。干等太慢；东财 push2ex 的 getTopicZTPool/ZBPool/DTPool
 * 支持按日期查历史（实测 2026-09 可回溯约 15-16 个交易日，更早返回空）。
 *
 * 诚实红线：
 *   - 早于接口保留期的日期返回【空池】，无法区分"真没涨跌停"还是"那天没数据"，
 *     这类日期一律跳过（不写成 0，否则会把假的"太平日"塞进分布，严重低估分位）。
 *   - 判定"真有数据"：当天至少一个池 rawTotal>0（极弱市涨停可能极少，但炸板/跌停一般非0；
 *     若三池 rawTotal 全 0 视为无保留，跳过）。
 *   - 只回填【情绪池三字段】（limit_up/broken/limit_down/broken_rate/ladder/seal_fund），
 *     不伪造历史指数技术面（那些列留 null）——分位基准只需要情绪字段。
 *   - 已存在真实盘中 slot(open/mid_am/midday/close) 的日期不覆盖，只补缺；
 *     回填统一写 slot='backfill'，且每天至多一行（幂等）。
 * 零新增依赖，节流交给 em_client（fetchPool 已走它）。
 */

const sentiment = require('./sentiment');
const db = require('../db');

/** 最近 lookback 个自然日内的工作日，返回 ['YYYYMMDD',...]，含今天，按日期升序 */
function recentWeekdays(lookbackDays) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < lookbackDays; i++) {
    const t = new Date(d); t.setDate(d.getDate() - i);
    const wd = t.getDay();
    if (wd >= 1 && wd <= 5) {
      const y = t.getFullYear();
      const m = String(t.getMonth() + 1).padStart(2, '0');
      const dd = String(t.getDate()).padStart(2, '0');
      out.push(`${y}${m}${dd}`);
    }
  }
  return out.reverse();
}

/**
 * 执行回填。
 * @param {object} opt {lookbackDays=35, dryRun=false, onProgress(fn)}
 * @returns {fills:[], skipped:[], existed:[], errors:[]}
 */
async function backfill(opt = {}) {
  const lookbackDays = opt.lookbackDays || 35;
  const dryRun = !!opt.dryRun;
  // 连续这么多个工作日都取不到保留数据，就认为已越过接口保留期，停止再往前翻
  // （旧日期每次都要 3 次慢请求，纯空转；实测保留期约 15-16 个交易日）。
  const maxConsecutiveEmpty = opt.maxConsecutiveEmpty ?? 4;
  const dates = recentWeekdays(lookbackDays);

  // 已有样本：date -> 已有 slot 集合（不覆盖真实盘中 slot）
  const existing = new Map();
  for (const r of db.alertSamples()) {
    if (!existing.has(r.date)) existing.set(r.date, new Set());
    existing.get(r.date).add(r.slot);
  }

  const fills = [], skipped = [], existed = [], errors = [];

  /* 从最新往最旧翻：接口只保留最近约15-16个交易日，越过保留期会连续空，
     便于命中 maxConsecutiveEmpty 提前停止（旧→新会在开头就连空，无法判断）。 */
  const iterDates = dates.slice().reverse();
  let consecutiveEmpty = 0;

  for (const ymd of iterDates) {
    if (consecutiveEmpty >= maxConsecutiveEmpty) break;
    const isoDate = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    const slots = existing.get(isoDate);

    // 已有真实盘中定型 slot → 直接计入已存在，不回填（保留最权威的那条）
    if (slots && ['close', 'midday', 'mid_am', 'open'].some(s => slots.has(s))) {
      existed.push(isoDate);
      consecutiveEmpty = 0;
      if (opt.onProgress) opt.onProgress({ date: isoDate, status: 'existed' });
      continue;
    }

    let snap;
    try {
      // date 选项让三池按历史日期拉取；指数技术面即便取到也是"最新值"，回填不使用，
      // 所以保存时只保留 sentiment（saveAlertSample 对缺失 indexes 写 null）。
      snap = await sentiment.snapshot({ date: ymd, poolsOnly: true });
    } catch (e) {
      errors.push({ date: isoDate, error: e.message });
      if (opt.onProgress) opt.onProgress({ date: isoDate, status: 'error', error: e.message });
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const se = snap && snap.sentiment;
    const rt = (se && se.rawTotal) || {};
    const hasRetention = (rt.limitUp || 0) + (rt.broken || 0) + (rt.limitDown || 0) > 0;

    if (!snap.ok || !se || !hasRetention) {
      // 空池：非交易日或超出接口保留期，无法证实，跳过（绝不写 0）
      skipped.push(isoDate);
      consecutiveEmpty++;
      if (opt.onProgress) opt.onProgress({ date: isoDate, status: 'skipped' });
      continue;
    }
    consecutiveEmpty = 0;

    const row = { date: isoDate, sentiment: se };
    if (!dryRun) db.saveAlertSample(isoDate, 'backfill', row);
    fills.push({
      date: isoDate,
      limitUp: se.limitUpCount, broken: se.brokenCount, limitDown: se.limitDownCount,
      brokenRate: se.brokenRate == null ? null : +se.brokenRate.toFixed(1),
      ladderHeight: se.ladderHeight,
    });
    if (opt.onProgress) opt.onProgress({ date: isoDate, status: 'filled', row: fills[fills.length - 1] });
  }

  fills.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return {
    ok: errors.length === 0,
    dryRun,
    filledCount: fills.length,
    skippedCount: skipped.length,
    existedCount: existed.length,
    fills, skipped, existed, errors,
    dailySampleCount: db.alertSamplesDaily().length,
  };
}

module.exports = { backfill, recentWeekdays };
