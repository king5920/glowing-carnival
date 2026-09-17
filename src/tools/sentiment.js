'use strict';
/**
 * 大盘情绪 + 技术指标采集（盯盘预警的信号底座）
 *
 * ══════ 用户 2026-09-10 定的方法论 ══════
 * 「用大盘来定买卖时机，板块定方向」
 *   大盘情绪/技术 → 总开关（有没有买入时机）
 *   板块调整到位 → 方向（钱往哪去），且只在大盘转多时才有意义
 *
 * 本模块只负责【如实采集 + 计算原始指标】，不做买卖结论。
 * 结论在 alerts.js，阈值在标定完成前一律标注"未标定"。
 *
 * 数据来源（全部 2026-09-10 本机实测可达）：
 *   涨停/炸板/跌停池  东财 push2ex（走 em_client 节流+熔断）
 *   指数日K(算技术指标) 腾讯 ifzq（HTTP，不封 IP）
 *   全A涨跌家数        东财 clist total + 三池/板块交叉
 *
 * 设计原则（项目一贯）：
 *   - 任何一个子源失败，指标标 null 并带 error，绝不拿 null 当 0 算
 *   - 字段不猜：push2ex 池字段 c/n/lbc/fund/zbc 是实测过的
 *   - 原始快照可直接落 alert_samples 供标定
 */

const http = require('http');
const https = require('https');
const em = require('./em_client');
const health = require('./source_health');

const UA = em.UA;
const POOL_UT = '7eea3edcaed734bea9cbfc24409ed989';

function num(v) {
  if (v == null || v === '-' || v === '') return null;
  const x = Number(v);
  return isFinite(x) ? x : null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─────────────── 东财涨跌停三池 ─────────────── */

function poolUrl(kind, date, pageSize = 200) {
  // kind: zt 涨停 / zb 炸板 / dt 跌停
  const map = {
    zt: ['getTopicZTPool', 'fbt:asc'],
    zb: ['getTopicZBPool', 'fbt:asc'],
    dt: ['getTopicDTPool', 'fund:asc'],
  };
  const [api, sort] = map[kind];
  return `https://push2ex.eastmoney.com/${api}?ut=${POOL_UT}&dpt=wz.ztzt`
    + `&Pageindex=0&pagesize=${pageSize}&sort=${sort}&date=${date}`;
}

async function fetchPool(kind, date) {
  const j = await em.emGetJson(poolUrl(kind, date));
  const pool = j?.data?.pool || [];
  return { total: j?.data?.tc ?? pool.length, pool };
}

/* ─────────────── 可投资宇宙过滤（主板+创业板，剔 ST）───────────────
 * 情绪三池是逐只个股，必须套用用户口径（见 tools/universe.js）：
 * 排除科创板(688/689)、北交所(4xx/8xx/920)、ST/*ST/退。
 * 大盘指数与板块不经过这里（那是聚合体，不套个股白名单）。
 * 池字段：c=代码 n=名称 lbc=连板数 fund=封板资金（2026-09 实测）。
 *
 * 诚实提示：pagesize=200，极端日某池可能 >200 只被截断。此时 filtered 只数到
 * 抓回来的部分，调用方应同时看 truncated 标志，不能把低估的家数当精确值。 */
const universe = require('./universe');
function filterPoolToUniverse(pool, tc) {
  const kept = [];
  for (const s of pool) {
    if (universe.inTradableUniverse({ code: s.c, name: s.n })) kept.push(s);
  }
  const truncated = pool.length < (tc || 0);  // 抓回来的比总数少 = 被翻页上限截断
  return { kept, truncated, rawCount: pool.length, rawTotal: tc ?? pool.length };
}

/* ─────────────── 腾讯指数日K ─────────────── */

/** 取某指数/个股的日K（腾讯不封IP）。rows: [{date,open,close,high,low,volume}] */
function fetchKline(secid, limit = 60) {
  return new Promise((resolve, reject) => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${secid},day,,,${limit},qfq`;
    const req = https.get(url, { headers: { 'User-Agent': UA }, timeout: 10000 }, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(ch).toString('utf8'));
          const node = j.data && j.data[secid];
          if (!node) return reject(new Error('腾讯K线无此标的: ' + secid));
          const arr = node.day || node.qfqday || [];
          resolve(arr.map(k => ({
            date: k[0], open: num(k[1]), close: num(k[2]),
            high: num(k[3]), low: num(k[4]), volume: num(k[5]),
          })).filter(k => k.close != null));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('腾讯K线超时')); });
  });
}

/* ─────────────── 技术指标（纯函数，可单测）─────────────── */

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** 指数移动平均序列（用于 MACD） */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (const v of values) {
    prev = prev == null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** MACD：返回最新的 dif/dea/macd 柱（基于收盘价序列） */
function macd(closes) {
  if (closes.length < 26) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = emaSeries(dif, 9);
  const i = closes.length - 1;
  return {
    dif: dif[i], dea: dea[i], hist: (dif[i] - dea[i]) * 2,
    /* 金叉：今天 dif 上穿 dea；死叉反之。需要前一根比较 */
    cross: dif[i - 1] <= dea[i - 1] && dif[i] > dea[i] ? 'golden'
         : dif[i - 1] >= dea[i - 1] && dif[i] < dea[i] ? 'dead' : null,
  };
}

/** RSI(14)，Wilder 平滑 */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}

/**
 * 单个指数的技术面快照。
 * 关键：每个值都可能为 null（数据不足），不强行给数。
 */
function indexTechnicals(kl) {
  const closes = kl.map(k => k.close);
  const last = kl[kl.length - 1];
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const m = macd(closes);
  const r = rsi(closes, 14);
  return {
    asOf: last?.date || null,
    close: last?.close ?? null,
    ma5, ma10, ma20,
    aboveMa5: ma5 != null ? last.close > ma5 : null,
    aboveMa20: ma20 != null ? last.close > ma20 : null,
    macdCross: m?.cross ?? null,
    macdHist: m?.hist ?? null,
    rsi14: r,
    /* 近5日累计涨跌幅，判断是在趋势中还是在回调 */
    pct5: closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : null,
  };
}

/* ─────────────── 情绪面快照 ─────────────── */

/**
 * 计算涨停池的连板梯队。
 * 返回 {height, ladder:{板数:家数}, boardCount}
 */
function ladderOf(ztPool) {
  const ladder = {};
  let height = 0;
  for (const s of ztPool) {
    const lb = num(s.lbc) || 1;
    ladder[lb] = (ladder[lb] || 0) + 1;
    if (lb > height) height = lb;
  }
  return { height, ladder, boardCount: ztPool.length };
}

/**
 * 大盘情绪 + 技术综合快照。
 *
 * @param {object} opts {date:'YYYYMMDD' 可测试，默认今天, poolsOnly:false 只取三池不拉指数K}
 * @returns 原始指标对象（供落库标定 + alerts 判断）
 */
async function snapshot(opts = {}) {
  const poolsOnly = !!opts.poolsOnly;
  const d = opts.date ? new Date(opts.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) : new Date();
  const date = opts.date ||
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = { ok: true, date, at: new Date().toISOString(), sources: {} };

  /* ── 情绪三池 ── */
  try {
    const [zt, zb, dt] = await Promise.all([
      fetchPool('zt', date), fetchPool('zb', date), fetchPool('dt', date),
    ]);
    health.record('eastmoney.pool', true);
    result.sources.pools = 'eastmoney.push2ex';

    /* 三池逐只过滤到可投资宇宙（主板+创业板，剔 ST/科创/北交）。
     * 情绪家数/炸板率/连板梯队/封板资金全部用过滤后的口径，分子分母同宇宙。 */
    const fZt = filterPoolToUniverse(zt.pool, zt.total);
    const fZb = filterPoolToUniverse(zb.pool, zb.total);
    const fDt = filterPoolToUniverse(dt.pool, dt.total);
    const ztN = fZt.kept.length, zbN = fZb.kept.length, dtN = fDt.kept.length;
    const lad = ladderOf(fZt.kept);
    const truncated = fZt.truncated || fZb.truncated || fDt.truncated;

    result.sentiment = {
      /* 主口径：白名单宇宙（主板+创业板，剔 ST）。情绪判断/崩溃指标用这套。 */
      limitUpCount: ztN,
      brokenCount: zbN,
      limitDownCount: dtN,
      /* 炸板率 = 炸板 / (涨停封板 + 炸板)，分子分母都在白名单宇宙内。
       * 这是"敢不敢封板"的直接情绪指标：越高越恐慌。
       * 数据不足（都为0）时返回 null，不编造 0%。 */
      brokenRate: (ztN + zbN) > 0 ? zbN / (ztN + zbN) * 100 : null,
      ladderHeight: lad.height,
      ladder: lad.ladder,
      /* 封板资金合计（亿元），白名单宇宙内涨停封单真金白银的强度 */
      sealFundYi: fZt.kept.reduce((s, x) => s + (num(x.fund) || 0), 0) / 1e8,
      /* 口径与数据质量标记：让下游知道这是"主板+创业板"而非全交易所，
       * 以及极端日池>200只被翻页截断时家数可能偏低。 */
      universe: 'main_chinext',          // main board + ChiNext，excl. STAR/BJ/ST
      truncated: !!truncated,
      rawTotal: { limitUp: zt.total, broken: zb.total, limitDown: dt.total },
    };
  } catch (e) {
    health.record('eastmoney.pool', false, e.message);
    result.ok = false;
    result.sources.poolsError = e.message;
    result.sentiment = null;
  }

  /* ── 指数技术面（腾讯不封IP，各指数独立容错）──
   * 回填历史基准只需情绪三池，poolsOnly 时整段跳过（省4次K线请求），indexes 留空。 */
  result.indexes = {};
  if (poolsOnly) return result;
  const INDEX_SECIDS = [
    ['sh000001', '上证'], ['sz399006', '创业板'],
    ['sh000300', '沪深300'], ['sh000905', '中证500'],
  ];
  for (const [secid, short] of INDEX_SECIDS) {
    try {
      const kl = await fetchKline(secid, 60);
      result.indexes[short] = indexTechnicals(kl);
      health.record('tencent.kline', true);
      await sleep(150);
    } catch (e) {
      health.record('tencent.kline', false, e.message);
      result.indexes[short] = { error: e.message };
    }
  }

  return result;
}

module.exports = {
  snapshot, fetchKline,
  sma, emaSeries, macd, rsi, indexTechnicals, ladderOf,
  poolUrl, fetchPool, filterPoolToUniverse,
};
