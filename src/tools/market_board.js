'use strict';
/**
 * 大盘指数 + 行业板块行情
 *
 * ── 数据源策略（和 stock_quote.js 一致的教训）──
 * 指数：腾讯主源（实测 100% 通）+ 东财备用
 * 板块：**只有东财有**。通达信/腾讯/新浪都没有行业板块数据，
 *       同花顺的板块接口 2026 年初加了 401 登录态反爬。
 *       所以没有"换源"这条路，只能更聪明地用东财 —— 走 em_client 的
 *       串行节流 + Keep-Alive 复用 + 熔断，见 em_client.js 的说明。
 */

const http = require('http');
const https = require('https');
const em = require('./em_client');
const health = require('./source_health');

const UA = em.UA;

/* 腾讯代码 → 显示名。腾讯自己也返回名称，这里主要是控制顺序和简称。 */
const INDEXES = [
  { tx: 'sh000001', short: '上证' },
  { tx: 'sz399001', short: '深成' },
  { tx: 'sz399006', short: '创业板' },
  { tx: 'sh000688', short: '科创50' },
  { tx: 'sh000300', short: '沪深300' },
  { tx: 'sh000905', short: '中证500' },
];

/* ─────────────── 指数：腾讯主源 ─────────────── */

function fetchIndexTencent() {
  return new Promise((resolve, reject) => {
    const params = INDEXES.map(x => x.tx).join(',');
    const req = http.get(`http://qt.gtimg.cn/q=${params}`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const text = new TextDecoder('gbk').decode(Buffer.concat(chunks));
          const map = {};
          for (const line of text.split('\n')) {
            const m = /v_(\w+)="([^"]*)"/.exec(line);
            if (!m || !m[2]) continue;
            const f = m[2].split('~');
            if (f.length < 47) continue;
            map[m[1]] = {
              code: f[2],
              name: (f[1] || '').trim(),
              price: num(f[3]),
              prevClose: num(f[4]),
              open: num(f[5]),
              volume: num(f[6]),                    // 手
              change: num(f[31]),
              changePct: num(f[32]),
              high: num(f[33]),
              low: num(f[34]),
              amount: mul(num(f[37]), 10000),       // 万元 → 元
            };
          }
          // 按 INDEXES 的顺序输出，并补上简称
          const rows = [];
          for (const spec of INDEXES) {
            const r = map[spec.tx];
            if (r) rows.push({ ...r, short: spec.short, source: 'tencent' });
          }
          if (!rows.length) return reject(new Error('腾讯指数返回空'));
          resolve(rows);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('腾讯指数超时')); });
    req.on('error', reject);
  });
}

/* ─────────────── 指数：东财备用 ─────────────── */

const EM_INDEX = {
  sh000001: '1.000001', sz399001: '0.399001', sz399006: '0.399006',
  sh000688: '1.000688', sh000300: '1.000300', sh000905: '1.000905',
};

async function fetchIndexEastmoney() {
  const secids = INDEXES.map(x => EM_INDEX[x.tx]).filter(Boolean).join(',');
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
    + `?fltt=2&invt=2&secids=${encodeURIComponent(secids)}`
    + '&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18';
  const j = await em.emGetJson(url);
  const diff = j?.data?.diff;
  const arr = diff ? (Array.isArray(diff) ? diff : Object.values(diff)) : [];
  if (!arr.length) throw new Error('东财指数返回空');
  const shortByCode = {};
  for (const spec of INDEXES) {
    const code = (EM_INDEX[spec.tx] || '').split('.')[1];
    if (code) shortByCode[code] = spec.short;
  }
  return arr.map(r => ({
    code: r.f12,
    name: r.f14,
    short: shortByCode[r.f12] || r.f14,
    price: num(r.f2),
    changePct: num(r.f3),
    change: num(r.f4),
    volume: num(r.f5),
    amount: num(r.f6),
    high: num(r.f15),
    low: num(r.f16),
    open: num(r.f17),
    prevClose: num(r.f18),
    source: 'eastmoney',
  }));
}

/** 大盘指数一览。腾讯主源，东财备用。 */
async function indexes() {
  const errs = [];
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetchIndexTencent();
      health.record('tencent.quote', true);
      return r;
    }
    catch (e) { errs.push('腾讯: ' + e.message); }
    if (i === 0) await sleep(300);
  }
  health.record('tencent.quote', false, errs[errs.length - 1]);
  // 东财备用：em_client 自带节流和熔断，这里不再自己重试
  try {
    const r = await fetchIndexEastmoney();
    health.record('eastmoney.index', true);
    return r;
  }
  catch (e) {
    errs.push('东财: ' + e.message);
    health.record('eastmoney.index', false, e.message);
  }
  throw new Error('指数获取失败 —— ' + errs.join('; '));
}

/* ─────────────── 板块：只有东财 ─────────────── */

/** 拉一页板块数据 */
async function fetchSectorPage(pn, pz = 100) {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2`
    + '&fields=f3,f8,f12,f14,f104,f105,f128,f136,f140,f207,f208';
  const j = await em.emGetJson(url);
  const d = j?.data;
  const diff = d?.diff;
  const arr = diff ? (Array.isArray(diff) ? diff : Object.values(diff)) : [];
  return { total: d?.total || 0, rows: arr };
}

function mapSector(x) {
  return {
    code: x.f12,
    name: x.f14,
    changePct: num(x.f3),
    turnover: num(x.f8),          // 换手率 %
    upCount: num(x.f104),         // 上涨家数
    downCount: num(x.f105),       // 下跌家数
    leader: x.f128 || null,       // 领涨股名称（f140 是代码，f128 才是名字）
    leaderCode: x.f140 || x.f208 || null,
    leaderPct: num(x.f136),
  };
}

/**
 * 全部行业板块。
 *
 * ══════ 为什么必须分页 ══════
 * 东财的 pz 参数**服务端硬截断在 100**，传 pz=500 也只返回 100 条。
 * 而行业板块总数约 500 个。只拉第一页的后果是：
 * "领跌板块"实际是涨幅第 96-100 名（可能还在涨），完全是错的。
 * 实测就踩了这个坑：显示"领跌 物业管理 +1.91%"。
 *
 * 所以要拿真正的涨跌两端，必须拉首页（涨幅 top）+ 末页（涨幅 bottom）。
 * 因为已按 fid=f3 降序，末页就是跌得最多的。
 */
async function fetchSectors() {
  const first = await fetchSectorPage(1, 100);
  if (!first.rows.length) throw new Error('板块返回空');

  const total = first.total || first.rows.length;
  const pageSize = 100;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  let rows = first.rows.map(mapSector);

  // 只有多页时才拉末页（省一次请求）
  if (lastPage > 1) {
    try {
      const last = await fetchSectorPage(lastPage, pageSize);
      const tailRows = last.rows.map(mapSector);
      // 用 code 去重合并（首末页在只有 2 页时可能重叠）
      const seen = new Set(rows.map(r => r.code));
      for (const r of tailRows) {
        if (!seen.has(r.code)) { rows.push(r); seen.add(r.code); }
      }
    } catch (_) {
      // 末页拉不到就只用首页，但要标记数据不完整
      rows._partial = true;
    }
  }

  rows = rows.filter(x => x.name && x.changePct != null);
  if (!rows.length) throw new Error('板块解析后为空');
  rows.sort((a, b) => b.changePct - a.changePct);
  rows.totalKnown = total;
  return rows;
}

/**
 * 行业板块涨跌榜。
 * 只有东财有这个数据，拿不到就返回 null —— 周报少一节比整体失败好。
 * 重试和熔断都在 em_client 里做，这里不再叠加重试（叠加只会更快触发风控）。
 */
async function sectors(topN = 8) {
  try {
    const rows = await fetchSectors();
    return {
      top: rows.slice(0, topN),
      bottom: rows.slice(-topN).reverse(),
      total: rows.length,
      // 涨跌板块数量对比，是判断市场情绪的直接指标
      upSectors: rows.filter(r => r.changePct > 0).length,
      downSectors: rows.filter(r => r.changePct < 0).length,
      source: 'eastmoney',
    };
  } catch (e) {
    // 明确返回 null 并把原因带出去，调用方自己决定怎么表述
    return null;
  }
}

/** 把排好序的板块列表整理成涨跌榜结构 */
function buildSectorSummary(rows, topN) {
  const sampled = rows.length;
  const totalKnown = rows.totalKnown || sampled;
  return {
    top: rows.slice(0, topN),
    bottom: rows.slice(-topN).reverse(),
    // total = 市场上共有多少个板块；sampled = 实际抓到多少条
    total: totalKnown,
    sampled,
    // 只抓首末两页时，涨跌家数是**样本内**统计，不代表全市场
    partial: sampled < totalKnown,
    upSectors: rows.filter(r => r.changePct > 0).length,
    downSectors: rows.filter(r => r.changePct < 0).length,
    source: 'eastmoney',
  };
}

/**
 * 行业板块涨跌榜。
 * 只有东财有这个数据，拿不到就返回 null —— 周报少一节比整体失败好。
 * 重试、域名切换、熔断都在 em_client 里做，这里不叠加重试。
 *
 * 每次调用都记录健康状态（L1）：连续失败 3 次会被标记 degraded，
 * 巡视时会主动上报「板块源挂了 N 天」，而不是默默降级到你永远发现不了。
 */
async function sectors(topN = 8) {
  try {
    const r = buildSectorSummary(await fetchSectors(), topN);
    health.record('eastmoney.sector', true);
    return r;
  } catch (e) {
    health.record('eastmoney.sector', false, e.message);
    return null;   // 明确返回 null，调用方自己判断怎么表述
  }
}

/** 同 sectors，但失败时带出具体原因（诊断 + 给用户诚实说明用） */
async function sectorsWithReason(topN = 8) {
  try {
    const r = buildSectorSummary(await fetchSectors(), topN);
    health.record('eastmoney.sector', true);
    return { ok: true, data: r };
  } catch (e) {
    health.record('eastmoney.sector', false, e.message);
    return { ok: false, reason: e.message, emStatus: em.status() };
  }
}

function num(v) {
  if (v == null || v === '-' || v === '') return null;
  const x = Number(v);
  return isFinite(x) ? x : null;
}
function mul(v, k) { return v == null ? null : v * k; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { indexes, sectors, sectorsWithReason, emStatus: em.status };
