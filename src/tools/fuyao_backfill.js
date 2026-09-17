'use strict';
/**
 * fuyao_backfill.js —— 用同花顺 fuyao 历史三池回填【长跨度】冰点基准。
 * ─────────────────────────────────────────────────────────
 * 东财 push2ex 只保留约15个交易日；fuyao 的涨停/跌停/炸板池按交易日可取近一年，
 * 让崩溃冰点分位从"刚够15天"扩到约 240 个交易日，分布立刻扎实。
 *
 * 诚实红线（与 fear_backfill.js 完全一致）：
 *   - 交易日历只取 fuyao 给出的真实交易日，不碰周末/节假日。
 *   - 三池 rawTotal 全 0 的日期视为"无有效数据"跳过，绝不写成 0（节假日/数据未就绪）。
 *   - 已存在真实盘中 slot(open/mid_am/midday/close) 的日期不覆盖；
 *     回填统一 slot='backfill'，每日幂等（UPSERT 到 date+slot='backfill'）。
 *   - 只回填情绪字段；指数技术面留 null（分位基准不需要）。
 *   - 数据源不同（fuyao vs 东财）：raw 里标 source，家数口径以白名单统一，
 *     但两家统计时点/口径有 5 只上下差异，属可接受（分位是排序统计），不做逐只强配。
 */

const fy = require('./fuyao');
const db = require('../db');

const REAL_SLOTS = ['close', 'midday', 'mid_am', 'open'];

/**
 * @param opt {days=240 取最近N个交易日, dryRun=false, onProgress(fn), minDays=15}
 * @returns 汇总
 */
async function backfill(opt = {}) {
  const wantDays = Math.max(1, opt.days || 240);
  const dryRun = !!opt.dryRun;
  if (!fy.hasKey()) throw new Error('未配置 FUYAO_API_KEY（.env）');

  const cal = await fy.tradingDays();            // 升序，近一年
  const days = cal.slice(-wantDays);

  // 已有样本：date(iso) -> Set(slot)
  const existing = new Map();
  for (const r of db.alertSamples()) {
    if (!existing.has(r.date)) existing.set(r.date, new Set());
    existing.get(r.date).add(r.slot);
  }

  const fills = [], skipped = [], existed = [], errors = [];

  // 从最新往最旧跑（更符合直觉的进度，且若中途限流停掉，最新数据先到位）
  for (const ymd of days.slice().reverse()) {
    const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    const slots = existing.get(iso);
    if (slots && REAL_SLOTS.some(s => slots.has(s))) {
      existed.push(iso);
      if (opt.onProgress) opt.onProgress({ date: iso, status: 'existed' });
      continue;
    }
    let snap;
    try {
      snap = await fy.fearSnapshot(ymd);
    } catch (e) {
      // 限流：短暂退避后重试一次，仍失败则记账继续（不阻断其余日期）
      if (/429|4001|timeout|超时/i.test(e.message)) {
        await new Promise(r => setTimeout(r, 1500));
        try { snap = await fy.fearSnapshot(ymd); }
        catch (e2) { errors.push({ date: iso, error: e2.message }); if (opt.onProgress) opt.onProgress({ date: iso, status: 'error', error: e2.message }); continue; }
      } else {
        errors.push({ date: iso, error: e.message });
        if (opt.onProgress) opt.onProgress({ date: iso, status: 'error', error: e.message });
        continue;
      }
    }
    if (!snap.hasAnyData) {
      skipped.push(iso);
      if (opt.onProgress) opt.onProgress({ date: iso, status: 'skipped' });
      continue;
    }
    const se = snap.sentiment;
    const row = {
      date: iso,
      limitUp: se.limitUpCount, broken: se.brokenCount, limitDown: se.limitDownCount,
      brokenRate: se.brokenRate == null ? null : +se.brokenRate.toFixed(1),
      ladderHeight: se.ladderHeight,
    };
    if (!dryRun) db.saveAlertSample(iso, 'backfill', { sentiment: se, indexes: {} });
    fills.push({ date: iso, ...row });
    if (opt.onProgress) opt.onProgress({ date: iso, status: 'filled', row });
  }

  fills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    ok: errors.length === 0,
    source: 'fuyao',
    dryRun,
    tradingDaysConsidered: days.length,
    filledCount: fills.length,
    skippedCount: skipped.length,
    existedCount: existed.length,
    fills, skipped, existed, errors,
    dailySampleCount: db.alertSamplesDaily().length,
  };
}

module.exports = { backfill };
