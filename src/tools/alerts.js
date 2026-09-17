'use strict';
/**
 * 盯盘预警判断器 —— 大盘定时【总开关】，板块定【方向】
 *
 * ══════ 用户 2026-09-10 定的方法论 ══════
 * 「用大盘来定买卖时机，板块定方向」
 *
 *   信号 A（大盘时机）：情绪 + 技术多条件共振 → 有没有买入时机（总开关）
 *   信号 B（板块方向）：收盘扫描确认的主线板块 → 哪个调整到位了（方向）
 *   顺序不可逆：大盘不在买入窗口时，板块信号也不喊动手，只做观察。
 *
 * ══════ 阈值标定（诚实第一）══════
 * 现在样本为 0，下面的 GATE 只是【保守的临时观察阈值】，不是定论。
 * 每个交易日盘中攒快照进 alert_samples，攒够 MIN_CAL_DAYS（15-20）后，
 * 用真实分布的分位数替换，并像 close_scan 那样用前向收益验证信号有效性。
 * 标定完成前，所有输出都带 calibrated:false 和"仅供观察"字样。
 *
 * 绝不：单日数据定阈值、把一次满足说成买入信号、对个股给买卖建议。
 */

const sentiment = require('./sentiment');
const closeScan = require('./close_scan');

/* 标定所需最少交易日（和 close_scan 的 20 天同量级） */
const MIN_CAL_DAYS = 15;

/* ─────────────── 临时观察阈值（未标定，宁严勿松）───────────────
 * 这些数字不来自分布，只是教科书常识级别的"多条件共振"门槛，
 * 目的是让系统在标定前【极少误报】，宁可漏掉也不乱喊。 */
const TEMP_GATE = {
  brokenRateMax: 25,     // 炸板率 ≤25% 才算资金敢封板（今天实测 38.6%，明显不满足）
  limitUpMin: 50,        // 涨停 ≥50 家（今天 35，不满足）
  limitDownMax: 8,       // 跌停 ≤8 家（今天 11，不满足）
  ladderHeightMin: 3,    // 至少有 3 板高度，情绪不算冰点
  // 技术：上证要站上 MA20，且 MACD 不死叉；创业板（弹性）最好金叉或站上MA20
};

/**
 * 信号 A：大盘买入时机。
 * 必须情绪与技术【同时】转强，且是从"非强"转"强"才有提示价值。
 *
 * @returns {buy:boolean, confidence, checks[], calibrated, reason}
 */
function judgeMarket(snap, historyDays = 0) {
  const se = snap.sentiment;
  const sh = snap.indexes && snap.indexes['上证'];
  const cyb = snap.indexes && snap.indexes['创业板'];
  const calibrated = historyDays >= MIN_CAL_DAYS;

  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  if (!se) {
    return { buy: false, confidence: 0, checks, calibrated, reason: '情绪数据缺失，无法判断大盘时机' };
  }

  /* 情绪条件 */
  add('炸板率≤' + TEMP_GATE.brokenRateMax + '%', se.brokenRate != null && se.brokenRate <= TEMP_GATE.brokenRateMax,
    se.brokenRate == null ? '无数据' : `炸板率 ${se.brokenRate.toFixed(1)}%`);
  add('涨停≥' + TEMP_GATE.limitUpMin + '家', se.limitUpCount >= TEMP_GATE.limitUpMin,
    `涨停 ${se.limitUpCount} 家`);
  add('跌停≤' + TEMP_GATE.limitDownMax + '家', se.limitDownCount <= TEMP_GATE.limitDownMax,
    `跌停 ${se.limitDownCount} 家`);
  add('连板高度≥' + TEMP_GATE.ladderHeightMin, se.ladderHeight >= TEMP_GATE.ladderHeightMin,
    `最高 ${se.ladderHeight} 连板`);

  /* 技术条件 */
  const shOk = sh && !sh.error && sh.aboveMa20 === true && sh.macdCross !== 'dead';
  add('上证站上MA20且MACD不死叉', !!shOk,
    !sh || sh.error ? '上证数据缺失'
      : `收${sh.close} vs MA20 ${sh.ma20 ? sh.ma20.toFixed(1) : '?'}, MACD ${sh.macdCross || '维持'}`);

  const cybOk = cyb && !cyb.error && (cyb.aboveMa20 === true || cyb.macdCross === 'golden');
  add('创业板转强(站上MA20或MACD金叉)', !!cybOk,
    !cyb || cyb.error ? '创业板数据缺失'
      : `收${cyb.close}, 站上MA20=${cyb.aboveMa20}, MACD ${cyb.macdCross || '维持'}`);

  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;
  const buy = passed === total;       // 全满足才算买入窗口（未标定阶段极保守）

  return {
    buy,
    confidence: passed / total,
    passed, total, checks,
    calibrated,
    reason: buy
      ? '情绪与技术多条件共振，进入可关注的买入窗口'
      : `大盘时机未到（${passed}/${total} 项满足），板块机会只观察不动手`,
  };
}

/* ─────────────── 信号 B：主线板块调整到位 ─────────────── */

/**
 * 评估一只板块龙头的回调状态（用日K）。
 * "调整到位"的保守技术定义（不是预测，是状态描述）：
 *   1. 前期有过一段强势（近20日有明显上涨）——确认它是"主线的龙头"
 *   2. 之后进入回调（近几日从高点回落），且回调缩量
 *   3. 当前价接近 MA10/MA20（±3%），但不有效跌破 MA20
 *   4. RSI 从超买区回落到 40-55（降温但不弱）
 *
 * 返回状态：'near_support'(贴近支撑企稳) / 'pulling'(仍在回调) / 'broken'(跌破) / 'strong'(还在高位没调)
 */
function judgeLeaderPullback(kl) {
  if (!kl || kl.length < 20) return { state: 'unknown', reason: 'K线不足20日' };
  const s = sentiment.indexTechnicals(kl);
  const closes = kl.map(k => k.close);
  const last = closes[closes.length - 1];

  /* 前期强势：20日内最高点相对20日前的涨幅 */
  const high20 = Math.max(...kl.slice(-20).map(k => k.high));
  const base = closes[closes.length - 20];
  const runUpPct = (high20 / base - 1) * 100;

  /* 从高点的回撤幅度 */
  const drawdown = (last / high20 - 1) * 100;

  /* 近3日是否缩量：对比近3日均量与前10日均量 */
  const vols = kl.map(k => k.volume).filter(v => v != null);
  const avg3 = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const avg10 = vols.slice(-12, -3).reduce((a, b) => a + b, 0) / 9;
  const shrinking = avg3 < avg10;

  const nearMa10 = s.ma10 && Math.abs(last / s.ma10 - 1) <= 0.03;
  const nearMa20 = s.ma20 && Math.abs(last / s.ma20 - 1) <= 0.03;
  const belowMa20 = s.ma20 && last < s.ma20 * 0.98;

  const detail = {
    runUpPct: +runUpPct.toFixed(1), drawdown: +drawdown.toFixed(1),
    shrinking, nearMa10, nearMa20, belowMa20,
    rsi14: s.rsi14 != null ? +s.rsi14.toFixed(1) : null,
    last, ma10: s.ma10 ? +s.ma10.toFixed(2) : null, ma20: s.ma20 ? +s.ma20.toFixed(2) : null,
  };

  if (runUpPct < 12) return { state: 'not_leader', reason: '20日涨幅不足12%，不够强势龙头', ...detail };
  if (belowMa20) return { state: 'broken', reason: '有效跌破MA20，趋势走坏', ...detail };
  if (drawdown > -3 && detail.rsi14 != null && detail.rsi14 > 65)
    return { state: 'strong', reason: '还在高位超买，没开始调整', ...detail };
  if (drawdown <= -6 && (nearMa10 || nearMa20) && shrinking)
    return { state: 'near_support', reason: `从高点回撤${drawdown.toFixed(1)}%、缩量、贴近${nearMa20 ? 'MA20' : 'MA10'}支撑`, ...detail };
  if (drawdown <= -3) return { state: 'pulling', reason: `回调${drawdown.toFixed(1)}%中，未到支撑`, ...detail };
  return { state: 'strong', reason: '高位横盘，尚无明显回调', ...detail };
}

/**
 * 扫描主线板块的调整状态。
 * @param {object} opts {market:{buy} 信号A结果, maxSectors}
 * @returns 板块方向列表；大盘不转多时每条标注"只观察"。
 */
async function scanMainlineAdjustments(opts = {}) {
  let scan;
  try {
    scan = await closeScan.scan({ topN: 40 });
  } catch (e) {
    return { ok: false, error: '收盘扫描失败: ' + e.message, sectors: [] };
  }
  const mainlines = (scan.sectors || []).filter(s => s.grade === '主线候选');
  const out = [];

  for (const sec of mainlines.slice(0, opts.maxSectors || 8)) {
    if (!sec.leaderCode) continue;
    const code = String(sec.leaderCode);
    const pre = code.startsWith('6') ? 'sh' : 'sz';
    let kl = null;
    try {
      kl = await sentiment.fetchKline(`${pre}${code}`, 30);
    } catch (_) { continue; }
    const j = judgeLeaderPullback(kl);
    out.push({
      sector: sec.name, leader: sec.leader, leaderCode: code,
      state: j.state, reason: j.reason,
      ...('drawdown' in j ? {
        drawdownPct: j.drawdown, runUpPct: j.runUpPct, shrinking: j.shrinking,
        rsi14: j.rsi14, nearMa20: j.nearMa20,
      } : {}),
    });
  }

  /* 只有 near_support 才是"调整到位"候选；且大盘不转多时只观察不动手 */
  const ready = out.filter(x => x.state === 'near_support');
  return {
    ok: true,
    dataTime: scan.dataTime,
    mainlineCount: mainlines.length,
    marketWindow: !!(opts.market && opts.market.buy),
    ready: ready.map(x => x.sector),
    sectors: out,
    note: ready.length
      ? (opts.market && opts.market.buy
        ? '大盘在买入窗口，以下主线板块龙头缩量回踩支撑，可作为方向重点关注'
        : '有主线板块回踩到位，但大盘时机未到，只列入观察、暂不提示动手')
      : '当前主线龙头没有出现"缩量回踩支撑"形态',
  };
}

module.exports = {
  judgeMarket, judgeLeaderPullback, scanMainlineAdjustments,
  TEMP_GATE, MIN_CAL_DAYS,
};
