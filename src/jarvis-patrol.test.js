'use strict';
/**
 * Phase 5 模块测试 —— 会话扫描 / 待办提取 / 巡视判定
 *
 * 重点测**过滤逻辑**和**阈值判定**，因为这两块最容易悄悄回归：
 *   - 过滤挂了 → 周报里塞满 <environment_context> 垃圾
 *   - 阈值挂了 → 贾维斯每分钟弹一次「大盘涨了 0.1%」
 *
 * 网络类（大盘/板块）不放这里，靠手工实测（见 STATUS.md）。
 */

const assert = require('assert');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ══════════ 待办提取：信号词识别 ══════════ */

const te = require('./tools/todo_extract');

test('识别强信号"还没做"', () => {
  const hits = te.scanText('这个功能还没做，下周补上。');
  assert(hits.length === 1 && hits[0].weight === 2, JSON.stringify(hits));
});

test('识别强信号 TODO', () => {
  const hits = te.scanText('TODO: 把这段重构掉。');
  assert(hits.length >= 1 && hits[0].weight === 2, JSON.stringify(hits));
});

test('识别中信号"先这样"', () => {
  const hits = te.scanText('先这样吧，后面有空再优化。');
  assert(hits.length >= 1, JSON.stringify(hits));
  assert(hits.some(h => h.weight >= 1), JSON.stringify(hits));
});

test('"已完成"降权：同句有完成标记时权重下调', () => {
  const plain = te.scanText('这个功能还没做完。');
  const withDone = te.scanText('测试通过了，但还没做完文档。');
  assert(plain.length >= 1 && withDone.length >= 1, 'both should hit');
  assert(withDone[0].weight < plain[0].weight,
    `降权失效: plain=${plain[0].weight} withDone=${withDone[0].weight}`);
});

test('无信号词的句子不产生候选', () => {
  const hits = te.scanText('今天天气不错，代码跑得很顺。');
  assert(hits.length === 0, JSON.stringify(hits));
});

test('太短的句子被忽略', () => {
  const hits = te.scanText('待办');
  assert(hits.length === 0, JSON.stringify(hits));
});

/* ══════════ 待办提取：中断点（填充词 + 注入过滤）══════════ */

/** 造一个假会话 */
function mkSession(msgs, cwd = 'C:\\proj\\demo') {
  return {
    cwd, sourceName: 'Test', messageCount: msgs.length,
    messages: msgs.map(([role, text]) => ({ role, text, at: null })),
  };
}

test('中断点跳过填充词"继续"', () => {
  const s = mkSession([
    ['user', '把 InstancedMesh 版本的神经网络写出来，四层节点数不够'],
    ['assistant', '好，拓扑文件已落地，接下来重写 3D 核心。'],
    ['user', '继续'],
  ]);
  const { tail } = te.fromSession(s);
  assert(tail.lastUserRequest.includes('InstancedMesh'),
    '应该跳过"继续"找到真需求，实际: ' + tail.lastUserRequest);
  assert(tail.endedOnFiller === true, 'endedOnFiller 应为 true');
});

test('中断点跳过填充词"？？"', () => {
  const s = mkSession([
    ['user', '选股因子的第三道审计结论是什么'],
    ['assistant', '置换检验只有 mom20 和 m7_m14 幸存……'],
    ['user', '？？'],
  ]);
  const { tail } = te.fromSession(s);
  assert(tail.lastUserRequest.includes('审计'),
    '实际: ' + tail.lastUserRequest);
});

test('中断点过滤 <environment_context> 注入', () => {
  const s = mkSession([
    ['user', '帮我采集古籍知识库的有用信息'],
    ['assistant', '已修正目录判断错误。'],
    ['user', '<environment_context>\n<current_date>2026-09-03</current_date>\n<timezone>Asia/Shanghai</timezone>\n</environment_context>'],
  ]);
  const { tail } = te.fromSession(s);
  assert(tail.lastUserRequest.includes('古籍'),
    '应该跳过注入内容，实际: ' + String(tail.lastUserRequest).slice(0, 60));
});

test('中断点过滤 "# Files mentioned by the user" 注入', () => {
  const s = mkSession([
    ['user', '自媒体工作流还有什么缺陷'],
    ['assistant', '缺素材时会静默填空白，已修。'],
    ['user', '# Files mentioned by the user:\n## codex-clipboard-abc.png: C:/Temp/x.png'],
  ]);
  const { tail } = te.fromSession(s);
  assert(tail.lastUserRequest.includes('自媒体'),
    '实际: ' + String(tail.lastUserRequest).slice(0, 60));
});

test('候选提取跳过注入内容里的 TODO', () => {
  const s = mkSession([
    ['user', '<system-reminder>TODO: 这是系统注入的假待办</system-reminder>'],
    ['assistant', '收到。'],
  ]);
  const { candidates } = te.fromSession(s);
  assert(!candidates.some(c => c.text.includes('系统注入的假待办')),
    '注入内容里的 TODO 不应成为候选: ' + JSON.stringify(candidates.map(c => c.text)));
});

test('会话末尾的命中权重更高', () => {
  const msgs = [];
  for (let i = 0; i < 20; i++) msgs.push(['assistant', '中间某句话还没做完的事情 ' + i]);
  const s = mkSession(msgs);
  const { candidates } = te.fromSession(s);
  const tailHits = candidates.filter(c => c.position === 'tail' || c.position === 'last');
  const midHits = candidates.filter(c => c.position === 'middle');
  assert(tailHits.length > 0, '应该有 tail 命中');
  if (midHits.length) {
    assert(tailHits[0].weight > midHits[0].weight,
      `tail 应更高: tail=${tailHits[0].weight} mid=${midHits[0].weight}`);
  }
});

test('aggregate 按项目分组', () => {
  const e1 = { session: mkSession([['assistant', 'A 项目还没做完。']], 'C:\\a'), meta: { project: 'a' } };
  const e2 = { session: mkSession([['assistant', 'B 项目还没做完。']], 'C:\\b'), meta: { project: 'b' } };
  const groups = te.aggregate([e1, e2]);
  assert(groups.length === 2, '应有 2 个项目，实际 ' + groups.length);
  assert(groups.every(g => g.candidates.length >= 1), JSON.stringify(groups.map(g => g.candidateCount)));
});

/* ══════════ 会话扫描：白名单安全 ══════════ */

const al = require('./tools/agent_logs');

test('readSession 拒绝白名单外的路径', async () => {
  await assert.rejects(
    () => al.readSession('D:\\jarvis\\.env'),
    /白名单/,
    '应该拒绝读白名单外的文件'
  );
});

test('readSession 拒绝 ../ 越界', async () => {
  const os = require('os');
  const p = require('path').join(os.homedir(), '.claude', 'projects', '..', '..', '.ssh', 'id_rsa');
  await assert.rejects(() => al.readSession(p), /白名单|不存在/);
});

test('listSessions 返回结构完整', () => {
  const list = al.listSessions(3650);   // 拉长范围确保有数据
  if (!list.length) {
    console.log('       (本机无会话数据，跳过内容断言)');
    return;
  }
  const s = list[0];
  for (const k of ['source', 'sourceName', 'file', 'project', 'sizeKB', 'modified']) {
    assert(k in s, '缺字段 ' + k);
  }
});

/* ══════════ 巡视：阈值判定 ══════════ */

const patrol = require('./patrol');

test('阈值配置存在且合理', () => {
  const t = patrol.THRESHOLDS;
  assert(t.indexChangePct > 0 && t.indexChangePct <= 5, 'indexChangePct=' + t.indexChangePct);
  assert(t.indexDivergence > 0, 'indexDivergence=' + t.indexDivergence);
  assert(t.sectorChangePct > 0, 'sectorChangePct=' + t.sectorChangePct);
  assert(t.sectorBreadth > 0.5 && t.sectorBreadth < 1, 'sectorBreadth=' + t.sectorBreadth);
});

test('冷却时间分级正确（便宜的短、贵的长）', () => {
  const c = patrol.COOLDOWNS;
  assert(c.market_scan < c.session_scan, '大盘扫描应比会话扫描更频繁');
  assert(c.session_scan < c.memory_tidy, '会话扫描应比记忆整理更频繁');
  assert(c.memory_tidy < c.weekly_report, '记忆整理应比周报更频繁');
  assert(c.weekly_report >= 7 * 24 * 3600 * 1000, '周报冷却应至少 7 天');
});

test('cooldownStatus 返回每个任务的状态', () => {
  const s = patrol.cooldownStatus();
  for (const task of Object.keys(patrol.COOLDOWNS)) {
    assert(task in s, '缺任务 ' + task);
    assert('ready' in s[task] && 'cooldownMs' in s[task], JSON.stringify(s[task]));
  }
});

test('weeklyDue 只在周末为 true', () => {
  const d = new Date().getDay();
  const isWeekend = d === 0 || d === 6;
  const due = patrol.weeklyDue();
  if (!isWeekend) {
    assert(due === false, '非周末不应该 due');
  }
  // 周末时 due 取决于冷却，不强断言
});


/* ══════════ Obsidian：写入安全（最高优先级）══════════
 * 用户的库有 1264 文件 / 4.97GB 真实资产，写错地方无法挽回。
 * 这组测试比任何功能测试都重要。 */

const ob = require('./tools/obsidian');

const FORBIDDEN_PATHS = [
  ['绝对路径',        'D:\\evil.md'],
  ['../ 越界',        '../evil.md'],
  ['深层 ../',        '00-Inbox/../../evil.md'],
  ['附件目录',        '附件/x.md'],
  ['.obsidian 配置',  '.obsidian/app.json'],
  ['.workbuddy',      '.workbuddy/memory/x.md'],
  ['四书五经子库',    '四书五经/论语.md'],
  ['术数风水子库',    '术数风水/x.md'],
  ['安脱达资料',      '安脱达资料/x.md'],
  ['缠论量化',        '缠论量化/x.md'],
  ['股市悟道对话录',  '股市悟道对话录/x.md'],
  ['20-Areas',        '20-Areas/x.md'],
  ['30-Resources',    '30-Resources/x.md'],
  ['40-Archives',     '40-Archives/x.md'],
  ['90-MOC 枢纽',     '90-MOC/知识库总览.md'],
  ['99-演化日志',     '99-演化日志/本周浮现.md'],
  ['库根 AGENTS.md',  'AGENTS.md'],
  ['UNC 路径',        '\\\\server\\share\\x.md'],
];

for (const [label, p] of FORBIDDEN_PATHS) {
  test('Obsidian 拒绝写入: ' + label, () => {
    assert.throws(() => ob.resolveSafe(p), /受保护|只允许|越出|相对路径|不能为空/,
      '应该拒绝 ' + p);
  });
}

test('Obsidian 允许 00-Inbox', () => {
  const r = ob.resolveSafe('00-Inbox/test.md');
  assert(r.firstSeg === '00-Inbox', JSON.stringify(r));
});

test('Obsidian 允许 AI智能体工作记录', () => {
  const r = ob.resolveSafe('AI智能体工作记录/精华/x.md');
  assert(r.firstSeg === 'AI智能体工作记录', JSON.stringify(r));
});

test('Obsidian 同名文件自动改名不覆盖', () => {
  // 用库里真实存在的文件测
  const existing = '00-Inbox/2026-09-03 每日同步.md';
  const r = ob.createNote(existing, 'X', { dryRun: true });
  assert(r.renamed === true, '应该标记 renamed');
  assert(r.path !== existing.replace('/', '\\'), '路径应该变了: ' + r.path);
});

test('Obsidian appendBlock 要求文件已存在', () => {
  assert.throws(() => ob.appendBlock('00-Inbox/绝对不存在的文件xyz.md', 'x'),
    /不存在/);
});

test('Obsidian 白名单/黑名单常量完整', () => {
  assert(ob.WRITABLE.includes('00-Inbox'), 'WRITABLE 缺 00-Inbox');
  assert(ob.WRITABLE.length === 2, 'WRITABLE 应该只有 2 个: ' + ob.WRITABLE.join(','));
  for (const d of ['附件', '.obsidian', '四书五经']) {
    assert(ob.FORBIDDEN.includes(d), 'FORBIDDEN 缺 ' + d);
  }
});

/* ══════════ 数据源健康跟踪 ══════════ */

const sh = require('./tools/source_health');

test('健康跟踪：连续失败达阈值才标 degraded', () => {
  sh.reset('__test__');
  for (let i = 1; i < sh.DEGRADE_THRESHOLD; i++) {
    sh.record('__test__', false, '测试失败');
    assert(sh.health('__test__').degraded === false,
      `第 ${i} 次失败就 degraded 了，阈值应该是 ${sh.DEGRADE_THRESHOLD}`);
  }
  sh.record('__test__', false, '测试失败');
  assert(sh.health('__test__').degraded === true, '达到阈值应该 degraded');
  sh.reset('__test__');
});

test('健康跟踪：成功后清零', () => {
  sh.reset('__test__');
  for (let i = 0; i < 5; i++) sh.record('__test__', false, 'x');
  assert(sh.health('__test__').degraded === true);
  sh.record('__test__', true);
  const h = sh.health('__test__');
  assert(h.degraded === false, '成功后应该恢复');
  assert(h.consecutiveFailures === 0, '连续失败数应清零');
  sh.reset('__test__');
});

test('健康跟踪：返回 null 也算失败', async () => {
  sh.reset('__test__2');
  const wrapped = sh.track('__test__2', async () => null);
  await wrapped();
  assert(sh.health('__test__2').consecutiveFailures === 1,
    '返回 null 应该记为失败（sectors() 失败时就是返回 null）');
  sh.reset('__test__2');
});

test('健康跟踪：problems 只返回 degraded 的', () => {
  sh.reset('__test__3');
  sh.record('__test__3', true);
  assert(!sh.problems().some(p => p.source === '__test__3'), '健康的不该出现在 problems');
  sh.reset('__test__3');
});

test('资金流源标为 critical 且不许挂假备用源', () => {
  const s = sh.KNOWN_SOURCES['stock.fundflow'];
  assert(s, '应该有 stock.fundflow');
  assert(s.critical === true, '资金流是唯一来源，应该 critical');

  /* ══════ 这条断言被推翻过两次，记录完整过程 ══════
   *
   * v1: `s.alt === null` —— 意图对（不许挂腾讯）但实现过窄，
   *     它同时禁止了合法的 push2delay 镜像。
   *
   * v2: 按名单禁止 ['tencent','gtimg','sina','qq']，并要求 alt 必须含 eastmoney。
   *     依据是「资金流拆解是东财独家，新浪腾讯都没有」。
   *
   * v3（现在）: **v2 的事实前提有一半是错的。**
   *     实测（2026-09-09）新浪 MoneyFlow 接口：
   *       vip.stock.finance.sina.com.cn/.../MoneyFlow.ssl_qsfx_zjlrqs
   *       → 一次返回 30 天，字段 opendate/netamount/trade/turnover
   *     新浪**确实有资金流**，只是**没有四档拆分**（只有净额总数）。
   *
   *     而东财的致命短板是：fflow 系四个入口全部**只返回当日一行**
   *     （push2 / push2delay / daykline / datacenter，换三只票验证过）。
   *
   *     所以两个源是**能力互补，不是互相替代**：
   *       · 四档拆解（主力/大单/中单/小单）→ 只有东财
   *       · 多日趋势（判断是否持续流入）    → 只有新浪
   *
   * 结论：不能再用"alt 必须含 eastmoney"来锁，因为多日能力东财给不了。
   * 改成锁**能力**：禁止纯行情快照源（腾讯 gtimg 确实只有行情），
   * 允许真有资金流数据的源，并要求 note 里说清口径差异。 */
  const alt = s.alt || '';
  ['tencent', 'gtimg', 'qq'].forEach(bad =>
    assert(!new RegExp(bad, 'i').test(alt),
      `资金流 alt=${alt} 含 ${bad} —— 腾讯只有行情快照，没有任何资金流数据，是假备用源`));

  if (s.alt) {
    assert(/eastmoney|sina/i.test(s.alt),
      `资金流 alt=${s.alt} 不是已实测有资金流数据的源`);
    /* 挂了非东财源就必须说明口径差异，否则会被当成同口径混算 */
    if (!/eastmoney/i.test(s.alt)) {
      assert(/口径/.test(s.note || ''),
        `alt=${s.alt} 是非东财源，note 必须说明口径差异（四档 vs 净额总额）`);
    }
  }
});

/* ══════════ 飞书：未配置时的行为 ══════════ */

const feishu = require('./feishu');

test('飞书未配置时 status 给出下一步指引', () => {
  const s = feishu.status();
  assert(typeof s.configured === 'boolean');
  if (!s.configured) {
    assert(s.nextStep && s.nextStep.includes('open.feishu.cn'),
      '未配置时应该告诉用户去哪拿凭证');
  }
});

test('飞书未配置时 connect 不抛异常只返回错误', async () => {
  if (feishu.configured()) return;   // 已配置就跳过
  const r = await feishu.connect(() => null);
  assert(r.ok === false, '未配置应该返回 ok:false');
  assert(r.nextStep, '应该带 nextStep 指引');
});

/* ══════════ memory_tidy：记忆整理 ══════════
 * 这个模块补的是我自己留的空壳（COOLDOWNS 里有、runOne 里没实现）。
 * 阈值不是拍脑袋定的，是实测 190 个配对的相似度分布定的。 */

const mt = require('./tools/memory_tidy');
const db = require('./db');

test('记忆整理：阈值符合实测分布', () => {
  // 实测：#12/#16 相似度 0.876 是真重复；#3/#4 只有 0.742 但也是真重复
  // 所以 AUTO_MERGE 必须 <=0.876 才能抓到前者，ASK_MODEL_MIN 必须 <=0.742 才能抓到后者
  assert(mt.AUTO_MERGE <= 0.876, `AUTO_MERGE=${mt.AUTO_MERGE} 抓不到实测的 0.876 真重复`);
  assert(mt.ASK_MODEL_MIN <= 0.742, `ASK_MODEL_MIN=${mt.ASK_MODEL_MIN} 抓不到实测的 0.742 真重复`);
  assert(mt.ASK_MODEL_MIN < mt.AUTO_MERGE, '问模型区间必须低于自动合并区间');
  // 但不能太低，否则 0.67 的"不同侧面"记忆会被误判
  assert(mt.ASK_MODEL_MIN > 0.67, `ASK_MODEL_MIN=${mt.ASK_MODEL_MIN} 太低，会把不同侧面的记忆拖进判断`);
});

test('记忆整理：event 类半衰期最短，person 最长', () => {
  const h = mt.HALFLIFE_DAYS;
  assert(h.event < h.interest, 'event 应该忘得比 interest 快');
  assert(h.interest < h.project, 'interest 应该忘得比 project 快');
  assert(h.project < h.person, 'person 应该最不容易忘');
});

test('记忆整理：dryRun 不改动记忆库', async () => {
  const before = db.counts().memories;
  await mt.tidy({ dryRun: true, useModel: false });
  const after = db.counts().memories;
  assert(before === after, `dryRun 改了记忆数量 ${before} → ${after}`);
});

test('记忆整理：衰减只降不升，且有下限', () => {
  const changes = mt.decayWeights({ dryRun: true });
  for (const c of changes) {
    assert(c.to <= c.from, `#${c.id} 权重升了 ${c.from} → ${c.to}，衰减只能降`);
    assert(c.to >= 0.05, `#${c.id} 权重 ${c.to} 低于下限 0.05，会等于删除`);
  }
});

test('记忆整理：一天内的新记忆不衰减', () => {
  const changes = mt.decayWeights({ dryRun: true });
  for (const c of changes) {
    assert(c.ageDays >= 1, `#${c.id} 只有 ${c.ageDays} 天就被衰减了`);
  }
});

test('记忆整理：skipIds 能跳过指定记忆（防止给即将删除的记忆调权重）', () => {
  const all = mt.decayWeights({ dryRun: true });
  if (!all.length) return;                    // 没有可衰减的就跳过
  const victim = all[0].id;
  const filtered = mt.decayWeights({ dryRun: true, skipIds: new Set([victim]) });
  assert(!filtered.some(c => c.id === victim),
    `#${victim} 在 skipIds 里却仍被衰减 —— 这会导致"给已删除记忆改权重"的自相矛盾`);
});

test('记忆整理：findDuplicates 区分自动合并和待判断', () => {
  const r = mt.findDuplicates();
  assert(typeof r.total === 'number', '应该返回扫描总数');
  assert(Array.isArray(r.auto) && Array.isArray(r.needJudge));
  // auto 里的相似度必须都 >= AUTO_MERGE
  r.auto.forEach(p => assert(p.sim >= mt.AUTO_MERGE,
    `auto 里出现 sim=${p.sim} < AUTO_MERGE`));
  // needJudge 必须都在区间内
  r.needJudge.forEach(p => assert(p.sim >= mt.ASK_MODEL_MIN && p.sim < mt.AUTO_MERGE,
    `needJudge 里出现越界的 sim=${p.sim}`));
});

test('记忆整理：needJudge 有数量上限（控模型成本）', () => {
  const r = mt.findDuplicates();
  assert(r.needJudge.length <= 12, `needJudge ${r.needJudge.length} 条超过上限 12`);
});

/* ══════════ FTS 索引一致性（合并记忆后最容易出的 bug）══════════ */

test('FTS 索引与 memories 表一致，无孤立索引', () => {
  const all = db.allMemories();
  const idx = db.db.prepare('SELECT mem_id FROM mem_fts').all();
  const memIds = new Set(all.map(m => m.id));
  const orphans = idx.filter(r => !memIds.has(r.mem_id));
  assert(orphans.length === 0,
    `${orphans.length} 条孤立索引（记忆已删但索引还在）: ${orphans.map(o => '#' + o.mem_id).join(' ')}`);
});

test('FTS 索引无缺失，每条记忆都可搜', () => {
  const all = db.allMemories();
  const idx = db.db.prepare('SELECT mem_id FROM mem_fts').all();
  const idxIds = new Set(idx.map(r => r.mem_id));
  const missing = all.filter(m => !idxIds.has(m.id));
  assert(missing.length === 0,
    `${missing.length} 条记忆没有索引（搜不到）: ${missing.map(m => '#' + m.id).join(' ')}`);
});

test('ftsSearch 返回的 id 都能查到实体记忆', () => {
  for (const q of ['拿铁', '宁德时代', '量化', '老陈']) {
    const hits = db.ftsSearch(q, 10);
    for (const h of hits) {
      assert(db.memById(h.id), `搜"${q}"返回 #${h.id} 但 memById 查不到 —— 幽灵索引`);
    }
  }
});

/* ══════════ 周报自动触发接线 ══════════ */

test('patrol 导出全部四个任务函数', () => {
  for (const f of ['runOne', 'scanMarket', 'scanSessions', 'checkHealth', 'tidyMemory']) {
    assert(typeof patrol[f] === 'function', `patrol.${f} 缺失`);
  }
});

test('memory_tidy 在 COOLDOWNS 里且已真正实现', () => {
  assert(patrol.COOLDOWNS.memory_tidy > 0, 'COOLDOWNS 缺 memory_tidy');
  assert(typeof patrol.tidyMemory === 'function',
    'memory_tidy 在冷却表里却没有实现函数 —— 这就是之前的空壳问题');
});

test('memory_tidy 必须防链式合并（同一条记忆不能既保留又被删）', () => {
  /* ══ 实测记录：这个 bug 真实发生过 ══
   *
   * findDuplicates() 一次算出所有配对，然后逐对合并。
   * 不去重就会出现：
   *   配对 (39,43) → 保留 39
   *   配对 (32,39) → 删掉 39      ← 39 刚当过保留方
   *
   * 我在本机跑了一次 memory_tidy，实测后果：
   *   6 条记忆既当保留方又被淘汰（#18 #32 #12 #39 #69 #42）
   *   10 条合并记录的 kept_id 指向已删除的记忆
   *   mergeStats.total=30 但存活合并只有 20
   * 直接导致两条测试变红。
   *
   * 修法是一个跨阶段共享的 consumed 集合：
   * 任何记忆一旦参与合并，本轮不再碰。
   * 剩下的配对留到下一轮 —— 因为 A 吞 B 后内容已变，
   * 本轮算的相似度对新内容已经失效。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'memory_tidy.js'), 'utf8');

  assert(/const consumed = new Set\(\)/.test(src),
    'memory_tidy 没有 consumed 集合 —— 会产生链式合并和悬空记录');

  /* 两个合并阶段（相似度自动合并 / 模型判断合并）都必须检查 */
  const guards = src.match(/consumed\.has\(/g) || [];
  assert(guards.length >= 4,
    `consumed.has 只出现 ${guards.length} 次 —— 两个合并阶段各需检查 a 和 b（至少 4 次）`);

  const adds = src.match(/consumed\.add\(/g) || [];
  assert(adds.length >= 4,
    `consumed.add 只出现 ${adds.length} 次 —— 保留方和淘汰方都要记入（每阶段 2 次）`);

  /* consumed 必须在阶段 2 之前声明，才能被阶段 3 共享 */
  const declPos = src.indexOf('const consumed = new Set()');
  const modelPos = src.indexOf('中等相似度问模型');
  assert(declPos > 0 && modelPos > 0 && declPos < modelPos,
    'consumed 必须声明在模型判断阶段之前，否则两阶段之间仍会链式合并');
});

test('数据库里不应存在悬空合并记录', () => {
  /* kept_id 指向一条已不存在的记忆 = 链式合并留下的垃圾。
   * 这条测试直接查真实库，是上面那条的运行时对应。 */
  const db = require('./db');
  const ids = new Set(db.allMemories().map(m => m.id));
  const dangling = db.allMerges().filter(x => !ids.has(x.kept_id));
  assert(dangling.length === 0,
    `有 ${dangling.length} 条合并记录的 kept_id 指向已删除的记忆` +
    (dangling.length ? `（如 kept=${dangling[0].kept_id}）` : ''));
});

test('cooldownStatus 覆盖所有 COOLDOWNS 任务', () => {
  const cs = patrol.cooldownStatus();
  for (const k of Object.keys(patrol.COOLDOWNS)) {
    assert(cs[k], `cooldownStatus 缺 ${k}`);
    assert(typeof cs[k].ready === 'boolean', `${k}.ready 应该是 boolean`);
  }
});

/* ══════════ 飞书接入 ══════════
 * 凭证已配置并实测通过（token + 长连接 + 主动推送都成功），
 * 这里测的是不依赖网络的逻辑部分。 */

const fsh = require('./feishu');

test('飞书：配置已加载且字段完整', () => {
  assert(fsh.configured(), '飞书应已配置（.feishu.json 存在）');
  const c = fsh.loadConfig();
  assert(c.appId && c.appId.startsWith('cli_'), 'appId 格式应为 cli_xxx');
  assert(c.appSecret && c.appSecret.length >= 20, 'appSecret 长度异常');
  assert(c.ownerOpenId && c.ownerOpenId.startsWith('ou_'),
    'ownerOpenId 应为 ou_xxx，缺了就无法主动推送');
});

test('飞书：status 不泄露完整密钥', () => {
  const st = fsh.status();
  const json = JSON.stringify(st);
  const c = fsh.loadConfig();
  assert(!json.includes(c.appSecret),
    'status() 输出里出现了完整 appSecret —— 这会随日志/接口泄露');
  // appId 可以露（它不是秘密），但也应该截断显示
  assert(st.configured === true);
});

test('飞书：getConnectUrl 已导出（分步排查需要）', () => {
  assert(typeof fsh.getConnectUrl === 'function',
    'getConnectUrl 未导出，凭证对不对和长连接能不能建立就无法分开排查');
});

/* ══════════ 前向收益回填（第四优先的另一半）══════════ */

test('回填：必须绕开 sandbox 读取截断，否则会静默删历史', () => {
  /* ══ 一个会静默销毁几个月数据的 bug ══
   *
   * sandbox.read 有 MAX_READ_CHARS = 40000 截断（保护模型上下文，合理），
   * 并且**返回 truncated:true 但 content 已被 slice**。
   *
   * 第一版 calibration 直接用 sb.read + sb.write：
   * 实测造 25 天样本（156KB）只读回 10 天，
   * 而 backfill() 会拿读到的内容**整份重写文件** ——
   * 超出 40KB 的历史样本被**静默删除**，没有任何报错。
   * 攒两个月的数据可能一次回填就全没了。
   *
   * read 明明返回了 truncated 标志，我没读。
   * 又是「没看返回结构就用」这个今天反复犯的错误。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'calibration.js'), 'utf8');
  assert(/readRaw/.test(src) && /writeRaw/.test(src),
    '缺 readRaw/writeRaw —— 用 sb.read 会因 40000 字符截断而静默丢历史');
  assert(!/sb\.read\(SCAN_FILE\)/.test(src),
    'history/record 仍在用 sb.read(SCAN_FILE)，会截断');
  assert(!/sb\.write\(SCAN_FILE/.test(src),
    'backfill 仍在用 sb.write(SCAN_FILE)，配合截断读取会删数据');

  /* 运行时验证：写入超过 40000 字符仍能全量读回 */
  const cal = require('./tools/calibration');
  const fs = require('fs');
  const sb = require('./tools/sandbox');
  const abs = sb.safePath(cal.SCAN_FILE);
  const real = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  try {
    const lines = [];
    for (let i = 0; i < 60; i++) {
      lines.push(JSON.stringify({
        date: `2099-01-${String(1 + i).padStart(2, '0')}`,
        padding: 'x'.repeat(800), sectors: [],
      }));
    }
    const payload = lines.join('\n') + '\n';
    assert(payload.length > 40000, '测试数据本身没超过截断阈值，测不到问题');
    fs.writeFileSync(abs, payload, 'utf8');
    const back = cal.history();
    assert(back.length === 60,
      `写入 60 条只读回 ${back.length} 条 —— 截断又回来了`);
  } finally {
    if (real !== null) fs.writeFileSync(abs, real, 'utf8');
    else if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
});

test('回填：缺失的那天必须留 null，不能填 0', () => {
  /* 某板块某天没进前 30 名时，它的 level 是**未知**，不是"没涨"。
   * 填 0 会把"没记录"伪装成"零涨幅"，在回归里把均值往 0 拉 ——
   * 这是最恶劣的数据污染，而且看起来完全正常（有数字、无报错）。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'calibration.js'), 'utf8');
  assert(/数据缺失，不是 0 涨幅/.test(src),
    '没有说明缺失日必须留 null 的理由，后人可能改成填 0');
  const m = /if \(!Number\.isFinite\(later\)[\s\S]{0,400}?continue;/.exec(src);
  assert(m, '缺失 later 时没有 continue —— 可能被填成了 0');
});

test('回填：analyze 必须同时要求条数和独立天数', () => {
  /* 只看条数会被"板块×天"的乘法效应骗过：
   * 每天存 30 个板块，2 天就有 60 条，看起来样本很多，
   * 实际只有 2 天的市场环境。同一天的 30 个板块同涨同跌，
   * 高度相关，不是独立样本。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'calibration.js'), 'utf8');
  assert(/fwdDays/.test(src), '没统计回填覆盖的独立天数');
  assert(/MIN_FWD_DAYS/.test(src), '没有独立天数下限');
  assert(/高度相关|不算独立样本/.test(src),
    '没说明同一天多板块不算独立样本的理由');
});

test('回填：均值差异必须过效应量门槛，不能只比大小', () => {
  /* ══ 实测证据：均值比较会误报 ══
   * 造两组**漂移完全相同**的假数据（真值 = 门槛无用），
   * 结果主线组均值 +0.79% vs 情绪组 +0.43% ——
   * 纯噪声也能让均值分出高下。
   * 只比均值就会得出"硬门槛有效"的错误结论。
   * 加了效应量（|d|<0.2 视为噪声）后，正确报出"无实际区分力"。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'calibration.js'), 'utf8');
  assert(/effectSize/.test(src), '没算效应量');
  assert(/0\.2/.test(src), '没有效应量噪声阈值');
  assert(/无实际区分力/.test(src), '缺"无区分力"这个判词分支');
});

test('回填：已接入 patrol，且必须在 record 之后执行', () => {
  /* 顺序很关键：必须先把今天存进去，才能给之前的样本当参照物。
   * 顺序反了会永远差一天，最近那天的 d1 永远填不上。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  const fn = /async function runCloseScan\(\)[\s\S]*?\n}/.exec(src);
  assert(fn, '找不到 runCloseScan');
  assert(/cal\.backfill\(\)/.test(fn[0]), 'patrol 没调用 backfill');
  const iRec = fn[0].indexOf('cal.record(');
  const iBf = fn[0].indexOf('cal.backfill(');
  assert(iRec > 0 && iBf > iRec,
    'backfill 必须在 record 之后 —— 否则今天的点位来不及当参照物');
  const cal = require('./tools/calibration');
  assert(typeof cal.backfill === 'function', 'backfill 未导出');
});

test('回填：板块指数点位必须存下来（历史K线全部不可用）', () => {
  /* 实测板块历史K线三个域名全挂：
   *   push2his   /stock/kline/get?secid=90.BKxxxx → TCP 层被拦
   *   push2delay 同上                            → 返回 0 行
   *   push2      同上                            → TCP 层被拦
   * 龙头个股历史K线也是 0 行。
   * 所以回填**只能**靠每天存 level 再做差。
   * 少了这个字段，第四优先的回归永远做不了。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(/level: Number\(d\.f2\)/.test(src),
    'close_scan 没存板块指数点位 f2 —— 回填没有参照物');
  const cal = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'calibration.js'), 'utf8');
  assert(/level: s\.level/.test(cal), 'calibration 没把 level 存进样本');
});

/* ══════════ 用户 2026-09-09 提的四项优先修复 ══════════ */

test('第一优先：资金流数量短缺必须断言，不能静默成功', async () => {
  /* ══ 用户的原话 ══
   * 「我连续两次告诉你"只有一天"，第三次才拿到 20 日序列……
   *   这个不修，我会继续给你错的判断，而且我自己不知道错了。」
   *
   * ══ 但根因和用户/我最初的判断都不同，必须记清楚 ══
   * 用户提的修法是 `len(klines) > 0`。
   * **这条检查其实早就存在**（stock_fundflow.js 里 `if (!klines || !klines.length)`），
   * 而且它**根本拦不住这个 bug** —— 因为返回的不是空数组。
   *
   * 实测：请求 lmt=20，klines 长度 = 1。非空，所有旧检查全部通过。
   * 真正的根因是：**要 20 给 1，没有任何代码比较过 请求量 vs 返回量**。
   *
   * 「非空但远少于请求」比「空数组」隐蔽得多 —— 空数组显眼，
   * 数量短缺看起来完全正常。这才是那类"我自己不知道错了"的 bug。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/shortfall/.test(src), '缺数量短缺断言');
  assert(/requested/.test(src) && /received/.test(src),
    '返回值必须同时带 requested/received，否则调用方无法自查');

  const ff = require('./tools/stock_fundflow');
  const r = await ff.fundFlow('603019', 20);
  assert(r.requested === 20, `requested 应为 20，实际 ${r.requested}`);
  assert(typeof r.received === 'number', 'received 缺失');
  /* 东财只给当日，所以这里必然短缺 —— 必须被标出来 */
  if (r.received < 3) {
    assert(r.shortfall, `请求20只返回${r.received}却没标 shortfall —— 静默短缺又回来了`);
    assert(/只返回当日|备用源/.test(r.shortfall.reason || ''),
      'shortfall.reason 没说明原因和出路');
    assert(/⚠/.test(r.note), 'note 里没有醒目警告');
  }
});

test('第一优先：数量短缺必须显式暴露，且不能污染健康表', () => {
  /* ══ 这条断言 2026-09-11 改过目标，原因必须写清楚 ══
   *
   * 原版要求：短缺时 health.record(SOURCE, false)。
   * 出发点是对的 —— 「面板绿灯 + 用户拿到残缺数据」是 Phase 20
   * 那类"指标测的不是用户关心的东西"的翻版。
   *
   * 但用错了机制，实测后果更坏：
   *   东财 fflow **设计上就只给当日**（四个入口全试过）。
   *   于是每次调用都记一次失败 → 连续 36 次 → 永久降级，
   *   横幅"个股资金流拆解不可用，已持续 2.5 天"。
   *   而同一时刻 fundFlow('600519') 明明返回了当日真实数据，
   *   新浪备用源也正常给 10 天序列 —— 整条链路是通的。
   * 把"接口能力上限"记成"接口故障"，等于常年拉响假警报；
   * 真出故障时用户已经不看横幅了。这比绿灯骗人更危险。
   *
   * 所以职责重新划分，两条都必须成立：
   *   健康表 → 只回答"这个源现在还取不取得到数据"
   *   返回值 → 负责让调用方看见"数据全不全"（shortfall + warning + note）
   * 下面同时守住这两条。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');

  /* 1) 短缺事实必须出现在返回值里，不能只写日志 —— 这是原断言真正要保的东西 */
  assert(/shortfall,/.test(src), '返回值里必须带 shortfall 字段');
  assert(/warning:\s*shortfall/.test(src), '短缺时必须带 warning 自首');

  /* 2) 拿到当日数据就该记成功，不能因为"给不满多日"而记失败 */
  assert(/health\.record\(SOURCE,\s*true\);/.test(src),
    '取到当日数据必须记成功 —— 否则接口能力上限会被当成故障，永久降级');
  assert(!/数量短缺：请求/.test(src),
    '不应再把数量短缺写进健康表失败原因（会造成永久假降级）');

  /* 3) 真正的故障路径仍必须记失败，别把这条一起放水了 */
  assert(/health\.record\(SOURCE,\s*false,\s*'请求失败/.test(src),
    '网络失败仍必须记 false');
  assert(/health\.record\(SOURCE,\s*false,\s*'klines 解析后为空'\)/.test(src),
    '空数据仍必须记 false');
});

test('第二优先：板块必须分页抓全，不能只抓第一页', async () => {
  /* ══ 用户的原话 ══
   * 「现在 496 个板块只抓 196 个，中间三百个我看不见。
   *   今天这五个主线候选恰好都在涨幅前端所以能抓到，
   *   但如果某条线正在低位启动、涨幅排在中段，我会完全漏掉。」
   *
   * 实测比用户说的更糟：只抓了 **80 / 1000**（行业40+概念40）。
   *
   * 这个漏洞最恶劣的地方是**它只在关键时刻发作**：
   * 主线涨起来后排在前面，抓得到；主线低位吸筹时排在中段，抓不到。
   * 越是想早发现主线，它越会挡住你。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(/for \(let pn = 1/.test(src), '没有分页循环');
  assert(/coverage/.test(src), '没有覆盖率断言');

  const cs = require('./tools/close_scan');
  const rows = await cs.fetchSectorFlow('industry');

  /* 口径分两条，绝不混为一谈：
   *  - 东财直出：分页必须抓全（≥total 98% 且 >200），守"中段板块不漏"的原 bug；
   *  - 内部降级同花顺：必然只有约50个，此时不能再硬卡200（那是东财口径），
   *    但必须证明它诚实——source 标明、带 boardFallback、每条有真实涨跌幅，
   *    而不是把粗口径静默伪装成东财全覆盖。 */
  const degraded = rows[0] && rows[0].source === 'ths.board';
  if (degraded) {
    assert(rows.length >= 30, `同花顺行业只解析出 ${rows.length} 个，解析可能坏了`);
    assert(rows.every(r => typeof r.changePct === 'number'),
      '降级行必须带真实涨跌幅');
    assert(rows[0].boardFallback && /同花顺/.test(rows[0].boardFallback.note),
      '降级必须带 boardFallback 口径说明，不能伪装成东财全覆盖');
    assert(rows[0].complete === true, '同花顺自身这50个是抓全的，complete 应为 true');
  } else {
    const total = rows[0] && rows[0].total;
    if (total) {
      assert(rows.length >= total * 0.98,
        `只抓到 ${rows.length}/${total} —— 分页没抓全，中段板块会漏`);
    }
    assert(rows.length > 200,
      `行业板块只抓到 ${rows.length} 个，实测上游有 496 个`);
  }
});

test('第三优先：盘后调用必须校验数据时点', async () => {
  /* ══ 用户的原话 ══
   * 「你说"收盘了"，我拿到的是 11:00 的数据。
   *   应该在盘后调用时校验数据时间是否 ≥15:00，
   *   不匹配就明确提示，而不是等我自己发现。」
   *
   * 原则：不要让用户替你做校验。
   * 靠人眼比对两个时间戳，早晚会漏。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(/staleWarning/.test(src), '缺时点校验');
  assert(/afterClose/.test(src), '没判断是否盘后');

  const cs = require('./tools/close_scan');
  const r = await cs.scan({ topN: 3 });
  assert('staleWarning' in r, 'scan 返回里缺 staleWarning 字段');
  assert('afterClose' in r, 'scan 返回里缺 afterClose 字段');
  /* 若确实盘后且数据是盘中的，必须有警告；反之不该乱报 */
  if (r.afterClose && r.dataTime) {
    const hh = Number(String(r.dataTime).split(':')[0]);
    if (hh < 15) assert(r.staleWarning, `盘后拿到 ${r.dataTime} 的数据却没警告`);
    else assert(!r.staleWarning, `数据是 ${r.dataTime}（终盘）却误报警告`);
  }
  /* 警告必须出现在报告正文里，不能只在字段里 */
  if (r.staleWarning) {
    assert(cs.formatScan(r).includes(r.staleWarning),
      '警告没写进报告正文 —— 用户看报告时发现不了');
  }
});

test('第四优先：校准样本必须落盘，且样本不足时拒绝下结论', async () => {
  /* ══ 用户的原话 ══
   * 「"10日≥50亿"这个门槛是单日样本定的……
   *   每天扫完存一份到沙箱，攒够样本再回归。」
   *
   * 这补上了「过滤阈值必须来自实测样本」的空缺。
   * 关键是 analyze() 必须**在样本不足时明确拒绝出结论** ——
   * 「基于单次观测下结论」是我在语音那边犯过 5 次的错误，
   * 不能在这里用一个似是而非的数字重演。 */
  const cal = require('./tools/calibration');
  const h = cal.history();
  assert(Array.isArray(h), 'history() 应返回数组');

  const a = cal.analyze(20);
  assert(typeof a.ready === 'boolean', 'analyze 缺 ready 字段');
  if (h.length < 20) {
    assert(a.ready === false,
      `只有 ${h.length} 天样本却 ready=true —— 又在少量观测上下结论`);
    assert(/样本不足|不做/.test(a.verdict),
      `样本不足时 verdict 必须明确说不做结论：${a.verdict}`);
  }

  /* 记录里必须存判定当时的阈值和覆盖率，否则回归无法剔除脏样本 */
  if (h.length) {
    const r = h[h.length - 1];
    assert(r.thresholds, '没存判定当时的阈值 —— 改阈值后无法解释历史判定');
    assert('coverageComplete' in r, '没存覆盖率 —— 无法剔除抓不全那天的脏样本');
    assert('staleWarning' in r, '没存时点校验 —— 无法剔除盘中快照那天');
    assert(Array.isArray(r.sectors) && r.sectors.length > 12,
      `只存了 ${r.sectors && r.sectors.length} 个板块 —— `
      + '回归最需要看"被判体量不足的后来涨没涨"（假阴性），只存前12名全是高分板块');
    assert(r.sectors[0].forward, '没留 forward 占位，无法回填次日表现');
  }
});

/* ══════════ 收盘扫描：指数判时机 · 板块定方向 · 龙头选个股 ══════════ */

test('收盘扫描：主线判定必须有资金体量硬门槛', () => {
  /* ══ 第一版的错误，记录下来防止回退 ══
   *
   * 阈值最初把 MAINLINE_10D_YI 定在 30亿，实测 80 个板块里
   * **16 个被判"主线候选"（20%）** —— 主线不可能有 16 条。
   *
   * 更糟的是出现「航运港口：10日主力+9.4亿」却拿 83 分评上主线：
   * 因为加速/普涨/龙头涨停三项满分，加权盖过了体量不足。
   * 但主线的定义就是**钱多且持续**，龙头涨停而资金没进的是情绪盘。
   * 把它标成主线会直接误导仓位。
   *
   * 修法是把体量改成**一票否决**而不是加权项。 */
  const cs = require('./tools/close_scan');
  const th = cs.currentThresholds();
  assert(th.MAINLINE_10D_YI >= 50,
    `体量门槛 ${th.MAINLINE_10D_YI}亿 太低 —— 实测 30亿 会让 20% 板块变主线`);

  /* 构造一个"高分但体量不足"的板块：必须被拦住 */
  const emo = cs.scoreMainline({
    d10Yi: 9.4, d5Yi: 22.4, changePct: 2.81,
    upCount: 37, downCount: 0,
    leader: '海通发展', leaderPct: 9.98,
  });
  assert(emo.score >= 80, `这个样本应该是高分，实际 ${emo.score}`);
  assert(emo.grade !== '主线候选',
    `10日仅 9.4亿 却评为主线候选 —— 体量硬门槛失效了`);
  assert(/情绪驱动|体量不足/.test(emo.grade),
    `应明确标注情绪驱动，实际 grade=${emo.grade}`);

  /* 真正体量够的必须能评上 */
  const real = cs.scoreMainline({
    d10Yi: 140.6, d5Yi: 133.2, changePct: 2.73,
    upCount: 43, downCount: 5,
    leader: '依顿电子', leaderPct: 10,
  });
  assert(real.grade === '主线候选',
    `10日140.6亿+普涨+龙头涨停 应评主线候选，实际 ${real.grade}`);
});

test('收盘扫描：10日资金必须一次请求取得，不能依赖本地累积', () => {
  /* 个股 fflow 四个入口全部只给当日（见 stock_fundflow.js），
   * 我一开始以为板块也要自己按天攒。实测发现东财 clist
   * 同一请求就带 f164(5日)/f174(10日)，**零累积零等待**。
   *
   * 锁住这个字段：如果后人改成本地累积，
   * 用户要等 10 个交易日才能看到第一份完整扫描。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(/f174/.test(src), '缺 f174（10日主力净额）字段');
  assert(/f164/.test(src), '缺 f164（5日主力净额）字段');
  assert(/fid=f174/.test(src), '未按 10 日资金排序，取不到"近10日活跃"的板块');
});

test('收盘扫描：分级板块必须去重（航海装备Ⅱ/Ⅲ 是同一个）', () => {
  /* 实测东财按申万一二三级都建板块，
   * 「航海装备Ⅱ」和「航海装备Ⅲ」数据完全一致
   * （同为 +4.67%、今日8.6亿、10日19.5亿、龙头亚星锚链）。
   * 不去重的话前 10 名会被同一题材塞进两三条，挤掉真正不同的方向。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(/[ⅠⅡⅢⅣⅤ]/.test(src), '没有处理罗马数字分级板块的去重');
  assert(/mergedNames/.test(src), '去重后没保留被合并的板块名（无法追溯）');
});

test('收盘扫描：用户选了不推送，patrol 必须恒不报告', () => {
  /* 用户在飞书垃圾消息事故后明确选择：
   * 「先只在网页显示，等我看几天觉得靠谱再开推送」。
   * 这条必须锁死 —— 不能因为觉得"这个结果很重要"就自作主张推送。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  const fn = /async function runCloseScan\(\)[\s\S]*?\n}/.exec(src);
  assert(fn, '找不到 runCloseScan');
  assert(!/worthReporting:\s*true/.test(fn[0]),
    'runCloseScan 里出现 worthReporting:true —— 用户明确说了先不推送');
  assert(/worthReporting:\s*false/.test(fn[0]), '应显式写 worthReporting:false');
});

test('收盘扫描：只在交易日收盘后跑，周末不跑', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  assert(/isAfterClose/.test(src), '没有收盘时间窗判定');
  /* 必须限定 day 1-5，否则周末会重复跑出和周五一样的结果 */
  const m = /const isAfterClose\s*=\s*([^;]+);/.exec(src);
  assert(m, '找不到 isAfterClose 定义');
  assert(/day\s*>=\s*1/.test(m[1]) && /day\s*<=\s*5/.test(m[1]),
    `收盘扫描没限定交易日，周末会跑出重复结果: ${m[1]}`);
  assert(/hour\s*>=\s*15/.test(m[1]),
    `收盘扫描必须 15:00 之后才跑（盘中资金流还在变）: ${m[1]}`);
});

test('收盘扫描：已注册为模型工具且说明了硬门槛语义', () => {
  const r = require('./tools/registry');
  const t = r.listForModel().map(x => x.function || x).find(x => x.name === 'close_scan');
  assert(t, 'close_scan 未注册 —— 模型用不到');
  /* description 必须解释"情绪驱动"是什么意思，
   * 否则模型会把它和"主线候选"当成同一档 */
  assert(/情绪驱动|体量/.test(t.description),
    'description 没解释资金体量硬门槛，模型会误把情绪盘当主线');
});

test('收盘扫描：落盘失败不能被静默吞掉', async () => {
  /* ══ 实际踩到的坑 ══
   * 第一版写 category:'market'，但 memories 表有 CHECK 约束
   * category IN ('person','place','event','interest','project')。
   * 结果 addMemory 抛 CHECK constraint failed，
   * 而我的 catch 把错误吞了 → memId 恒 null，但扫描仍返回 ok:true。
   *
   * 这就是本项目反复强调的「看起来在工作但实际没连上」：
   * 表面全绿，实际每天的扫描结果一条都没存下来，
   * 而校准阈值恰恰依赖这些历史记录。
   *
   * 所以：错误必须冒泡到返回值里，且 category 必须合法。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  const fn = /async function runCloseScan\(\)[\s\S]*?\n}/.exec(src);
  assert(fn, '找不到 runCloseScan');
  assert(/memError/.test(fn[0]),
    '落盘错误被静默吞掉 —— 必须记进 memError 并返回，否则永远发现不了');
  assert(!/category:\s*'market'/.test(fn[0]),
    "category:'market' 违反 CHECK 约束（只允许 person/place/event/interest/project）");

  /* 运行时验证：真能落盘且能查回 */
  const p = require('./patrol');
  const db = require('./db');
  const r = await p.runCloseScan();
  if (r.ok) {
    assert(!r.memError, `落盘报错: ${r.memError}`);
    assert(r.memId, '扫描成功但没落盘 —— 历史记录缺失就无法校准阈值');
    const m = db.memById(r.memId);
    assert(m && /收盘扫描/.test(m.content), '落盘的记忆查不回来');
  }
});

test('收盘扫描：时间戳必须本地时区，且报告要自证数据时点', async () => {
  /* ══ 一个时区 bug 让整份报告可信度打折 ══
   *
   * 第一版 at 用 `new Date().toISOString()`，UTC 比北京时间早 8 小时。
   * 19:00 收盘后扫描，报告里显示 "10:59"。
   * 端到端测试时贾维斯直接在回答开头写了一整段：
   *   「扫描返回的时间戳是 10:59:55，不是收盘后……
   *     所以下面的板块资金和涨幅是上午盘中的，不是终盘数据」
   *
   * 数据其实完全正确（东财 f124 时间戳 = 15:39:32，确实是终盘），
   * 只是我的时间戳格式误导了模型。
   *
   * 双重修法：
   *   1. at 用本地时间
   *   2. 报告显式带上**行情数据自己的时点**（f124），不靠推断 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'close_scan.js'), 'utf8');
  assert(!/at:\s*new Date\(\)\.toISOString/.test(src),
    'at 用了 toISOString（UTC）—— 会显示成 8 小时前，模型会误判为盘中数据');
  assert(/f124/.test(src), '没取 f124 数据时点 —— 无法自证是不是收盘数据');

  const cs = require('./tools/close_scan');
  const r = await cs.scan({ topN: 3 });
  if (r.ok) {
    /* at 应该和本机当前小时一致（容差 1 小时，跨小时边界） */
    const nowH = new Date().getHours();
    const m = /\s(\d{1,2}):/.exec(r.at);
    assert(m, `at 格式无法解析小时: ${r.at}`);
    const atH = Number(m[1]);
    assert(Math.abs(atH - nowH) <= 1,
      `at 小时 ${atH} 与本机 ${nowH} 差太多 —— 时区又错了`);
    const text = cs.formatScan(r);
    assert(/数据时点/.test(text), '报告没写数据时点');
  }
});

/* ══════════ 推送去重（防止你关掉通知）══════════ */

test('推送：测试态绝不真发飞书（用户曾一天收到 100+ 条垃圾）', async () => {
  /* ══ 这是一个真实事故，不是假想风险 ══
   *
   * 2026-09-09 用户截图报告：飞书一天收到 100 多条
   * 「测试异动-1788947806320」「甲类异动1788947807813」这类消息。
   *
   * 根因就是下面那三条去重测试 —— 它们直接调 mind.pushToFeishu()，
   * 而该函数当时**没有任何测试保护**，一路打到真实飞书 API。
   * 我那天为验证别的改动跑了十几遍测试，每跑一次用户手机多 4 条。
   *
   * 危害等级高于"测试污染数据库"：污染的是**用户的注意力**，
   * 而且用户唯一的止损手段是关掉整个通知 —— 那样真异动也收不到了。
   *
   * 所以闸门必须存在，且必须在**去重之后**才短路，
   * 否则去重状态不更新，下面三条测试就形同虚设。 */
  const mind = require('./mind');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mind.js'), 'utf8');

  assert(/_isTestMode/.test(src), 'pushToFeishu 缺测试禁投递闸门');
  assert(/JARVIS_FEISHU_DRYRUN/.test(src), '闸门没有可显式控制的环境变量');

  /* 闸门必须在 feishu.send 之前 */
  const gatePos = src.indexOf('if (_isTestMode())');
  const sendPos = src.indexOf('await feishu.send(');
  assert(gatePos > 0 && sendPos > 0 && gatePos < sendPos,
    '闸门必须在 feishu.send 之前短路，否则照样会真发');

  /* 闸门必须在去重判断之后（否则去重不可测） */
  const dedupPos = src.indexOf('同类异动近期已推送');
  assert(dedupPos > 0 && dedupPos < gatePos,
    '闸门放在去重之前会让去重状态不更新，三条去重测试会变成假绿');

  /* 运行时验证：当前就是测试态，必须 dryRun 且未投递 */
  const r = await mind.pushToFeishu('闸门回归测试-' + Date.now(), false);
  assert(r.dryRun === true, `测试态应 dryRun，实际 ${JSON.stringify(r)}`);
  assert(r.delivered === false, '测试态不该标记为已投递');
});

test('推送去重：同内容一小时内只推一次', async () => {
  const mind = require('./mind');
  const uniq = '测试异动-' + Date.now();
  const r1 = await mind.pushToFeishu(uniq, false);
  const r2 = await mind.pushToFeishu(uniq, false);
  // 第一次可能因为网络失败，但第二次必须被去重拦住
  assert(r2.ok === false, '同内容重复推送没有被拦');
  assert(/近期已推送/.test(r2.reason || ''), `拦截原因异常: ${r2.reason}`);
});

test('推送去重：仅数字变化视为同类异动', async () => {
  const mind = require('./mind');
  const tag = 'X' + Date.now();
  await mind.pushToFeishu(`${tag} 板块涨 7.80%`, false);
  const r = await mind.pushToFeishu(`${tag} 板块涨 7.92%`, false);
  assert(r.ok === false,
    '涨幅从 7.80% 变成 7.92% 就重复推送 —— 盘中每次微变都会推，你会直接关通知');
});

test('推送去重：完全不同的内容不被误拦', async () => {
  const mind = require('./mind');
  const a = await mind.pushToFeishu('甲类异动' + Date.now(), false);
  const b = await mind.pushToFeishu('乙类完全不同的异动' + Date.now(), false);
  // 两条都是新内容，不应该互相拦截（除非撞到日上限）
  const blockedByDedup = (x) => x.ok === false && /近期已推送/.test(x.reason || '');
  assert(!blockedByDedup(b), '不同内容被误判为重复');
});

/* ══════════ brain.js：网页和飞书共用一条大脑 ══════════ */

test('brain 导出 think 且限制了工具轮次', () => {
  const brain = require('./brain');
  assert(typeof brain.think === 'function', 'brain.think 缺失');
  assert(brain.MAX_TOOL_ROUNDS > 0 && brain.MAX_TOOL_ROUNDS <= 10,
    `工具轮次上限 ${brain.MAX_TOOL_ROUNDS} 不合理，模型可能循环调用出不来`);
});

test('brain：飞书渠道会注入手机端格式提示', () => {
  /* 这条防的是"网页答得好、手机答得差"——
   * 两条链路必须共用 brain.think，只在输出格式上区分。 */
  const src = require('fs').readFileSync(require('path').join(__dirname, 'brain.js'), 'utf8');
  assert(src.includes("channel === 'feishu'"),
    'brain.js 里没有飞书渠道分支');
  assert(/300\s*字|不要用\s*Markdown\s*表格/.test(src),
    '飞书渠道没有长度或格式约束，手机上会挤成一团');
});

test('server.js 的 /api/chat 已改用 brain.think（不是两份实现）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert(src.includes('brain.think'), 'server.js 没有调用 brain.think');
  // 旧的内联实现标志：不该再出现在 server.js 里
  assert(!src.includes('const MAX_TOOL_ROUNDS = 5'),
    'server.js 里还留着内联的工具循环 —— 两份实现会漂移');
});

/* ══════════ 飞书帧解析（都是实测踩到的真 bug）══════════ */

test('飞书：extractEventJson 不被 protobuf 里的 0x7b 骗到', () => {
  /* 真实踩过的 bug：飞书帧的 protobuf 头里有一个字节等于 0x7b（'{'），
   * 原来用 raw.indexOf('{') 找 JSON 起点，切在了那个字节上，
   * 导致"飞书明明推了消息，程序完全没反应"。
   * 更坑的是日志前缀以 { 开头，很像 JSON，误导排查方向。 */
  const ex = fsh._extractEventJson;
  assert(typeof ex === 'function', '_extractEventJson 未导出，无法测试');

  const evt = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'e1', event_type: 'im.message.receive_v1' },
    event: { message: { message_id: 'om_1', chat_type: 'p2p', message_type: 'text',
                        content: JSON.stringify({ text: '今天大盘怎么样' }) },
             sender: { sender_id: { open_id: 'ou_x' } } },
  });
  // 前缀模拟真实 protobuf 头：第一个字节就是 0x7b
  const raw = '{\x0ainstance_id\x12@lcKX533EUmby\x2a\x0atype\x00event' + evt;

  // 先证明老方法确实会失败
  let oldFailed = false;
  try { JSON.parse(raw.slice(raw.indexOf('{'))); } catch { oldFailed = true; }
  assert(oldFailed, 'indexOf 方法居然成功了，说明这个测试构造不对');

  // 新方法必须成功
  const got = ex(raw);
  assert(got, 'extractEventJson 提取失败');
  assert(got.header.event_type === 'im.message.receive_v1', `事件类型错: ${got.header.event_type}`);
  const c = JSON.parse(got.event.message.content);
  assert(c.text === '今天大盘怎么样', `文本错: ${c.text}`);
});

test('飞书：消息文本含花括号不破坏 JSON 配对', () => {
  const ex = fsh._extractEventJson;
  const evt = JSON.stringify({
    schema: '2.0', header: { event_type: 'im.message.receive_v1' },
    event: { message: { content: JSON.stringify({ text: '代码 function(){ return {a:1}; }' }) } },
  });
  const got = ex('{\x0ajunk' + evt);
  assert(got, '提取失败');
  const c = JSON.parse(got.event.message.content);
  assert(c.text.includes('return {a:1}'), `文本被截断: ${c.text}`);
});

test('飞书：心跳帧返回 null 而不是报错', () => {
  const ex = fsh._extractEventJson;
  assert(ex('{\x0ainstance_id\x12@abc') === null, '心跳帧应返回 null');
});

test('飞书：protobuf 里偶然的合法 JSON 不被误认为事件', () => {
  const ex = fsh._extractEventJson;
  // {"a":1} 是合法 JSON 但没有 schema/event_type，不该被当成飞书事件
  assert(ex('xx{"a":1}yy') === null, '误把 {"a":1} 当成飞书事件');
});

test('飞书：event_id 去重（这是个花钱的 bug）', () => {
  /* 长连接没有 HTTP 的 200 应答，飞书靠重复投递保证不丢。
   * 实测发 2 条消息收到 3 帧。不去重的话每次重复都会：
   *   调一次模型（花钱）+ 跑一遍记忆抽取 + 重复执行工具。
   * 所以去重必须在调用大脑之前。 */
  const src = require('fs').readFileSync(require('path').join(__dirname, 'feishu.js'), 'utf8');
  assert(/_seenEvents/.test(src), 'feishu.js 里没有事件去重缓存');
  // 去重必须发生在 onMessage 之前
  const dedupPos = src.indexOf('_seenEvents.has');
  const callPos = src.indexOf('this.onMessage(ctx)');
  assert(dedupPos > 0 && callPos > 0, '找不到去重或调用位置');
  assert(dedupPos < callPos,
    '去重发生在调用大脑之后 —— 那就已经花过钱了，去重必须前置');
});

test('飞书：分片消息会被重组（continuation 帧）', () => {
  /* WebSocket 允许把一条消息拆成多帧：起始帧 fin=false，
   * 后续 opcode=0，末帧 fin=true。原来完全没处理 opcode 0，
   * 长消息的后半段被静默丢弃，整条消息解析失败。 */
  const src = require('fs').readFileSync(require('path').join(__dirname, 'feishu.js'), 'utf8');
  assert(/_fragBuf/.test(src), '没有分片重组缓冲');
  assert(/opcode === 0x0/.test(src), '没有处理 continuation 帧（opcode 0）');
  // 重连时必须清理残留分片
  const reconnectPart = src.slice(src.indexOf('重连'));
  assert(/_fragBuf = Buffer\.alloc\(0\)/.test(reconnectPart),
    '重连时没清理残留分片 —— 会污染新连接的第一条消息');
});

/* ══════════ 语音增强：连续对话 / 打断 / 噪声过滤 ══════════ */

function mkListener() {
  const voice = require('./voice');
  const evs = [];
  const L = new voice.Listener(e => evs.push(e));
  return {
    L, evs,
    fire(ev) { evs.length = 0; L._handle(ev); return evs.slice(); },
    wake() { L.closeConvo(); L.lastWakeAt = 0; return this.fire({ type: 'wake', text: '贾维斯', conf: 0.99 }); },
  };
}

test('唤醒词打开连续对话窗口', () => {
  const h = mkListener();
  assert(!h.L.inConvo(), '初始状态窗口就开着 —— 那等于常开麦');
  h.wake();
  assert(h.L.inConvo(), '唤醒后窗口没打开');
});

test('低置信度唤醒被挡且不开窗口', () => {
  /* ══ 这条测试原来写死 conf=0.5，因为当时阈值硬编码 0.90 ══
   *
   * 现在阈值按实测设备质量自适应（宽带0.85/中等0.45/窄带0.10/未探测0.30），
   * 0.5 在某些等级下是**合法唤醒**，写死数字会误报。
   *
   * 教训（这个项目里已经犯过一次）：
   * **测试要锁意图，不要锁"恰好满足意图的某个数值"。**
   * 意图是「明显低于当前阈值的唤醒必须被挡」——
   * 所以取当前生效阈值再往下压，而不是钉死 0.5。 */
  const micQuality = require('./mic_quality');
  const h = mkListener();
  const gate = micQuality.currentPolicy().wakeConf;
  const tooLow = Math.max(gate - 0.15, 0.001);
  const r = h.fire({ type: 'wake', text: '贾维斯', conf: tooLow });
  /* 2026-09-13 起，低置信 wake 在开了 whisper 兜底的设备上会送复核，
   * 而不是静默丢弃（修漏唤醒）。所以这里锁的是**意图**，不是"零事件"：
   *   ① 绝不能直接开窗；
   *   ② 绝不能直接当成功唤醒。
   * 复核是异步的，成功与否由 whisper 决定，且有节流/信号地板兜底。 */
  const woke = r.some(e => e.type === 'wake');
  assert(!woke, `conf=${tooLow} 低于阈值 ${gate} 竟直接当成唤醒`);
  assert(!h.L.inConvo(), '低置信度居然打开了对话窗口');
});

test('唤醒阈值必须自适应设备质量，不能写死', () => {
  /* 用户原话：**「语音交互不应该挑设备」**。
   *
   * 硬编码 WAKE_MIN_CONFIDENCE=0.90 在窄带设备上等于永久锁死唤醒 ——
   * 实测 HUAWEI USB-C 耳机上系统识别器对「贾维斯」只给 0.002-0.107，
   * 永远够不到 0.90。这条测试锁住"阈值来自策略而非常量"。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const handle = /_handle\(ev\)\s*\{[\s\S]*?if \(ev\.type === 'speech'\)/.exec(src);
  assert(handle, '找不到 _handle 的 wake 分支');
  assert(/micQuality\.currentPolicy\(\)/.test(handle[0]),
    'wake 判定没取自适应策略 —— 差设备会被永久锁死');
  assert(!/ev\.conf < WAKE_MIN_CONFIDENCE/.test(handle[0]),
    '还在用硬编码 WAKE_MIN_CONFIDENCE 判定 —— 这就是"挑设备"的根源');
});

test('降低阈值必须配二次确认，不能只做前者', () => {
  /* 窄带等级的 wakeConf 低到 0.10，单靠置信度几乎挡不住误触发。
   * 「降阈值」和「whisper 二次确认」是一对：
   * 只降阈值 = 电视声、旁人说话都能唤醒（既是隐私也是花钱问题）。 */
  const micQuality = require('./mic_quality');
  for (const [name, g] of Object.entries(micQuality.GRADES)) {
    if (g.wakeConf < 0.5) {
      assert(g.needWhisperConfirm === true,
        `等级 ${name} 阈值只有 ${g.wakeConf} 却没开 whisper 兜底 —— 会大量误触发`);
    }
  }
});

test('设备质量未探测时必须走保守策略', () => {
  /* 「假设设备好而实际差」会让功能静默失效 ——
   * 和「假备用源比没有备用源更危险」同一个道理。 */
  const micQuality = require('./mic_quality');
  const u = micQuality.GRADES.unknown;
  assert(u.needWhisperConfirm === true,
    '未探测时没开 whisper 兜底 —— 等于假设设备是好的');
  assert(u.wakeConf < micQuality.GRADES.wideband.wakeConf,
    '未探测时的阈值不该和宽带一样高');
});

test('连续对话：窗口内说话直接当指令，不用再喊唤醒词', () => {
  /* 这是调研 eadmin2/jarvis_ai 后补的核心体验。
   * 之前每说一句都要重新喊"贾维斯"。 */
  const h = mkListener();
  h.wake();
  const r = h.fire({ type: 'speech', text: '看一下大盘', conf: 0.72 });
  assert(r.some(x => x.type === 'speech' && x.convo === true),
    '窗口内的话没被当成指令 —— 连续对话失效');
});

test('窗口外的语音必须丢弃（误触发就是花钱）', () => {
  /* 听写语法是自由文本，房间里所有中文都会被识别。
   * 窗口外不拦的话，电视声/旁人对话会直接发给模型 ——
   * 既是隐私问题，也是每次都产生模型调用费用。 */
  const h = mkListener();
  h.L.closeConvo();
  const r = h.fire({ type: 'speech', text: '今天天气不错', conf: 0.85 });
  assert(r.length === 0,
    '窗口外的语音被处理了 —— 会造成误触发和意外费用');
});

test('每次交互都续期，连续对话不会中途断掉', () => {
  const h = mkListener();
  h.wake();
  const t1 = h.L.convoUntil;
  h.fire({ type: 'speech', text: '第一个问题', conf: 0.7 });
  assert(h.L.convoUntil >= t1, '没续期 —— 追问第二句时会掉出窗口');
});

test('说「结束」立刻关闭对话窗口', () => {
  const h = mkListener();
  h.wake();
  const r = h.fire({ type: 'speech', text: '结束', conf: 0.9 });
  assert(r.some(x => x.type === 'convo_end'), '没发 convo_end 事件');
  assert(!h.L.inConvo(), '说了结束但窗口还开着');
});

test('打断：interrupt 必须排在 wake 之前', () => {
  /* 顺序错了就会出问题：喇叭还在响时先处理 wake，
   * 麦克风会收到贾维斯自己的声音 → 自问自答。 */
  const h = mkListener();
  h.L.setSpeaking(true);
  h.L.closeConvo(); h.L.lastWakeAt = 0;
  const r = h.fire({ type: 'wake', text: '贾维斯', conf: 0.99 });
  const iPos = r.findIndex(x => x.type === 'interrupt');
  const wPos = r.findIndex(x => x.type === 'wake');
  assert(iPos >= 0, '朗读中被唤醒却没发 interrupt');
  assert(iPos < wPos, 'interrupt 排在 wake 之后 —— 喇叭还在响会导致自问自答');
});

test('打断：朗读中直接说话也能截住（完整 barge-in）', () => {
  const h = mkListener();
  h.wake();
  h.L.setSpeaking(true);
  const r = h.fire({ type: 'speech', text: '停一下', conf: 0.8 });
  assert(r.some(x => x.type === 'interrupt'),
    '只有唤醒词能打断 —— 说话截不住它，体验仍然是"必须等它说完"');
});

test('噪声过滤：单字语气词不发给模型', () => {
  const h = mkListener();
  h.wake();
  const r = h.fire({ type: 'speech', text: '嗯', conf: 0.95 });
  assert(!r.some(x => x.type === 'speech'),
    '"嗯"被当成指令了 —— 语气词和键盘声都会这样触发模型调用');
});

test('噪声过滤：低置信度不上报模型（whisper 兜底关闭时才显示"没听清"）', () => {
  /* 不是完全丢弃 —— 界面显示"没听清"比毫无反应好，让用户知道麦克风活着。
   * 但绝不发给模型。
   *
   * 2026-09-11 起：needWhisperConfirm 在所有设备等级都为 true（血的教训，
   * 见 mic_quality.js），所以低置信默认走 whisper 异步复核，不再同步产生
   * speech_unclear。这条用例显式把兜底关掉，锁"没有 whisper 时"的旧契约：
   * 上报没听清、但不发给模型。 */
  const micQuality = require('./mic_quality');
  const orig = micQuality.currentPolicy;
  micQuality.currentPolicy = () => ({ wakeConf: 0.3, needWhisperConfirm: false, grade: 'wideband' });
  try {
    const h = mkListener();
    h.wake();
    const r = h.fire({ type: 'speech', text: '哗啦哗啦', conf: 0.2 });
    assert(r.some(x => x.type === 'speech_unclear'), '没上报 speech_unclear');
    assert(!r.some(x => x.type === 'speech'), '低置信度语音被发给模型了');
  } finally {
    micQuality.currentPolicy = orig;
  }
});

test('VAD 参数已设置且比默认值更宽容', () => {
  /* ⚠ 这条测试记录一次我的判断错误：
   * 我以为默认 EndSilenceTimeout"太迟钝"想调快，
   * 实测打印默认值发现是 **0.15 秒**，比我要设的 0.6 秒快 4 倍。
   * 真正的问题是太快 —— 0.15 秒静音就判定讲完，
   * 中文句子里的自然停顿会被切成两句。 */
  const voice = require('./voice');
  assert(voice.VAD_END_SILENCE_SEC > 0.15,
    `EndSilenceTimeout=${voice.VAD_END_SILENCE_SEC} 不大于默认 0.15 秒，`
    + '中文自然停顿会被切断');
  assert(voice.VAD_END_SILENCE_SEC <= 1.5,
    '静音等待太长，说完要等很久才提交');

  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  assert(/\$r\.EndSilenceTimeout\s*=/.test(src), 'PowerShell 脚本里没设 EndSilenceTimeout');
  assert(/\$r\.BabbleTimeout\s*=/.test(src), 'PowerShell 脚本里没设 BabbleTimeout');
});

test('生成的 PowerShell 脚本不含中文（会让 Grammar 返回 null）', () => {
  /* 实测踩过的坑：脚本里加一行中文注释，
   * New-Object Grammar(path) 就返回 null，删掉立刻正常。
   * 全角标点会破坏 PowerShell 解析。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  // 取所有反引号模板里的 PowerShell 脚本
  const scripts = [...src.matchAll(/const script = `([\s\S]*?)`;/g)].map(m => m[1]);
  assert(scripts.length > 0, '找不到 PowerShell 脚本模板');
  scripts.forEach((s, i) => {
    const han = s.match(/[\u4e00-\u9fa5]/g);
    assert(!han, `第 ${i + 1} 段 PowerShell 脚本含中文 [${han && han.slice(0, 6).join('')}] —— `
      + '实测会让 Grammar 加载返回 null');
  });
});

test('TTS 路由不能被 speaking 路由前缀吞掉', () => {
  /* 实测踩到的前缀冲突：
   * startsWith('/api/voice/speak') 会把 /api/voice/speaking 也匹配上，
   * 当成缺 text 参数的 TTS 请求返回 400。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'server.js'), 'utf8');
  assert(!/url\.startsWith\('\/api\/voice\/speak'\)/.test(src),
    "还在用 startsWith('/api/voice/speak') —— 会吞掉 /api/voice/speaking 返回 400");
  assert(/'\/api\/voice\/speaking'/.test(src) || /voice\/speaking/.test(src),
    '没有 speaking 路由 —— 打断功能拿不到朗读状态，等于死代码');
});

test('前端必须上报朗读状态，否则打断是死代码', () => {
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert(/voice\/speaking\?on=/.test(app),
    '前端没调 /api/voice/speaking —— 服务端不知道在朗读，判定不出打断');
  assert(/voice_interrupt/.test(app),
    '前端没监听 voice_interrupt 事件 —— 打断了也不会停播');
});

test('前端不能再用 awake 拦住连续对话', () => {
  /* 门禁已上移到服务端。前端如果还要求 awake，
   * 连续对话就失效了（唤醒处理完 awake 就被清掉）。 */
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  const idx = app.indexOf("addEventListener('voice_speech'");
  assert(idx > 0, '找不到 voice_speech 处理');
  const body = app.slice(idx, idx + 900);
  assert(/d\.convo\s*!==\s*true/.test(body),
    '前端没有信任服务端的 convo 标记 —— 连续对话会被前端的 awake 拦掉');
});

test('语音主循环必须用 Wait-Event，绝不能用 Start-Sleep', () => {
  /* ══ 这是让语音功能从未真正工作的那一行 ══
   * 原代码结尾 `while ($true) { Start-Sleep -Milliseconds 250 }`
   * 阻塞 PowerShell 消息泵，而 SpeechRecognitionEngine 靠它接收音频回调。
   *
   * 实测铁证（同一份代码、只改主循环）：
   *   while(1){ Start-Sleep }  ->  AudioLevelUpdated = 0    （音频完全不进来）
   *   Wait-Event 循环          ->  AudioLevelUpdated = 62-94 （正常）
   *
   * 之前"验证通过"只验证了进程活着、ready 收到了 ——
   * 从没验证过音频真的进来。「进程在跑」不等于「功能在工作」。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const scripts = [...src.matchAll(/const script = `([\s\S]*?)`;/g)].map(m => m[1]);
  const listen = scripts.find(s => /RecognizeAsync/.test(s));
  assert(listen, '找不到监听脚本');
  assert(!/while\s*\(\$true\)\s*\{\s*Start-Sleep/.test(listen),
    'while($true){Start-Sleep} 阻塞消息泵 —— 音频永远进不来，语音等于没有');
  assert(/Wait-Event/.test(listen),
    '主循环没用 Wait-Event —— 消息泵不转，收不到音频');
});

test('语音脚本必须主动清理事件队列', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const scripts = [...src.matchAll(/const script = `([\s\S]*?)`;/g)].map(m => m[1]);
  const listen = scripts.find(s => /RecognizeAsync/.test(s));
  assert(/Remove-Event/.test(listen),
    '取了事件不删 —— 队列无限增长，常听跑一天会 OOM');
});

test('前端麦克风开关必须持久化（否则刷新页面就假开）', () => {
  /* ══ 实测 bug：用户报「喊了贾维斯但不能唤醒」══
   * 前端 `let micOn = false` 写死，刷新后：
   *   前端 micOn=false → 不建 SSE；后端 _forceOn=true → 还占着麦克风
   * 最坑的组合：系统提示"麦克风正在使用中"，
   * 唤醒词也识别了、事件也发了，**但没人接收**。 */
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert(/localStorage\.getItem\('jarvis_mic'\)/.test(app),
    'micOn 没从 localStorage 恢复 —— 刷新后前端不连 SSE');
  assert(/localStorage\.setItem\('jarvis_mic'/.test(app),
    '切换麦克风时没写 localStorage');
  assert(/if \(micOn\) \{[\s\S]{0,240}connectVoice\(\)/.test(app),
    '恢复了 micOn 却没重连 SSE —— 按钮显示"开着"但事件流没建立，等于假开');
});

test('前端有状态漂移自检', () => {
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  assert(/d\.voice\s*&&\s*d\.voice\.listening\s*&&\s*!voiceES/.test(app),
    '没有状态对账 —— 后端在听、前端没连时无人发现');
});

test('前端唤醒窗口必须和服务端对齐', () => {
  /* 原来前端 8 秒、服务端 30 秒：服务端还开着窗口，
   * 前端按钮已变灰，用户以为要重新喊，于是重复喊反而更乱。 */
  const voice = require('./voice');
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  const m = /const AWAKE_WINDOW_MS = (\d+)/.exec(app);
  assert(m, '找不到 AWAKE_WINDOW_MS');
  assert(Number(m[1]) === voice.CONVO_WINDOW_MS,
    `前端 ${m[1]}ms 与服务端 ${voice.CONVO_WINDOW_MS}ms 不一致 —— 按钮提前变灰会误导用户`);
});

test('状态提示文案不能有叠字或语义错乱', () => {
  /* ══ 用户截图里发现的 bug ══
   * 界面显示「贾维斯正在没听清……」。
   *
   * 根因：showDoing() 无条件拼 '贾维斯正在' + label + '…'，
   * 而各调用点传进来的 label 风格不一致，拼出来五花八门：
   *   '在听…'            → 贾维斯正在在听……   （叠字）
   *   '没听清…'          → 贾维斯正在没听清…   （截图里就是这个）
   *   '对话结束'         → 贾维斯正在对话结束… （语义反了）
   *   '正在恢复语音监听…' → 贾维斯正在正在恢复… （叠字）
   * 六个调用点里只有巡视那一处恰好通顺。
   *
   * 自动拼前缀这种"贴心"设计，调用点一多就必然失控。
   * 改成由调用点给完整句子 —— 看得见即所得。 */
  const app = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');

  /* ⚠ 必须先剥注释再检查 ——
   * 这条测试第一版直接扫全文，结果匹配到了 app.js 里
   * 用来解释这个 bug 的注释示例代码，自己把自己判成失败。
   * 检查代码的测试，要先把注释排除掉。 */
  const code = app
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '');      // 行注释

  assert(!/'贾维斯正在'\s*\+\s*label/.test(code),
    'showDoing 又在自动拼前缀 —— 调用点风格不一致时必然拼出叠字或语义错乱');

  // 逐个检查调用点的最终文案
  const calls = [...code.matchAll(/showDoing\((['`])([^'`]*)\1\)/g)].map(m => m[2]);
  assert(calls.length >= 4, `只找到 ${calls.length} 个字面量调用点，检查是否漏了`);
  calls.forEach(text => {
    assert(!/正在正在|在听在听|正在在听/.test(text), `文案叠字：「${text}」`);
    assert(!/正在(没听清|对话结束|结束)/.test(text),
      `语义错乱：「${text}」—— "正在"接完成态动词读不通`);
  });
});

/* ══════════ 麦克风音量自愈 ══════════ */

const micVol = require('./mic_volume');

test('音量模块：阈值合理', () => {
  /* ══ 这个模块的存在是本项目最贵的一课 ══
   * 用户报「喊了贾维斯不能唤醒」，我查了三轮，
   * 期间得出过两个错误结论（"麦克风输出削波垃圾"、"华为APO吞音频"），
   * 真因简单到离谱：**麦克风输入音量 = 0%（-96dB 数字静音）**。
   *
   * 一个数字解释了所有现象：
   *   waveIn 采到 peak=1、引擎报 AudioState=Silence、
   *   而 WAV 直接喂识别器却有 conf=0.995（绕过了音量）。 */
  assert(micVol.TARGET_SCALAR > 0.7 && micVol.TARGET_SCALAR <= 1.0,
    `目标音量 ${micVol.TARGET_SCALAR} 不合理`);
  assert(micVol.MIN_ACCEPTABLE > 0 && micVol.MIN_ACCEPTABLE < micVol.TARGET_SCALAR,
    '可接受下限必须低于目标值，否则每次都会触发修正');
  assert(micVol.FIX_COOLDOWN_MS >= 10000,
    `冷却 ${micVol.FIX_COOLDOWN_MS}ms 太短 —— 会把这事变成注册表轰炸`);
});

test('音量模块：生成的 C# 必须是纯 ASCII', () => {
  /* 实测踩过两次：中文在 `powershell.exe -File` 下编码损坏，
   * 引号被吞导致语法错误（宄板€? 这种乱码）。
   * 这条规则我自己写进过文档，又自己违反过 —— 用测试锁住。 */
  const cs = micVol.CS_SOURCE;
  const bad = [...cs].filter(c => c.charCodeAt(0) > 127);
  assert(bad.length === 0,
    `C# 源码含 ${bad.length} 个非 ASCII 字符（${bad.slice(0, 8).join('')}）—— 会在 PowerShell 里编码损坏`);
});

test('音量模块：C# 不能用裸 < 比较（here-string 会当重定向）', () => {
  /* PowerShell here-string 里的 `s < n` 会被当成重定向，
   * 报 "类、结构或接口成员声明中的标记for无效"。
   * 循环条件统一写成 `i != n`。 */
  const cs = micVol.CS_SOURCE;
  const loops = [...cs.matchAll(/for\s*\([^)]*\)/g)].map(m => m[0]);
  loops.forEach(l => assert(!/[^<>=!]<[^<=]/.test(l),
    `for 循环用了裸 < ：${l} —— here-string 会当成重定向`));
});

test('音量模块：只在真的改动了才报 fixed', () => {
  /* 报告"修好了"但其实没动，比报告失败更有害 ——
   * 和「假备用源比没有备用源更危险」同一个道理。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mic_volume.js'), 'utf8');
  assert(/fixed:\s*apply\s*&&\s*after\s*>\s*before/.test(src),
    'fixed 判定没要求 after > before —— 可能报告假的修复成功');
});

test('语音启动前必须先修音量，且不能阻塞启动', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const startFn = /start\(\)\s*\{[\s\S]*?const script = `/.exec(src);
  assert(startFn, '找不到 Listener.start()');
  assert(/micVolume\.ensureAudible\(\)/.test(startFn[0]),
    'start() 没修音量 —— 音量是运行时状态，拔插耳机就会被打回 0');
  assert(!/await\s+micVolume\.ensureAudible/.test(startFn[0]),
    '不该 await —— 修音量要跑 PowerShell（1-2秒），会拖慢识别器启动');
  assert(/\.catch\(/.test(startFn[0]),
    '没接 catch —— 修音量失败会变成未捕获的 Promise 拒绝');
});

test('音量过低时给出可执行的指引，不只说"有问题"', () => {
  /* 「报错难懂」和「没有报错」一样糟。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  assert(/设置.*声音.*输入/.test(src),
    '没告诉用户去哪里手动调音量');
});

/* ══════════ 录音模块（whisper 接入实时链路的前提） ══════════ */

const micRec = require('./mic_record');

test('录音必须只用 waveIn，绝不能用 MCI', () => {
  /* ══ 这条规则是本项目最贵的一课 ══
   *
   * 实测：同一时刻、同一个麦克风
   *   MCI    → peak=32641（满幅，看起来信号很强）
   *   waveIn → peak=1（真实的静音）
   *
   * 我基于 MCI 的假读数推了三轮结论，得出过两个完全错误的判断：
   *   ①「麦克风输出削波垃圾数据」
   *   ②「华为音频特效 APO 吞掉了音频」
   * 换成 waveIn 一次就露馅了。
   *
   * 教训：交叉验证要在第一步做，不是第五步。 */
  const cs = micRec.CS_SOURCE;
  assert(/waveInOpen/.test(cs), '没用 waveIn');
  assert(!/mciSendString/i.test(cs),
    '用了 MCI —— 实测它在这台机器上返回假数据（peak=32641 全是垃圾）');
});

test('录音生成的 C# 必须是纯 ASCII', () => {
  /* 中文在 `powershell.exe -File` 下编码损坏，
   * 引号被吞导致语法错误（见过 `宄板€?` 这种乱码）。 */
  const bad = [...micRec.CS_SOURCE].filter(c => c.charCodeAt(0) > 127);
  assert(bad.length === 0,
    `C# 含 ${bad.length} 个非 ASCII 字符（${bad.slice(0, 8).join('')}）`);
});

test('录音 C# 不能用裸 < 比较（here-string 会当重定向）', () => {
  /* PowerShell here-string 把 `s < n` 当成重定向，
   * 报「类、结构或接口成员声明中的标记for无效」。 */
  const loops = [...micRec.CS_SOURCE.matchAll(/for\s*\([^)]*\)/g)].map(m => m[0]);
  loops.forEach(l => assert(!/[^<>=!]<[^<=]/.test(l),
    `for 用了裸 < ：${l}`));
});

test('VAD 必须要求最短语音时长，防单次爆音误停', () => {
  /* 实测踩过：阈值触发后立刻静音 → 只录到 1000ms 就停，
   * whisper 拿到几乎空的音频，识别结果为空。
   * 修法是要求累计 ≥1 秒语音才允许因静音停止。 */
  const cs = micRec.CS_SOURCE;
  assert(/speechMs\s*>=\s*1000/.test(cs),
    'VAD 没要求最短语音时长 —— 一次爆音就会让录音立刻停止');
  assert(/runningPeak/.test(cs),
    '没做滑动峰值平滑 —— 单帧尖峰会误触发 VAD');
});

test('录音必须报告 sawSpeech，让调用方能拒绝静音', () => {
  /* whisper 在纯静音上会**编出内容**（幻觉），
   * 实测见过「谢谢观看」这种凭空生成的文本。
   * 所以录音层必须诚实报告"这段到底有没有人说话"。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mic_record.js'), 'utf8');
  assert(/sawSpeech/.test(src), '没报告 sawSpeech');
  assert(/幻觉|hallucinat/i.test(src),
    '没记录"静音喂给 whisper 会产生幻觉"这个风险');
});

test('录音时长上限要防止 whisper 变慢', () => {
  /* 实测：大量静音会让 whisper 从 4 秒涨到 24 秒 ——
   * 静音不是"免费"的，它同样要过一遍模型。 */
  assert(micRec.MAX_MS <= 15000,
    `录音上限 ${micRec.MAX_MS}ms 太长 —— whisper 会明显变慢`);
  assert(micRec.RATE === 16000,
    'whisper 内部按 16kHz 重采样，直接录成目标格式省一次转换');
});

test('质量分级：太短的样本必须拒绝判定', () => {
  /* 实测踩过：VAD 只录到 1 秒的样本被判成 wideband（3kHz=100%），
   * 同一设备用完整样本判出来是 narrowband（3kHz=1%）。
   * 短样本里一次爆音就能主导整个频谱。
   *
   * **分级错了比不分级更危险**：窄带误判成宽带
   * → 高阈值 0.85 + 关掉 whisper 兜底 → 功能直接归零。 */
  const q = require('./mic_quality');
  const fs = require('fs'), path = require('path'), os = require('os');
  const p = path.join(os.tmpdir(), 'jarvis_short_test.wav');
  const rate = 16000, n = Math.floor(rate * 0.5);   // 只有 0.5 秒
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
  const body = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) body.writeInt16LE(Math.round(20000 * Math.sin(i * 0.4)), i * 2);
  fs.writeFileSync(p, Buffer.concat([hdr, body]));
  try {
    const r = q.analyze(p);
    assert(r.grade === 'unknown',
      `0.5s 的样本被判成 ${r.grade} —— 太短的样本不该用来分级`);
    assert(/太短/.test(r.why || ''), '没说明为什么拒绝判定');
  } finally { try { fs.unlinkSync(p); } catch {} }
});

test('质量分级：静音不能被误判成"设备差"', () => {
  /* 把"没说话"判成"设备差"会永久降低阈值，增加误触发。
   * 必须区分这两件事。 */
  const q = require('./mic_quality');
  const fs = require('fs'), path = require('path'), os = require('os');
  const p = path.join(os.tmpdir(), 'jarvis_silence_test.wav');
  const rate = 16000, n = rate * 2;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(p, Buffer.concat([hdr, Buffer.alloc(n * 2)]));
  try {
    const r = q.analyze(p);
    assert(r.hasSignal === false, '静音被当成有信号');
    assert(r.grade === 'unknown', `静音被判成 ${r.grade}`);
  } finally { try { fs.unlinkSync(p); } catch {} }
});

test('不做手工音频补偿（预加重已实测有害）', () => {
  /* ══ 记录一个失败的方案，免得以后再犯 ══
   *
   * 我试过预加重 y[n] = x[n] - 0.95*x[n-1] 来补高频：
   *   频谱确实改善：2000Hz 从 16% 提升到 62%（4 倍）
   *   但 whisper 识别**变差**：「为了维斯」→「way way way」
   *
   * 原因：预加重是 MFCC 特征提取的前处理，
   * 而 whisper 内部已有自己的 log-Mel 前处理，
   * 外面再加一层破坏了它期望的输入分布。
   *
   * 教训：**不要在成熟模型的输入端做"想当然"的信号处理。** */
  const fs = require('fs'), path = require('path');
  for (const f of ['mic_record.js', 'mic_quality.js', 'voice.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert(!/preEmphasis|preemph/i.test(code),
      `${f} 里有预加重代码 —— 实测让 whisper 识别变差`);
  }
});

test('录音循环不能用 != 做边界判断（会越界崩溃）', () => {
  /* ══ 真实事故：AccessViolationException ══
   *
   * 我为了规避 here-string 把 `<` 当重定向的问题，
   * 把循环条件从 `i + 1 < to` 改成 `i != to`。
   * 测试全绿，但**录音功能直接崩了**：
   *
   *   Unhandled Exception: System.AccessViolationException
   *     at System.Runtime.InteropServices.Marshal.ReadByte
   *
   * 根因：`while (elapsed != maxMs)` 在 maxMs 不是 chunkMs 倍数时
   * （例如 maxMs=2000, chunkMs=30）永远匹配不上 —— elapsed 从
   * 1980 跳到 2010，循环冲出缓冲区，ReadByte 读到保护内存。
   *
   * ══ 两条教训 ══
   * ① **`!=` 不是边界检查的安全替代品**。
   *    规避 A 问题时引入了更严重的 B 问题。
   * ② **测试全绿不等于功能正常**。
   *    这正是本项目反复踩的「看起来在工作但实际没连上」。
   *    改完必须跑真实功能，不能只看测试。
   *
   * 正确写法：用减法比较，只需要 `>=`，既避开 `<` 又保证边界安全。 */
  const cs = micRec.CS_SOURCE;
  assert(!/while\s*\([^)]*!=[^)]*\)/.test(cs),
    'while 用 != 做边界判断 —— maxMs 不是 chunkMs 倍数时会越界崩溃');
  const forHeaders = [...cs.matchAll(/for\s*\([^)]*\)/g)].map(m => m[0]);
  forHeaders.forEach(h => {
    /* i++ 步进 1 的循环用 != 是安全的（一定能命中上界）；
     * 步进 >1 的必须用减法比较。 */
    if (/\+=\s*[2-9]/.test(h)) {
      assert(!/!=/.test(h),
        `步进大于 1 的循环用了 != ：${h} —— 可能跳过上界越界`);
    }
  });
});

test('录音在 maxMs 非 chunk 倍数时也必须安全', () => {
  /* 锁住上面那个事故的具体触发条件。
   * chunkMs=30，所以 2000/3100 这类值都不是整数倍。 */
  const cs = micRec.CS_SOURCE;
  const m = /int chunkMs = (\d+)/.exec(cs);
  assert(m, '找不到 chunkMs');
  const chunk = Number(m[1]);
  /* 条件必须是"剩余时间够不够再来一帧"，而不是"是否正好等于上限" */
  assert(/maxMs - elapsed >= chunkMs/.test(cs),
    `循环条件必须容忍 maxMs 不是 ${chunk} 的整数倍`);
});

/* ══════════ whisper 唤醒复核（差设备救命通道） ══════════ */

test('whisper 唤醒复核：每条退出路径都必须留痕', () => {
  /* ══ 真实事故 ══
   * 第一版所有 return 都是静默的，结果真机上
   * 「没有命中也没有失败」，我只能靠猜定位。
   * 这正是本项目反复踩的「看起来在工作但实际没连上」。
   *
   * 加上诊断事件后一次就看到根因：no_speech peak=31。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  /* 复核逻辑 2026-09-11 抽到共用 helper（wake/command 两条通道都走它）。
   * 守卫针对 helper，保证"静默 return 不得多于诊断事件"的约束不被重构丢掉。 */
  const fn = /_whisperFromRing\(rawText, kind\)\s*\{[\s\S]*?\n  \}/.exec(src);
  assert(fn, '找不到 _whisperFromRing');
  const body = fn[0];
  /* 数一下 return 和诊断事件的数量 —— 不要求一一对应，
   * 但静默 return 明显多于事件就说明又在暗地里失败。 */
  const returns = (body.match(/\breturn;/g) || []).length;
  const skips = (body.match(/whisper_wake_skip/g) || []).length;
  assert(skips >= returns - 1,
    `${returns} 个 return 只有 ${skips} 个诊断事件 —— 会出现"静默什么都没做"`);
});

test('whisper 唤醒复核：必须有节流和互斥', () => {
  /* whisper 一次要几秒 CPU，差设备上乱码事件很密集
   * （实测 3 秒内 3 次）。不设节流会把 CPU 打满，
   * 并发跑两个 whisper 只会互相拖慢到不可用。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  assert(/_whisperBusy/.test(src), '没有互斥标记');
  assert(/WHISPER_WAKE_COOLDOWN_MS/.test(src), '没有节流');
  const v = require('./voice');
  assert(v.WHISPER_WAKE_COOLDOWN_MS >= 1500,
    `冷却 ${v.WHISPER_WAKE_COOLDOWN_MS}ms 太短`);
});

test('whisper 唤醒复核：busy 标记不能泄漏', () => {
  /* 泄漏一次就永久失效 —— 之后所有唤醒都被 busy 挡掉。
   * 必须用 finally 清理，不能只在正常路径清。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const fn = /_whisperFromRing\(rawText, kind\)\s*\{[\s\S]*?\n  \}/.exec(src);
  assert(/finally\s*\{[\s\S]*?_whisperBusy = false/.test(fn[0]),
    'busy 标记没在 finally 里清 —— 抛异常就永久卡住');
});

test('唤醒词变体：接受 whisper 的近音输出但不过度放宽', () => {
  /* whisper 在窄带音频上不会给完美的「贾维斯」，
   * 实测给过：「为了维斯」「为了维克维斯」「小维斯呢」。
   * 不接受这些变体 = whisper 白接。
   *
   * 但也不能太宽：窗口外误唤醒会开麦收音并调模型，
   * 既是隐私问题也是花钱问题。 */
  const v = require('./voice');
  const m = v.matchesWakeWord;
  // 必须命中（都是实测 whisper 真实输出）
  ['贾维斯', '为了维斯', '为了维克维斯', '小维斯呢', '加维斯', 'jarvis']
    .forEach(t => assert(m(t), `应命中却没命中：「${t}」`));
  // 必须拒绝
  ['维', '', '今天大盘怎么样', '我有肉不', '这个维斯康星州的经济数据显示']
    .forEach(t => assert(!m(t), `应拒绝却命中了：「${t}」`));
});

test('反应式录音有固定启动开销，必须记录这个限制', () => {
  /* ══ 实测发现的架构缺陷 ══
   * 每次录音都要新起 PowerShell + 编译 C#，实测固定开销 1.6 秒：
   *   第1次 总耗时2661ms 录音990ms 开销1671ms
   *   第2次 总耗时2629ms 录音990ms 开销1639ms
   *   第3次 总耗时2574ms 录音990ms 开销1584ms
   *
   * 后果：用户说完「贾维斯」→ 识别器识别(约1s) → 才开始录音
   * → 再等1.6s才真正收音，话早说完了。
   * 实测确认：_tryWhisperWake 拿到的是 no_speech peak=31（静音）。
   *
   * **结论：反应式录音在架构上是错的**，
   * 正确做法是常驻环形缓冲区（说话前的音频也在里面）。
   * 这条测试锁住"这个限制已被记录"，避免以后误以为它能用。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  assert(/1\.6|1600|环形|ring ?buffer|启动开销|太晚|来不及/i.test(src),
    'voice.js 没记录反应式录音的启动开销限制 —— 后人会以为它能可靠工作');
});

/* ══════════ 环形缓冲（Phase 1） ══════════ */

const micRing = require('./mic_ring');

test('环形缓冲：读写正确性（不依赖麦克风）', () => {
  /* 纯逻辑验证环形写入 + 回读，包括**跨尾部回绕**这个最容易写错的路径。 */
  const R = new micRing.RingBuffer(() => { });
  const total = micRing.RING_BYTES;
  /* 灌入 1.5 倍容量，强制回绕 */
  const n = Math.floor(total * 1.5 / 2) * 2;
  for (let i = 0; i < n; i += 3200) {
    const chunk = Buffer.alloc(Math.min(3200, n - i));
    for (let k = 0; k + 1 < chunk.length; k += 2) {
      chunk.writeInt16LE(((i + k) / 2) % 30000, k);
    }
    R._onChunk(chunk.toString('base64'));
  }
  const wav = R.readRecent(1000);
  assert(wav, '回绕后取不到音频');
  assert(wav.length === 44 + micRing.RATE * 2, `WAV 大小不对: ${wav.length}`);
  assert(wav.slice(0, 4).toString() === 'RIFF', '不是合法 WAV');
  /* 取回的必须是**最新**的数据，不是最旧的 */
  const lastVal = ((n - 2) / 2) % 30000;
  const gotLast = wav.readInt16LE(wav.length - 2);
  assert(gotLast === lastVal,
    `取回的不是最新数据：期望 ${lastVal} 得到 ${gotLast}`);
});

test('环形缓冲：缓冲不足时必须返回 null 而不是静音', () => {
  /* 返回一段静音 WAV 会让 whisper 产生幻觉（实测凭空生成「谢谢观看」），
   * 所以料不够时必须明确说"没有"。 */
  const R = new micRing.RingBuffer(() => { });
  assert(R.readRecent(3000) === null, '空缓冲居然返回了数据');
  const chunk = Buffer.alloc(3200);
  R._onChunk(chunk.toString('base64'));
  assert(R.readRecent(3000) === null, '料不够却返回了数据');
});

test('环形缓冲：C# 源码必须满足三条硬约束', () => {
  const cs = micRing.CS_SOURCE;
  /* 1. 纯 ASCII —— 中文在 powershell -File 下编码损坏 */
  const bad = [...cs].filter(c => c.charCodeAt(0) > 127);
  assert(bad.length === 0, `C# 含 ${bad.length} 个非 ASCII 字符`);
  /* 2. 只能用 waveIn，绝不能用 MCI（实测 MCI 返回假数据 peak=32641） */
  assert(/waveInOpen/.test(cs), '没用 waveIn');
  assert(!/mciSendString/i.test(cs), '用了 MCI —— 实测返回假数据');
  /* 3. for/while 头部不能有裸 < （here-string 当重定向） */
  [...cs.matchAll(/(?:for|while)\s*\([^)]*\)/g)].forEach(m => {
    assert(!/[^<>=!]<[^<=]/.test(m[0]), `循环头有裸 < ：${m[0]}`);
  });
});

test('环形缓冲：必须轮询而不是注册回调', () => {
  /* waveIn 回调需要消息泵，而 PowerShell 的 Start-Sleep 会阻塞消息泵 ——
   * 这正是最早唤醒词完全不触发的根因（0 个音频事件）。 */
  const cs = micRing.CS_SOURCE;
  assert(/flags & 1u/.test(cs) || /WHDR_DONE/.test(cs),
    '没有轮询 WHDR_DONE 标志位');
});

test('环形缓冲：设备号可指定，且以 WAVE_MAPPER 兜底', () => {
  /* ══ 这条断言改过一次，值得说明为什么 ══
   *
   * 旧版要求 C# 里**写死** `waveInOpen(out h, 0xFFFFFFFF`，
   * 理由是"没用 WAVE_MAPPER 换耳机就得重启"。
   *
   * 但那只是当时实现「换耳机不用重启」的手段，不是目的本身。
   * 2026-09-09 把设备号参数化后，能力反而更强了：
   *   · 不传参 → 仍是 WAVE_MAPPER（旧行为完整保留）
   *   · 传设备号 → 可绕开"Windows 默认设备恰好是坏的那个"
   * 实测本机默认设备是板载阵列麦（rms=1，quiet），
   * USB 耳机才是可用的（rms=12，ok）—— 写死 WAVE_MAPPER 时
   * 只能靠用户去系统设置里换默认设备，程序自己无能为力。
   *
   * 所以断言的对象要从「写死某个手段」换成「守住那个目的」：
   * 兜底必须还在，同时必须可被覆盖。 */
  const cs = micRing.CS_SOURCE;
  assert(/uint devId = 0xFFFFFFFF/.test(cs),
    '丢了 WAVE_MAPPER 兜底 —— 探测失败时会完全没法录音');
  assert(/args\.Length/.test(cs) && /TryParse\(args\[0\]/.test(cs),
    '设备号不可指定 —— 默认设备是坏的时候程序无法自救');
  assert(/waveInOpen\(out h, devId/.test(cs),
    '打开设备时没用解析出来的 devId');
  /* 光 C# 支持没用，Node 侧得真的把它传下去 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mic_ring.js'), 'utf8');
  assert(/spawn\(built\.exe, \[String\(devIndex\)\]/.test(src),
    'Node 侧没把设备号作为参数传给采集进程');
});

test('环形缓冲：stalled 必须能被检测到', () => {
  /* 「看起来在工作但实际没连上」是本项目最难查的一类问题，
   * 采集卡住必须能主动发现，不能等用户报"叫不醒"。 */
  const R = new micRing.RingBuffer(() => { });
  R.running = true;
  R.lastChunkAt = Date.now() - 5000;
  assert(R.status().stalled === true, '5 秒没数据却不报 stalled');
  R.lastChunkAt = Date.now();
  assert(R.status().stalled === false, '刚收到数据却报 stalled');
});

test('音量门槛：MIN_ACCEPTABLE 不足以判断"能用"', () => {
  /* ══ 实测事故 ══
   * 默认采集设备停在 62%（+2.6dB），高于 MIN_ACCEPTABLE(30%)，
   * 旧逻辑判定"没问题、不用修"，但实际采到的语音峰值只有 571
   * （正常一两万），A/B/A 三段测试有声块 2/75 —— 等于采不到人声。
   *
   * 修好后同一设备直录 peak=19890、环形缓冲 18667，两者一致。
   *
   * 更重要的是：我据此错误地下了"waveIn 与 SAPI 设备级互斥"的结论，
   * 差点按错误前提重新设计整个架构。
   * **教训：先排除最简单的解释（音量），再怀疑架构。** */
  const mv = require('./mic_volume');
  assert(mv.MIN_HEALTHY > mv.MIN_ACCEPTABLE,
    'MIN_HEALTHY 必须严格高于 MIN_ACCEPTABLE');
  assert(mv.MIN_HEALTHY >= 0.8,
    `MIN_HEALTHY=${mv.MIN_HEALTHY} 太低 —— 实测 62% 就已经采不到人声`);
  /* 修正条件必须用 MIN_HEALTHY，否则 62% 这类设备永远不会被修 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mic_volume.js'), 'utf8');
  assert(/Run\(\$\{TARGET_SCALAR\}, \$\{MIN_HEALTHY\}/.test(src),
    '修正阈值还在用 MIN_ACCEPTABLE —— 62% 的设备不会被修');
});

test('音量修复必须诚实：没改动就不能报 fixed', () => {
  /* 假修复比不修更危险：它让人以为问题解决了，从此往错方向查。
   * 实测 dev0 已经 100%，必须报 fixed=false。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'mic_volume.js'), 'utf8');
  assert(/fixed: apply && after > before/.test(src),
    'fixed 不是由"实际变化"决定的');
});

test('whisper 复核必须从环形缓冲取音频，不能现场录', () => {
  /* 现场录音有 1.6 秒启动开销，实测拿到的全是 no_speech peak≈30。
   * 改成从常驻缓冲取之后，实测 whisper 真正跑起来、
   * 「因静音被跳过」降到 0 次。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const fn = /_whisperFromRing\(rawText, kind\)\s*\{[\s\S]*?\n  \}/.exec(src);
  assert(fn, '找不到 _whisperFromRing');
  assert(/dumpRecent/.test(fn[0]), '没从环形缓冲取音频');
  assert(!/rec\.record\(/.test(fn[0]),
    '还在现场录音 —— 启动开销会让它永远录不到唤醒词');
});

test('宽带设备也必须保留 whisper 兜底', () => {
  /* ══ 血的教训：修好音量反而让唤醒彻底失效 ══
   *
   * 原来 wideband 的 needWhisperConfirm 是 false，理由是
   * "宽带设备系统识别器够准"。实测把这个假设证伪了：
   *
   *   1. 麦克风音量 62% -> 90%，音频质量真的变好
   *   2. 频谱分级从 unknown 升级成 wideband
   *   3. wideband 关掉 whisper 兜底，阈值抬到 0.85
   *   4. 但这台设备系统识别器对「贾维斯」只给 conf <= 0.117
   *   5. 结果：**修好音量之后，唤醒从"偶尔能成"变成"永远不可能"**
   *
   * 根本错误：把两件独立的事当成因果 ——
   *   「频谱好」 != 「系统识别器认得出唤醒词」
   * 频谱说明音频通路质量；识别率取决于声学模型、口音、语言包。
   *
   * 修复后实测：whisper 复核从 0 次变成 3 次。 */
  const q = require('./mic_quality');
  Object.entries(q.GRADES).forEach(([name, g]) => {
    assert(g.needWhisperConfirm === true,
      `等级 ${name} 关掉了 whisper 兜底 —— 一旦系统识别器认不出唤醒词就永久失效`);
  });
});

test('阈值必须被实测上界压住，不能高于设备能力', () => {
  /* 阈值高于设备物理上限 = 唤醒永久失效，
   * 而且**表面上一切正常**（不报错，只是永远不响应）——
   * 正是本项目最难查的那类问题。 */
  const q = require('./mic_quality');
  q.resetWakeOutcomes();
  q.resetProbe();
  /* 频谱好，但系统识别器一直给低分（复现实测场景） */
  q.recordProbe({ hasSignal: true, grade: 'wideband',
    gradeInfo: q.GRADES.wideband, spectrum: {}, hf3k: 0.26 });
  const before = q.currentPolicy().wakeConf;
  assert(before > 0.5, `wideband 基础阈值应该较高，实际 ${before}`);
  [0.002, 0.043, 0.117, 0.008].forEach(c => q.recordWakeOutcome(c, true));
  const after = q.currentPolicy();
  assert(after.wakeConf < 0.12,
    `阈值 ${after.wakeConf} 仍高于实测上界 0.117 —— 唤醒永久失效`);
  assert(after.needWhisperConfirm === true,
    '压低阈值后必须开兜底，否则会大量误触发');
  assert(after.wakeConfCappedFrom === before,
    '没有记录原始阈值，排查时看不出发生了压制');
  q.resetWakeOutcomes();
  q.resetProbe();
});

test('观测样本不足时不能乱压阈值', () => {
  /* 一两次观测就压阈值会被偶发噪声带偏 ——
   * 和「基于单次观测下结论」同一类错误，本项目已犯过三次。 */
  const q = require('./mic_quality');
  q.resetWakeOutcomes();
  q.resetProbe();
  q.recordProbe({ hasSignal: true, grade: 'wideband',
    gradeInfo: q.GRADES.wideband, spectrum: {}, hf3k: 0.26 });
  q.recordWakeOutcome(0.01, true);
  assert(q.currentPolicy().wakeConf > 0.5,
    '只有 1 个样本就压阈值 —— 太容易被噪声带偏');
  assert(q.observedCeiling() === null, '样本不足时上界应为 null');
  q.resetWakeOutcomes();
  q.resetProbe();
});

test('probe 必须暴露生效策略（可观测性）', () => {
  /* 这一轮排查最大的时间浪费就是**看不见服务端进程内的真实状态**：
   * 我只能在别的进程 require 同一模块来猜，
   * 而那个进程是 unknown、服务端已经是 wideband，
   * 于是我连续下了两个错误结论（"互斥"、"兜底开着"）。
   *
   * 阈值和兜底开关是唤醒成败的决定性变量，必须一眼可见。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'voice.js'), 'utf8');
  const fn = /async function probe\(\)[\s\S]*?\n\}/.exec(src);
  assert(fn, '找不到 probe()');
  assert(/policy:\s*micQuality\.currentPolicy\(\)/.test(fn[0]),
    'probe 没暴露 policy —— 排查时只能靠猜');
});
/* ══════════ 跑 ══════════ */

(async () => {
  section('待办提取 + 会话扫描 + 巡视阈值');
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  }
  console.log('\n───────────────────────────────────');
  console.log(`  通过: ${pass}  |  失败: ${fail}`);
  console.log('───────────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
