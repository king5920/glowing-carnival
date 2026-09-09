'use strict';
/**
 * ══════════════ 新闻源 ══════════════
 *
 * 用户明确指出「新闻接口没有」，这是真缺口 ——
 * 之前贾维斯能看行情、能算指标，但不知道**为什么涨跌**。
 *
 * ── 三个源，全部实测通过 ──
 *   1. 财联社电报   全市场快讯，官方签名（零 key），实测 errno=0
 *   2. 新浪财经要闻 宏观/国际，独立域名 → 真备胎
 *   3. 东财个股新闻 按代码搜，实测拿到茅台最新到 2026-09-09
 *
 * ── 为什么放弃东财 7x24 ──
 * 实测该端点参数校验极严，补一个又缺一个：
 *   缺 fastColumn → 补上 → 缺 sortEnd → ……
 * 财联社已能拿到同类数据（全市场快讯）。
 * **一个可用的真源，胜过两个半通的源。**
 *
 * ── 财联社签名算法（实测）──
 *   sign = md5(sha1(参数按 key 排序后拼成的 query 串))
 * 零密钥、纯本地计算。key 不排序就 errno != 0。
 */

const https = require('https');
const crypto = require('crypto');
const health = require('./source_health');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TIMEOUT_MS = 10000;

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({ 'User-Agent': UA }, headers || {}),
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        code: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
  });
}

/** 清掉 HTML 标签和多余空白 —— 搜索接口的标题常带 <em> 高亮 */
function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** 时间统一成 'YYYY-MM-DD HH:mm' */
function fmtTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const num = Number(v);
    const ms = num < 1e12 ? num * 1000 : num;   // 财联社给秒级
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
  const s = String(v).trim();
  const m = /(\d{4})[-/](\d{2})[-/](\d{2})[\sT]*(\d{2}:\d{2})?/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}${m[4] ? ' ' + m[4] : ''}`;
  return s.slice(0, 16);
}

/* ══════════ 1. 财联社电报（主源） ══════════ */

function clsSign(params) {
  const q = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sha = crypto.createHash('sha1').update(q).digest('hex');
  const sign = crypto.createHash('md5').update(sha).digest('hex');
  return { query: q, sign };
}

async function cailianpress(limit = 15) {
  const params = {
    app: 'CailianpressWeb', os: 'web', sv: '7.7.5',
    category: '', lastTime: '', last_time: '',
    rn: String(Math.max(1, Math.min(50, limit))),
  };
  const { query, sign } = clsSign(params);
  const r = await get(`https://www.cls.cn/v1/roll/get_roll_list?${query}&sign=${sign}`,
    { Referer: 'https://www.cls.cn/telegraph' });

  const j = JSON.parse(r.body);
  if (j.errno !== 0) throw new Error(`财联社 errno=${j.errno} ${j.errmsg || ''}`);

  const rows = j?.data?.roll_data || [];
  return rows.map(x => {
    const title = clean(x.title || x.content);
    const content = clean(x.content);
    return {
      source: '财联社',
      time: fmtTime(x.ctime),
      title: title.slice(0, 120),
      // content 常比 title 完整；相同就不重复占上下文
      detail: (content && content !== title) ? content.slice(0, 300) : null,
      important: !!(x.is_ask || x.level === 'A'),
      stocks: (x.stock_list || []).map(s => ({
        code: s.StockID || s.stock_id || null, name: s.name || null,
      })).filter(s => s.code).slice(0, 5),
    };
  });
}

/* ══════════ 2. 新浪财经要闻（独立备胎） ══════════ */

async function sinaNews(limit = 15) {
  const n = Math.max(1, Math.min(50, limit));
  const r = await get(`https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=${n}&page=1`);
  const j = JSON.parse(r.body);
  const rows = j?.result?.data || [];
  return rows.map(x => ({
    source: '新浪财经',
    time: fmtTime(x.ctime || x.intime),
    title: clean(x.title).slice(0, 120),
    detail: x.intro ? clean(x.intro).slice(0, 300) : null,
    url: x.url || null,
    important: false,
    stocks: [],
  }));
}

/* ══════════ 3. 东财个股新闻（按代码） ══════════ */

async function stockNews(code, limit = 10) {
  if (!/^\d{6}$/.test(String(code))) throw new Error('股票代码必须是 6 位数字');
  const n = Math.max(1, Math.min(30, limit));
  const param = {
    uid: '', keyword: String(code), type: ['cmsArticleWebOld'],
    client: 'web', clientType: 'web', clientVersion: 'curr',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default', sort: 'default',
        pageIndex: 1, pageSize: n, preTag: '', postTag: '',
      },
    },
  };
  const r = await get(
    `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`,
    { Referer: 'https://so.eastmoney.com/' });

  const m = /cb\((.+)\)\s*$/s.exec(r.body);       // JSONP: cb({...})
  const j = JSON.parse(m ? m[1] : r.body);
  const rows = j?.result?.cmsArticleWebOld || [];
  return rows.map(x => ({
    source: '东财',
    time: fmtTime(x.date),
    title: clean(x.title).slice(0, 120),
    detail: x.content ? clean(x.content).slice(0, 300) : null,
    url: x.url || null,
    important: false,
    stocks: [{ code: String(code), name: null }],
  }));
}

/* ══════════ 对外接口 ══════════ */

/**
 * 市场快讯：财联社为主，失败降级到新浪。
 *
 * 为什么降级而不是合并两源：内容重叠度高，
 * 合并会让模型看到大量重复条目，既浪费上下文又干扰判断。
 */
async function marketNews(limit = 15) {
  const errors = [];
  try {
    const rows = await cailianpress(limit);
    if (rows.length) {
      health.record('news.cailianpress', true);
      return { source: '财联社', degraded: false, count: rows.length, news: rows };
    }
    errors.push('财联社返回空');
    health.record('news.cailianpress', false, '返回空');
  } catch (e) {
    errors.push('财联社: ' + e.message);
    health.record('news.cailianpress', false, e.message);
  }

  try {
    const rows = await sinaNews(limit);
    health.record('news.sina', rows.length > 0, rows.length ? null : '返回空');
    return {
      source: '新浪财经', degraded: true, count: rows.length, news: rows,
      note: '财联社不可用，已降级到新浪。新浪偏宏观/国际，A股盘中快讯不如财联社及时。',
      errors,
    };
  } catch (e) {
    errors.push('新浪: ' + e.message);
    health.record('news.sina', false, e.message);
  }

  /* 两个源都挂了就抛错，**绝不返回空数组假装"今天没新闻"** ——
   * 那会让模型以为市场平静，是最危险的一种静默失败。 */
  throw new Error('所有新闻源不可用：' + errors.join('; '));
}

/** 个股新闻 */
async function newsForStock(code, limit = 10) {
  /* ══ 参数校验必须在 try 之外 ══
   *
   * 实测踩到的坑：这行校验原本在 try 里面，
   * 于是调用方传了 'abc' / '12345' / 注入串时，
   * catch 会把它记成 **news.eastmoney 数据源失败**。
   *
   * 后果：跑了几次参数校验测试，健康灯就从 100% 掉到 14%，
   * 面板显示"东财个股新闻降级" —— 而接口其实完全正常（实测 43-137ms）。
   *
   * 这比不记录更糟：**假故障会掩盖真故障**。
   * 健康表只该记录「数据源的健康」，不该记录「调用方的手误」。 */
  if (!/^\d{6}$/.test(String(code))) {
    throw new Error('股票代码必须是 6 位数字：' + code);
  }
  try {
    const rows = await stockNews(code, limit);
    health.record('news.eastmoney', rows.length > 0, rows.length ? null : '返回空');
    return { code: String(code), count: rows.length, news: rows };
  } catch (e) {
    health.record('news.eastmoney', false, e.message);
    throw e;
  }
}

module.exports = { marketNews, newsForStock, cailianpress, sinaNews, stockNews };
