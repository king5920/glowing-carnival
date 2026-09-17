'use strict';
/* 买卖点条件式提示模块：对股票池内个股做「条件式」买卖点状态判断。
 *
 * 与 alerts.js 的分工（沿用 Phase 28 盘面纪律）：
 *   alerts 管大盘与板块（有没有时机、方向去哪）；
 *   本模块管个股（池子里每只当前处于什么技术状态）。
 *
 * 纪律红线：
 * 1. 输出是条件式触发描述（"放量站回5日线可关注"），绝不给出确定性买卖指令。
 * 2. 大盘不在买入窗口时，买点类信号降级为"仅供观察"（marketOk:false）；
 *    卖点类（跌破/超买）不受闸门限制——风险提示任何时候都该报。
 * 3. 同日同股同类型只记一次（DB 主键去重），不刷屏。
 */

const sentiment = require('./sentiment');
const alerts = require('./alerts');
const poolMod = require('./stock_pool');

/* ── 判定阈值（条件式阈值，未标定，宁严勿松）── */
const TH = {
  breakoutVolRatio: 1.5,   // 突破放量：当日量 > 5日均量 × 1.5
  overboughtRsi: 80,       // 超买
  lagPct: 1,               // 滞涨：当日涨幅 < 1%
};

/** MA20 斜率（近 5 根窗口）：返回最新 MA20 减去 5 根前的 MA20，负 = 走平/向下 */
function ma20Slope(kl) {
  const closes = kl.map(k => k.close);
  const n = closes.length;
  if (n < 25) return 0;
  const now = sentiment.sma(closes, 20);
  const prevWin = closes.slice(0, n - 5);
  const prev = prevWin.length >= 20 ? sentiment.sma(prevWin, 20) : null;
  if (prev == null) return 0;
  return now - prev;
}

/**
 * 对单只个股判买卖点信号（纯函数，可单测）。
 * @param {Array} kl 日K [{date,open,close,high,low,volume}]，≥20 根
 * @returns {Array} [{sigType, triggerDesc, refPrice, refMa20}]
 */
function judgeSignals(kl) {
  if (!kl || kl.length < 20) return [];
  const s = sentiment.indexTechnicals(kl);
  const closes = kl.map(k => k.close);
  const last = closes[closes.length - 1];
  const vols = kl.map(k => k.volume).filter(v => v != null);
  const signals = [];

  const volToday = vols.length ? vols[vols.length - 1] : null;
  const avg5 = vols.length >= 5
    ? vols.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const pctToday = closes.length >= 2
    ? (last / closes[closes.length - 2] - 1) * 100 : null;

  /* ① buy_near_support：复用龙头回调判断（前期强势+回撤≥6%+缩量+贴近均线），
   * 再叠加 RSI 40-55（降温但不弱）。 */
  const pb = alerts.judgeLeaderPullback(kl);
  if (pb.state === 'near_support') {
    const rsiOk = pb.rsi14 == null || (pb.rsi14 >= 40 && pb.rsi14 <= 55);
    if (rsiOk) {
      signals.push({
        sigType: 'buy_near_support',
        triggerDesc: `回踩${pb.nearMa20 ? 'MA20' : 'MA10'}缩量企稳（现价${pb.last}，`
          + `${pb.nearMa20 ? 'MA20 ' + pb.ma20 : 'MA10 ' + pb.ma10}），放量收回可关注`,
        refPrice: pb.last,
        refMa20: pb.ma20,
      });
    }
  }

  /* ② buy_breakout：放量 + 收盘创 20 日新高。
   * 注意：新高参照必须不含当日 high，否则当根高点必 ≥ 当根收盘，条件永不成立。 */
  const priorHigh = kl.length > 1
    ? Math.max(...kl.slice(0, -1).map(k => k.high)) : null;
  if (volToday != null && avg5 != null && priorHigh != null
    && volToday > avg5 * TH.breakoutVolRatio && last > priorHigh) {
    signals.push({
      sigType: 'buy_breakout',
      triggerDesc: `放量突破20日新高（现价${last}，量比${(volToday / avg5).toFixed(1)}），站稳可关注`,
      refPrice: last,
      refMa20: s.ma20,
    });
  }

  /* ③ buy_golden_cross：收盘站上 MA20 且 MACD 金叉 */
  if (s.aboveMa20 === true && s.macdCross === 'golden') {
    signals.push({
      sigType: 'buy_golden_cross',
      triggerDesc: `站上MA20且MACD金叉（现价${last}，MA20 ${s.ma20 ? s.ma20.toFixed(2) : '—'}），趋势转多可关注`,
      refPrice: last,
      refMa20: s.ma20,
    });
  }

  /* ④ sell_broken_ma20：收盘跌破 MA20 且 MA20 走平/向下 */
  if (s.ma20 != null && last < s.ma20 && ma20Slope(kl) <= 0) {
    signals.push({
      sigType: 'sell_broken_ma20',
      triggerDesc: `跌破MA20（现价${last}，MA20 ${s.ma20.toFixed(2)}）且均线走平/向下，趋势转弱需警惕`,
      refPrice: last,
      refMa20: s.ma20,
    });
  }

  /* ⑤ sell_overbought：RSI≥80 且放量滞涨（涨幅<1% 或收阴） */
  if (s.rsi14 != null && s.rsi14 >= TH.overboughtRsi
    && volToday != null && avg5 != null && volToday > avg5 * TH.breakoutVolRatio) {
    const lag = pctToday != null && (pctToday < TH.lagPct || last < closes[closes.length - 2]);
    if (lag) {
      signals.push({
        sigType: 'sell_overbought',
        triggerDesc: `RSI超买(${s.rsi14.toFixed(1)})+高位放量滞涨（今日${pctToday.toFixed(1)}%），短线过热需警惕`,
        refPrice: last,
        refMa20: s.ma20,
      });
    }
  }

  return signals;
}

/**
 * 主入口：读股票池 → 逐一判信号 → 大盘闸门 → 落库。
 * @param {object} opts { pool?: 显式传池子(便于测试), checkMarket?: 是否查大盘, marketBuy?: 显式传大盘闸门 }
 * @returns {object} { ok, date, market, signals, findings, didSomething, worthReporting:false, ... }
 */
async function run(opts = {}) {
  const dbm = require('../db');
  const d = new Date();
  const date = opts.date || (d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0'));

  /* 1. 读池（最新一次选股快照） */
  let poolRows;
  try {
    poolRows = opts.pool || dbm.latestStockPool();
  } catch (e) {
    return { ok: false, error: '读取股票池失败: ' + e.message, findings: [], didSomething: false, worthReporting: false };
  }
  if (!poolRows || !poolRows.length) {
    return {
      ok: true, date, poolEmpty: true, signals: [], findings: [],
      didSomething: false, worthReporting: false,
      note: '股票池为空（可能今天还没跑选股，或收盘扫描无候选）',
    };
  }

  /* 2. 大盘闸门 */
  const market = { buy: null, checked: false };
  if (opts.checkMarket === false) {
    if (opts.marketBuy != null) { market.buy = !!opts.marketBuy; market.checked = true; }
  } else {
    try {
      const snap = await sentiment.snapshot();
      const j = alerts.judgeMarket(snap);
      market.buy = j.buy;
      market.checked = true;
      market.checks = j.checks;
      market.calibrated = j.calibrated;
      market.reason = j.reason;
    } catch (e) {
      market.error = e.message;
      market.checked = false;
    }
  }

  /* 3. 逐一判信号 */
  const signals = [];
  const errors = [];
  const asOf = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  for (const row of poolRows) {
    let kl;
    try {
      kl = await sentiment.fetchKline(poolMod.secidOf(row.code), 60);
    } catch (e) {
      errors.push({ code: row.code, error: 'K线拉取失败: ' + e.message });
      continue;
    }
    if (!kl || kl.length < 20) { errors.push({ code: row.code, error: 'K线不足20日' }); continue; }

    const sigs = judgeSignals(kl);
    for (const sig of sigs) {
      const isBuy = sig.sigType.startsWith('buy_');
      const row2 = {
        date, code: row.code, name: row.name,
        sigType: sig.sigType, triggerDesc: sig.triggerDesc,
        refPrice: sig.refPrice, refMa20: sig.refMa20,
        asOf, dataTs: kl[kl.length - 1].date,
        marketOk: isBuy ? market.buy : true,   // 买点受大盘闸门，卖点恒报
        source: 'intraday',
      };
      try { dbm.saveStockSignal(row2); } catch (e) { errors.push({ code: row.code, sigType: sig.sigType, error: '落库失败: ' + e.message }); }
      signals.push(row2);
    }
  }

  /* 4. findings */
  const findings = signals.map(sig => ({
    kind: 'stock_signal_' + sig.sigType,
    severity: sig.sigType.startsWith('sell_') ? 'medium' : 'low',
    text: `${sig.marketOk ? '' : '(大盘时机未到·仅观察) '}${sig.name || sig.code} ${sig.triggerDesc}`,
    data: {
      code: sig.code, name: sig.name, sigType: sig.sigType,
      refPrice: sig.refPrice, refMa20: sig.refMa20,
      marketOk: sig.marketOk, as_of: sig.asOf,
    },
  }));

  return {
    ok: true,
    date,
    at: asOf,
    market: { buy: market.buy, checked: market.checked, reason: market.reason || null, calibrated: market.calibrated || false },
    poolSize: poolRows.length,
    signalCount: signals.length,
    signals,
    errors,
    findings,
    didSomething: signals.length > 0,
    /* 恒为 false：用户选了只在网页看。改之前必须先问。 */
    worthReporting: false,
    calibrated: false,
    note: '条件式触发描述，非确定性买卖建议；阈值未标定，宁严勿松',
  };
}

module.exports = { run, judgeSignals, ma20Slope, TH };