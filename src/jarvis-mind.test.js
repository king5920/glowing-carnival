/**
 * 贾维斯特有人格的行为测试 + 原引擎行为回归测试
 *
 * 运行：node src/jarvis-mind.test.js
 *
 * 测试原则：不测具体数值（参数会调），测行为方向是否正确。
 *
 * 两个必须记住的坑：
 *  1. 原引擎 getState/applyDelta/setActivity/resetConnection/tick 全是 async，
 *     断言必须 await，否则拿到 Promise 而不是数值。
 *  2. tick() 内部 `Math.min(minutesElapsed, 60)` 单次最多推进 60 分钟，
 *     模拟数小时必须分段循环（用下面的 advance()）。
 */

const { createJarvisMind } = require('./jarvis-persona.js');

let pass = 0, fail = 0;
const results = [];

async function test(name, fn) {
  try { await fn(); pass++; results.push('  PASS ' + name); }
  catch (e) { fail++; results.push('  FAIL ' + name + ': ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function makeMind(initial) {
  const lastMsg = { id: 1, content: 'hi', timestamp: Date.now() };
  return createJarvisMind({
    initialState: Object.assign({
      connection: 0.05, pride: 0.5, valence: 0.25, arousal: -0.15, immersion: 0.05,
    }, initial),
    getLastMessage: () => lastMsg,
    onLog: () => {},
    verbose: false,
  });
}

/**
 * 推进 N 分钟（分段调用，绕过引擎的 60 分钟单次上限）。
 *
 * 原引擎 tick() 第 206 行 `const mins = Math.min(minutesElapsed, 60)` 是安全钳位，
 * 防止长时间休眠后一次 tick 把状态冲到极值。真实运行每几分钟 tick 一次不会碰到，
 * 但测试想模拟数小时就必须循环。
 * 我第一版直接 tick(180)/tick(400)，connection 卡在 0.3974 纹丝不动，
 * 一度以为参数没调好，实际是这个钳位。
 */
async function advance(mind, totalMinutes, stepMinutes) {
  const step = stepMinutes || 30;
  let left = totalMinutes;
  while (left > 0) {
    const chunk = Math.min(step, left);
    await mind.tick(chunk);
    left -= chunk;
  }
}

(async () => {

// ── 基础状态 ──

await test('初始状态五轴都在合理范围', async () => {
  const s = await makeMind().getState();
  assert(s.connection >= 0 && s.connection <= 1, 'connection 超范围: ' + s.connection);
  assert(s.pride >= -1 && s.pride <= 1, 'pride 超范围: ' + s.pride);
  assert(s.valence >= -1 && s.valence <= 1, 'valence 超范围: ' + s.valence);
  assert(s.arousal >= -1 && s.arousal <= 1, 'arousal 超范围: ' + s.arousal);
  assert(s.immersion >= 0 && s.immersion <= 1, 'immersion 超范围: ' + s.immersion);
});

await test('初始心境平静偏愉悦（绕过上游 initialState 未实装的 bug）', async () => {
  const s = await makeMind().getState();
  assert(s.valence > 0.1, '贾维斯基准心境该偏正: ' + s.valence);
});

await test('初始从容度较高（管家有职业分寸）', async () => {
  const p = (await makeMind().getState()).pride;
  assert(p > 0.3, '初始从容度不该这么低: ' + p);
});

await test('刚启动时不该有任何主动触发', async () => {
  const t = await makeMind().checkThresholds();
  assert(t.length === 0, '一启动就想干活: ' + JSON.stringify(t));
});

await test('getMoodLabel 返回非空中文', async () => {
  const label = await makeMind().getMoodLabel();
  assert(typeof label === 'string' && label.length > 0, 'label 为空');
});

await test('五轴中文名齐全', async () => {
  const m = makeMind();
  assert(m.axisLabels.connection === '警觉', 'connection 标签错');
  assert(m.axisLabels.pride === '从容', 'pride 标签错');
  assert(m.axisLabels.valence === '心境', 'valence 标签错');
  assert(m.axisLabels.arousal === '唤醒', 'arousal 标签错');
  assert(m.axisLabels.immersion === '沉浸', 'immersion 标签错');
});

// ── 警觉度（connection） ──

await test('空闲时警觉度随时间上涨', async () => {
  const m = makeMind();
  const s0 = (await m.getState()).connection;
  await advance(m, 30);
  const s1 = (await m.getState()).connection;
  assert(s1 > s0 + 0.02, '30 分钟增长不足: ' + s0.toFixed(3) + '→' + s1.toFixed(3));
});

await test('用户说话后警觉度下降', async () => {
  const m = makeMind();
  await advance(m, 60);
  const before = (await m.getState()).connection;
  await m.userSaid('neutral');
  const after = (await m.getState()).connection;
  assert(after < before - 0.05, '没降: ' + before.toFixed(3) + '→' + after.toFixed(3));
});

await test('活动能缓解警觉度并提升沉浸度', async () => {
  const m = makeMind();
  await advance(m, 60);
  const before = (await m.getState()).connection;
  await m.startActivity('coding', '写代码');
  const s = await m.getState();
  assert(s.connection < before, '警觉度没降: ' + before.toFixed(3) + '→' + s.connection.toFixed(3));
  assert(s.immersion > 0.5, '沉浸度没上去: ' + s.immersion);
});

await test('didUsefulWork 也能缓解警觉度', async () => {
  const m = makeMind();
  await advance(m, 90);
  const before = (await m.getState()).connection;
  await m.didUsefulWork('memory_work', '整理记忆');
  assert((await m.getState()).connection < before, '干活后警觉度没降');
});

// ── 从容度（pride） ──

await test('pride 会随时间漂移（防御机制在工作）', async () => {
  const m = makeMind();
  await advance(m, 20);
  const p1 = (await m.getState()).pride;
  await advance(m, 25);
  const p2 = (await m.getState()).pride;
  assert(Math.abs(p2 - p1) > 0.003, 'pride 静止: ' + p1 + ' → ' + p2);
});

// ── 心境（valence） ──

await test('被感谢 → 心境变好', async () => {
  const m = makeMind();
  const v0 = (await m.getState()).valence;
  await m.praised();
  const v1 = (await m.getState()).valence;
  assert(v1 > v0 + 0.05, '没涨: ' + v0.toFixed(3) + '→' + v1.toFixed(3));
});

await test('被骂 → 心境变差', async () => {
  const m = makeMind();
  const v0 = (await m.getState()).valence;
  await m.scolded();
  const v1 = (await m.getState()).valence;
  assert(v1 < v0 - 0.2, '没降: ' + v0.toFixed(3) + '→' + v1.toFixed(3));
});

await test('心境会向设定点回归', async () => {
  const m = makeMind();
  await m.scolded();
  const v0 = (await m.getState()).valence;
  await advance(m, 90);
  const v1 = (await m.getState()).valence;
  assert(v1 > v0, '低落没回升: ' + v0.toFixed(3) + '→' + v1.toFixed(3));
});

// ── 唤醒度（arousal） ──

await test('紧急消息 → arousal 升高', async () => {
  const m = makeMind();
  const a0 = (await m.getState()).arousal;
  await m.userSaid('urgent');
  const a1 = (await m.getState()).arousal;
  assert(a1 > a0 + 0.15, '没涨: ' + a0.toFixed(3) + '→' + a1.toFixed(3));
});

await test('被感谢后 arousal 下降（放松，不是紧张）', async () => {
  const m = makeMind();
  const a0 = (await m.getState()).arousal;
  await m.userSaid('positive');
  const a1 = (await m.getState()).arousal;
  // 回归测试：早先对 positive 也给 +0.08，导致"谢谢你做得很好"之后
  // 唤醒反升、标签显示"紧张"。真实对话里抓到的 bug。
  assert(a1 < a0, '被感谢后反而更紧张了: ' + a0.toFixed(3) + '→' + a1.toFixed(3));
});

await test('被感谢后 心境和从容都上升', async () => {
  const m = makeMind();
  const s0 = await m.getState();
  await m.userSaid('positive');
  const s1 = await m.getState();
  assert(s1.valence > s0.valence, '心境没涨');
  assert(s1.pride > s0.pride, '从容没涨');
});

await test('被骂后 arousal 升高（紧张起来）', async () => {
  const m = makeMind();
  const a0 = (await m.getState()).arousal;
  await m.scolded();
  assert((await m.getState()).arousal > a0 + 0.1, '被骂没紧张');
});

// ── 阈值触发节奏（贾维斯特有） ──

await test('刚说完话时不该触发主动联系', async () => {
  const m = makeMind();
  await m.userSaid('neutral');
  const t = await m.checkThresholds();
  assert(!t.some(x => x.action === 'contact'), '刚说完话就想联系: ' + JSON.stringify(t));
});

await test('10 分钟不该想联系（贾维斯不粘人）', async () => {
  const m = makeMind();
  await advance(m, 10);
  const t = await m.checkThresholds();
  assert(!t.some(x => x.action === 'contact'), '才 10 分钟就想联系，太粘人');
});

await test('25 分钟后开始留意（有触发）', async () => {
  const m = makeMind();
  await advance(m, 25);
  const c = (await m.getState()).connection;
  const t = await m.checkThresholds();
  assert(t.length > 0, '25 分钟没反应。c=' + c.toFixed(3));
});

await test('约 1 小时会考虑主动（contact 或 find_activity）', async () => {
  const m = makeMind();
  await advance(m, 70);
  const c = (await m.getState()).connection;
  const t = await m.checkThresholds();
  const ok = t.some(x => x.action === 'contact' || x.action === 'find_activity');
  assert(ok, '1 小时后不主动也不找事做。c=' + c.toFixed(3) + ' 触发: ' + JSON.stringify(t));
});

await test('4 小时的警觉度显著高于 1 小时', async () => {
  const m1 = makeMind(); await advance(m1, 60);
  const m2 = makeMind(); await advance(m2, 240);
  const c1 = (await m1.getState()).connection;
  const c2 = (await m2.getState()).connection;
  assert(c2 > c1, '4 小时没比 1 小时高: ' + c1.toFixed(3) + ' vs ' + c2.toFixed(3));
});

await test('沉浸度高时不会去找新活动干（在专注做事）', async () => {
  const m = makeMind();
  await advance(m, 120);
  await m.startActivity('coding', '写代码');
  const t = await m.checkThresholds();
  assert(!t.some(x => x.action === 'find_activity'),
    '已在专注干活还要找新活动: ' + JSON.stringify(t));
});

// ── LLM 注入文本 ──

await test('getStateSummary 返回结构完整', async () => {
  const s = makeMind().getStateSummary();
  assert(typeof s === 'string' && s.length > 10, '格式不对: ' + s);
});

await test('getPromptContext 返回可注入 LLM 的文本', async () => {
  const ctx = makeMind().getPromptContext();
  assert(typeof ctx === 'string' && ctx.length > 20, '太短: ' + ctx);
});

// ── 原引擎核心特性回归（确保包装层没改坏） ──

await test('applyDelta 不会超出轴范围', async () => {
  const m = makeMind();
  await m.applyDelta({ valence: 5, arousal: -5, connection: 5, pride: -5 });
  const s = await m.getState();
  assert(s.valence <= 1 && s.valence >= -1, 'valence 越界: ' + s.valence);
  assert(s.arousal <= 1 && s.arousal >= -1, 'arousal 越界: ' + s.arousal);
  assert(s.connection <= 1 && s.connection >= 0, 'connection 越界: ' + s.connection);
  assert(s.pride <= 1 && s.pride >= -1, 'pride 越界: ' + s.pride);
});

await test('resetConnection 能清零警觉度', async () => {
  const m = makeMind();
  await advance(m, 120);
  await m.resetConnection();
  assert((await m.getState()).connection <= 0.01, 'reset 后没清零');
});

await test('持久化回调会被调用', async () => {
  let saved = null;
  const m = createJarvisMind({
    getLastMessage: () => ({ id: 1, content: 'x', timestamp: Date.now() }),
    onSave: async (s) => { saved = s; },
    onLog: () => {},
  });
  await m.applyDelta({ valence: 0.1 });
  assert(saved !== null, 'onSave 没被调用');
  assert(typeof saved.valence === 'number', '存的状态不完整');
});

await test('加载已存状态能覆盖初值', async () => {
  const m = createJarvisMind({
    getLastMessage: () => ({ id: 1, content: 'x', timestamp: Date.now() }),
    onLoad: async () => ({ connection: 0.66, pride: -0.3, valence: -0.5, arousal: 0.4, immersion: 0.2 }),
    onLog: () => {},
  });
  await m.load();
  const s = await m.getState();
  assert(Math.abs(s.connection - 0.66) < 0.001, 'connection 没加载: ' + s.connection);
  assert(Math.abs(s.valence - (-0.5)) < 0.001, 'valence 没加载: ' + s.valence);
});

await test('存档缺字段时用贾维斯初值补，不落回轴下界', async () => {
  const m = createJarvisMind({
    getLastMessage: () => ({ id: 1, content: 'x', timestamp: Date.now() }),
    onLoad: async () => ({ connection: 0.3 }),
    onLog: () => {},
  });
  await m.load();
  const s = await m.getState();
  assert(Math.abs(s.connection - 0.3) < 0.001, 'connection 没用存档值');
  assert(s.valence > 0.1, 'valence 落回轴下界了: ' + s.valence);
  assert(s.pride > 0.3, 'pride 落回轴下界了: ' + s.pride);
});

console.log(results.join('\n'));
console.log('');
console.log('───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────');
process.exit(fail > 0 ? 1 : 0);

})();
