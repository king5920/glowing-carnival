'use strict';
/**
 * cs_warm.js —— 收盘扫描（close_scan）服务端预热的纯决策函数
 *
 * 为什么单独抽成纯函数：预热"该不该现在扫一次东财"是最容易写错、也最该被单测覆盖
 * 的规则（错了要么节假日空扫外部源、要么交易时段缓存变冷让首访用户白等几十秒）。
 * 抽成无副作用纯函数，Node 单测可以直接喂任意"交易时段 / 缓存年龄"组合，不必真起服务、
 * 不必等真实开盘。
 *
 * 配套：src/server.js 的预热定时器每 60s 调 shouldWarmCloseScan()，仅当返回 warm=true
 * 才触发一次 csScanFull()（在途合并 + 只缓存成功结果都在 server 侧，这里不关心）。
 */

/* 仅 A 股连续竞价时段需要让缓存保持热：
 *   上午盘 09:30–11:30、下午盘 13:00–15:00（名称与 src/clock.js tradingSession 对齐）。
 * 盘前 / 集合竞价 / 午间休市 / 收盘竞价刚结束 / 收盘后 / 休市日 都不主动预热。 */
const WARMABLE_SESSIONS = ['上午盘', '下午盘'];

/** 当前交易时段是否属于"该预热"窗口 */
function isWarmableSession(session) {
  return WARMABLE_SESSIONS.indexOf(session) >= 0;
}

/**
 * 这一拍该不该触发一次收盘扫描预热。
 *
 * @param {object} p
 * @param {string} p.session   clock.tradingSession(now) 的返回值（交易日历，含节假日/调休）
 * @param {number|null|undefined} p.slotAt  当前缓存的写入时间戳(ms)；null=尚无缓存
 * @param {number} p.now       当前时间戳(ms)，默认 Date.now()
 * @param {number} p.maxAgeMs  缓存年龄阈值；超过即视为"将冷"，应续热
 * @returns {{warm:boolean, reason:string}}
 *   warm=true 的 reason: 'no-cache'（首访前预热）| 'stale'（缓存将冷）
 *   warm=false 的 reason: 'non-session'（非竞价时段）| 'fresh'（缓存仍新鲜）| 'invalid-age'
 */
function shouldWarmCloseScan(p) {
  const opts = p || {};
  const session = opts.session;
  const slotAt = opts.slotAt;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const maxAgeMs = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : 75000;

  if (!isWarmableSession(session)) {
    return { warm: false, reason: 'non-session' };
  }
  if (slotAt == null) {
    return { warm: true, reason: 'no-cache' };
  }
  if (typeof slotAt !== 'number' || !isFinite(slotAt) || !isFinite(maxAgeMs) || maxAgeMs < 0) {
    return { warm: false, reason: 'invalid-age' };
  }
  if (now - slotAt > maxAgeMs) {
    return { warm: true, reason: 'stale' };
  }
  return { warm: false, reason: 'fresh' };
}

module.exports = {
  WARMABLE_SESSIONS,
  isWarmableSession,
  shouldWarmCloseScan,
};
