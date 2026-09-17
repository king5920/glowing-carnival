'use strict';
/**
 * fuyao.js —— 同花顺 fuyao（hithink-finance）A股数据客户端
 * ─────────────────────────────────────────────────────────
 * 官方文档：https://fuyao.aicubes.cn/docs/
 * 鉴权：请求头 X-api-key，Key 只从环境变量 FUYAO_API_KEY 或项目根 .env 读，
 *       绝不硬编码、不写日志、不在返回里带出。
 *
 * 本模块当前只接 JARVIS 需要的【情绪三池 + 连板天梯】：
 *   /api/a-share/special-data/limit-up-pool    涨停池（按交易日）
 *   /api/a-share/special-data/limit-down-pool  跌停池
 *   /api/a-share/special-data/limit-break-pool 炸板池
 *   /api/a-share/special-data/limit-up-ladder  近30交易日连板天梯
 *
 * 与现有情绪口径对齐（见 sentiment.js）：
 *   - 逐只个股套 universe 白名单（主板 600/601/603/605 + 深 000/001/002/003
 *     + 创业板 300/301，剔 ST/退/科创/北交）。指数/板块不过滤。
 *   - 炸板率 = 炸板 / (涨停 + 炸板)，同宇宙分子分母；两者都0 → null（不编0）。
 *   - 任一子源失败 → 抛错给调用方，绝不拿 null 当 0。
 * 零新增依赖，仅内置 https。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const universe = require('./universe');

const HOST = 'fuyao.aicubes.cn';
const PAGE_SIZE_MAX = 200;

/* ── Key：进程环境优先，回退到根 .env（与 llm.loadEnv 同款极简解析，不引 dotenv）── */
function readEnvFile() {
  const out = {};
  try {
    const p = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  } catch (_) { /* 读不到就空，由 hasKey 体现 */ }
  return out;
}
let _key = null;
function apiKey() {
  if (_key !== null) return _key;
  _key = (process.env.FUYAO_API_KEY || readEnvFile().FUYAO_API_KEY || '').trim();
  return _key;
}
/** 测试/热重载用 */
function setApiKey(k) { _key = k == null ? null : String(k); }
function hasKey() { return !!apiKey(); }

/* ── 纯函数：上海时区某天 00:00(+08:00) 的 Unix 毫秒戳（=前一日 16:00 UTC）── */
function shMidnightMs(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
  return Date.UTC(y, m - 1, d - 1, 16, 0, 0, 0);
}
/** Date → 'YYYYMMDD'（上海日历日） */
function ymdOf(date) {
  // 用 +08:00 偏移取出上海年月日，避免 UTC 跨日误差
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10).replace(/-/g, '');
}

/* ── HTTP（带限流/上游超时退避）── */
function rawGet(reqPath, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: reqPath, method: 'GET',
      headers: { 'X-api-key': apiKey(), 'User-Agent': 'jarvis-fuyao/1.0', 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, res => {
      let s = '';
      res.on('data', d => (s += d));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(Object.assign(new Error('fuyao 429 限流'), { retryable: true, status: 429 }));
        let j;
        try { j = JSON.parse(s); } catch (e) { return reject(new Error('fuyao 非JSON响应: ' + s.slice(0, 100))); }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('fuyao 请求超时')));
    req.end();
  });
}

const RETRYABLE_CODES = new Set([4001, 5002, 5003]);   // 限流/上游超时/上游不可用
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 带退避的 GET，返回解包后的 data；业务码非0且不可重试则抛错。 */
async function getJson(reqPath, { retries = 2, baseWaitMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let j;
    try {
      j = await rawGet(reqPath);
    } catch (e) {
      lastErr = e;
      if (e.retryable && attempt < retries) { await sleep(baseWaitMs * (attempt + 1)); continue; }
      throw e;
    }
    if (j.code === 0) return j.data;
    if (RETRYABLE_CODES.has(j.code) && attempt < retries) {
      lastErr = new Error('fuyao code=' + j.code + ' ' + j.message);
      await sleep(baseWaitMs * (attempt + 1));
      continue;
    }
    const err = new Error('fuyao code=' + j.code + ' ' + j.message);
    err.code = j.code; err.business = true;
    throw err;
  }
  throw lastErr || new Error('fuyao 未知失败');
}

const POOL_PATH = {
  up: 'limit-up-pool',
  down: 'limit-down-pool',
  break: 'limit-break-pool',
};

/**
 * 拉某池全部分页（size 上限200），返回原始 item[]。
 * @param kind 'up'|'down'|'break'
 * @param ymd 'YYYYMMDD'
 */
async function fetchPoolAll(kind, ymd, { pageSize = PAGE_SIZE_MAX, onWait } = {}) {
  const seg = POOL_PATH[kind];
  if (!seg) throw new Error('未知池类型: ' + kind);
  const size = Math.min(PAGE_SIZE_MAX, Math.max(1, pageSize | 0));
  const dms = shMidnightMs(ymd);
  let page = 1, items = [], total = 0, pages = 1;
  do {
    const q = `/api/a-share/special-data/${seg}?date_ms=${dms}&page=${page}&size=${size}`;
    const data = await getJson(q);
    const pg = data.pagination || {};
    total = pg.total != null ? pg.total : (data.item || []).length;
    pages = pg.pages || 1;
    items = items.concat(data.item || []);
    if (page < pages && onWait) onWait(page);
    if (page < pages) await sleep(250);   // 温和分页，避免高并发
    page++;
  } while (page <= pages);
  return { total, items };
}

/* ── 白名单口径（与 sentiment.filterPoolToUniverse 同规则）── */
function inTradableUniverse(x) {
  return universe.inTradableUniverse({ code: x && x.ticker, name: x && x.name });
}

/**
 * 某日三池 → 与 sentiment.snapshot.sentiment 同形状（白名单宇宙内）。
 * 历史回填只取情绪字段，不需要指数技术面。
 *
 * @returns {limitUpCount,brokenCount,limitDownCount,brokenRate,
 *           ladderHeight,ladder,sealFundYi,universe,truncated,rawTotal}
 * 非交易日/无数据：fuyao 三池都 total=0，调用方据此判空（不能写成真0样本——
 *   区分方式：若三个 total 全0，视为"该日无有效数据"，由回填层跳过）。
 */
async function fearSnapshot(ymd, deps = {}) {
  if (!hasKey()) throw new Error('未配置 FUYAO_API_KEY');
  // deps.fetchPool 便于单测注入；生产用本模块 fetchPoolAll
  const fetchPool = deps.fetchPool || ((kind, d) => fetchPoolAll(kind, d));
  const [zt, dt, zb] = await Promise.all([
    fetchPool('up', ymd), fetchPool('down', ymd), fetchPool('break', ymd),
  ]);
  const ztKeep = zt.items.filter(inTradableUniverse);
  const dtKeep = dt.items.filter(inTradableUniverse);
  const zbKeep = zb.items.filter(inTradableUniverse);

  const ztN = ztKeep.length, zbN = zbKeep.length, dtN = dtKeep.length;
  const ladder = {};
  let height = 0;
  for (const x of ztKeep) {
    const c = x.continue_day_cnt || 1;
    ladder[c] = (ladder[c] || 0) + 1;
    if (c > height) height = c;
  }
  // 封单额单位元 → 亿元
  const sealFundYi = ztKeep.reduce((s, x) => s + (Number(x.seal_money) || 0), 0) / 1e8;

  return {
    date: ymd,
    hasAnyData: (zt.total + dt.total + zb.total) > 0,
    sentiment: {
      limitUpCount: ztN,
      brokenCount: zbN,
      limitDownCount: dtN,
      brokenRate: (ztN + zbN) > 0 ? zbN / (ztN + zbN) * 100 : null,
      ladderHeight: height,
      ladder,
      sealFundYi,
      universe: 'main_chinext',
      truncated: zt.items.length < zt.total || dt.items.length < dt.total || zb.items.length < zb.total,
      rawTotal: { limitUp: zt.total, broken: zb.total, limitDown: dt.total, source: 'fuyao' },
    },
  };
}

/** 近30交易日连板天梯（原始 data，供后续需要时用） */
async function limitUpLadder() {
  return getJson('/api/a-share/special-data/limit-up-ladder');
}

/**
 * A股近一年交易日（固定窗口 [今日-1年, 今日]，无入参）。
 * @returns string[] 'YYYYMMDD'，升序
 */
async function tradingDays() {
  const data = await getJson('/api/a-share/calendar/trading-days');
  return (data.item || []).map(x => x.date).filter(Boolean);
}

/* ════════════════════ A. 集合竞价 ════════════════════ */

/** 'YYYYMMDD' → 'YYYY-MM-DD' */
function isoDate(ymd) { return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`; }

/**
 * 短线风向标竞价基准（全市场官方精选，约数只，带概念 tags）。
 * @param ymd? 'YYYYMMDD'，缺省当日
 * @returns {date, items:[{thscode,ticker,name,auctionPct,tags}]}
 */
async function auctionBenchmark(ymd) {
  const q = ymd ? `?date=${isoDate(ymd)}` : '';
  const data = await getJson('/api/a-share/auction/short-term-benchmark' + q);
  return {
    date: data.date || (ymd ? isoDate(ymd) : null),
    items: (data.item || []).map(x => ({
      thscode: x.thscode, ticker: x.ticker, name: x.name,
      auctionPct: x.auction_pct, tags: x.tags || [],
      inUniverse: inTradableUniverse(x),
    })),
  };
}

/**
 * 个股集合竞价快照（最多100只/次）。
 * @param thscodes string[]，stage 'live'|'final'
 * @returns {phase,status,items:[…]} 竞价明细（含价格/涨跌幅/量额/未匹配/量比）
 */
async function auctionSnapshot(thscodes, stage = 'final') {
  const codes = (thscodes || []).slice(0, 100).map(s => encodeURIComponent(s)).join(',');
  if (!codes) throw new Error('auctionSnapshot 需要至少一个 thscode');
  const data = await getJson(`/api/a-share/auction/snapshot?thscodes=${codes}&stage=${stage === 'live' ? 'live' : 'final'}`);
  return {
    phase: data.auction_phase || null,
    status: data.data_status || null,
    items: (data.item || []).map(x => ({
      thscode: x.thscode, ticker: x.ticker, name: x.name,
      price: x.auction_price, pct: x.auction_pct,
      volume: x.auction_volume, amount: x.auction_amount,
      unmatched: x.auction_unmatched, turnoverPct: x.auction_turnover_pct,
      volumeRatio: x.auction_volume_ratio, preClose: x.pre_close_price,
      inUniverse: inTradableUniverse(x),
    })),
  };
}

/* ════════════════════ B. 异动原因 ════════════════════ */

const ANOMALY_TAGS = ['LIMIT_UP', 'LIMIT_DOWN', 'SHARP_RISE', 'SHARP_FALL', 'RAPID_RALLY', 'RAPID_DECLINE'];

/** 全市场当日异动列表（可按标签过滤），仅当日。 */
async function anomalyList(tagCodes) {
  let q = '';
  if (Array.isArray(tagCodes) && tagCodes.length) {
    const clean = tagCodes.filter(t => ANOMALY_TAGS.includes(t));
    q = '?tag_codes=' + clean.join(',');
  }
  const data = await getJson('/api/a-share/special-data/anomaly-analysis-list' + q);
  return (data.item || []).map(mapAnomaly).filter(x => x.inUniverse);
}

/** 按股票批量查当日异动原因（≤50只），白名单内才返回。 */
async function anomalyByStocks(thscodes) {
  const codes = (thscodes || []).slice(0, 50).map(s => encodeURIComponent(s)).join(',');
  if (!codes) return [];
  const data = await getJson('/api/a-share/special-data/anomaly-analysis-stock?thscodes=' + codes);
  return (data.item || []).map(mapAnomaly).filter(x => x.inUniverse);
}

function mapAnomaly(x) {
  return {
    thscode: x.thscode,
    ticker: (x.thscode || '').split('.')[0],
    name: x.stock_name,
    tag: x.tag_name || null,
    keywords: x.keyword_list || [],
    content: x.analysis_content || '',
    inUniverse: universe.inTradableUniverse({ code: (x.thscode || '').split('.')[0], name: x.stock_name }),
  };
}

/* ════════════════════ B. 龙虎榜 ════════════════════ */

/**
 * 龙虎榜（按交易日，一年内）。
 * @param board 'all'|'org'|'hot_money'，ymd? 缺省最近可用交易日
 * @returns {tradeDate,board,stockItems:[…], hotMoneyItems:[…]}
 *   stockItems 已套白名单；机构/游资资金统一换算成亿元。
 */
async function dragonTiger(board = 'all', ymd) {
  const b = ['all', 'org', 'hot_money'].includes(board) ? board : 'all';
  const q = `?board_type=${b}` + (ymd ? `&date=${isoDate(ymd)}` : '');
  const data = await getJson('/api/a-share/special-data/dragon-tiger-list' + q);

  const stockItems = (data.stock_items || [])
    .map(mapDragonStock)
    .filter(x => x.inUniverse);

  const hotMoneyItems = (data.hot_money_items || []).map(h => ({
    name: h.name,
    netBuyYi: (h.buying || 0) / 1e8,
    rows: (h.rows || []).map(mapDragonStock).filter(x => x.inUniverse),
  })).filter(h => h.rows.length);

  return {
    tradeDate: data.trade_date || (ymd ? isoDate(ymd) : null),
    board: data.board_type || b,
    stockCount: stockItems.length,
    stockItems,
    hotMoneyItems,
  };
}

const YI = 1e8;
function mapDragonStock(x) {
  const ticker = x.ticker || (x.thscode || '').split('.')[0];
  const inU = universe.inTradableUniverse({ code: ticker, name: x.name });
  const orgNet = x.org_net_value;
  const hmNet = x.hot_money_net_value;
  // 谁主导：机构净卖出优先提示（龙头风险信号）；其次机构净买入有席位→机构；游资净买→游资；否则其它
  let driver = '其它';
  if (orgNet != null && orgNet < 0) driver = '机构卖出';
  else if (orgNet != null && orgNet > 0 && (x.org_buy_num || 0) > 0) driver = '机构';
  else if (hmNet != null && hmNet > 0) driver = '游资';
  return {
    thscode: x.thscode, ticker, name: x.name,
    concepts: (x.concept_list || []).map(c => c.name).filter(Boolean),
    limitReason: x.limit_reason || null,
    changePct: x.change != null ? x.change * 100 : null,
    netBuyYi: (x.net_value || 0) / YI,
    buyYi: (x.buy_value || 0) / YI,
    sellYi: (x.sell_value || 0) / YI,
    orgNetYi: orgNet != null ? orgNet / YI : null,
    orgBuyNum: x.org_buy_num ?? null,
    orgSellNum: x.org_sell_num ?? null,
    hotMoneyNetYi: hmNet != null ? hmNet / YI : null,
    hotRank: x.hot_rank ?? null,
    rangeDays: x.range_days ?? null,
    driver,
    inUniverse: inU,
  };
}

module.exports = {
  apiKey, hasKey, setApiKey,
  shMidnightMs, ymdOf,
  getJson, fetchPoolAll, fearSnapshot, limitUpLadder, tradingDays,
  isoDate, auctionBenchmark, auctionSnapshot,
  anomalyList, anomalyByStocks, ANOMALY_TAGS,
  dragonTiger,
  mapAnomaly, mapDragonStock, isoDate,
  inTradableUniverse,
};
