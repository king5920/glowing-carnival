'use strict';
/**
 * 记忆整理（memory_tidy）
 *
 * ══════ 这个模块补的是我自己留的坑 ══════
 * Phase 5 我在 patrol.js 的 COOLDOWNS 里写了 `memory_tidy: 2小时`，
 * 但 runOne 里从来没实现它 —— 空壳挂了两个 Phase。
 * 前端会显示"整理记忆"，实际什么都没做，这是假装在干活。
 *
 * ══════ 用实测数据定策略，不猜 ══════
 * 本机 20 条记忆、190 个配对的余弦相似度实测分布：
 *   ≥0.95     0 对
 *   0.90-0.95 0 对
 *   0.85-0.90 1 对   ← #12「持续跟踪宁德时代个股走势」vs #16「持有或密切跟踪宁德时代个股表现」
 *   0.80-0.85 0 对
 *   <0.80   189 对
 *
 * 关键发现（反直觉）：
 *   #3「老陈喜欢喝拿铁，不加糖」vs #4「喝咖啡习惯点拿铁，不加糖」
 *   人眼看是同一件事，但余弦相似度只有 **0.742**。
 *
 * 所以**单一阈值必然出错**：
 *   - 阈值定 0.85 → 漏掉咖啡那对（真重复）
 *   - 阈值降到 0.74 → 误合并 0.67 的宁德记忆（它们其实是不同侧面：
 *     一条讲 60 天区间位置，一条讲市值，合并会丢信息）
 *
 * 因此走两段式（和待办提取同一个思路）：
 *   高相似（≥0.85）→ 直接合并，零成本
 *   中相似（0.70-0.85）→ 交给模型判断是"同一件事"还是"不同侧面"
 *   低相似（<0.70）→ 不碰
 */

const db = require('../db');
const llm = require('../llm');

/* 阈值。基于上面的实测分布，不是拍脑袋。
 *
 * ── 0.70 这个下界是验证过的，别随便往下调 ──
 * 模型自己质疑过：「0 条待合并可能是真没重复，也可能是重复项掉到 0.70 以下
 * 连模型都没被问到」。这个担忧方向对，所以我实测了 0.55-0.70 区间的全部 14 对：
 *
 *   0.659  #9「量化系统用区间位置+均线计分」vs #11「量化系统关注技术指标因子」
 *          → 接近重复，但 #9 有具体指标名，合并会丢信息
 *   0.628  #17「板块数据源做市场宽度」vs #18「资金流用东财接口」→ 明确两件事
 *   0.556  #6「茅台+宁德市值」vs #8「宁德60天区间位置」→ 明确两件事
 *
 * 结论：**这 14 对里没有一对是"该合并却漏了"的**，全是同一个项目的不同侧面。
 * 0.70 恰好卡在"同义改写"和"不同侧面"的分界上。往下调会开始丢信息。
 */
const AUTO_MERGE = 0.85;      // 以上自动合并
const ASK_MODEL_MIN = 0.70;   // 这个区间问模型（下界经 14 对实测验证）
const MAX_MODEL_PAIRS = 12;   // 一次最多问模型 12 对，控成本

/* 衰减参数。weight 高的半衰期长 —— 重要的事忘得慢，这是设计意图。 */
const HALFLIFE_DAYS = {
  person:   180,    // 人不容易忘
  project:  120,    // 项目
  interest: 90,     // 兴趣
  place:    90,
  event:    30,     // 事件忘得最快
};
const MIN_WEIGHT = 0.05;      // 衰减下限，不归零（归零就等于删除，太激进）

function cos(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function daysBetween(iso, now = Date.now()) {
  const t = Date.parse(String(iso).replace(' ', 'T'));
  if (!isFinite(t)) return 0;
  return Math.max(0, (now - t) / 86400000);
}

/* ═══════════ 一、找重复 ═══════════ */

/**
 * 扫描语义重复的记忆对。
 * @returns {{auto: [], needJudge: []}}
 */
function findDuplicates() {
  const all = db.allMemories().map(m => ({
    id: m.id, content: m.content, category: m.category, entity: m.entity,
    weight: m.weight, read_count: m.read_count, created_at: m.created_at,
    vec: db.blobToVec(m.embedding),
  })).filter(m => m.vec);

  const auto = [], needJudge = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const s = cos(all[i].vec, all[j].vec);
      if (s >= AUTO_MERGE) auto.push({ a: all[i], b: all[j], sim: s });
      else if (s >= ASK_MODEL_MIN) needJudge.push({ a: all[i], b: all[j], sim: s });
    }
  }
  auto.sort((x, y) => y.sim - x.sim);
  needJudge.sort((x, y) => y.sim - x.sim);
  return { auto, needJudge: needJudge.slice(0, MAX_MODEL_PAIRS), total: all.length };
}

const JUDGE_SYSTEM = `你判断两条记忆是否在说**同一件事**。

判断标准：
- 同一件事 = 合并后不丢失任何信息。例如「老陈喜欢喝拿铁，不加糖」和
  「喝咖啡习惯点拿铁，不加糖」是同一件事。
- 不同侧面 = 各自带独立信息，合并会丢东西。例如「关注宁德时代60天区间位置」和
  「关注宁德时代市值」是两件事，都要留。

宁可保守：不确定就判 keep_both。丢信息比留冗余糟糕得多。

对每一对，输出一行 JSON（不要 markdown 代码块）：
{"pair":1,"verdict":"merge","merged":"合并后的表述","reason":"12字内"}
或
{"pair":1,"verdict":"keep_both","reason":"12字内"}

merged 字段要求：保留两条的全部信息，用最简洁的中文，不超过 40 字。`;

/** 让模型判断中等相似度的记忆对 */
async function judgeWithModel(pairs) {
  if (!pairs.length) return [];

  const listing = pairs.map((p, i) =>
    `${i + 1}. [相似度 ${p.sim.toFixed(3)}]\n   A(#${p.a.id}, ${p.a.category}/${p.a.entity || '-'}): ${p.a.content}\n   B(#${p.b.id}, ${p.b.category}/${p.b.entity || '-'}): ${p.b.content}`
  ).join('\n');

  const r = await llm.chat([
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: `判断这 ${pairs.length} 对：\n\n${listing}` },
  ], { maxTokens: 1600, temperature: 0.2, timeoutMs: 90000 });

  const text = (r && (r.content || r.text)) || '';
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim().replace(/^```\w*|```$/g, '').trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s);
      const idx = (j.pair || 0) - 1;
      if (idx < 0 || idx >= pairs.length) continue;
      out.push({ ...pairs[idx], verdict: j.verdict, merged: j.merged, reason: j.reason });
    } catch (_) { /* 单行解析失败不影响其他行 */ }
  }
  return out;
}

/* ═══════════ 二、衰减 ═══════════ */

/**
 * 按类别半衰期衰减权重。
 *
 * 注意：**只降不删**。删除记忆是不可逆的，而权重低的记忆
 * 在检索时自然排后面，效果等价但可恢复。
 */
function decayWeights(opts = {}) {
  const all = db.allMemories();
  const now = Date.now();
  const changes = [];
  const skip = opts.skipIds || new Set();

  for (const m of all) {
    if (skip.has(m.id)) continue;               // 已被合并删除的不处理
    const hl = HALFLIFE_DAYS[m.category] || 90;
    const age = daysBetween(m.created_at, now);
    if (age < 1) continue;                      // 一天内的不动

    /* 半衰期衰减：weight * 0.5^(age/halflife)
     * 但读得多的记忆抗衰减 —— read_count 每次 +8% 半衰期。
     * 理由：你反复问的事情显然重要，不该因为"旧"就淡忘。 */
    const effectiveHl = hl * (1 + (m.read_count || 0) * 0.08);
    const decayed = m.weight * Math.pow(0.5, age / effectiveHl);
    const next = Math.max(MIN_WEIGHT, decayed);

    // 变化太小就不写库（省 IO，也避免每次巡视都产生"改动"）
    if (Math.abs(next - m.weight) < 0.005) continue;

    changes.push({
      id: m.id, from: +m.weight.toFixed(3), to: +next.toFixed(3),
      ageDays: +age.toFixed(1), category: m.category,
      content: m.content.slice(0, 40),
    });
    if (!opts.dryRun) db.setMemoryWeight(m.id, next);
  }
  return changes;
}

/* ═══════════ 三、主流程 ═══════════ */

/**
 * 整理记忆。
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun 只报告不改库
 * @param {boolean} opts.useModel 是否让模型判断中等相似度对（默认 true）
 */
async function tidy(opts = {}) {
  const dryRun = !!opts.dryRun;
  const result = {
    ok: true, dryRun,
    merged: [], keptBoth: [], decayed: [], errors: [],
  };

  /* ── 1. 找重复 ── */
  const { auto, needJudge, total } = findDuplicates();
  result.scanned = total;
  result.autoMergeCandidates = auto.length;
  result.modelJudgeCandidates = needJudge.length;

  /* ── 2. 高相似度直接合并 ── */
  /* ══════ 为什么需要 consumed ══════
   *
   * findDuplicates() 是**一次性算出所有配对**再逐对合并的。
   * 如果不记住"这条已经被处理过"，就会出现链式合并：
   *
   *   配对 (39,43) → 保留 39，删掉 43
   *   配对 (32,39) → 保留 32，删掉 39      ← 39 刚刚才当过保留方
   *
   * 结果 39 既是保留方又被删掉，合并记录里指向一条已不存在的记忆。
   *
   * ══ 实测后果（真实发生过）══
   * 我在本机跑了一次 memory_tidy，30 条合并记录里：
   *   6 条记忆既当保留方又被淘汰（#18 #32 #12 #39 #69 #42）
   *   10 条记录的 kept_id 指向已删除的记忆
   *   mergeStats.total 算 30，实际能追溯到存活记忆的只有 20
   * 两条测试因此变红（「被合并删除的记忆确实查不到了」
   * 「starmap.mergeStats 与实际合并数一致」）。
   *
   * 修法：任何一条记忆一旦参与过合并（无论保留还是淘汰），
   * 本轮就不再碰它。剩下的配对留给下一轮（2 小时后）——
   * 反正 A 吞 B 之后内容已经变了，本轮算的相似度对新内容已经失效，
   * 强行接着合并本身就是错的。 */
  const consumed = new Set();
  for (const p of auto) {
    if (consumed.has(p.a.id) || consumed.has(p.b.id)) {
      result.skippedChained = (result.skippedChained || 0) + 1;
      continue;
    }
    // 保留权重高的那条；权重相同保留读得多的；再相同保留旧的（id 小）
    const keep = pickKeeper(p.a, p.b);
    const drop = keep === p.a ? p.b : p.a;
    consumed.add(keep.id);
    consumed.add(drop.id);
    result.merged.push({
      kept: keep.id, dropped: drop.id, sim: +p.sim.toFixed(3),
      by: 'similarity',
      keptContent: keep.content.slice(0, 50),
      droppedContent: drop.content.slice(0, 50),
    });
    if (!dryRun) {
      try { mergeInto(keep, drop, { similarity: p.sim, decidedBy: 'similarity' }); }
      catch (e) { result.errors.push(`合并 #${drop.id}→#${keep.id} 失败: ${e.message}`); }
    }
  }

  /* ── 3. 中等相似度问模型 ── */
  if (needJudge.length && opts.useModel !== false) {
    try {
      const judged = await judgeWithModel(needJudge);
      for (const j of judged) {
        if (j.verdict === 'merge' && j.merged) {
          /* 同样要防链式合并 —— consumed 跨阶段共享：
           * 阶段 2 已经吞掉的记忆，阶段 3 不能再动。 */
          if (consumed.has(j.a.id) || consumed.has(j.b.id)) {
            result.skippedChained = (result.skippedChained || 0) + 1;
            continue;
          }
          const keep = pickKeeper(j.a, j.b);
          const drop = keep === j.a ? j.b : j.a;
          consumed.add(keep.id);
          consumed.add(drop.id);
          result.merged.push({
            kept: keep.id, dropped: drop.id, sim: +j.sim.toFixed(3),
            by: 'model', reason: j.reason,
            newContent: j.merged.slice(0, 60),
            keptContent: keep.content.slice(0, 50),
            droppedContent: drop.content.slice(0, 50),
          });
          if (!dryRun) {
            try {
              mergeInto(keep, drop, {
                similarity: j.sim, decidedBy: 'model',
                reason: j.reason, mergedText: j.merged,
              });
              // 模型给了更好的表述就用它
              if (j.merged && j.merged.length >= 4) db.setMemoryContent(keep.id, j.merged);
            } catch (e) { result.errors.push(`模型合并失败: ${e.message}`); }
          }
        } else {
          result.keptBoth.push({
            a: j.a.id, b: j.b.id, sim: +j.sim.toFixed(3), reason: j.reason,
          });
        }
      }
    } catch (e) {
      result.errors.push('模型判断失败: ' + e.message);
    }
  }

  /* ── 4. 衰减 ──
   * 必须在合并**之后**做，并且跳过已被删除的记忆。
   * dryRun 时记忆还没真删，所以要显式排除已判定要删的 id ——
   * 否则报告里会出现"给一条即将被删除的记忆调整权重"这种自相矛盾的动作。 */
  const droppedIds = new Set(result.merged.map(m => m.dropped));
  result.decayed = decayWeights({ dryRun, skipIds: droppedIds });

  /* ── 汇总 ── */
  result.summary = {
    scanned: total,
    mergedCount: result.merged.length,
    keptBothCount: result.keptBoth.length,
    decayedCount: result.decayed.length,
    errorCount: result.errors.length,
  };
  // 有没有做实事，决定巡视要不要上报
  result.didSomething = result.merged.length > 0 || result.decayed.length > 0;
  return result;
}

/** 决定两条重复记忆保留哪条 */
function pickKeeper(a, b) {
  if (Math.abs(a.weight - b.weight) > 0.01) return a.weight > b.weight ? a : b;
  if ((a.read_count || 0) !== (b.read_count || 0)) {
    return (a.read_count || 0) > (b.read_count || 0) ? a : b;
  }
  return a.id < b.id ? a : b;      // 保留更早的
}

/**
 * 把 drop 合并进 keep：
 * 权重取较大值、read_count 相加，然后删掉 drop。
 * 合并而不是简单删除，是为了不丢失"这件事被提到过多次"的信息。
 *
 * **先记历史再删**：合并是唯一不可逆的操作，
 * memory_merges 表里存的 dropped_text 是被删原文的唯一留存处。
 * 顺序反了就等于没记 —— 删完再去读内容只能读到空。
 */
function mergeInto(keep, drop, meta = {}) {
  const w = Math.max(keep.weight, drop.weight);
  const rc = (keep.read_count || 0) + (drop.read_count || 0);

  db.recordMerge({
    keptId: keep.id, droppedId: drop.id,
    keptBefore: keep.content,
    droppedText: drop.content,          // 唯一留存处
    mergedText: meta.mergedText || null,
    similarity: meta.similarity || 0,
    decidedBy: meta.decidedBy || 'similarity',
    reason: meta.reason || null,
    category: keep.category, entity: keep.entity,
  });

  db.mergeMemory(keep.id, drop.id, w, rc);
}

module.exports = {
  tidy, findDuplicates, decayWeights, judgeWithModel,
  AUTO_MERGE, ASK_MODEL_MIN, HALFLIFE_DAYS,
};
