'use strict';
/**
 * 星图拾取数学（picking math）
 *
 * ══════ 为什么单独拆一个文件 ══════
 * 点击拾取最容易出的 bug 是「看起来能点，实际偏几十像素」——
 * 这种 bug 靠肉眼看不出来，只能靠数值验算。
 *
 * 但项目有「只允许 better-sqlite3 一个依赖」的硬约束，
 * 装 puppeteer/playwright 跑真实浏览器不可行。
 *
 * 所以把纯数学部分抽出来，做成浏览器和 Node 都能 require 的模块：
 *   - starfield.js 在浏览器里用它做实际拾取
 *   - jarvis-starmap.test.js 在 Node 里用它做数值验算
 *
 * 约束推动了更好的结构：这些函数本来就不该埋在 800 行渲染代码里。
 */

/* ── 4x4 矩阵（列主序，与 WebGL uniformMatrix4fv 一致）── */

/**
 * 4x4 矩阵乘法。
 *
 * 索引顺序必须和 starfield.js 的渲染代码**逐字一致**：
 *   s += A[k*4 + j] * B[i*4 + k]
 *
 * 我第一次写成了 `A[i*4+k] * B[k*4+j]`（教科书上的行主序写法），
 * 结果 VP[15] 算成 0 —— 平移分量丢了，相机距离没进矩阵，
 * 于是 40 个球面点里 35 个被判为"在相机背后"。
 *
 * 测试正是这样抓到它的：球面上的点不可能 87% 在相机背后。
 */
function mul(A, B) {
  const C = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + j] * B[i * 4 + k];
      C[i * 4 + j] = s;
    }
  }
  return C;
}

function persp(fovy, aspect, near, far) {
  const t = 1 / Math.tan(fovy / 2);
  return [t / aspect, 0, 0, 0,
          0, t, 0, 0,
          0, 0, (far + near) / (near - far), -1,
          0, 0, 2 * far * near / (near - far), 0];
}

function translate(x, y, z) {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
}
function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1];
}
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
}

/**
 * 构建与渲染循环完全一致的 MVP 矩阵。
 * 抽出来是为了让测试能复现渲染时的确切变换 ——
 * 如果测试自己另算一套矩阵，测的就不是真实行为。
 */
function buildVP(opts) {
  const { rx = 0, ry = 0, contentR = 1, aspect = 2.5, fovy = 1.0 } = opts || {};
  const fit = contentR / Math.tan(fovy / 2) * 1.18;
  let M = mul(rotY(ry), rotX(rx));
  M = mul(translate(0, 0, -fit), M);
  return mul(persp(fovy, aspect, 0.1, 20), M);
}

/**
 * 把世界坐标投影到 NDC。
 *
 * spread 必须传当帧的值：着色器里顶点坐标乘过 uSpread（呼吸动画），
 * 拾取时不乘同一个系数，点击位置会随呼吸整体偏移十几像素。
 * 实测 spread 0.90→1.15 时同一个点的屏幕 x 从 163.9 移到 147.7（差 16px）。
 *
 * @returns {{sx,sy,w}|null} null 表示在相机背后
 */
function project(p, VP, spread) {
  const sp = spread == null ? 1 : spread;
  const x = p[0] * sp, y = p[1] * sp, z = p[2] * sp;
  const cx = VP[0]*x + VP[4]*y + VP[8]*z  + VP[12];
  const cy = VP[1]*x + VP[5]*y + VP[9]*z  + VP[13];
  const cw = VP[3]*x + VP[7]*y + VP[11]*z + VP[15];
  if (cw <= 0.0001) return null;
  return { sx: cx / cw, sy: cy / cw, w: cw };
}

/** NDC → 画布像素 */
function ndcToPx(sx, sy, w, h) {
  return { px: (sx + 1) / 2 * w, py: (1 - sy) / 2 * h };
}
/** 画布像素 → NDC */
function pxToNdc(px, py, w, h) {
  return { ndcX: (px / w) * 2 - 1, ndcY: 1 - (py / h) * 2 };
}

/**
 * 命中半径（像素）。
 * 随节点大小和透视深度变化 —— 远处的点屏幕上更小，
 * 固定半径会导致远处几乎点不中。
 */
function hitRadiusPx(nodeSize, w) {
  return Math.max(7, (nodeSize || 1) * 3.2 / Math.max(0.3, w) * 2.2);
}

/**
 * 在屏幕空间找最接近点击位置的节点。
 *
 * 用 CPU 遍历而不是 GPU 拾取缓冲：节点只有几百个，一次遍历 <0.1ms，
 * 而 GPU 拾取要额外 framebuffer + readPixels（同步阻塞渲染管线）。
 * 这个规模上不值得。
 *
 * @param {Array} nodes 节点数组，每项 {p:[x,y,z], sz, kind, ...}
 * @param {number} px 画布内像素 x
 * @param {number} py 画布内像素 y
 * @param {object} ctx {VP, spread, width, height, kinds}
 * @returns {{index, dist, w}|null}
 */
function pickNode(nodes, px, py, ctx) {
  const { VP, spread = 1, width, height, kinds } = ctx;
  if (!VP || !nodes || !nodes.length) return null;
  const { ndcX, ndcY } = pxToNdc(px, py, width, height);
  const allow = kinds ? new Set(kinds) : null;

  let best = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    /* 只拾取真实数据节点。骨架填充点（corefill/filler）不对应任何记忆，
     * 让用户点到一个没有内容的占位点是纯粹的困惑。 */
    if (allow && !allow.has(n.kind)) continue;
    const pr = project(n.p, VP, spread);
    if (!pr) continue;
    const d = Math.hypot(
      (pr.sx - ndcX) * width / 2,
      (pr.sy - ndcY) * height / 2
    );
    if (d > hitRadiusPx(n.sz, pr.w)) continue;
    // 同样命中时取离相机更近的，避免选到被球体遮挡的背面点
    if (!best || pr.w < best.w - 0.05 ||
        (Math.abs(pr.w - best.w) <= 0.05 && d < best.dist)) {
      best = { index: i, dist: d, w: pr.w };
    }
  }
  return best;
}

const API = {
  mul, persp, translate, rotX, rotY, buildVP,
  project, ndcToPx, pxToNdc, hitRadiusPx, pickNode,
  worldPerPx, camShiftTarget,
};

/**
 * §6 抽屉联动：抽屉开时星图相机的横向偏移量（世界坐标）。
 *
 * 为什么抽到这里：偏移公式涉及透视投影（fit 距离处的 world/px 换算），
 * 和 buildVP/project 同一族数学；starfield.js 内联写死就没法在 Node 里验算，
 * 而"偏移错了"肉眼很难发现（看起来只是"好像歪了一点"）。
 *
 * @param {number} fit      相机距离（contentR / tan(fovY/2) * 余量）
 * @param {number} fovy     垂直视场角（弧度）
 * @param {number} height   画布高（px）
 * @returns {number} 每屏幕像素对应的世界坐标长度
 */
function worldPerPx(fit, fovy, height) {
  return 2 * fit * Math.tan(fovy / 2) / Math.max(1, height);
}

/**
 * 抽屉相机偏移目标值（世界坐标，带符号）。
 * @param {boolean} open     抽屉是否打开
 * @param {boolean} fromLeft 抽屉是否从左滑出
 * @param {number} wpp       worldPerPx() 的结果
 * @param {number} [shiftPx] 屏幕让位像素（默认 200 = 400px 抽屉的一半）
 * @returns {number} 右抽屉为负（场景左移）、左抽屉为正、关闭为 0
 */
function camShiftTarget(open, fromLeft, wpp, shiftPx) {
  if (!open) return 0;
  return (fromLeft ? 1 : -1) * (shiftPx == null ? 200 : shiftPx) * wpp;
}

/* 双环境导出：浏览器挂 window，Node 走 module.exports */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.PICKMATH = API;
