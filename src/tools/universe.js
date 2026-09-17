'use strict';
/**
 * 可投资宇宙口径（全局白名单）
 * ─────────────────────────────────────────────────────────
 * 用户 2026-09-13 拍板：「我只做主板和创业板。」
 *
 * 纳入（代码前缀白名单）：
 *   沪市主板  600 / 601 / 603 / 605
 *   深市主板  000 / 001 / 002 / 003
 *   创业板    300 / 301
 *
 * 排除：
 *   科创板    688 / 689
 *   北交所    4xxxxx / 8xxxxx（43/83/87/88 等）/ 920
 *   ST 类     名称含 ST、*ST、退（即便代码落在白名单段，也一票否决）
 *
 * ══ 作用边界（用户两次强调"对大盘/板块无效"）══
 *   ✅ 生效：逐只个股的统计——全A涨跌家数、涨停/跌停/炸板/连板情绪池等
 *   ❌ 不生效：大盘指数（点位/K线/技术指标）、行业/概念板块（资金流/涨跌家数/主线打分）
 *      指数与板块是聚合体，不是个股，不能套用本白名单。
 *
 * 纯函数、零网络、零依赖，便于离线单测。只认 6 位 A 股代码；其它长度一律 false
 * （宁可漏计也不放进不明标的）。
 *
 * ⚠ 契约：本模块只判断【个股】，不要喂指数/板块。指数与个股有撞号（沪深300 指数
 * sh000300 与深市 000300 股票同码；000001 上证指数与平安银行同码），区分它们靠市场
 * 前缀/secid，而 normalizeCode 会剥掉前缀，故调用方必须先按上下文确认传入的是个股。
 */

/* 纳入的 6 位代码前缀。用 3 位前缀穷举，比"排除 688/北交所"的黑名单更不漏。 */
const ALLOWED_PREFIXES = [
  // 沪市主板
  '600', '601', '603', '605',
  // 深市主板
  '000', '001', '002', '003',
  // 创业板
  '300', '301',
];

/** 标准化代码：去掉市场前缀(sh/sz/bj)和交易所后缀(.SH/.SZ)，只留数字主体。 */
function normalizeCode(code) {
  if (code == null) return '';
  return String(code)
    .trim()
    .replace(/^(sh|sz|bj)/i, '')
    .replace(/\.(sh|sz|bj)$/i, '')
    .trim();
}

/**
 * 仅按代码段判断是否主板/创业板（不看名称，故不判断 ST）。
 * 必须正好 6 位数字，否则 false。
 */
function isBoardAllowed(code) {
  const c = normalizeCode(code);
  if (!/^\d{6}$/.test(c)) return false;
  return ALLOWED_PREFIXES.some((p) => c.startsWith(p));
}

/**
 * 名称是否 ST / *ST / 退市整理。
 * 东财名称里常见 "STxxx"、"*STxxx"、"xxx退"。去掉空白后统一判断。
 */
function isStName(name) {
  if (name == null) return false;
  const n = String(name).replace(/\s+/g, '').toUpperCase();
  if (!n) return false;
  if (n.includes('ST')) return true;       // 同时覆盖 ST 与 *ST（*ST 含子串 ST）
  if (n.includes('退')) return true;       // 退市整理期
  return false;
}

/**
 * 最终口径：代码在主板/创业板白名单 **且** 名称非 ST/退。
 * @param {{code:string,name?:string}} stock
 */
function inTradableUniverse(stock) {
  if (!stock) return false;
  if (!isBoardAllowed(stock.code)) return false;
  if (isStName(stock.name)) return false;
  return true;
}

/**
 * 从一批逐只个股里筛出可投资宇宙。元素需含 code，name 可选（无 name 时只按代码）。
 * @param {Array<{code:string,name?:string}>} rows
 * @returns {{kept:Array, dropped:Array}} 保留与被剔除（带 reason，便于排障/统计）
 */
function filterUniverse(rows) {
  const kept = [], dropped = [];
  for (const r of rows || []) {
    const c = normalizeCode(r && r.code);
    if (!/^\d{6}$/.test(c)) { dropped.push({ row: r, reason: 'bad_code' }); continue; }
    if (!isBoardAllowed(c)) { dropped.push({ row: r, reason: 'board_excluded' }); continue; }
    if (isStName(r.name)) { dropped.push({ row: r, reason: 'st_or_delisting' }); continue; }
    kept.push(r);
  }
  return { kept, dropped };
}

module.exports = {
  ALLOWED_PREFIXES,
  normalizeCode,
  isBoardAllowed,
  isStName,
  inTradableUniverse,
  filterUniverse,
};
