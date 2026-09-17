'use strict';
/* 错误账本 / 自我进化（第①+②层）。
 * 原则：记账不能影响主流程；同类错误复发要累加而不是刷屏。 */

const assert = require('assert');
const db = require('./db');
const lessons = require('./tools/lessons');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  ✗ FAIL ' + name); console.log('    ' + e.message); }
}

/* 用唯一 scope，避免和真实数据/其他测试互相污染 */
const SCOPE = 'ut_lessons_' + Date.now();
function rec(name, err, extra) {
  return lessons.recordFailure(name, err, extra || {});
}
/* recordFailure 会给 scope 加 tool: 前缀，清理时必须带上，
 * 否则测试数据会永久污染真实账本（实测踩过）。 */
function clean() {
  db.db.prepare("DELETE FROM lessons WHERE scope LIKE 'tool:ut_lessons_%'").run();
}
clean();

test('同类错误复发累加 occurrence，不新增行', () => {
  const a = rec(SCOPE, '要20只返回1', { pattern: lessons.PATTERNS.EMPTY_AS_SUCCESS });
  const b = rec(SCOPE, '又短缺了', { pattern: lessons.PATTERNS.EMPTY_AS_SUCCESS });
  const c = rec(SCOPE, '第三次', { pattern: lessons.PATTERNS.EMPTY_AS_SUCCESS });
  assert.strictEqual(a.repeated, false, '第一次应是新增');
  assert.strictEqual(b.repeated, true, '第二次起应是复发');
  assert.strictEqual(c.repeated, true);
  const rows = db.lessonsFor('tool:' + SCOPE, 10);
  const target = rows.find(r => r.pattern === lessons.PATTERNS.EMPTY_AS_SUCCESS);
  assert(target, '找不到记录');
  assert.strictEqual(target.occurrence, 3, '次数应为 3，实际 ' + target.occurrence);
});

test('不同模式分别记录', () => {
  rec(SCOPE + '_b', 'socket hang up');
  rec(SCOPE + '_b', 'undefined is not a function');
  const rows = db.lessonsFor('tool:' + SCOPE + '_b', 10);
  const pats = new Set(rows.map(r => r.pattern));
  assert(pats.has(lessons.PATTERNS.NETWORK), '应分到网络类');
  assert(pats.has(lessons.PATTERNS.WRONG_SHAPE), '应分到猜结构类');
});

test('分类器：关键模式归类正确', () => {
  const C = lessons.classify;
  assert.strictEqual(C('要20给1'), lessons.PATTERNS.EMPTY_AS_SUCCESS, '数量短缺');
  assert.strictEqual(C('请求20条只返回1条'), lessons.PATTERNS.EMPTY_AS_SUCCESS);
  assert.strictEqual(C('Cannot read property x of undefined'), lessons.PATTERNS.WRONG_SHAPE);
  assert.strictEqual(C('socket hang up / 超时'), lessons.PATTERNS.NETWORK);
  assert.strictEqual(C('401 unauthorized'), lessons.PATTERNS.AUTH);
  /* 易混淆点：坏参数 JSON 必须是 BAD_ARGS 而不是 PARSE */
  assert.strictEqual(C('参数不是合法 JSON'), lessons.PATTERNS.BAD_ARGS);
  assert.strictEqual(C('某个没见过的奇怪错误xyz'), lessons.PATTERNS.UNKNOWN, '拿不准归 UNKNOWN，不许硬猜');
});

test('编造因果：状态变好时不许猜原因（2026-09-12 真实事故）', () => {
  /* ══ 事故经过 ══
   * 资金流告警消失后，模型回答：
   *   「当前健康检查显示没有任何数据源故障 (problems: 0)」
   *   「可能的解释：1. 资金流接口是间歇性故障，现在自愈了」
   *
   * 实际原因：我（开发者）几小时前改了健康统计口径，
   * 把"东财只给当日"从"故障"重新归类为"接口能力上限"。
   *
   * 模型看不到代码改动，却给出了一个听起来完全合理的因果。
   * 讽刺的是它在同一段话里写着"不能凭经验编造诊断细节冒充真实检查"。
   *
   * ══ 为什么这类错误必须单独设一类 ══
   * 报错会被发现；编造的因果会被当成结论采纳。
   * 用户会基于"它自愈了"决定不再排查 —— 而问题可能根本没解决。
   * 一个合理的猜测和一个查证过的结论，在用户那里长得一模一样。 */
  const C = lessons.classify;
  const P = lessons.PATTERNS.FABRICATED_CAUSE;

  /* 事故原句必须能被抓到 —— 第一版正则就漏了它，靠实测才发现 */
  assert.strictEqual(C('可能是间歇性故障，现在自愈了'), P, '事故原句必须命中');
  assert.strictEqual(C('应该是接口恢复正常了'), P);
  assert.strictEqual(C('大概是数据源变了'), P);
  assert.strictEqual(C('这个错误自己好了'), P);

  /* 不能误伤正常的不确定表述 —— 否则模型会连"可能"都不敢说 */
  assert.notStrictEqual(C('可能需要重试一次'), P, '正常的不确定表述不该命中');
  assert.notStrictEqual(C('请求超时'), P);
  assert.notStrictEqual(C('参数缺失'), P);

  /* guard 必须给出可执行的替代动作，而不是"别编造"这种空话 */
  const g = lessons.DEFAULT_GUARD[P];
  assert(g && g.length > 20, 'FABRICATED_CAUSE 必须有 guard');
  assert(/不知道|未查证|下一步|来源/.test(g), 'guard 要指明"承认不知道 + 给可查证动作"');
});

test('系统提示词必须写死"不许编造因果"', () => {
  /* 光有账本不够：账本只在工具调用前注入（hintFor 按 tool: 作用域），
   * 而编造因果发生在**解读结果**时，那条路径根本不经过工具提示。
   * 所以必须写进 SYSTEM_PROMPT —— 那是唯一对每次回答都生效的地方。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'server.js'), 'utf8');
  assert(/不许编造因果|不许编造/.test(src), 'SYSTEM_PROMPT 缺"不许编造因果"约束');
  assert(/不知道为什么变了|我不知道/.test(src), '必须明确给出"说不知道"这个允许的出口');
  assert(/看不到代码改动|口径调整/.test(src),
    '必须点明模型看不到代码/口径改动 —— 这是"自愈"结论几乎永远无依据的根本原因');
});

test('每条记录都带可执行的 guard，不只是"错了"', () => {
  /* 账本的价值在"下次怎么抓"，没有 guard 的教训是日记，不是进化。 */
  const rows = db.lessonsFor('tool:' + SCOPE, 10);
  assert(rows.length > 0, '应该有记录');
  rows.forEach(r => assert(r.guard && r.guard.length > 5, '缺少 guard: ' + r.pattern));
});

test('hintFor：有教训才提示，没有返回 null', () => {
  const h = lessons.hintFor(SCOPE);
  assert(h && h.includes('历史教训'), '应生成提示');
  assert(h.includes('已犯 3 次') || h.includes('自查'), '应体现复发次数或自查要求');
  const none = lessons.hintFor('never_used_scope_xyz_' + Date.now());
  assert.strictEqual(none, null, '没教训时必须返回 null，不注入废话');
});

test('overview：能统计模式分布和第③层候选', () => {
  const o = lessons.overview();
  assert(typeof o.total === 'number', '总数缺失');
  assert(o.patternCounts, '模式分布缺失');
  assert(Array.isArray(o.candidatesForTest), '候选测试列表缺失');
  /* 复发≥2 的应进入候选 */
  assert(o.candidatesForTest.some(x => x.scope === 'tool:' + SCOPE),
    '复发3次的错误应进入"建议固化测试"候选');
});

test('记账本身抛异常也不能影响调用方', () => {
  /* 第①层是旁路增强，绝不能反过来搞挂对话。
   * 传极端垃圾值验证它能兜底（不抛到外面）。 */
  let threw = false;
  try {
    lessons.recordFailure(null, null, { expected: null });
    const circle = {}; circle.self = circle;
    lessons.recordFailure(SCOPE + '_circ', circle);
  } catch (e) { threw = true; }
  assert.strictEqual(threw, false, '记账抛错不应泄漏到主流程');
  clean();   // 兜底记账可能写入的 circ 行也清掉
});

test('brain 已接线：工具失败会记账、并注入教训', () => {
  const src = require('fs').readFileSync(__dirname + '/brain.js', 'utf8');
  assert(/recordFailure/.test(src), 'brain 没在工具失败时记账');
  assert(/hintFor/.test(src), 'brain 没在重试前注入历史教训');
  /* 记账必须在失败分支里，不能对成功调用也记，否则全是噪音。
   * 不写脆弱的跨行正则，直接检查两个事实：
   *   1) recordFailure 出现在 isBenignCallerError 判断附近
   *   2) 存在 isBenignCallerError 函数定义 */
  assert(/if \(!tr\.ok && !isBenignCallerError/.test(src),
    'recordFailure 必须只在失败且非手误时调用');
  assert(/function isBenignCallerError/.test(src),
    '缺少 isBenignCallerError 定义');
  /* 调用方手误（不存在的代码）不该污染账本 */
  assert(/isBenignCallerError/.test(src), '缺少"调用方手误"过滤');
});

test('review_lessons 工具已注册', () => {
  const r = require('./tools/registry');
  const t = r.listForModel().map(x => x.function || x).find(x => x.name === 'review_lessons');
  assert(t, 'review_lessons 未注册');
});

test('空错误信息不记账（防止 unknown 垃圾行）', () => {
  const before = db.lessonCount();
  lessons.recordFailure('some_tool', '');
  lessons.recordFailure('some_tool', null);
  const after = db.lessonCount();
  assert.strictEqual(after, before, '空错误不应产生账本记录');
});

test('成功但可疑（warning）也要能进账本——这是最危险的一类', async () => {
  /* 贾维斯自己点破的设计缺口：只记 ok:false，那本项目最危险的
   * "要20给1"（ok:true 但数据残缺）反而记不进去。
   * 所以工具可在返回里带 warning 自首，brain 负责记账。
   *
   * 这里锁两件事：
   *  1) fundFlow 数量短缺时确实带 warning
   *  2) brain 接线了 result.warning 分支 */
  const ff = require('./tools/stock_fundflow');
  const r = await ff.fundFlow('603019', 20);
  if (r.shortfall) {
    /* 东财实测只给当日，这个分支应当成立 */
    assert(r.warning, '数量短缺时必须带 warning 自首，否则 ok:true 的残缺抓不到');
    assert.strictEqual(r.warning.pattern, lessons.PATTERNS.EMPTY_AS_SUCCESS);
    assert(r.warning.guard && r.warning.guard.length > 5, 'warning 必须带可执行 guard');
  }
  const brain = require('fs').readFileSync(__dirname + '/brain.js', 'utf8');
  assert(/result\.warning|tr\.result && tr\.result\.warning/.test(brain),
    'brain 没有处理工具成功但带 warning 的自首');
});

clean();
console.log(`\n通过: ${pass} | 失败: ${fail}`);
process.exit(fail ? 1 : 0);
