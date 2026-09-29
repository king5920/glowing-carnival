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

/* ══ 错误账本（自我进化 第①层）══════════════════════════════
 *
 * 用户 2026-09-10：「能找到自己的错误并自进化」。
 *
 * 这个会话里反复出现一类问题：错误当时被发现（靠用户或靠重测），
 * 但发现之后没有沉淀，下次换个地方同类错误再犯 ——
 * 猜返回字段名、把非空当成功、静默 catch、单次观测下结论。
 *
 * 账本只追加、不改写（和资金流校准样本同原则）。
 * 它记的不是"接口挂了"（那是 source_health 的职责），
 * 而是【预期 vs 现实不符】—— 尤其"我以为对但其实错"这一类，
 * 因为那是最危险、最容易静默的。
 *
 * 第②层（回答前按工具把教训注入 system）读的就是这张表。
 * 第③层（自动生成测试）暂不做，等真的看到同类错误重复再说。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  scope       TEXT,                 -- 场景：工具名 / 模块名
  pattern     TEXT,                 -- 错误模式分类（见 lessons.js PATTERNS）
  expected    TEXT,                 -- 当时以为会怎样
  actual      TEXT,                 -- 实际怎样
  root_cause  TEXT,                 -- 一句话根因
  guard       TEXT,                 -- 下次怎么抓（可执行的检查方式）
  occurrence  INTEGER NOT NULL DEFAULT 1,   -- 同类教训出现次数（复发计数）
  first_ts    TEXT,                 -- 第一次出现的时间
  test_locked INTEGER NOT NULL DEFAULT 0,   -- 是否已固化成测试（第③层占位）
  sig         TEXT                  -- 去重指纹：scope|pattern
);
CREATE INDEX IF NOT EXISTS idx_lessons_sig ON lessons(sig);
CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope);
`);

/* ══ 盯盘预警信号样本（标定底座，和 close_scan 校准同一哲学）══════════
 *
 * 用户 2026-09-10 要"大盘情绪/技术到买入标准就提示、主线调整到位就提醒"。
 * 但"涨停35家/炸板率38%"算冷还是热，一天定不了 —— 阈值必须来自实测分布，
 * 不能拍脑袋（项目已有教训：30亿资金门槛被分布打脸）。
 *
 * 所以先攒快照：盘中每个交易时段定时把情绪+技术指标原样存下来。
 * 攒够 15-20 个交易日后算分位数定阈值；同时存信号触发后的前向收益
 * （fwd_d1/fwd_d3 用上证指数次日/3日后收盘），事后检验信号有没有用。
 *
 * 一条 = 某个交易日的一次盘中快照（同一时段去重，靠 date+slot 主键）。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS alert_samples (
  date           TEXT NOT NULL,           -- YYYY-MM-DD
  slot           TEXT NOT NULL,           -- 时段标记：open/midday/close 等
  sampled_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  limit_up       INTEGER,                 -- 涨停家数
  broken         INTEGER,                 -- 炸板家数
  limit_down     INTEGER,                 -- 跌停家数
  broken_rate    REAL,                    -- 炸板率 %
  ladder_height  INTEGER,                 -- 最高连板
  seal_fund_yi   REAL,                    -- 封板资金合计（亿）
  sh_close       REAL,                    -- 上证收盘(快照时点)
  sh_above_ma5   INTEGER,                 -- 站上MA5 (0/1/null)
  sh_above_ma20  INTEGER,
  sh_rsi14       REAL,
  sh_macd_cross  TEXT,                    -- golden/dead/null
  cyb_close      REAL,                    -- 创业板
  cyb_above_ma20 INTEGER,
  cyb_rsi14      REAL,
  cyb_macd_cross TEXT,
  fwd_d1         REAL,                    -- 上证次日收益%(事后回填)
  fwd_d3         REAL,                    -- 3日收益%
  raw            TEXT,                    -- 完整快照 JSON 备查
  PRIMARY KEY (date, slot)
);
CREATE INDEX IF NOT EXISTS idx_alert_date ON alert_samples(date);

/* ── 盘中板块资金快照（异动盯盘的底座）──
 *
 * 为什么必须落库：异动 = 「现在」和「刚才」的差。
 * 东财 clist 只给当下截面（今日/5日/10日累计净额），
 * 不存快照就永远只能说"现在流入多少"，说不了"刚刚突然涌入"。
 *
 * 粒度：同日同板块同 slot 覆盖写（slot 用 HH:MM 向下取整到 5 分钟）。
 * 只存进了 top 池的板块，不是全部 961 个 —— 全存一天 11 万行，
 * 而异动只可能发生在有资金的板块里，存尾部纯属浪费。
 *
 * fwd_* 留给事后验证：和 alert_samples 一样，
 * 没有前向收益就无法判断"异动提示"到底有没有用。 */
CREATE TABLE IF NOT EXISTS sector_flow_snap (
  date        TEXT NOT NULL,            -- YYYY-MM-DD
  slot        TEXT NOT NULL,            -- HH:MM（5 分钟粒度）
  code        TEXT NOT NULL,            -- 板块代码 BKxxxx
  name        TEXT NOT NULL,
  kind        TEXT,                     -- industry/concept
  sampled_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  data_ts     TEXT,                     -- 行情自带时点，判断数据是否卡住
  level       REAL,                     -- 板块指数点位（前向收益唯一依据）
  change_pct  REAL,
  today_yi    REAL,                     -- 今日主力净额（亿）
  d5_yi       REAL,
  d10_yi      REAL,
  main_pct    REAL,
  up_count    INTEGER,
  down_count  INTEGER,
  leader      TEXT,
  leader_pct  REAL,
  fwd_d1      REAL,                     -- 事后回填：次日板块涨幅%
  fwd_d3      REAL,
  PRIMARY KEY (date, slot, code)
);
CREATE INDEX IF NOT EXISTS idx_secsnap_date ON sector_flow_snap(date);
CREATE INDEX IF NOT EXISTS idx_secsnap_code ON sector_flow_snap(code, date);

/* ── 板块每日定格（跨日主线追踪的底座）──
 *
 * 为什么必须单独一张表：
 * sector_flow_snap 是盘中分钟级快照，只在当天内做差，明天重新建基线。
 * 但「主线板块不是一天能看出来的」—— 判断主线要看的是
 * 「连续几天净流入」「资金是加速还是衰竭」「涨幅有没有兑现资金」，
 * 这些都需要跨日序列。
 *
 * close_scan 每天收盘都在算这些数，但算完就扔了（它连 db 都没 require）。
 * 于是「元件板块连续 8 天净流入」这种判断，系统永远答不出来 ——
 * 只能重复东财给的 5日/10日累计，那是别人算好的，且无法回溯、无法验证。
 *
 * 一天一行，收盘后定格。字段和快照表对齐，便于互相印证。
 *
 * fwd_*：前向收益，事后回填。没有它就永远无法回答
 * 「这套主线打分到底准不准」——这是第四优先要做的回归。 */
CREATE TABLE IF NOT EXISTS sector_daily (
  date        TEXT NOT NULL,            -- 交易日 YYYY-MM-DD
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  data_ts     TEXT,                     -- 行情自带时点
  level       REAL,                     -- 板块指数收盘点位（算前向收益唯一依据）
  change_pct  REAL,                     -- 当日涨跌幅
  today_yi    REAL,                     -- 当日主力净额（亿）
  d5_yi       REAL,                     -- 东财口径 5 日累计
  d10_yi      REAL,                     -- 东财口径 10 日累计
  main_pct    REAL,
  up_count    INTEGER,
  down_count  INTEGER,
  leader      TEXT,
  leader_code TEXT,
  leader_pct  REAL,
  score       REAL,                     -- close_scan 当日主线打分
  grade       TEXT,                     -- 主线候选/强势板块/...
  fwd_d1      REAL,                     -- 次日涨幅%（事后回填）
  fwd_d3      REAL,
  fwd_d5      REAL,
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_secdaily_date ON sector_daily(date);
CREATE INDEX IF NOT EXISTS idx_secdaily_code ON sector_daily(code, date);

/* ── 持续选股：候选个股池（每日快照，date+code 覆盖）── */
CREATE TABLE IF NOT EXISTS stock_pool (
  date        TEXT NOT NULL,             -- YYYY-MM-DD
  code        TEXT NOT NULL,
  name        TEXT,
  sector      TEXT,                      -- 来源板块名（连板池来源可为 NULL）
  source      TEXT,                      -- leader_mainline / leader_strong / zt_ladder
  leader      INTEGER,                   -- 是否板块领涨股 0/1
  price       REAL,
  score       REAL,
  reasons     TEXT,                      -- JSON 数组（每分可追溯）
  data_ts     TEXT,                      -- K线末根日期
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_pool_date ON stock_pool(date);

/* ── 买卖点条件式信号（同日同股同类型只记一次）── */
CREATE TABLE IF NOT EXISTS stock_signals (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT,
  sig_type     TEXT NOT NULL,            -- buy_near_support/buy_breakout/buy_golden_cross/sell_broken_ma20/sell_overbought
  trigger_desc TEXT NOT NULL,
  ref_price    REAL,
  ref_ma20     REAL,
  as_of        TEXT NOT NULL,            -- 信号判定时点（本地时间）
  data_ts      TEXT,
  market_ok    INTEGER,                  -- 大盘买入窗口 0/1（卖点类恒 1）
  source       TEXT,                     -- intraday / close
  PRIMARY KEY (date, code, sig_type)
);
CREATE INDEX IF NOT EXISTS idx_sig_date ON stock_signals(date);
`);

/* ── 分钟K线持久化（缠论多级别递归的底座）──
 *
 * 为什么要自己存：免费分钟源历史浅（5/15分仅数月、1分仅当天、新浪各档1023根），
 * 无法回填长历史。只能从上线日起每根 bar 收盘后落库，逐日累积出可做中枢/回测的序列。
 *
 * 粒度：code+period+bar_time 唯一，UPSERT 覆盖（同一根 bar 收盘后重刷幂等）。
 * 只在 bar 收盘后写（盘中未完成K不入库），避免缠论结构随未完成K闪烁。
 * 第一版只采大盘指数（上证 000001 的 m30/m60/day），故量很小。
 * period: m1/m5/m15/m30/m60/day；bar_time 分钟级 'YYYY-MM-DD HH:mm'、日线 'YYYY-MM-DD'。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS minute_kline (
  code       TEXT NOT NULL,
  period     TEXT NOT NULL,
  bar_time   TEXT NOT NULL,
  open       REAL,
  close      REAL,
  high       REAL,
  low        REAL,
  volume     REAL,
  source     TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (code, period, bar_time)
);
CREATE INDEX IF NOT EXISTS idx_mk_code_time ON minute_kline(code, period, bar_time);
`);

/* ── 迁移：alert_samples 增加 fwd_d5（多因子标定需要 5 日前向收益）──
 * 旧库无此列；用 PRAGMA 检查后再 ALTER，保证重复启动幂等。 */
(function migrateAlertFwd5(){
  const cols = db.prepare('PRAGMA table_info(alert_samples)').all().map(c => c.name);
  if (!cols.includes('fwd_d5')) {
    db.exec('ALTER TABLE alert_samples ADD COLUMN fwd_d5 REAL');
  }
})();

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

/* ── 语音识别领域词表 ──
 * whisper 的 initial_prompt 是"先验词表"，喂过的股票名/板块名才念得准
 * （实测同一批录音：无词表 58% → 有词表 92%）。
 * 这里把用户真实接触过的专名汇成一个去重、限长的列表：
 *   ① fundflow_daily 里查过资金的个股
 *   ② sector_daily 最近的板块名 + 领涨股名（收盘扫描攒下的）
 * 全部按"最近活跃"排序，名字限制约 60 字，避免挤掉音频上下文。 */
const _sectorVocab = db.prepare(`
  SELECT name AS n FROM sector_daily
   WHERE date = (SELECT MAX(date) FROM sector_daily)
   ORDER BY COALESCE(score,0) DESC LIMIT 40`);
const _sectorLeaders = db.prepare(`
  SELECT leader AS n FROM sector_daily
   WHERE date >= date((SELECT MAX(date) FROM sector_daily), '-6 day')
     AND leader IS NOT NULL AND leader <> ''
   ORDER BY date DESC LIMIT 30`);

/** 语音识别用的领域专名（股票+板块+龙头），返回去重后的中文名字数组。 */
function voiceVocab(limit = 24) {
  const out = [];
  const push = (n) => {
    n = String(n == null ? '' : n).trim();
    if (!n || out.includes(n)) return;
    out.push(n);
  };
  // 个股优先（用户点名查过的最可能再次被点）
  for (const r of fundFlowCodes()) push(r.name);
  // 最近板块龙头
  try { for (const r of _sectorLeaders.all()) push(r.n); } catch {}
  // 板块名放最后（术语类，base 本身已较稳）
  try { for (const r of _sectorVocab.all()) push(r.n); } catch {}
  // 按总字数封顶：中文专名按字符数算
  const capped = [];
  let chars = 0;
  for (const n of out) {
    if (chars + n.length > 60 || capped.length >= limit) break;
    capped.push(n);
    chars += n.length;
  }
  return capped;
}

/* ── 错误账本 ── */
const _insLesson = db.prepare(`
  INSERT INTO lessons(ts,scope,pattern,expected,actual,root_cause,guard,sig,first_ts)
  VALUES(datetime('now','localtime'),@scope,@pattern,@expected,@actual,@root_cause,@guard,@sig,
         datetime('now','localtime'))`);
/* 同指纹复发：只累加次数并刷新，不新增行（否则账本会被同一错误刷屏） */
const _bumpLesson = db.prepare(`
  UPDATE lessons SET occurrence = occurrence + 1, ts = datetime('now','localtime')
  WHERE id = ?`);
const _findLessonSig = db.prepare('SELECT id FROM lessons WHERE sig = ? ORDER BY id DESC LIMIT 1');
const _lessonsByScope = db.prepare(
  'SELECT * FROM lessons WHERE scope = ? ORDER BY occurrence DESC, ts DESC LIMIT ?');
const _recentLessons = db.prepare(
  'SELECT * FROM lessons ORDER BY ts DESC LIMIT ?');
const _allLessons = db.prepare('SELECT * FROM lessons ORDER BY ts DESC');
const _lessonCount = db.prepare('SELECT COUNT(*) n FROM lessons');

/**
 * 记一条教训。同 scope+pattern 视为复发，累加 occurrence 而不是新增。
 * @returns {{id, repeated:boolean, occurrence:number}}
 */
function addLesson(l) {
  const scope = String(l.scope || 'unknown').slice(0, 120);
  const pattern = String(l.pattern || 'uncategorized').slice(0, 80);
  const sig = scope + '|' + pattern;
  const existing = _findLessonSig.get(sig);
  if (existing) {
    _bumpLesson.run(existing.id);
    return { id: existing.id, repeated: true };
  }
  const info = _insLesson.run({
    scope, pattern,
    expected: String(l.expected || '').slice(0, 500),
    actual: String(l.actual || '').slice(0, 500),
    root_cause: String(l.rootCause || '').slice(0, 500),
    guard: String(l.guard || '').slice(0, 500),
    sig,
  });
  return { id: Number(info.lastInsertRowid), repeated: false };
}
function lessonsFor(scope, limit = 5) {
  return _lessonsByScope.all(String(scope), Math.max(1, Math.min(limit, 20)));
}
function recentLessons(limit = 20) {
  return _recentLessons.get
    ? _recentLessons.all(Math.max(1, Math.min(limit, 200)))
    : [];
}
function allLessons() { return _allLessons.all(); }
function lessonCount() { return _lessonCount.get().n; }

/* ── 盯盘预警样本 ── */
const _insAlert = db.prepare(`
  INSERT INTO alert_samples
    (date,slot,sampled_at,limit_up,broken,limit_down,broken_rate,ladder_height,seal_fund_yi,
     sh_close,sh_above_ma5,sh_above_ma20,sh_rsi14,sh_macd_cross,
     cyb_close,cyb_above_ma20,cyb_rsi14,cyb_macd_cross,raw)
  VALUES
    (@date,@slot,datetime('now','localtime'),@limit_up,@broken,@limit_down,@broken_rate,@ladder_height,@seal_fund_yi,
     @sh_close,@sh_above_ma5,@sh_above_ma20,@sh_rsi14,@sh_macd_cross,
     @cyb_close,@cyb_above_ma20,@cyb_rsi14,@cyb_macd_cross,@raw)
  ON CONFLICT(date,slot) DO UPDATE SET
    sampled_at=excluded.sampled_at, limit_up=excluded.limit_up, broken=excluded.broken,
    limit_down=excluded.limit_down, broken_rate=excluded.broken_rate,
    ladder_height=excluded.ladder_height, seal_fund_yi=excluded.seal_fund_yi,
    sh_close=excluded.sh_close, sh_above_ma5=excluded.sh_above_ma5,
    sh_above_ma20=excluded.sh_above_ma20, sh_rsi14=excluded.sh_rsi14,
    sh_macd_cross=excluded.sh_macd_cross, cyb_close=excluded.cyb_close,
    cyb_above_ma20=excluded.cyb_above_ma20, cyb_rsi14=excluded.cyb_rsi14,
    cyb_macd_cross=excluded.cyb_macd_cross, raw=excluded.raw`);
const _alertRows = db.prepare('SELECT * FROM alert_samples ORDER BY date, slot');
const _alertDates = db.prepare("SELECT DISTINCT date FROM alert_samples ORDER BY date");

/** 把 sentiment.snapshot() 落成一行样本。slot 区分盘中时段，同日同时段覆盖。 */
function saveAlertSample(date, slot, snap) {
  const se = snap.sentiment || {};
  const sh = snap.indexes?.上证 || {};
  const cyb = snap.indexes?.创业板 || {};
  const b = v => (v == null ? null : v ? 1 : 0);
  return _insAlert.run({
    date, slot,
    limit_up: se.limitUpCount ?? null,
    broken: se.brokenCount ?? null,
    limit_down: se.limitDownCount ?? null,
    broken_rate: se.brokenRate ?? null,
    ladder_height: se.ladderHeight ?? null,
    seal_fund_yi: se.sealFundYi ?? null,
    sh_close: sh.close ?? null,
    sh_above_ma5: b(sh.aboveMa5),
    sh_above_ma20: b(sh.aboveMa20),
    sh_rsi14: sh.rsi14 ?? null,
    sh_macd_cross: sh.macdCross || null,
    cyb_close: cyb.close ?? null,
    cyb_above_ma20: b(cyb.aboveMa20),
    cyb_rsi14: cyb.rsi14 ?? null,
    cyb_macd_cross: cyb.macdCross || null,
    raw: JSON.stringify(snap).slice(0, 200000),
  });
}
function alertSamples() { return _alertRows.all(); }
function alertSampleDates() { return _alertDates.all().map(r => r.date); }

/**
 * 每日【一条】样本（供崩溃冰点算分位）。
 * 同一天可能有 open/mid_am/midday/close/backfill 多个 slot —— 盘中 slot 是未定型值，
 * 直接全用会让某天被重复计权。优先级取当天最"定型"的一条：
 *   close > midday > mid_am > open > backfill > 其它。
 * 返回按日期升序、每天一行。
 */
function alertSamplesDaily() {
  const rows = _alertRows.all();
  const SLOT_RANK = { close: 5, midday: 4, mid_am: 3, open: 2, backfill: 1 };
  const byDate = new Map();
  for (const r of rows) {
    const cur = byDate.get(r.date);
    const rank = SLOT_RANK[r.slot] ?? 0;
    if (!cur || rank > (SLOT_RANK[cur.slot] ?? 0)) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

/* 回填某日(指定slot)的前向收益；upsert 只更新 fwd_d1/d3/d5 */
const _upAlertFwd = db.prepare(
  'UPDATE alert_samples SET fwd_d1=@d1,fwd_d3=@d3,fwd_d5=@d5 WHERE date=@date AND slot=@slot');
function updateAlertFwd(date, slot, d1, d3, d5) {
  return _upAlertFwd.run({ date, slot, d1, d3, d5 });
}

/* ── 盘中板块资金快照 ── */
const _insSecSnap = db.prepare(`
  INSERT INTO sector_flow_snap
    (date,slot,code,name,kind,sampled_at,data_ts,level,change_pct,
     today_yi,d5_yi,d10_yi,main_pct,up_count,down_count,leader,leader_pct)
  VALUES
    (@date,@slot,@code,@name,@kind,datetime('now','localtime'),@data_ts,@level,@change_pct,
     @today_yi,@d5_yi,@d10_yi,@main_pct,@up_count,@down_count,@leader,@leader_pct)
  ON CONFLICT(date,slot,code) DO UPDATE SET
    sampled_at=excluded.sampled_at, data_ts=excluded.data_ts,
    level=excluded.level, change_pct=excluded.change_pct,
    today_yi=excluded.today_yi, d5_yi=excluded.d5_yi, d10_yi=excluded.d10_yi,
    main_pct=excluded.main_pct, up_count=excluded.up_count,
    down_count=excluded.down_count, leader=excluded.leader, leader_pct=excluded.leader_pct`);

const _secSnapAt = db.prepare(
  'SELECT * FROM sector_flow_snap WHERE date=? AND slot=?');
const _secSnapSlots = db.prepare(
  'SELECT DISTINCT slot FROM sector_flow_snap WHERE date=? ORDER BY slot');
const _secSnapDates = db.prepare(
  'SELECT DISTINCT date FROM sector_flow_snap ORDER BY date');
const _secSnapCode = db.prepare(
  'SELECT * FROM sector_flow_snap WHERE code=? AND date=? ORDER BY slot');

/** 批量落一个 slot 的板块快照。rows 是 close_scan 的板块对象数组。 */
function saveSectorSnap(date, slot, rows) {
  const tx = db.transaction(list => {
    for (const s of list) {
      _insSecSnap.run({
        date, slot,
        code: s.code, name: s.name, kind: s.kind || null,
        data_ts: s.dataTs || null,
        level: s.level ?? null,
        change_pct: s.changePct ?? null,
        today_yi: s.todayYi ?? null,
        d5_yi: s.d5Yi ?? null,
        d10_yi: s.d10Yi ?? null,
        main_pct: s.mainPct ?? null,
        up_count: s.upCount ?? null,
        down_count: s.downCount ?? null,
        leader: s.leader || null,
        leader_pct: s.leaderPct ?? null,
      });
    }
  });
  tx(rows);
  return rows.length;
}
function sectorSnapAt(date, slot) { return _secSnapAt.all(date, slot); }
function sectorSnapSlots(date) { return _secSnapSlots.all(date).map(r => r.slot); }
function sectorSnapDates() { return _secSnapDates.all().map(r => r.date); }
function sectorSnapHistory(code, date) { return _secSnapCode.all(code, date); }

/* ── 板块每日定格（跨日主线追踪）── */
const _insSecDaily = db.prepare(`
  INSERT INTO sector_daily
    (date,code,name,kind,captured_at,data_ts,level,change_pct,today_yi,d5_yi,d10_yi,
     main_pct,up_count,down_count,leader,leader_code,leader_pct,score,grade)
  VALUES
    (@date,@code,@name,@kind,datetime('now','localtime'),@data_ts,@level,@change_pct,
     @today_yi,@d5_yi,@d10_yi,@main_pct,@up_count,@down_count,@leader,@leader_code,
     @leader_pct,@score,@grade)
  ON CONFLICT(date,code) DO UPDATE SET
    captured_at=excluded.captured_at, data_ts=excluded.data_ts, level=excluded.level,
    change_pct=excluded.change_pct, today_yi=excluded.today_yi, d5_yi=excluded.d5_yi,
    d10_yi=excluded.d10_yi, main_pct=excluded.main_pct, up_count=excluded.up_count,
    down_count=excluded.down_count, leader=excluded.leader, leader_code=excluded.leader_code,
    leader_pct=excluded.leader_pct, score=excluded.score, grade=excluded.grade`);

const _secDailyDates = db.prepare('SELECT DISTINCT date FROM sector_daily ORDER BY date');
const _secDailyAt = db.prepare('SELECT * FROM sector_daily WHERE date=? ORDER BY today_yi DESC');
/* 取某板块最近 N 个交易日，按日期正序 —— 连续性判断依赖顺序 */
const _secDailyCode = db.prepare(
  'SELECT * FROM sector_daily WHERE code=? ORDER BY date DESC LIMIT ?');
/* 跨日汇总：最近 N 日内每个板块的累计净额与出现天数 */
const _secDailyRange = db.prepare(
  'SELECT * FROM sector_daily WHERE date >= ? ORDER BY code, date');
const _secDailyNeedFwd = db.prepare(
  'SELECT DISTINCT date FROM sector_daily WHERE fwd_d1 IS NULL ORDER BY date');
const _updFwd = db.prepare(
  'UPDATE sector_daily SET fwd_d1=@d1, fwd_d3=@d3, fwd_d5=@d5 WHERE date=@date AND code=@code');

/** 收盘后把当日板块定格成一行。rows 来自 close_scan 的板块数组。 */
function saveSectorDaily(date, rows) {
  const tx = db.transaction(list => {
    for (const s of list) {
      _insSecDaily.run({
        date,
        code: s.code, name: s.name, kind: s.kind || null,
        data_ts: s.dataTs || null,
        level: s.level ?? null,
        change_pct: s.changePct ?? null,
        today_yi: s.todayYi ?? null,
        d5_yi: s.d5Yi ?? null,
        d10_yi: s.d10Yi ?? null,
        main_pct: s.mainPct ?? null,
        up_count: s.upCount ?? null,
        down_count: s.downCount ?? null,
        leader: s.leader || null,
        leader_code: s.leaderCode || null,
        leader_pct: s.leaderPct ?? null,
        score: s.score ?? null,
        grade: s.grade || null,
      });
    }
  });
  tx(rows);
  return rows.length;
}
function sectorDailyDates() { return _secDailyDates.all().map(r => r.date); }
function sectorDailyAt(date) { return _secDailyAt.all(date); }
function sectorDailyFor(code, limit = 30) { return _secDailyCode.all(code, limit); }
function sectorDailySince(date) { return _secDailyRange.all(date); }
function sectorDailyDatesNeedingFwd() { return _secDailyNeedFwd.all().map(r => r.date); }
function updateSectorFwd(date, code, d1, d3, d5) {
  return _updFwd.run({ date, code, d1, d3, d5 });
}

/* ── 持续选股：候选个股池 ── */
const _insPool = db.prepare(`
  INSERT INTO stock_pool (date,code,name,sector,source,leader,price,score,reasons,data_ts)
  VALUES (@date,@code,@name,@sector,@source,@leader,@price,@score,@reasons,@data_ts)
  ON CONFLICT(date,code) DO UPDATE SET
    name=excluded.name, sector=excluded.sector, source=excluded.source,
    leader=excluded.leader, price=excluded.price, score=excluded.score,
    reasons=excluded.reasons, data_ts=excluded.data_ts`);
const _poolAt = db.prepare('SELECT * FROM stock_pool WHERE date=? ORDER BY score DESC');
const _poolLatestDate = db.prepare('SELECT MAX(date) AS d FROM stock_pool');

/** rows: [{code,name,sector,source,leader,price,score,reasons,data_ts}] */
function saveStockPool(date, rows) {
  const tx = db.transaction(list => {
    for (const r of list) {
      _insPool.run({
        date,
        code: r.code, name: r.name || null, sector: r.sector || null,
        source: r.source || null, leader: r.leader ? 1 : 0,
        price: r.price ?? null, score: r.score ?? null,
        reasons: r.reasons ? JSON.stringify(r.reasons) : null,
        data_ts: r.dataTs || null,
      });
    }
  });
  tx(rows);
  return rows.length;
}
function stockPoolAt(date) {
  return _poolAt.all(date).map(r => ({ ...r, reasons: r.reasons ? JSON.parse(r.reasons) : null }));
}
function latestStockPool() {
  const row = _poolLatestDate.get();
  if (!row || !row.d) return [];
  return stockPoolAt(row.d);
}

/* ── 买卖点条件式信号 ── */
const _insSig = db.prepare(`
  INSERT INTO stock_signals
    (date,code,name,sig_type,trigger_desc,ref_price,ref_ma20,as_of,data_ts,market_ok,source)
  VALUES
    (@date,@code,@name,@sig_type,@trigger_desc,@ref_price,@ref_ma20,@as_of,@data_ts,@market_ok,@source)
  ON CONFLICT(date,code,sig_type) DO UPDATE SET
    name=excluded.name, trigger_desc=excluded.trigger_desc, ref_price=excluded.ref_price,
    ref_ma20=excluded.ref_ma20, as_of=excluded.as_of, data_ts=excluded.data_ts,
    market_ok=excluded.market_ok, source=excluded.source`);
const _sigsOn = db.prepare('SELECT * FROM stock_signals WHERE date=? ORDER BY market_ok DESC, code');
const _sigsLatestDate = db.prepare('SELECT MAX(date) AS d FROM stock_signals');
const _sigsRecent = db.prepare('SELECT * FROM stock_signals ORDER BY date DESC, code LIMIT ?');

function saveStockSignal(row) {
  return _insSig.run({
    date: row.date, code: row.code, name: row.name || null,
    sig_type: row.sigType, trigger_desc: row.triggerDesc,
    ref_price: row.refPrice ?? null, ref_ma20: row.refMa20 ?? null,
    as_of: row.asOf, data_ts: row.dataTs || null,
    market_ok: row.marketOk ? 1 : 0, source: row.source || null,
  });
}
function stockSignalsOn(date) { return _sigsOn.all(date); }
function latestStockSignals(limit = 30) {
  const row = _sigsLatestDate.get();
  if (!row || !row.d) return [];
  return _sigsRecent.all(limit).filter(r => r.date === row.d);
}

/* ── 分钟K线（缠论底座）：批量 UPSERT + 读取 ── */
const _upsertMinuteBar = db.prepare(`
  INSERT INTO minute_kline (code,period,bar_time,open,close,high,low,volume,source,updated_at)
  VALUES (@code,@period,@bar_time,@open,@close,@high,@low,@volume,@source,datetime('now','localtime'))
  ON CONFLICT(code,period,bar_time) DO UPDATE SET
    open=excluded.open, close=excluded.close, high=excluded.high, low=excluded.low,
    volume=excluded.volume, source=excluded.source,
    updated_at=datetime('now','localtime')
`);

/**
 * 批量落分钟/日K。bars 为 stock_kline 归一格式 {date,open,close,high,low,volume}，
 * date 即 bar_time（分钟 'YYYY-MM-DD HH:mm'、日 'YYYY-MM-DD'）。幂等，可重复灌。
 */
function saveMinuteBars(code, period, bars, source = null) {
  if (!bars || !bars.length) return 0;
  const tx = db.transaction(list => {
    for (const b of list) {
      _upsertMinuteBar.run({
        code, period, bar_time: b.date,
        open: b.open ?? null, close: b.close ?? null, high: b.high ?? null,
        low: b.low ?? null, volume: b.volume ?? null, source,
      });
    }
  });
  tx(bars);
  return bars.length;
}
const _mkBars = db.prepare(
  'SELECT bar_time AS date,open,close,high,low,volume,source FROM minute_kline '
  + 'WHERE code=? AND period=? ORDER BY bar_time');
function minuteBars(code, period) { return _mkBars.all(code, period); }
const _mkLatest = db.prepare(
  'SELECT bar_time AS date FROM minute_kline WHERE code=? AND period=? ORDER BY bar_time DESC LIMIT 1');
function latestMinuteBar(code, period) { const r = _mkLatest.get(code, period); return r ? r.date : null; }
function minuteBarCount(code, period) {
  return db.prepare(
    'SELECT COUNT(*) n FROM minute_kline WHERE code=? AND period=?').get(code, period).n;
}

module.exports = {
  db, cjkSplit, ftsQuery, vecToBlob, blobToVec,
  addMessage, recentMessages,
  addMemory, ftsSearch, allMemories, memById, bumpRead,
  entities, counts, loadState, saveState,
  setMemoryWeight, setMemoryContent, mergeMemory,
  recordMerge, mergesFor, allMerges, mergeCountMap,
  saveFundFlow, fundFlowHistory, fundFlowDayCount, fundFlowCodes, voiceVocab,
  addLesson, lessonsFor, recentLessons, allLessons, lessonCount,
  saveAlertSample, alertSamples, alertSamplesDaily, alertSampleDates, updateAlertFwd,
  saveSectorSnap, sectorSnapAt, sectorSnapSlots, sectorSnapDates, sectorSnapHistory,
  saveSectorDaily, sectorDailyDates, sectorDailyAt, sectorDailyFor, sectorDailySince,
  sectorDailyDatesNeedingFwd, updateSectorFwd,
  saveStockPool, stockPoolAt, latestStockPool,
  saveStockSignal, stockSignalsOn, latestStockSignals,
  saveMinuteBars, minuteBars, latestMinuteBar, minuteBarCount,
};
