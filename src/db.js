/**
 * db.js —— SQLite 存储层
 *
 * 设计决策（都有实测依据）：
 *  1. FTS5 用 unicode61 分词，但中文必须先按单字切开再入库。
 *     实测：不切分时 "西湖" 完全检索不到（0 命中）；切分后 5/5 命中。
 *     这也解释了 MemoryConstellations 为什么给 FTS5 纯字面匹配降权 0.7
 *     —— CJK 单字索引太松，容易误召回。
 *  2. 向量存 BLOB（Float32Array 原始字节），不引入 ChromaDB。
 *     实测 ARK 套餐 embeddings 返回 2048 维，单用户几千条记忆
 *     在 JS 里暴力算余弦足够快。
 */
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'jarvis.db'));
db.pragma('journal_mode = WAL');   // 并发读不阻塞写
db.pragma('synchronous = NORMAL');

/** CJK 按单字切分——FTS5 中文检索的前提 */
function cjkSplit(s) {
  return String(s || '')
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, c => ' ' + c + ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 FTS5 查询串转成安全的 AND 查询（转义引号，避免语法注入） */
function ftsQuery(s) {
  const terms = cjkSplit(s).split(' ')
    .filter(t => t && t.length > 0)
    .map(t => '"' + t.replace(/"/g, '""') + '"');
  return terms.length ? terms.join(' AND ') : null;
}

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 记忆碎片。weight = 情绪/重要度权重，决定衰减半衰期
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'event'
                CHECK(category IN ('person','place','event','interest','project')),
  entity      TEXT,                       -- 归属实体名（星座）
  weight      REAL NOT NULL DEFAULT 0.5,  -- 0..1
  read_count  INTEGER NOT NULL DEFAULT 0, -- 新颖度惩罚用
  embedding   BLOB,                       -- Float32Array 原始字节，2048 维
  source_msg  INTEGER,                    -- 来源消息
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY(source_msg) REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_entity   ON memories(entity);
CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);

-- 实体（星座）。五个星系 = category
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL DEFAULT 'person'
                CHECK(category IN ('person','place','event','interest','project')),
  mention_cnt INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- FTS5 索引表（存的是切分后的文本）
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  body, mem_id UNINDEXED, tokenize='unicode61'
);

-- 主动性引擎（jiwen）状态持久化
CREATE TABLE IF NOT EXISTS agent_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 记忆整理历史。
--
-- 为什么要专门存这个：memory_tidy 合并记忆时会**真的删掉**一条，
-- 之前只在返回值里报告一次就丢了。结果是：
--   1. 星图上看不出"这颗星是两颗合并来的"
--   2. 合并错了也无法追溯（我凭什么信 0.742 那次判断是对的？）
--   3. 用户没法审查 AI 到底动过哪些记忆
--
-- 存的是**被删除那条的完整内容**，所以即使合并判断错了，原文还在，可以人工恢复。
CREATE TABLE IF NOT EXISTS memory_merges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kept_id       INTEGER NOT NULL,       -- 保留的记忆 id
  dropped_id    INTEGER NOT NULL,       -- 被删除的记忆 id（已不存在于 memories）
  kept_before   TEXT NOT NULL,          -- 合并前保留方的内容
  dropped_text  TEXT NOT NULL,          -- 被删除的原文（唯一留存处，用于人工恢复）
  merged_text   TEXT,                   -- 合并后的最终表述（模型改写过才有值）
  similarity    REAL NOT NULL,
  decided_by    TEXT NOT NULL,          -- 'similarity' | 'model'
  reason        TEXT,                   -- 模型给的判断理由
  category      TEXT,
  entity        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_merge_kept ON memory_merges(kept_id);

-- ══════ 个股资金流历史 ══════
--
-- 为什么必须本地攒：东财 fflow 接口**只返回当天一行**。
--
-- 实测（2026-09-09 18:08，收盘后）：
--   push2delay .../fflow/kline/get?lmt=10   → 1 行
--   push2      .../fflow/kline/get?lmt=10   → 1 行
--   .../fflow/daykline/get?lmt=20           → 1 行
--   datacenter RPT_DMSK_TS_STOCKNEW?pageSize=10 → 1 行
-- 换茅台/平安银行/中国平安测，全都只有 1 行 —— 不是某只票的问题，
-- 也不是镜像域名的限制，是这个接口本身只供当日数据。
--
-- 后果（用户实际踩到的）：
--   「韶关算力这个利好落到哪些票上，得看主力净流入才能确认」
--   单日数据看不出资金是**持续进**还是**一日游**，
--   用户只能从涨幅和换手倒推。
--
-- 所以每次取到就存一天，天数自己长出来。同一票同一天用主键去重
-- （盘中多次调用只保留最后一次，收盘后的数据才是准的）。
CREATE TABLE IF NOT EXISTS fundflow_daily (
  code     TEXT NOT NULL,            -- 股票代码（6 位）
  date     TEXT NOT NULL,            -- 交易日 YYYY-MM-DD
  name     TEXT,                     -- 股票名称（东财返回，便于人工核对）
  main     REAL NOT NULL,            -- 主力净流入（元）
  small    REAL,                     -- 小单
  medium   REAL,                     -- 中单
  large    REAL,                     -- 大单
  source   TEXT,                     -- 数据来源域名，便于追溯是否延时源
  saved_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_ff_code_date ON fundflow_daily(code, date DESC);
`);

/* ── 消息 ── */
const _insMsg = db.prepare('INSERT INTO messages(role,content) VALUES(?,?)');
const _recentMsgs = db.prepare(
  'SELECT id,role,content,created_at FROM messages ORDER BY id DESC LIMIT ?');

function addMessage(role, content) {
  return _insMsg.run(role, content).lastInsertRowid;
}
function recentMessages(n = 20) {
  return _recentMsgs.all(n).reverse();
}

/* ── 记忆 ── */
const _insMem = db.prepare(
  `INSERT INTO memories(content,category,entity,weight,embedding,source_msg)
   VALUES(@content,@category,@entity,@weight,@embedding,@source_msg)`);
const _insFts = db.prepare('INSERT INTO mem_fts(body,mem_id) VALUES(?,?)');
const _upEntity = db.prepare(
  `INSERT INTO entities(name,category) VALUES(?,?)
   ON CONFLICT(name) DO UPDATE SET
     mention_cnt=mention_cnt+1, updated_at=datetime('now','localtime')`);

/** 向量 ⇄ BLOB */
function vecToBlob(v) {
  if (!v || !v.length) return null;
  return Buffer.from(new Float32Array(v).buffer);
}
function blobToVec(b) {
  if (!b) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

const addMemory = db.transaction((m) => {
  const id = _insMem.run({
    content: m.content,
    category: m.category || 'event',
    entity: m.entity || null,
    weight: m.weight == null ? 0.5 : m.weight,
    embedding: vecToBlob(m.embedding),
    source_msg: m.source_msg || null,
  }).lastInsertRowid;
  _insFts.run(cjkSplit(m.content), id);
  if (m.entity) _upEntity.run(m.entity, m.category || 'person');
  return id;
});

const _allMems = db.prepare(
  `SELECT id,content,category,entity,weight,read_count,embedding,created_at
   FROM memories`);
const _ftsSearch = db.prepare(
  `SELECT f.mem_id AS id, bm25(mem_fts) AS score
   FROM mem_fts f WHERE mem_fts MATCH ? ORDER BY score LIMIT ?`);
const _bumpRead = db.prepare(
  'UPDATE memories SET read_count=read_count+1 WHERE id=?');
const _memById = db.prepare(
  `SELECT id,content,category,entity,weight,read_count,created_at
   FROM memories WHERE id=?`);

function ftsSearch(q, limit = 30) {
  const query = ftsQuery(q);
  if (!query) return [];
  try { return _ftsSearch.all(query, limit); }
  catch { return []; }   // FTS5 语法异常不应让请求失败
}
function allMemories() { return _allMems.all(); }
function memById(id) { return _memById.get(id); }
function bumpRead(ids) {
  const tx = db.transaction(list => list.forEach(i => _bumpRead.run(i)));
  tx(ids);
}

/* ── 实体 / 星图 ── */
const _entities = db.prepare(
  `SELECT e.id, e.name, e.category, e.mention_cnt,
          (SELECT COUNT(*) FROM memories m WHERE m.entity = e.name) AS mem_cnt
   FROM entities e ORDER BY mem_cnt DESC, e.mention_cnt DESC`);
function entities() { return _entities.all(); }

const _counts = db.prepare(`
  SELECT (SELECT COUNT(*) FROM messages)  AS messages,
         (SELECT COUNT(*) FROM memories)  AS memories,
         (SELECT COUNT(*) FROM entities)  AS entities`);
function counts() { return _counts.get(); }

/* ── jiwen 状态 ── */
const _getState = db.prepare('SELECT v FROM agent_state WHERE k=?');
const _setState = db.prepare(
  `INSERT INTO agent_state(k,v) VALUES(?,?)
   ON CONFLICT(k) DO UPDATE SET v=excluded.v`);
function loadState(k) {
  const r = _getState.get(k);
  if (!r) return null;
  try { return JSON.parse(r.v); } catch { return null; }
}
function saveState(k, obj) { _setState.run(k, JSON.stringify(obj)); }

/* ── 记忆维护（memory_tidy 用）──
 *
 * 三个操作都是**保守的**：
 *   setMemoryWeight  只改权重，不删内容
 *   setMemoryContent 改表述（模型给了更好的合并说法时）
 *   mergeMemory      合并两条：权重取大、read_count 相加，然后删掉被合并的那条
 *
 * mergeMemory 是唯一会真删数据的操作，所以放在事务里，
 * 并且同步清理 FTS 索引（否则搜索会返回已删除记忆的幽灵结果）。
 */
const _setWeight  = db.prepare('UPDATE memories SET weight=? WHERE id=?');
const _setContent = db.prepare('UPDATE memories SET content=? WHERE id=?');
const _delMem     = db.prepare('DELETE FROM memories WHERE id=?');
const _delFts     = db.prepare('DELETE FROM mem_fts WHERE mem_id=?');
const _updFts     = db.prepare('UPDATE mem_fts SET body=? WHERE mem_id=?');
const _bumpMerged = db.prepare('UPDATE memories SET weight=?, read_count=? WHERE id=?');

function setMemoryWeight(id, w) {
  _setWeight.run(Math.max(0, Math.min(1, w)), id);
}

function setMemoryContent(id, content) {
  const tx = db.transaction(() => {
    _setContent.run(content, id);
    _updFts.run(cjkSplit(content), id);      // FTS 索引跟着更新，否则搜不到新表述
  });
  tx();
}

const mergeMemory = db.transaction((keepId, dropId, weight, readCount) => {
  _bumpMerged.run(Math.max(0, Math.min(1, weight)), readCount, keepId);
  _delFts.run(dropId);        // 先清索引
  _delMem.run(dropId);        // 再删记忆
});

/* ── 合并历史 ──
 *
 * 记录被删除记忆的原文，是这张表存在的核心理由：
 * 合并是唯一不可逆的操作，必须留一份可追溯的证据。 */
const _insMerge = db.prepare(
  `INSERT INTO memory_merges
     (kept_id, dropped_id, kept_before, dropped_text, merged_text,
      similarity, decided_by, reason, category, entity)
   VALUES (@kept_id, @dropped_id, @kept_before, @dropped_text, @merged_text,
           @similarity, @decided_by, @reason, @category, @entity)`);

const _mergesFor = db.prepare(
  `SELECT id, kept_id, dropped_id, kept_before, dropped_text, merged_text,
          similarity, decided_by, reason, created_at
   FROM memory_merges WHERE kept_id = ? ORDER BY id DESC`);

const _allMerges = db.prepare(
  `SELECT id, kept_id, dropped_id, kept_before, dropped_text, merged_text,
          similarity, decided_by, reason, category, entity, created_at
   FROM memory_merges ORDER BY id DESC LIMIT ?`);

const _mergeCounts = db.prepare(
  `SELECT kept_id, COUNT(*) AS n FROM memory_merges GROUP BY kept_id`);

function recordMerge(rec) {
  return _insMerge.run({
    kept_id: rec.keptId, dropped_id: rec.droppedId,
    kept_before: rec.keptBefore || '', dropped_text: rec.droppedText || '',
    merged_text: rec.mergedText || null,
    similarity: rec.similarity || 0,
    decided_by: rec.decidedBy || 'similarity',
    reason: rec.reason || null,
    category: rec.category || null, entity: rec.entity || null,
  }).lastInsertRowid;
}
function mergesFor(keptId) { return _mergesFor.all(keptId); }
function allMerges(limit = 200) { return _allMerges.all(limit); }
/** { memId: 合并次数 } —— 星图用来标记"这颗星吞并过几条记忆" */
function mergeCountMap() {
  const out = {};
  for (const r of _mergeCounts.all()) out[r.kept_id] = r.n;
  return out;
}

/* ── 资金流历史 ── */
const _insFF = db.prepare(`
  INSERT INTO fundflow_daily(code,date,name,main,small,medium,large,source)
  VALUES(@code,@date,@name,@main,@small,@medium,@large,@source)
  ON CONFLICT(code,date) DO UPDATE SET
    name=excluded.name, main=excluded.main, small=excluded.small,
    medium=excluded.medium, large=excluded.large,
    source=excluded.source, saved_at=datetime('now','localtime')`);
const _ffHistory = db.prepare(
  'SELECT * FROM fundflow_daily WHERE code=? ORDER BY date DESC LIMIT ?');
const _ffDays = db.prepare(
  'SELECT COUNT(*) n FROM fundflow_daily WHERE code=?');
const _ffCodes = db.prepare(
  'SELECT code, name, COUNT(*) days, MAX(date) latest FROM fundflow_daily GROUP BY code ORDER BY latest DESC');

/**
 * 存一天的资金流。
 *
 * 用 UPSERT 而不是 INSERT OR IGNORE：盘中数据会变，
 * 同一天重复调用应该用**最新**的覆盖旧的（收盘后的才是终值）。
 */
function saveFundFlow(row) {
  return _insFF.run({
    code: String(row.code), date: String(row.date),
    name: row.name || null,
    main: Number(row.main), small: Number(row.small),
    medium: Number(row.medium), large: Number(row.large),
    source: row.source || null,
  });
}
/** 取本地攒下的资金流历史（新→旧） */
function fundFlowHistory(code, limit = 30) {
  return _ffHistory.all(String(code), Math.max(1, Math.min(limit, 250)));
}
/** 这只票本地攒了几天 */
function fundFlowDayCount(code) {
  const r = _ffDays.get(String(code));
  return r ? r.n : 0;
}
/** 本地攒过哪些票 —— 用于告诉用户"哪些票已经有趋势可看" */
function fundFlowCodes() { return _ffCodes.all(); }

module.exports = {
  db, cjkSplit, ftsQuery, vecToBlob, blobToVec,
  addMessage, recentMessages,
  addMemory, ftsSearch, allMemories, memById, bumpRead,
  entities, counts, loadState, saveState,
  setMemoryWeight, setMemoryContent, mergeMemory,
  recordMerge, mergesFor, allMerges, mergeCountMap,
  saveFundFlow, fundFlowHistory, fundFlowDayCount, fundFlowCodes,
};
