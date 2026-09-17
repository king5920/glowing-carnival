'use strict';
/**
 * 星图增强（STARPLUS）纯逻辑测试
 *
 * 覆盖 DESIGN.md §10 五项增强里所有可数值验证的部分：
 *   STAGE5 稳定槽位   —— 位置只依赖 id，新增记忆不搬家
 *   STAGE1 三级景深   —— BFS 分层正确性 + 语义邻接并入
 *   STAGE2 相机聚焦   —— 目标角旋转后点落在 +z 轴
 *   STAGE3 事件脉冲   —— 逐级延迟单调递增
 *
 * 与 jarvis-starmap.test.js 的关系：原套件测拾取投影，本套件测增强逻辑，
 * 互不修改、互为回归基线。
 */

const assert = require('assert');
const SP = require('../ui/starplus');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

/* 与 starfield.js 完全一致的矩阵约定（列主序） */
function rY(a) { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }
function rX(a) { const c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; }
function mul(A, B) { const C = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0;
    for (let k = 0; k < 4; k++) s += A[k * 4 + j] * B[i * 4 + k]; C[i * 4 + j] = s; } return C; }
function xform(M, v) {
  return [M[0]*v[0]+M[4]*v[1]+M[8]*v[2], M[1]*v[0]+M[5]*v[1]+M[9]*v[2], M[2]*v[0]+M[6]*v[1]+M[10]*v[2]];
}

console.log('\n── STAGE5 稳定槽位 ──');

test('stableSlot 确定性：同一 id 永远同一槽', () => {
  for (const id of [1, 7, 42, 201, 999]) {
    assert.strictEqual(SP.stableSlot(id, 520), SP.stableSlot(id, 520));
  }
});

test('stableSlot 范围合法且不聚堆', () => {
  const seen = new Set();
  for (let id = 1; id <= 200; id++) {
    const s = SP.stableSlot(id, 520);
    assert(s >= 0 && s < 520, `槽位越界: ${s}`);
    seen.add(s);
  }
  // 黄金比例低差异序列：200 个 id 撞槽不应超过 15%
  assert(seen.size >= 170, `撞槽过多: 200 id 只占 ${seen.size} 槽`);
});

test('assignSlots 稳定性：新增 id 不移动既有 id 的槽位', () => {
  const base = [11, 23, 37, 51, 68];
  const m1 = SP.assignSlots(base, 100);
  const m2 = SP.assignSlots(base.concat([90]), 100);
  base.forEach(id => {
    assert.strictEqual(m1.get(id), m2.get(id), `id=${id} 的槽位被新成员挤动`);
  });
});

test('assignSlots 结果与插入顺序无关', () => {
  const a = SP.assignSlots([5, 3, 9, 1], 50);
  const b = SP.assignSlots([9, 1, 5, 3], 50);
  [1, 3, 5, 9].forEach(id => assert.strictEqual(a.get(id), b.get(id)));
});

test('assignSlots 无重叠', () => {
  const m = SP.assignSlots([1, 2, 3, 4, 5, 6, 7, 8], 8);
  assert.strictEqual(new Set(m.values()).size, 8);
});

console.log('\n── STAGE1 三级景深 ──');

test('neighborLevels：一度/二度分层正确', () => {
  // 0-1, 1-2, 2-3 链式 + 0-4
  const edges = [[0,1],[1,2],[2,3],[0,4]];
  const { l1, l2 } = SP.neighborLevels(5, edges, 0);
  assert(l1.has(0) && l1.has(1) && l1.has(4), '一度集合缺员');
  assert(!l1.has(2) && !l1.has(3), '一度集合越界');
  assert(l2.has(2), '二度应含 2');
  assert(!l2.has(3), '3 是三度，不应进二度集合');
});

test('neighborLevels：语义邻接并入分层', () => {
  // 几何上 0 孤立；语义上 0-9 相连
  const { l1 } = SP.neighborLevels(10, [], 0, [[0, 9]]);
  assert(l1.has(9), '语义邻居未并入一度集合');
});

test('neighborLevels：空图不崩', () => {
  const { l1, l2 } = SP.neighborLevels(3, [], 1);
  assert(l1.has(1) && l1.size === 1 && l2.size === 0);
});

console.log('\n── STAGE2 相机聚焦 ──');

test('cameraTarget：任意点旋转后落在 +z 轴（误差 < 1e-9）', () => {
  const pts = [[0.5,0.3,-0.4],[-0.9,0.1,0.2],[0.1,-0.8,0.5],[0.9,0.9,0.9],[0,0.9,0],[0.3,0,0.4],[-0.3,-0.5,-0.6]];
  for (const p of pts) {
    const t = SP.cameraTarget(p);
    const q = xform(mul(rY(t.ry), rX(t.rx)), p);
    const R = Math.hypot(...p);
    const err = Math.hypot(q[0], q[1]) + Math.abs(q[2] - R);
    assert(err < 1e-9, `点 ${p} 转后偏差 ${err}`);
  }
});

console.log('\n── STAGE3 事件脉冲 ──');

test('pulseOffsets：从零起步、等距递增', () => {
  const o = SP.pulseOffsets(4);
  assert.deepStrictEqual(o, [0, 260, 520, 780]);
});

test('pulseOffsets：自定义步长与空路径', () => {
  assert.deepStrictEqual(SP.pulseOffsets(3, 100), [0, 100, 200]);
  assert.deepStrictEqual(SP.pulseOffsets(0), []);
});

console.log(`\n通过: ${pass} | 失败: ${fail}`);
process.exit(fail ? 1 : 0);
