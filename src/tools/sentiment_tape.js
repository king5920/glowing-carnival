'use strict';
/**
 * sentiment_tape.js —— 情绪监控只留两列数。
 * 跌停家数、炸板率，各自在此前定型日里的分位。
 * 不编号，不分段，不画门槛，不给入场。
 */

const NOTE = '未标定。这两列数给不出入场时机。';
const SLOT_RANK = { close: 5, midday: 4, mid_am: 3, open: 2, backfill: 1 };
/* 开盘、午前、午后是盘中条。收盘和单独的回填才是定型。 */
const UNSETTLED_SLOT = { open: 1, mid_am: 1, midday: 1 };

function rank(slot) {
  return Object.prototype.hasOwnProperty.call(SLOT_RANK, slot) ? SLOT_RANK[slot] : 0;
}

/** 同一天多笔时取最定型的一条：收盘 > 午后 > 午前 > 开盘 > 回填。 */
function settle(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    if (!r || !r.date) continue;
    const cur = byDate.get(r.date);
    if (!cur || rank(r.slot) > rank(cur.slot)) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function num(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

/** 分位 = 此前有效日里原值 ≤ 今日原值的天数 / 此前有效天数。没有此前样本则分位为空，不写 0。 */
function cell(name, value, priorVals) {
  if (value == null) return { name, value: null, pct: null, n: null };
  const xs = [];
  for (const x of priorVals) {
    const n = num(x);
    if (n != null) xs.push(n);
  }
  if (!xs.length) return { name, value, pct: null, n: 0 };
  let leq = 0;
  for (const x of xs) if (x <= value) leq++;
  return { name, value, pct: leq / xs.length, n: xs.length };
}

/**
 * @param rows  alert 行，可含同一天多个 slot
 * @param opt.asOf  交易日 YYYY-MM-DD
 * @param opt.live  { limitDown, brokenRate } 盘中读数。当天没有收盘条时用它，且不计入分位分布
 */
function buildTape(rows, opt = {}) {
  const daily = settle(rows);
  const asOf = opt.asOf || null;
  const live = opt.live || null;
  const liveLd = live ? num(live.limitDown) : null;
  const liveBr = live ? num(live.brokenRate) : null;
  const today = asOf ? daily.find(r => r.date === asOf) : null;
  const settled = !!(today && !UNSETTLED_SLOT[today.slot]);

  let intraday = false;
  let ld = null;
  let br = null;
  let prior = [];

  if (settled) {
    ld = num(today.limit_down);
    br = num(today.broken_rate);
    prior = daily.filter(r => r.date < asOf);
  } else if (liveLd != null || liveBr != null) {
    const openSession = { '集合竞价': 1, '上午盘': 1, '午间休市': 1, '下午盘': 1 };
    intraday = opt.session ? !!openSession[opt.session] : true;
    ld = liveLd;
    br = liveBr;
    prior = asOf ? daily.filter(r => r.date < asOf) : daily;
  } else if (asOf) {
    const prev = [...daily].reverse().find(r => r.date < asOf);
    if (prev) {
      ld = num(prev.limit_down);
      br = num(prev.broken_rate);
      prior = daily.filter(r => r.date < prev.date);
    }
  } else if (daily.length) {
    const last = daily[daily.length - 1];
    ld = num(last.limit_down);
    br = num(last.broken_rate);
    prior = daily.filter(r => r.date < last.date);
  }

  return {
    intraday,
    asOf,
    note: NOTE,
    rows: [
      cell('跌停家数', ld, prior.map(r => r.limit_down)),
      cell('炸板率', br, prior.map(r => r.broken_rate)),
    ],
  };
}

module.exports = { buildTape, settle, NOTE, SLOT_RANK };
