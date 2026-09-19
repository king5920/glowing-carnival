'use strict';
/* 星图按需渲染判定（ui/animgate.js）测试。
 * 锁死"什么时候必须继续画、什么时候可以停 GPU"，防止待机空转回潮或停在半帧。
 * C1 重构追加：共享调度器单 rAF 链、register/unregister、失焦暂停、idle 检测。 */
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

/* ══════════════════════════════════════════════════════════
   C1 共享调度器测试
   ══════════════════════════════════════════════════════════ */

// ── rAF mock ──
// 模拟 requestAnimationFrame / cancelAnimationFrame，用于 Node 环境测试。
// 关键：pending 数组代表"当前排队的 rAF 回调"，length 就是 rAF 链数。
const rAF = {
  pending: [],
  idCounter: 0,
  callCount: 0,
};

function setupRafMock() {
  rAF.pending = [];
  rAF.idCounter = 0;
  rAF.callCount = 0;
  global.requestAnimationFrame = function (cb) {
    rAF.callCount++;
    rAF.idCounter++;
    rAF.pending.push({ id: rAF.idCounter, cb: cb });
    return rAF.idCounter;
  };
  global.cancelAnimationFrame = function (id) {
    rAF.pending = rAF.pending.filter(function (p) { return p.id !== id; });
  };
}

function flushRaf() {
  const items = rAF.pending.slice();
  rAF.pending = [];
  const ts = Date.now();
  items.forEach(function (p) {
    try { p.cb(ts); } catch (e) { /* ignore draw errors in test */ }
  });
}

// ── DOM mock（page.init 需要）──
function setupDomMock() {
  if (!global.document) {
    global.document = { hidden: false, addEventListener: function () {} };
  }
  if (typeof global.addEventListener !== 'function') {
    global.addEventListener = function () {};
  }
  // 无条件重置：防止上一个用例的自定义 matchMedia（如 matches:true）泄漏到本用例
  global.matchMedia = function () { return { matches: false }; };
}

function resetAll() {
  setupRafMock();
  setupDomMock();
  G._testReset();
}

// ── 测试用例 ──

test('sharedLoop.start() 创建调度器但不排 rAF（无注册 draw 时）', () => {
  resetAll();
  G.sharedLoop.start();
  assert.strictEqual(G.sharedLoop.isRunning(), true);
  assert.strictEqual(rAF.pending.length, 0, '无 draw 不应排 rAF');
  G.sharedLoop.stop();
});

test('register() 添加 draw 回调并触发 rAF', () => {
  resetAll();
  const u = G.register(function () {});
  assert.strictEqual(G.registerCount(), 1);
  assert.strictEqual(rAF.pending.length, 1, '1 个 draw 应有 1 条 rAF 链');
  u();
  assert.strictEqual(G.registerCount(), 0);
  assert.strictEqual(rAF.pending.length, 0, '注销后不应有 rAF 链');
});

test('unregister() 移除 draw 回调', () => {
  resetAll();
  const fn = function () {};
  G.register(fn);
  assert.strictEqual(G.registerCount(), 1);
  G.unregister(fn);
  assert.strictEqual(G.registerCount(), 0);
  assert.strictEqual(rAF.pending.length, 0);
});

test('★ 多 register 共享一条 rAF 链（关键断言）', () => {
  resetAll();
  const u1 = G.register(function () {});
  const u2 = G.register(function () {});
  const u3 = G.register(function () {});
  assert.strictEqual(G.registerCount(), 3);
  assert.strictEqual(rAF.pending.length, 1, '3 个 draw 共享 1 条 rAF 链');

  // flush 一帧：调度器排下一帧
  flushRaf();
  assert.strictEqual(rAF.pending.length, 1, 'flush 后仍是 1 条 rAF 链');

  // 再 flush 几帧，确认链数始终为 1
  for (let i = 0; i < 5; i++) {
    flushRaf();
    assert.strictEqual(rAF.pending.length, 1, '第 ' + (i + 1) + ' 帧后 rAF 链数仍为 1');
  }
  u1(); u2(); u3();
});

test('draw 回调被调用并收到正确的参数', () => {
  resetAll();
  let called = 0, lastTs = null, lastInfo = null;
  G.register(function (ts, info) {
    called++;
    lastTs = ts;
    lastInfo = info;
  });
  flushRaf();
  assert.strictEqual(called, 1);
  assert.strictEqual(typeof lastTs, 'number');
  assert.ok(lastInfo, 'info 对象应存在');
  assert.strictEqual(typeof lastInfo.dt, 'number');
  assert.strictEqual(lastInfo.active, true);
  assert.strictEqual(typeof lastInfo.reduceMotion, 'boolean');
  flushRaf();
  flushRaf();
  assert.strictEqual(called, 3);
});

test('draw 返回 false → 自动注销', () => {
  resetAll();
  let called = 0;
  G.register(function () {
    called++;
    return false;   // 请求注销
  });
  flushRaf();
  assert.strictEqual(called, 1);
  assert.strictEqual(G.registerCount(), 0, '返回 false 后应自动注销');
  assert.strictEqual(rAF.pending.length, 0, '注销后不应有 rAF 链');
  // 再 flush 不应有回调
  flushRaf();
  assert.strictEqual(called, 1);
});

test('draw 返回 undefined → 继续调度', () => {
  resetAll();
  let called = 0;
  G.register(function () {
    called++;
    // 不返回值 → undefined → 继续
  });
  flushRaf();
  flushRaf();
  flushRaf();
  assert.strictEqual(called, 3);
  assert.strictEqual(G.registerCount(), 1);
});

test('失焦暂停影响所有注册的 draw', () => {
  resetAll();
  // 模拟页面失焦
  G.page.init();
  G.page._m.setFocused(false);

  let called1 = 0, called2 = 0;
  G.register(function () { called1++; });
  G.register(function () { called2++; });
  assert.strictEqual(rAF.pending.length, 0, '失焦下不应排 rAF');

  // 但 flush 后不应有任何 draw 被调用（tick 检查 page.active()）
  flushRaf();
  assert.strictEqual(called1, 0, '失焦时 draw 不应被调用');
  assert.strictEqual(called2, 0, '失焦时 draw 不应被调用');
  assert.strictEqual(rAF.pending.length, 0, '失焦时不应排下一帧');

  // 恢复聚焦 → page.onActive 复活调度器
  G.page._m.setFocused(true);
  assert.strictEqual(rAF.pending.length, 1, '恢复聚焦后应排 rAF');
  flushRaf();
  assert.strictEqual(called1, 1, '恢复聚焦后 draw 应被调用');
  assert.strictEqual(called2, 1);
});

test('reduced-motion 标志传给每个 draw', () => {
  resetAll();
  global.matchMedia = function (q) {
    if (q === '(prefers-reduced-motion: reduce)') return { matches: true };
    return { matches: false };
  };

  let rm1 = null, rm2 = null;
  G.register(function (ts, info) { rm1 = info.reduceMotion; });
  G.register(function (ts, info) { rm2 = info.reduceMotion; });
  flushRaf();
  assert.strictEqual(rm1, true, 'draw1 应收到 reduceMotion=true');
  assert.strictEqual(rm2, true, 'draw2 应收到 reduceMotion=true');
  // 恢复默认
  global.matchMedia = function () { return { matches: false }; };
});

test('idle 检测：所有 draw 注销后调度器停止', () => {
  resetAll();
  let called = 0;
  G.register(function () {
    called++;
    return false;   // 立即注销
  });
  assert.strictEqual(rAF.pending.length, 1);
  flushRaf();
  assert.strictEqual(called, 1);
  assert.strictEqual(G.registerCount(), 0);
  assert.strictEqual(rAF.pending.length, 0, '所有 draw 注销后 rAF 链应为 0');
});

test('idle 检测：新 register 唤醒已静默的调度器', () => {
  resetAll();
  // 注册一个 draw 然后注销 → 调度器静默
  const u1 = G.register(function () {});
  u1();
  assert.strictEqual(G.registerCount(), 0);
  assert.strictEqual(rAF.pending.length, 0, '调度器应静默');
  assert.strictEqual(G.sharedLoop.isRunning(), true, '调度器仍存活');

  // 新注册 → 调度器唤醒
  const u2 = G.register(function () {});
  assert.strictEqual(rAF.pending.length, 1, '新注册应唤醒调度器');
  u2();
});

test('start/stop 生命周期', () => {
  resetAll();
  assert.strictEqual(G.sharedLoop.isRunning(), false);

  G.sharedLoop.start();
  assert.strictEqual(G.sharedLoop.isRunning(), true);

  const u = G.register(function () {});
  assert.strictEqual(rAF.pending.length, 1);

  // stop 暂停调度器
  G.sharedLoop.stop();
  assert.strictEqual(G.sharedLoop.isRunning(), false);
  assert.strictEqual(rAF.pending.length, 0, 'stop 后应取消 rAF');

  // stop 后注册的 draw 自动唤醒调度器
  const u2 = G.register(function () {});
  assert.strictEqual(G.sharedLoop.isRunning(), true, '注册应唤醒已 stop 的调度器');
  assert.strictEqual(rAF.pending.length, 1);

  // 再次 stop
  G.sharedLoop.stop();
  assert.strictEqual(rAF.pending.length, 0);
  u(); u2();
});

test('gatedLoop 旧 API 适配层向后兼容', () => {
  resetAll();
  let called = 0;
  // 旧 API：gatedLoop(fn) → 自动适配为 register
  const u = G.gatedLoop(function () { called++; });
  assert.strictEqual(G.registerCount(), 1, 'gatedLoop 应注册 1 个 draw');
  assert.strictEqual(rAF.pending.length, 1, 'gatedLoop 共享 1 条 rAF 链');
  flushRaf();
  assert.strictEqual(called, 1);
  flushRaf();
  flushRaf();
  assert.strictEqual(called, 3);
  u();
  assert.strictEqual(G.registerCount(), 0);
});

test('gatedLoop stop 回调生效', () => {
  resetAll();
  let called = 0, shouldStop = false;
  G.gatedLoop(function () { called++; }, function () { return shouldStop; });
  flushRaf();
  assert.strictEqual(called, 1);
  shouldStop = true;
  flushRaf();
  assert.strictEqual(called, 1, 'stop 返回 true 后不应再调用');
  assert.strictEqual(G.registerCount(), 0, 'stop 后应自动注销');
});

test('gatedLoop 多调用共享一条 rAF 链', () => {
  resetAll();
  const u1 = G.gatedLoop(function () {});
  const u2 = G.gatedLoop(function () {});
  const u3 = G.gatedLoop(function () {});
  const u4 = G.gatedLoop(function () {});
  assert.strictEqual(G.registerCount(), 4);
  assert.strictEqual(rAF.pending.length, 1, '4 个 gatedLoop 共享 1 条 rAF 链');
  flushRaf();
  assert.strictEqual(rAF.pending.length, 1, 'flush 后仍 1 条');
  u1(); u2(); u3(); u4();
});

test('单个 draw 异常不阻断其余 draw', () => {
  resetAll();
  let ok1 = 0, ok2 = 0;
  G.register(function () { throw new Error('boom'); });
  G.register(function () { ok1++; });
  G.register(function () { ok2++; });
  // 捕获 console.error
  const origError = console.error;
  console.error = function () {};
  flushRaf();
  console.error = origError;
  assert.strictEqual(ok1, 1, '异常 draw 不影响其余 draw');
  assert.strictEqual(ok2, 1);
  assert.strictEqual(G.registerCount(), 3, '异常 draw 不会被自动注销');
});

test('registerCount() 返回注册表长度', () => {
  resetAll();
  assert.strictEqual(G.registerCount(), 0);
  const u1 = G.register(function () {});
  assert.strictEqual(G.registerCount(), 1);
  const u2 = G.register(function () {});
  assert.strictEqual(G.registerCount(), 2);
  u1();
  assert.strictEqual(G.registerCount(), 1);
  u2();
  assert.strictEqual(G.registerCount(), 0);
});

test('register 非函数抛 TypeError', () => {
  resetAll();
  assert.throws(function () { G.register('not a function'); }, TypeError);
  assert.throws(function () { G.register(null); }, TypeError);
  assert.throws(function () { G.register(42); }, TypeError);
});

test('sharedLoop.start() 幂等（重复调用不排多条 rAF）', () => {
  resetAll();
  G.sharedLoop.start();
  G.sharedLoop.start();
  G.sharedLoop.start();
  const u = G.register(function () {});
  assert.strictEqual(rAF.pending.length, 1, '多次 start 不应排多条 rAF');
  u();
  G.sharedLoop.stop();
});

test('stop 后 draw 不被调用，start 恢复', () => {
  resetAll();
  G.sharedLoop.start();
  let called = 0;
  const u = G.register(function () { called++; });
  flushRaf();
  assert.strictEqual(called, 1);

  // stop → 暂停
  G.sharedLoop.stop();
  // 即使 pending rAF 还在，tick 也应跳过
  if (rAF.pending.length > 0) {
    flushRaf();
    assert.strictEqual(called, 1, 'stop 后 draw 不应被调用');
  }

  // start → 恢复
  G.sharedLoop.start();
  assert.strictEqual(rAF.pending.length, 1);
  flushRaf();
  assert.strictEqual(called, 2);
  u();
});

test('page.reduceMotion() 在 Node 环境安全返回 false', () => {
  resetAll();
  // Node 环境无 matchMedia → 应返回 false
  assert.strictEqual(G.page.reduceMotion(), false);
});

test('页面隐藏（visibilitychange）暂停所有 draw', () => {
  resetAll();
  let hidden = false;
  G.page._m = G.createPageActivity(function () { return hidden; });
  G.sharedLoop.start();
  let called1 = 0, called2 = 0;
  G.register(function () { called1++; });
  G.register(function () { called2++; });

  // 隐藏
  hidden = true;
  G.page._m.visibilityChange();
  if (rAF.pending.length > 0) {
    flushRaf();
    assert.strictEqual(called1, 0, '隐藏时 draw 不应被调用');
    assert.strictEqual(called2, 0);
  }
  assert.strictEqual(rAF.pending.length, 0, '隐藏后不应排 rAF');

  // 显示
  hidden = false;
  G.page._m.visibilityChange();
  assert.strictEqual(rAF.pending.length, 1);
  flushRaf();
  assert.strictEqual(called1, 1);
  assert.strictEqual(called2, 1);
});

test('dt 计算正确（连续帧间时间差）', () => {
  resetAll();
  let dt1 = null, dt2 = null;
  let frameNum = 0;
  G.register(function (ts, info) {
    frameNum++;
    if (frameNum === 1) dt1 = info.dt;
    if (frameNum === 2) dt2 = info.dt;
  });
  flushRaf();
  // 第一帧 dt 应为默认值 0.016（lastTs 未初始化）
  assert.strictEqual(dt1, 0.016);
  flushRaf();
  // 第二帧 dt 应接近 0（同一毫秒内 flush）或 >0
  assert.strictEqual(typeof dt2, 'number');
  assert.ok(dt2 >= 0 && dt2 <= 0.05, 'dt 应在 [0, 0.05] 范围内');
});

test('全量回归：6 条旧 gatedLoop 调用 → 1 条 rAF 链', () => {
  resetAll();
  // 模拟旧的 6 条 gatedLoop（app.js ×4 + voicecore ×1 + 星图 ×1）
  const loops = [];
  for (let i = 0; i < 4; i++) {
    loops.push(G.gatedLoop(function () {}));
  }
  // voicecore 式 gatedLoop（带 stop 回调）
  loops.push(G.gatedLoop(function () {}, function () { return false; }));
  // 星图式 register（不通过 gatedLoop）
  loops.push(G.register(function () {}));
  assert.strictEqual(G.registerCount(), 6);
  assert.strictEqual(rAF.pending.length, 1, '6 个调用共享 1 条 rAF 链');

  // 跑 10 帧，确认链数始终为 1
  for (let i = 0; i < 10; i++) {
    flushRaf();
    assert.strictEqual(rAF.pending.length, 1, '第 ' + (i + 1) + ' 帧后 rAF 链数仍为 1');
  }

  // 全部注销
  loops.forEach(function (u) { u(); });
  assert.strictEqual(G.registerCount(), 0);
  assert.strictEqual(rAF.pending.length, 0);
});

console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
