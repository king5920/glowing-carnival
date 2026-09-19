'use strict';
/**
 * animgate.js —— 共享 rAF 调度器 + 按需渲染判定（纯函数 + 浏览器调度器）
 *
 * C1 rAF 链重构（2026-09-19）：
 *   旧架构：每次 AnimGate.gatedLoop() 各建一条独立 rAF 链 → 6 条链 / 8 canvas。
 *   新架构：共享调度器，一个 rAF 驱动所有注册的 draw 回调 → 1 条链。
 *
 * 新 API：
 *   AnimGate.sharedLoop()       -> { start, stop, isRunning }  单一 rAF 驱动
 *   AnimGate.register(draw,opts)-> unregister()                 注册 draw 回调
 *   AnimGate.unregister(fn)                             按引用注销
 *
 * 旧 API（deprecated 适配层，向后兼容）：
 *   AnimGate.gatedLoop(fn, stop)-> unregister()                 自动适配为 register
 *
 * 纯函数（不变，可 Node 单测）：
 *   shouldAnimate, scheduleNext, isPageActive, createPageActivity
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.AnimGate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object} s
   * @param {boolean} s.dragging          正在拖拽旋转
   * @param {number}  s.forceFrames       唤醒后强制还要画的帧数（>0 必画）
   * @param {object}  s.cur               当前渲染参数
   * @param {object}  s.tgt               目标渲染参数
   * @param {boolean} s.targetIsIdle      目标是否为待机态（待机允许停，非待机持续）
   * @param {Float32Array|number[]} s.act 各节点当前激活度
   * @param {number[]} s.baseGlow         各节点底光（衰减下限），与 act 等长
   * @param {number}  s.eps               收敛阈值
   * @returns {boolean} 是否仍需继续渲染
   */
  function shouldAnimate(s) {
    if (!s) return false;
    if (s.forceFrames > 0) return true;
    if (s.dragging) return true;
    if (!s.targetIsIdle) return true;

    // 状态参数还在向目标插值（如 think→idle 的亮度回落没结束）
    const eps = s.eps == null ? 0.004 : s.eps;
    const cur = s.cur || {}, tgt = s.tgt || {};
    for (const k in tgt) {
      if (Math.abs((cur[k] || 0) - tgt[k]) > eps) return true;
    }

    // 有节点的高亮还没衰减回底光（检索点亮后的余光动画）
    const act = s.act, base = s.baseGlow;
    if (act && base && act.length === base.length) {
      for (let i = 0; i < act.length; i++) {
        if (act[i] > base[i] + eps) return true;
      }
    }
    return false;
  }

  /**
   * 综合"是否排下一帧"：在 shouldAnimate 基础上叠加 reduced-motion。
   * reduced-motion 下只允许画强制帧（一次性呈现），绝不因为待机自转持续。
   */
  function scheduleNext(s) {
    if (!s) return false;
    if (s.forceFrames > 0) return true;
    if (s.reduceMotion) return false;     // 强制帧耗尽后，减弱动态偏好下立即停
    return shouldAnimate(s);
  }

  /* ──────────── 页面活性闸门 ────────────
   * §4 硬预算承诺"页面失焦（visibilitychange）全部暂停"。这里把它做成真的：
   * 任何 rAF 循环都通过共享调度器挂进来，标签页隐藏或窗口失焦时全部停帧，
   * 重新激活时自动续帧。纯判定与状态机与 DOM 解耦，Node 测试直接喂 {hidden,focused}。 */

  /** 纯判定：页面是否处于"该画"状态。默认（缺字段）视为活跃，保持宽松。 */
  function isPageActive(s) {
    if (!s) return true;
    if (s.hidden) return false;
    return s.focused !== false;
  }

  /**
   * 页面活性状态机（纯，可测）。
   * getHidden: () => boolean，由调用方注入 document.hidden；不传时按"未隐藏"处理。
   * 订阅者只在 active 的**上升沿**（停→跑）被回调一次 —— 这正是"被暂停的循环需要被重启"的时刻；
   * 转暗不需要动作，循环会在下一帧自查 active() 后自行停。
   */
  function createPageActivity(getHidden) {
    const subs = [];
    let focused = true;
    let active = isPageActive({ hidden: getHidden ? getHidden() : false, focused });

    function sync() {
      const was = active;
      active = isPageActive({ hidden: getHidden ? getHidden() : false, focused });
      if (active && !was) {
        for (let i = 0; i < subs.length; i++) {
          try { subs[i](); } catch (e) { /* 单个订阅者异常不阻断其余循环复活 */ }
        }
      }
      return active;
    }
    return {
      active: () => active,
      onActive: (cb) => { subs.push(cb); if (active) cb(); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
      setFocused: (f) => { focused = !!f; return sync(); },
      visibilityChange: () => sync(),
    };
  }

  /**
   * 浏览器单例：把 visibilitychange / blur / focus 接到上面的状态机上。
   * init() 惰性调用（只在调度器首次使用时），保证 Node 测试 require 本文件不触碰 document。
   * Node 安全：缺 document / addEventListener 时降级为"始终活跃"。
   */
  const page = {
    _m: null,
    init() {
      if (page._m) return;
      const getHidden = (typeof document !== 'undefined') ? () => document.hidden : () => false;
      page._m = createPageActivity(getHidden);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => page._m.visibilityChange());
      }
      if (typeof addEventListener === 'function') {
        addEventListener('blur', () => page._m.setFocused(false));
        addEventListener('focus', () => page._m.setFocused(true));
      }
      page._m.visibilityChange();
    },
    active() { return page._m ? page._m.active() : true; },
    onActive(cb) { if (!page._m) page.init(); return page._m.onActive(cb); },
    /** 当前是否偏好减弱动态（Node 环境返回 false） */
    reduceMotion() {
      var mm = globalThis.matchMedia;
      if (typeof mm === 'function') {
        return mm('(prefers-reduced-motion: reduce)').matches;
      }
      return false;
    },
  };

  /* ══════════════════════════════════════════════════════════
     C1 共享 rAF 调度器
     ══════════════════════════════════════════════════════════
     核心思想：全局一条 rAF 链驱动所有注册的 draw 回调。
     旧架构每次 gatedLoop 各建一条链 → 链数 = 调用次数（实测 6 条）。
     新架构 register() 只往注册表追加，rAF 链始终 1 条。

     生命周期：
       start()  — 启动调度器（running=true），注册 page.onActive 复活钩子
       stop()   — 暂停调度器（running=false），保留注册表
       isRunning() — 调度器是否存活（≠ 是否有 rAF 在跑）

     draw 回调契约：
       fn(ts, info) -> boolean | undefined
         ts: rAF 时间戳（ms）
         info: { dt: seconds, active: bool, reduceMotion: bool }
         return false  → 自动注销（调度器下次不再调用）
         return true / undefined → 继续调用

     失焦暂停：page.active() 为 false 时 tick() 不画也不排下一帧；
               页面复活时 page.onActive 补排一帧。
     reduced-motion：info.reduceMotion 传给每个 draw，由 draw 自行降级。
     idle 检测：registry 为空 → 不排 rAF（调度器进入静默）；
                新 register 时自动唤醒。 */

  const registry = [];       // [{ fn, opts }]
  let rafId = null;          // 当前 rAF id（null = 未排）
  let running = false;       // 调度器存活标志
  let lastTs = 0;            // 上一帧时间戳（算 dt 用）
  let onActiveOff = null;    // page.onActive 退订函数

  /** 核心 tick：调用所有注册的 draw，决定是否排下一帧 */
  function tick(ts) {
    rafId = null;
    if (!running) return;
    if (!page.active()) return;         // 失活：不画也不排，等 page.onActive 复活

    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;

    // 拷贝注册表再遍历：允许 draw 在回调中 register/unregister
    const snapshot = registry.slice();
    const rm = page.reduceMotion();
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i];
      try {
        const result = entry.fn(ts, { dt: dt, active: page.active(), reduceMotion: rm });
        if (result === false) {
          // draw 主动请求注销
          const idx = registry.indexOf(entry);
          if (idx >= 0) registry.splice(idx, 1);
        }
      } catch (e) {
        // 单个 draw 异常不阻断其余 draw 和调度器存活
        if (typeof console !== 'undefined') console.error('[AnimGate] draw error:', e);
      }
    }

    // 只要注册表非空且页面活跃就继续排下一帧
    if (running && page.active() && registry.length > 0) {
      var rafFn = globalThis.requestAnimationFrame;
      if (rafFn) rafId = rafFn(tick);
    }
  }

  /** 确保有 rAF 在跑（幂等：已有则跳过） */
  function ensureScheduled() {
    if (rafId != null) return;
    if (!running || !page.active() || registry.length === 0) return;
    lastTs = 0;   // 唤醒时重置 dt，避免长时间失焦后 dt 过大
    var rafFn = globalThis.requestAnimationFrame;
    if (rafFn) rafId = rafFn(tick);
  }

  /** 共享调度器对外接口 */
  const sharedLoop = {
    start() {
      if (running) { ensureScheduled(); return; }
      running = true;
      lastTs = 0;
      page.init();
      if (onActiveOff) { try { onActiveOff(); } catch (e) {} onActiveOff = null; }
      onActiveOff = page.onActive(() => {
        if (!running) return;
        lastTs = 0;
        ensureScheduled();
      });
      ensureScheduled();
    },
    stop() {
      if (!running) return;
      running = false;
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
      if (onActiveOff) { try { onActiveOff(); } catch (e) {} onActiveOff = null; }
      lastTs = 0;
    },
    isRunning() { return running; },
  };

  /**
   * 注册一个 draw 回调到共享调度器。
   * @param {function} fn  draw(ts, info) -> boolean|undefined
   * @param {object}   opts  调用方自定义选项（透传，不做解释）
   * @returns {function} 注销函数
   */
  function register(fn, opts) {
    if (typeof fn !== 'function') throw new TypeError('AnimGate.register: fn must be a function');
    registry.push({ fn: fn, opts: opts || {} });
    if (!running) sharedLoop.start();
    else ensureScheduled();
    return function unregister() {
      const idx = registry.findIndex(function (e) { return e.fn === fn; });
      if (idx >= 0) registry.splice(idx, 1);
      if (registry.length === 0 && rafId != null) {
        if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }

  /** 按引用注销一个 draw 回调 */
  function unregister(fn) {
    const idx = registry.findIndex(function (e) { return e.fn === fn; });
    if (idx >= 0) registry.splice(idx, 1);
    if (registry.length === 0 && rafId != null) {
      if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /** 当前注册表长度（调试/测试用） */
  function registerCount() { return registry.length; }

  /* ══════════════════════════════════════════════════════════
     旧 API 适配层（deprecated）
     ══════════════════════════════════════════════════════════
     gatedLoop(fn, stop) 的旧调用方无需修改即可工作：
       - fn(ts)  被包装为 wrapper，每帧调用 fn(ts, info)
       - stop()  返回 true 时 wrapper 返回 false → 自动注销
       - 返回的注销函数 = register 返回的注销函数
     所有 gatedLoop 共享同一条 rAF 链，不再各建一条。 */

  function gatedLoop(fn, stop) {
    const wrapper = function (ts, info) {
      if (stop && stop()) return false;   // 调用方主动停 → 注销
      fn(ts, info);
      return true;                          // 继续
    };
    return register(wrapper, {});
  }

  /* ══════════════════════════════════════════════════════════
     测试辅助（仅测试环境使用，不影响生产行为）
     ══════════════════════════════════════════════════════════ */
  function _testReset() {
    registry.length = 0;
    if (rafId != null) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = null; }
    running = false;
    lastTs = 0;
    if (onActiveOff) { try { onActiveOff(); } catch (e) {} onActiveOff = null; }
  }
  function _testGetRafId() { return rafId; }
  function _testGetRegistry() { return registry.slice(); }
  function _testSetRafId(v) { rafId = v; }

  return {
    // 纯函数（原有）
    shouldAnimate, scheduleNext, isPageActive, createPageActivity,
    page,
    // 新 API
    sharedLoop: sharedLoop,
    register: register,
    unregister: unregister,
    registerCount: registerCount,
    // 旧 API（deprecated 适配层）
    gatedLoop: gatedLoop,
    // 测试辅助
    _testReset: _testReset,
    _testGetRafId: _testGetRafId,
    _testGetRegistry: _testGetRegistry,
    _testSetRafId: _testSetRafId,
  };
});
