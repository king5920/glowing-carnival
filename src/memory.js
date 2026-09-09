/**
 * memory.js —— 记忆抽取与混合检索
 *
 * 算法借鉴 MemoryConstellations (MIT) 的 librarian.js，自行实现：
 *   ① 分段衰减 segmentedDecay —— 半衰期由 weight 决定，≤3天看新鲜度、>3天看情绪
 *   ② 新颖度惩罚 noveltyPenalty = 1/(1+log10(read_count+1))
 *   ③ 召回多道关卡 —— "信号弱时宁可空返回也不塞噪音"
 *   ④ RRF 融合 FTS5 与向量结果
 *
 * 与原项目的差异：不用 ChromaDB。向量存 SQLite BLOB，
 * 余弦相似度在 JS 里算（单用户几千条足够快）。
 */
'use strict';
const db = require('./db');
const llm = require('./llm');

/* ── ① 分段衰减 ── */
function decayLambda(w) {
  if (w >= 0.8) return 0.005;   // 140天半衰期
  if (w >= 0.6) return 0.01;    // 70天
  if (w >= 0.4) return 0.02;    // 35天
  return 0.04;                  // 17天
}
const STM_TIME_W = 0.7, LTM_EMO_W = 0.7, SEGMENT_DAYS = 3;

function segmentedDecay(days, weight) {
  const w = weight == null ? 0.5 : weight;
  const timeDecay = Math.exp(-decayLambda(w) * days);
  const emoRetain = 0.3 + w * 0.7;
  if (days <= SEGMENT_DAYS) {
    return STM_TIME_W * timeDecay + (1 - STM_TIME_W) * emoRetain;
  }
  return (1 - LTM_EMO_W) * timeDecay + LTM_EMO_W * emoRetain;
}

/**
 * 纯时间衰减比例（0~1）："这条记忆还剩多少没被时间冲淡"。
 *
 * 和 segmentedDecay 的区别很重要，我一开始搞混了：
 *   segmentedDecay = **检索得分**，混了时间衰减和情绪保留项（0.3 + w*0.7），
 *                    所以 w=0.60 的新记忆能拿到 0.907 分 —— 它不是百分比
 *   retentionRatio = **纯时间维度**，只回答"过了多久、淡了多少"
 *
 * 拿前者判断"正在变淡"会永远显示 fresh（实测 18 条全 fresh），
 * 因为情绪保留项把分数托住了。分档必须用纯时间项。
 */
function retentionRatio(days, weight) {
  return Math.exp(-decayLambda(weight == null ? 0.5 : weight) * days);
}

/* ── ② 新颖度惩罚 ── */
function noveltyPenalty(readCount) {
  if (!readCount || readCount <= 1) return 1.0;
  return 1 / (1 + Math.log10(readCount + 1));
}

function daysAgo(ts) {
  if (!ts) return 365;
  const d = new Date(String(ts).replace(' ', 'T'));
  if (isNaN(d.getTime())) return 365;
  return Math.max(0, (Date.now() - d.getTime()) / 86400000);
}

/* ── ③ 召回关卡 ── */
const MIN_COMBINED_SCORE = 0.005;
/**
 * 向量相似度地板 = 0.35，这个值是本机实测标定的，不是照抄。
 *
 * 原项目用 0.22，但那是针对它自己的 embedding 模型。
 * doubao-embedding-vision 的相似度分布明显偏高——实测「量子力学」
 * 与「老陈喜欢喝拿铁」的余弦相似度仍有 0.2350，用 0.22 会让
 * 完全无关的查询召回全部记忆（实测确实如此）。
 *
 * 标定数据（基准："老陈喜欢喝拿铁，不加糖"）：
 *   相关-强  拿铁              0.6403
 *   相关-弱  老陈是谁          0.5559
 *   相关-强  我咖啡怎么喝的    0.4849
 *   相关-中  喜欢什么饮料      0.4514  ← 相关最低
 *   ───────────────── 间隔 0.2107 ─────────────────
 *   无关     A股量化交易       0.2406  ← 无关最高
 *   无关     量子力学          0.2350
 *   无关     西红柿炒蛋的做法  0.2198
 *   无关     明天天气如何      0.2196
 *
 * 取中点 0.35。若换 embedding 模型，必须重新标定。
 */
const VEC_SIMILARITY_FLOOR = 0.35;
const FTS_ONLY_PENALTY = 0.7;    // CJK 单字索引太松，无向量交叉验证则降权
const RRF_K = 60;

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 混合检索：FTS5 + 向量，RRF 融合，再乘衰减与新颖度。
 * 返回 [{id,content,category,entity,score,...}]
 */
async function search(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];

  // — FTS5 路 —
  const ftsHits = db.ftsSearch(q, 30);
  const ftsRank = new Map();
  ftsHits.forEach((h, i) => ftsRank.set(h.id, i + 1));

  // — 向量路 —
  const vecRank = new Map();
  const vecSim = new Map();
  const emb = await llm.embed([q]);
  if (emb.ok && emb.vectors[0]) {
    const qv = emb.vectors[0];
    const scored = [];
    for (const m of db.allMemories()) {
      if (!m.embedding) continue;
      const sim = cosine(qv, db.blobToVec(m.embedding));
      if (sim >= VEC_SIMILARITY_FLOOR) scored.push({ id: m.id, sim });
    }
    scored.sort((a, b) => b.sim - a.sim);
    scored.slice(0, 30).forEach((s, i) => { vecRank.set(s.id, i + 1); vecSim.set(s.id, s.sim); });
  }

  if (!ftsRank.size && !vecRank.size) return [];

  // — ④ RRF 融合 —
  const ids = new Set([...ftsRank.keys(), ...vecRank.keys()]);
  const vecWorked = vecRank.size > 0 || !llm.hasKey();
  const out = [];
  for (const id of ids) {
    const row = db.memById(id);
    if (!row) continue;

    // 关卡：纯 FTS5 命中且向量路可用却没投票 → 直接丢弃。
    // 原因：中文按单字切分索引，"量子力学"会因为共享单字而误命中，
    // 这类命中没有语义支持，宁可不返回（原项目只降权 0.7，实测不够）。
    if (!vecRank.has(id) && vecWorked && llm.hasKey()) continue;

    let rrf = 0;
    if (ftsRank.has(id)) rrf += 1 / (RRF_K + ftsRank.get(id));
    if (vecRank.has(id)) rrf += 1 / (RRF_K + vecRank.get(id));
    if (ftsRank.has(id) && !vecRank.has(id)) rrf *= FTS_ONLY_PENALTY;

    const decay = segmentedDecay(daysAgo(row.created_at), row.weight);
    const novelty = noveltyPenalty(row.read_count);
    const score = rrf * decay * novelty;
    if (score < MIN_COMBINED_SCORE) continue;   // 关卡：宁可空返回
    out.push({ ...row, score, sim: vecSim.get(id) || 0, decay, novelty });
  }

  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, limit);
  if (top.length) db.bumpRead(top.map(t => t.id));   // 更新 read_count
  return top;
}

/* ── 记忆抽取 ── */
const CATEGORIES = ['person', 'place', 'event', 'interest', 'project'];

const EXTRACT_PROMPT = `你是记忆抽取器。从对话中提取值得长期记住的事实。

规则：
- 只提取关于用户的稳定事实、偏好、计划、关系、事件。
- 寒暄、临时问答、你自己的回复内容，一律不提取。
- 每条事实独立成句，不超过40字，必须自带上下文（不能只写"喜欢它"）。
- category 只能是：person(人物) place(地点) event(事件) interest(兴趣) project(项目)
- entity 是这条记忆归属的核心实体名（人名/地名/项目名/兴趣名），2-8字。
- weight 是重要度 0.1~1.0：随口提到 0.3，明确偏好 0.6，重要关系或长期计划 0.9。

只输出 JSON 数组，无其他文字。没有值得记的就输出 []。
格式：[{"content":"...","category":"...","entity":"...","weight":0.6}]`;

/** 从一轮对话抽取记忆并入库。返回入库的记忆数组 */
async function extract(userText, assistantText, sourceMsgId) {
  if (!llm.hasKey()) return [];
  const r = await llm.chat([
    { role: 'system', content: EXTRACT_PROMPT },
    { role: 'user', content: `用户说：${userText}\n\n我回复：${assistantText || '(无)'}` },
  ], { temperature: 0.2, maxTokens: 700 });
  if (!r.ok) return [];

  // 容错解析：模型可能包 ```json 或加解释文字
  let arr = [];
  try {
    const m = r.text.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  } catch { return []; }
  if (!Array.isArray(arr) || !arr.length) return [];

  const valid = arr.filter(x => x && typeof x.content === 'string' && x.content.trim())
    .slice(0, 8)
    .map(x => ({
      content: String(x.content).trim().slice(0, 200),
      category: CATEGORIES.includes(x.category) ? x.category : 'event',
      entity: x.entity ? String(x.entity).trim().slice(0, 40) : null,
      weight: Math.max(0.1, Math.min(1, Number(x.weight) || 0.5)),
    }));
  if (!valid.length) return [];

  // 批量取向量（一次调用，省钱）
  const emb = await llm.embed(valid.map(v => v.content));
  const saved = [];
  for (let i = 0; i < valid.length; i++) {
    const id = db.addMemory({
      ...valid[i],
      embedding: emb.ok ? emb.vectors[i] : null,
      source_msg: sourceMsgId || null,
    });
    saved.push({ id, ...valid[i] });
  }
  return saved;
}

/** 星图数据：五星系 + 双星核心 + 每条记忆一颗星 */
function starmap() {
  const ents = db.entities();
  const c = db.counts();
  const mergeCounts = db.mergeCountMap();

  // 每条记忆都是一颗星（不是每个实体）。这样星图密度 = 真实记忆量，
  // 而不是靠随机点填充。节点亮度用 segmentedDecay 算真实记忆强度。
  const mems = db.allMemories().map(m => {
    const age = daysAgo(m.created_at);
    const strength = segmentedDecay(age, m.weight);
    const retention = retentionRatio(age, m.weight);
    return {
      id: m.id,
      entity: m.entity,
      category: m.category,
      weight: m.weight,
      // 当前记忆强度（0~1），衰减后的真实值 —— 这是**检索得分**
      strength: Number(strength.toFixed(4)),
      // 纯时间衰减比例 —— 这是"还剩多少没淡"
      retention: Number(retention.toFixed(4)),

      /* ── 以下字段供点击面板显示 ──
       * 之前星图只有节点位置和亮度，点了没反应，
       * 记忆内容完全看不到 —— 等于一堆匿名光点。 */
      content: m.content,
      readCount: m.read_count || 0,
      ageDays: Number(age.toFixed(1)),
      createdAt: m.created_at,

      /* 这颗星吞并过几条记忆。
       * 合并会真删数据，不标出来的话星图上完全看不出痕迹。 */
      mergedCount: mergeCounts[m.id] || 0,

      /* 衰减状态分档，用**纯时间比例**而非检索得分。
       * 用 strength 分档的话 18 条全是 fresh（情绪保留项托住了分数），
       * 等于没分档。 */
      decayState: retention >= 0.9 ? 'fresh'
                : retention >= 0.6 ? 'normal'
                : 'fading',
    };
  });

  return {
    counts: c,
    galaxies: CATEGORIES,
    entities: ents.map(e => ({
      id: e.id, name: e.name, category: e.category,
      memCount: e.mem_cnt, mentions: e.mention_cnt,
    })),
    memories: mems,
    // 整理痕迹统计，前端顶栏显示
    mergeStats: {
      total: Object.values(mergeCounts).reduce((a, b) => a + b, 0),
      starsWithMerges: Object.keys(mergeCounts).length,
    },
  };
}

module.exports = {
  search, extract, starmap,
  segmentedDecay, retentionRatio, noveltyPenalty, cosine, CATEGORIES,
};
