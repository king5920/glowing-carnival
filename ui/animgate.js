'use strict';
/**
 * animgate.js —— 星图按需渲染的"是否继续动画"判定（纯函数，可单测）
 *
 * 第三层把星图从"永久 rAF 空转"改成"动才画、静下来就停 GPU"。
 * 真正容易写错的是"什么算还在动"这个判定（漏判会停在半帧、误判会永不省电），
 * 所以抽成无副作用纯函数，前端与 Node 测试共用。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.AnimGate = factory();
})(typeof self !== 'undefined' ? self : this, function () {

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
   * 任何 rAF 循环都通过 gatedLoop() 挂进来，标签页隐藏或窗口失焦时全部停帧，
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
   * init() 惰性调用（只在 gatedLoop 首次使用时），保证 Node 测试 require 本文件不触碰 document。
   */
  const page = {
    _m: null,
    init() {
      if (page._m) return;
      page._m = createPageActivity(() => document.hidden);
      document.addEventListener('visibilitychange', () => page._m.visibilityChange());
      addEventListener('blur', () => page._m.setFocused(false));
      addEventListener('focus', () => page._m.setFocused(true));
      page._m.visibilityChange();
    },
    active() { return page._m ? page._m.active() : true; },
    onActive(cb) { if (!page._m) page.init(); return page._m.onActive(cb); },
  };

  /**
   * 给已有的 rAF 循环套上"失活即停、复活即续"的闸门，返回 () => void 取消函数。
   *   fn(ts)  每帧回调
   *   stop()  可选；返回 true 时本循环永久终止（如资源已释放）
   * 失活期间不再排下一帧（rAF 队列真正归零，不是"挂着不画"）；
   * 恢复活跃时由 page.onActive 补排一帧，避免"停了就再也起不来"。
   */
  function gatedLoop(fn, stop) {
    page.init();
    let scheduled = false;
    function step(ts) {
      scheduled = false;
      if (stop && stop()) return;          // 调用方主动停
      if (!page.active()) return;          // 失活：这一帧不画也不排
      fn(ts);
      if (page.active()) { scheduled = true; requestAnimationFrame(step); }
    }
    return page.onActive(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(step); } });
  }

  return { shouldAnimate, scheduleNext, isPageActive, createPageActivity, page, gatedLoop };
});
