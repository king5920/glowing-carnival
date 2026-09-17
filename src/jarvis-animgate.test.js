'use strict';
/* 星图按需渲染判定（ui/animgate.js）测试。
 * 锁死"什么时候必须继续画、什么时候可以停 GPU"，防止待机空转回潮或停在半帧。 */
const assert = require('assert');
const G = require('../ui/animgate.js');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }

const idleCur = { spin:.1, pulse:.22, glow:.42, warm:.22, spread:1, flow:.04 };
const idleTgt = { ...idleCur };

test('待机、无强制帧、无高亮 → 停止（省电的核心）', () => {
  const act = new Float32Array([0.1, 0.2]);
  const base = [0.1, 0.2];
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, dragging:false, cur:idleCur, tgt:idleTgt,
    targetIsIdle:true, act, baseGlow:base }), false);
});

test('有强制帧（刚唤醒）→ 必画', () => {
  assert.strictEqual(G.shouldAnimate({ forceFrames:3, targetIsIdle:true, cur:idleCur, tgt:idleTgt }), true);
});

test('正在拖拽 → 必画', () => {
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, dragging:true, targetIsIdle:true, cur:idleCur, tgt:idleTgt }), true);
});

test('非待机目标（思考/说话）→ 持续画', () => {
  const tgt = { spin:1.15, glow:1.08 };
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, dragging:false, targetIsIdle:false,
    cur:idleCur, tgt }), true);
});

test('think→idle 亮度还在回落（参数未收敛）→ 继续', () => {
  const cur = { glow:0.9 };  // 离 idle 0.42 还很远
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, targetIsIdle:true, cur, tgt:idleTgt }), true);
});

test('参数只差一点点（<eps）→ 视为收敛，可停', () => {
  const cur = { ...idleTgt, glow: idleTgt.glow + 0.001 };
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, targetIsIdle:true, cur, tgt:idleTgt }), false);
});

test('有节点高亮未衰减到底光 → 继续（余光动画）', () => {
  const act = new Float32Array([0.1, 0.8]);
  const base = [0.1, 0.2];
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, targetIsIdle:true, cur:idleCur, tgt:idleTgt,
    act, baseGlow:base }), true);
});

test('act/baseGlow 长度不一致 → 不据此判定（避免脏数据误判），其余收敛则停', () => {
  const act = new Float32Array([0.9]);
  const base = [0.1, 0.2];
  assert.strictEqual(G.shouldAnimate({ forceFrames:0, targetIsIdle:true, cur:idleCur, tgt:idleTgt,
    act, baseGlow:base }), false);
});

/* scheduleNext：reduced-motion */
test('reduced-motion 下强制帧仍画', () => {
  assert.strictEqual(G.scheduleNext({ forceFrames:2, reduceMotion:true, targetIsIdle:false }), true);
});
test('reduced-motion 下强制帧耗尽 → 立刻停，绝不持续自转', () => {
  const tgt = { spin:1.15 };
  assert.strictEqual(G.scheduleNext({ forceFrames:0, reduceMotion:true, targetIsIdle:false,
    cur:tgt, tgt }), false);
});
test('正常偏好 + 非待机 → 继续', () => {
  const tgt = { glow:1 };
  assert.strictEqual(G.scheduleNext({ forceFrames:0, reduceMotion:false, targetIsIdle:false,
    cur:tgt, tgt }), true);
});

test('空输入安全', () => {
  assert.strictEqual(G.shouldAnimate(null), false);
  assert.strictEqual(G.scheduleNext(null), false);
});

/* ── isPageActive：页面是否"该画"的纯判定（§4 硬预算：失焦全暂停）── */
test('可见且聚焦 → 活跃', () => {
  assert.strictEqual(G.isPageActive({ hidden: false, focused: true }), true);
});
test('标签页隐藏 → 不活跃', () => {
  assert.strictEqual(G.isPageActive({ hidden: true, focused: true }), false);
});
test('窗口失焦 → 不活跃', () => {
  assert.strictEqual(G.isPageActive({ hidden: false, focused: false }), false);
});
test('空/缺字段输入按活跃处理（宽松默认，避免误停 GPU）', () => {
  assert.strictEqual(G.isPageActive(null), true);
  assert.strictEqual(G.isPageActive({}), true);
});

/* ── createPageActivity：只在 active 上升沿（停→跑）通知订阅者 ── */
test('初始活跃 → 订阅时立即回调一次', () => {
  const m = G.createPageActivity(() => false);
  let n = 0;
  m.onActive(() => n++);
  assert.strictEqual(m.active(), true);
  assert.strictEqual(n, 1);
});

test('可见但失焦 → 停；下降沿不回调（循环自己会在下一帧自查后停）', () => {
  const m = G.createPageActivity(() => false);
  let n = 0;
  m.onActive(() => n++); n = 0;                   // 清掉初始回调计数，只看之后的边沿
  assert.strictEqual(m.setFocused(false), false);
  assert.strictEqual(m.active(), false);
  assert.strictEqual(n, 0);
});

test('失焦后重新聚焦 → 恢复活跃并回调一次（被暂停的循环靠这一帧续起来）', () => {
  const m = G.createPageActivity(() => false);
  m.setFocused(false);
  let n = 0;
  m.onActive(() => n++);                           // 仍不活跃 → 订阅不触发
  assert.strictEqual(n, 0);
  assert.strictEqual(m.setFocused(true), true);
  assert.strictEqual(m.active(), true);
  assert.strictEqual(n, 1);
});

test('visibilitychange：隐藏 → 停；显示 → 恢复并回调', () => {
  let hidden = false;
  const m = G.createPageActivity(() => hidden);
  hidden = true;
  assert.strictEqual(m.visibilityChange(), false);
  let n = 0;
  m.onActive(() => n++);                           // 不活跃 → 不立即回调
  assert.strictEqual(n, 0);
  hidden = false;
  assert.strictEqual(m.visibilityChange(), true);
  assert.strictEqual(m.active(), true);
  assert.strictEqual(n, 1);
});

test('隐藏与失焦叠加 → 只恢复其中一路时仍不活跃，两路都恢复才激活', () => {
  let hidden = true;
  const m = G.createPageActivity(() => hidden);
  m.setFocused(false);
  assert.strictEqual(m.active(), false);
  hidden = false;
  assert.strictEqual(m.visibilityChange(), false); // 还失焦着
  assert.strictEqual(m.setFocused(true), true);    // 聚焦 → 激活
});

test('订阅者抛错 → 不阻断其它订阅者复活', () => {
  const m = G.createPageActivity(() => false);
  m.setFocused(false);
  let ok = 0;
  m.onActive(() => { throw new Error('boom'); });
  m.onActive(() => ok++);
  m.setFocused(true);
  assert.strictEqual(ok, 1);
});

test('onActive 返回的取消函数生效（退订后不再被复活）', () => {
  const m = G.createPageActivity(() => false);
  m.setFocused(false);
  let n = 0;
  const off = m.onActive(() => n++);
  off();
  m.setFocused(true);
  assert.strictEqual(n, 0);
});

test('createPageActivity 不传 getHidden → 按可见处理', () => {
  const m = G.createPageActivity();
  assert.strictEqual(m.active(), true);
  m.setFocused(false);
  assert.strictEqual(m.active(), false);
});

console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
