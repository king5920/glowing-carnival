'use strict';
/**
 * mp_cache.js —— market_phase 的 stale-while-revalidate 缓存。
 * ─────────────────────────────────────────────────────────
 * 为什么：/api/market_phase 冷启动实测 27s+（瓶颈在情绪快照逐股拉K，外部源无法加速）。
 *   让用户等这个时间不可接受。做法是【别在请求路径上现算】：
 *     - 服务启动立刻后台拉一次（预温），之后按 TTL 自动刷新；
 *     - 请求命中新鲜缓存 → 立即返回；
 *     - 缓存过期 → 立即返回旧值，同时后台刷新（SWR，绝不阻塞用户）；
 *     - 只有"服务刚起、一帧都还没拉到"的冷窗：首个请求等第一次结果（其余请求合并到同一 promise）。
 *
 * 诚实：返回旧值时带 stale=true 与 cachedAt，前端可显示"数据时间"，不把旧数据伪装成实时。
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;   // 交易时段面板也是5分钟刷新，对齐

function createCache(producer, opt = {}) {
  const ttl = opt.ttlMs || DEFAULT_TTL_MS;
  let slot = null;          // { at, value }
  let inflight = null;      // Promise —— 在途刷新（合并并发）
  let timer = null;

  function refresh() {
    if (!inflight) {
      inflight = Promise.resolve()
        .then(producer)
        .then(value => { slot = { at: Date.now(), value }; return value; })
        .catch(err => {
          // 刷新失败不清空旧值（仍可 SWR）；冷启动时把错误抛出给等待者
          if (!slot) throw err;
          return slot.value;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  /**
   * 请求入口。
   * @returns {value, stale, cachedAt, ageMs}
   */
  async function get() {
    if (slot) {
      const age = Date.now() - slot.at;
      if (age <= ttl) return pack(false);
      // 过期：返回旧值 + 后台刷新（不等）
      refresh().catch(() => {});
      return pack(true);
    }
    // 冷窗：等第一次（并发已合并）
    await refresh();
    return slot ? pack(false) : null;
  }

  function pack(stale) {
    return {
      value: slot.value, stale, cachedAt: new Date(slot.at).toISOString(),
      ageMs: Date.now() - slot.at,
    };
  }

  /** 启动预温 + 定时刷新；不 await（后台跑） */
  function start() {
    refresh().catch(() => {});
    if (opt.autoRefresh !== false && !timer) {
      timer = setInterval(() => refresh().catch(() => {}), ttl);
      if (timer.unref) timer.unref();
    }
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function _peek() { return slot ? { at: slot.at } : null; }

  return { get, refresh, start, stop, _peek };
}

module.exports = { createCache, DEFAULT_TTL_MS };
