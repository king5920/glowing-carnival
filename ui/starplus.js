/**
 * starplus.js — 星图增强的纯逻辑层（无 DOM/GL 依赖，Node 可单测）
 *
 * 承载 DESIGN.md §10 五项增强里所有可数值验证的数学：
 *   STAGE5 稳定槽位   stableSlot / assignSlots     —— 位置只依赖 id，新增记忆不搬家
 *   STAGE1 三级景深   neighborLevels               —— 一度/二度邻居 BFS 分层
 *   STAGE2 相机聚焦   cameraTarget                 —— 目标点旋转到正前方的 ry/rx
 *   STAGE3 事件脉冲   pulseOffsets                 —— 沿真实路径的逐级延迟
 *
 * 与 starfield.js 的关系：starfield 通过 window.STARPLUS 调用本文件；
 * 本文件不知道星图的存在，输入输出都是纯数组/纯数字。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.STARPLUS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PHI_INV = 0.6180339887498949;   // 黄金比例倒数：低差异序列的核心

  /* ── STAGE5 ─────────────────────────────────────────────
   * 稳定槽位：frac(id * φ⁻¹) 把 id 均匀撒进 [0,1)（Weyl 等分布），
   * 与"第 k 条记忆"无关——同一条记忆无论库里有多少条，槽位永远相同。 */
  function stableSlot(id, capacity) {
    var f = (id * PHI_INV) % 1;
    if (f < 0) f += 1;
    return Math.min(capacity - 1, Math.floor(f * capacity));
  }

  /* 批量分配：撞槽时确定性顺移（id 升序处理，结果与插入顺序无关）。
   * 返回 Map(id -> slot)。调用方保证 capacity >= ids.length。 */
  function assignSlots(ids, capacity) {
    var sorted = ids.slice().sort(function (a, b) { return a - b; });
    var used = new Set();
    var out = new Map();
    for (var i = 0; i < sorted.length; i++) {
      var s = stableSlot(sorted[i], capacity);
      while (used.has(s)) s = (s + 1) % capacity;
      used.add(s);
      out.set(sorted[i], s);
    }
    return out;
  }

  /* ── STAGE1 ─────────────────────────────────────────────
   * 三级景深分层：以 start 为圆心做两层 BFS。
   * extra 是语义邻接（记忆→实体→星系中枢这类几何上没有连线的关系），
   * 形式 [[a, b], ...]，与几何边合并后再分层。
   * 返回 { l1: Set, l2: Set }，start 自身归入 l1 由调用方决定。 */
  function neighborLevels(nodeCount, edges, start, extra) {
    var adj = new Map();
    function link(a, b) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    }
    (edges || []).forEach(function (e) { link(e[0], e[1]); });
    (extra || []).forEach(function (e) { link(e[0], e[1]); });

    var l1 = new Set([start]);
    (adj.get(start) || new Set()).forEach(function (n) { l1.add(n); });
    var l2 = new Set();
    l1.forEach(function (n) {
      (adj.get(n) || new Set()).forEach(function (m) { if (!l1.has(m)) l2.add(m); });
    });
    return { l1: l1, l2: l2 };
  }

  /* ── STAGE2 ─────────────────────────────────────────────
   * 相机聚焦目标角：求 ry/rx 偏移量，使 rY(ry)·rX(rx) 把 p 转到正前方 (0,0,+|p|)。
   * 矩阵约定与 starfield.js 完全一致（列主序，先 rX 后 rY 作用到向量上）：
   *   世界变换 M = rY(ry)·rX(rx)，点 p 经过 M 后应落在 +z 轴。
   * 反解：先绕 y 轴把 p 的经度归零（x→0），再绕 x 轴把纬度抬到赤道面上方 +z。 */
  function cameraTarget(p) {
    var x = p[0], y = p[1], z = p[2];
    /* 先 rX 把 y 归零（z1 = √(y²+z²) 保持非负），再 rY 把 x 归零。
     * 顺序与 starfield 的 M = rY·rX 一致：向量先被 rX 作用。 */
    var rx = Math.atan2(y, z);
    var z1 = Math.sqrt(y * y + z * z);
    var ry = Math.atan2(-x, z1);
    return { ry: ry, rx: rx };
  }

  /* ── STAGE3 ─────────────────────────────────────────────
   * 脉冲逐级延迟：path 上第 i 跳的触发时刻（ms）。
   * 260ms 一跳：肉眼可分辨传播方向，又快到不像卡顿。 */
  function pulseOffsets(pathLen, stepMs) {
    var step = stepMs || 260;
    var out = [];
    for (var i = 0; i < pathLen; i++) out.push(i * step);
    return out;
  }

  return {
    PHI_INV: PHI_INV,
    stableSlot: stableSlot,
    assignSlots: assignSlots,
    neighborLevels: neighborLevels,
    cameraTarget: cameraTarget,
    pulseOffsets: pulseOffsets,
  };
});


