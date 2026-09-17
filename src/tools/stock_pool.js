'use strict';
/* 持续选股模块：从主线/强势板块领涨股 + 涨停连板池中筛出候选个股池。
 *
 * 方法论（沿用 Phase 28 盘面纪律）：「指数判时机 · 板块定方向 · 龙头选个股」。
 * 本模块只做「选出候选池」，不替代大盘时机判断（alerts.judgeMarket），
 * 不给出确定性买卖指令（那是 stock_signal 的条件式提示）。
 *
 * 核心原则：
 * 1. 候选来源锁死在板块领涨股 + 连板≥2，避免「全市场扫一遍列出几百只」；
 *    「同一天相同条件的股票很多」——用板块身份（领涨=板块里最强）+ 四维评分
 *    排序取 top N，精准而非罗列。
 * 2. 评分每一分都可追溯到具体数字（规则可复现，明天再跑结果不变）。
 * 3. 单因子失败 → 该股标 error 跳过，不拿 null 当 0 算总分。
 * 4. 输出带 calibrated:false 与覆盖率，不把涨停/资金排名包装成「选股结果」。
 */

const sentiment = require('./sentiment');
const closeScan = require('./close_scan');

const MIN_SCORE = 50;   // 低于此分不入池（宁严勿松）
const DEFAULT_TOP_N = 15;

/** 股票代码 → 腾讯 secid 前缀。实测口径：6/9开头→sh、4/8开头→bj、其余→sz。 */
function secidOf(code) {
  const c = String(code);
  if (/^[69]/.test(c)) return 'sh' + c;
  if (/^[48]/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

/**
 * 候选去重：同 code 只留第一优先来源。
 * collectCandidates 按 主线领涨 → 强势领涨 → 连板池 的顺序 push，
 * 因此遇到重复 code 直接跳过。
 */
function dedupCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
  }
  return out;
}

/**
 * 四维规则评分（每维 0-25，总分 0-100）。
 * @param {Array} kl 日K [{date,open,close,high,low,volume}]，需 ≥20 根
 * @returns {{score:number, close:number, reasons:string[], error?:string}}
 */
function scoreStock(kl) {
  if (!kl || kl.length < 20) {
    return { score: 0, close: null, reasons: [], error: 'K线不足20日' };
  }
  const closes = kl.map(k => k.close);
  const last = closes[closes.length - 1];
  const ma5 = sentiment.sma(closes, 5);
  const ma10 = sentiment.sma(closes, 10);
  const ma20 = sentiment.sma(closes, 20);
  if (ma5 == null || ma10 == null || ma20 == null) {
    return { score: 0, close: last, reasons: [], error: '均线数据不足' };
  }

  const reasons = [];
  let score = 0;
  const f = (v) => (v == null ? null : +v.toFixed(2));

  /* ① 趋势（25）：收盘站上 MA20 且 MA5 > MA10 = 多头排列 */
  const aboveMa20 = last > ma20;
  const maAsc = ma5 > ma10;
  if (aboveMa20) {
    score += 15;
    reasons.push(`趋势+15: 收盘${f(last)}站上MA20(${f(ma20)})`);
  } else {
    reasons.push(`趋势+0: 收盘${f(last)}在MA20(${f(ma20)})下方`);
  }
  if (maAsc) {
    score += 10;
    reasons.push(`趋势+10: MA5(${f(ma5)})>MA10(${f(ma10)})多头排列`);
  } else {
    reasons.push(`趋势+0: MA5(${f(ma5)})未站上MA10(${f(ma10)})`);
  }

  /* ② 位置（25）：距 20 日最高点回撤幅度。
   * 回调不深说明强势，太深说明走坏，远离高点追高风险大。 */
  const high20 = Math.max(...kl.slice(-20).map(k => k.high));
  const dd = (last / high20 - 1) * 100;
  const ddS = dd.toFixed(1) + '%';
  if (dd <= -3 && dd >= -15) {
    score += 25;
    reasons.push(`位置+25: 距20日高点回撤${ddS}，处于回调买点区`);
  } else if (dd > -3 && dd <= 5) {
    score += 18;
    reasons.push(`位置+18: 贴近20日高点(回撤${ddS})，追高风险中等`);
  } else if (dd > 5) {
    score += 8;
    reasons.push(`位置+8: 已高于20日高点${ddS}，追高风险大`);
  } else if (dd >= -25) {
    score += 15;
    reasons.push(`位置+15: 回撤较深(${ddS})，需确认企稳`);
  } else {
    score += 5;
    reasons.push(`位置+5: 回撤过深(${ddS})，趋势可能走坏`);
  }

  /* ③ 强势（25）：近20日涨幅>12%（强股不是慢股），且近期出现过大涨 */
  let run20 = null;
  if (closes.length >= 21) {
    run20 = (last / closes[closes.length - 21] - 1) * 100;
  }
  const nearMax = kl.slice(-10).reduce((mx, k, i, arr) => {
    if (i === 0) return mx;
    return Math.max(mx, k.close / arr[i - 1].close - 1);
  }, 0) * 100;
  if (run20 != null && run20 > 12) {
    score += 15;
    reasons.push(`强势+15: 近20日涨幅${run20.toFixed(1)}%`);
  } else {
    reasons.push(`强势+0: ${run20 == null ? 'K线不足21日' : '近20日涨幅' + run20.toFixed(1) + '%'}不足12%`);
  }
  if (nearMax >= 7) {
    score += 10;
    reasons.push(`强势+10: 近10日出现单日+${nearMax.toFixed(1)}%大涨`);
  } else {
    reasons.push(`强势+0: 近10日无单日≥7%大涨(最大${nearMax.toFixed(1)}%)`);
  }

  /* ④ 量价（25）：近3日均量 < 前10日均量 = 缩量回调蓄势 */
  const vols = kl.map(k => k.volume).filter(v => v != null);
  if (vols.length >= 13) {
    const avg3 = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const avg10 = vols.slice(-13, -3).reduce((a, b) => a + b, 0) / 10;
    const ratio = avg3 / avg10;
    if (ratio < 1) {
      score += 25;
      reasons.push(`量价+25: 近3日均量/前10日均量=${ratio.toFixed(2)} 缩量`);
    } else if (ratio < 1.2) {
      score += 15;
      reasons.push(`量价+15: 量能温和(${ratio.toFixed(2)})`);
    } else {
      score += 8;
      reasons.push(`量价+8: 放量(${ratio.toFixed(2)})，若下跌需警惕出逃`);
    }
  } else {
    reasons.push('量价+0: 成交量数据不足');
  }

  return { score: +score.toFixed(1), close: last, reasons };
}

/**
 * 三层漏斗收集候选：
 *   1. close_scan 主线候选板块的领涨股（第一优先）
 *   2. close_scan 强势板块的领涨股（第二优先）
 *   3. 涨停池连板≥2（第三优先）
 * 返回已去重候选；stats 记录每路命中数与失败（诚实标注 coverage）。
 */
async function collectCandidates(opts = {}) {
  const out = [];
  const stats = { sources: {}, scan: null, errors: [] };
  let scan = null;

  try {
    scan = await closeScan.scan({ topN: opts.scanTopN || 60 });
  } catch (e) {
    stats.errors.push('close_scan: ' + e.message);
  }

  const sectors = (scan && scan.sectors) || [];
  let mainlineHit = 0;
  let strongHit = 0;
  for (const s of sectors) {
    if (!s.leaderCode) continue;
    if (s.grade === '主线候选') {
      out.push({
        code: String(s.leaderCode), name: s.leader || null,
        sector: s.name, source: 'leader_mainline', leader: 1,
      });
      mainlineHit++;
    } else if (s.grade && /强势/.test(s.grade)) {
      out.push({
        code: String(s.leaderCode), name: s.leader || null,
        sector: s.name, source: 'leader_strong', leader: 1,
      });
      strongHit++;
    }
  }
  stats.sources.leader_mainline = mainlineHit;
  stats.sources.leader_strong = strongHit;
  stats.scan = scan
    ? { ok: scan.ok, dataTime: scan.dataTime, staleWarning: scan.staleWarning, scanned: scan.scanned }
    : null;

  /* 第三路：涨停连板池（c=代码 n=名称 lbc=连板数，实测字段） */
  let ztHit = 0;
  try {
    const zt = await sentiment.fetchPool('zt');
    for (const s of zt.pool || []) {
      if (!s.c) continue;
      const lbc = Number(s.lbc) || 1;
      if (lbc >= 2) {
        out.push({
          code: String(s.c), name: s.n || null,
          sector: null, source: 'zt_ladder', leader: 0,
        });
        ztHit++;
      }
    }
    stats.sources.zt_ladder = ztHit;
    stats.ztTotal = zt.total != null ? zt.total : (zt.pool || []).length;
  } catch (e) {
    stats.errors.push('zt_pool: ' + e.message);
    stats.sources.zt_ladder = 0;
  }

  return { candidates: dedupCandidates(out), stats };
}

/**
 * 主入口：收集 → 拉K线 → 评分 → top N 落库。
 * @returns {object} { ok, date, dataTime, scored, pool, failed, stats, calibrated, ... }
 */
async function run(opts = {}) {
  const topN = opts.topN || DEFAULT_TOP_N;
  const { candidates, stats } = await collectCandidates(opts);

  const scored = [];
  const failed = [];
  for (const c of candidates) {
    let kl;
    try {
      kl = await sentiment.fetchKline(secidOf(c.code), 60);
    } catch (e) {
      failed.push({ ...c, error: 'K线拉取失败: ' + e.message });
      continue;
    }
    if (!kl || kl.length < 20) {
      failed.push({ ...c, error: 'K线不足20日' });
      continue;
    }
    const r = scoreStock(kl);
    if (r.error) {
      failed.push({ ...c, error: r.error });
      continue;
    }
    if (r.score < MIN_SCORE) {
      failed.push({ ...c, error: `评分不足${MIN_SCORE}`, score: r.score, reasons: r.reasons });
      continue;
    }
    scored.push({
      code: c.code, name: c.name,
      sector: c.sector, source: c.source, leader: c.leader,
      score: r.score, reasons: r.reasons,
      price: r.close,
      dataTs: kl[kl.length - 1].date,
    });
  }

  scored.sort((a, b) => (b.score - a.score) || (a.code < b.code ? -1 : 1));
  const pool = scored.slice(0, topN);

  /* 落库（仅当数据终盘或调用方显式要求；失败不静默） */
  let persisted = null, persistError = null, date = null;
  if (opts.persist !== false) {
    try {
      const db = require('../db');
      const d = new Date();
      date = d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
      persisted = db.saveStockPool(date, pool);
    } catch (e) {
      persistError = e.message;
    }
  }

  return {
    ok: pool.length > 0,
    at: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    date,
    dataTime: stats.scan ? stats.scan.dataTime : null,
    staleWarning: stats.scan ? stats.scan.staleWarning : null,
    topN: pool.length,
    scanned: candidates.length,
    scored: scored.length,
    failedCount: failed.length,
    failed,
    pool,
    sources: stats.sources,
    scan: stats.scan,
    errors: stats.errors,
    persisted, persistError,
    calibrated: false,
    thresholds: { minScore: MIN_SCORE, topN },
    note: '规则打分可追溯可复现；阈值基于经验设定未用历史样本标定，标定前宁严勿松',
  };
}

module.exports = { run, scoreStock, secidOf, dedupCandidates, MIN_SCORE, DEFAULT_TOP_N };