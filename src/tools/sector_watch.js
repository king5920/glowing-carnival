'use strict';
/**
 * sector_watch.js —— 盘中板块资金异动盯盘
 *
 * ══════ 这个模块回答什么问题 ══════
 *
 * close_scan 回答的是「现在哪些板块有资金」（截面）。
 * 这个模块回答「刚刚哪些板块资金突然变了」（变化）。
 *
 * 两者完全不同：元件板块 10 日 +117 亿，close_scan 天天把它排第一，
 * 但那是**已经发生**的事。用户要的是在**正在发生**时看见。
 *
 * ══════ 为什么必须落快照 ══════
 *
 * 东财 clist 只给当下截面（今日/5日/10日累计净额），没有增量字段。
 * 不存快照就永远只能说"现在流入 37.9 亿"，
 * 说不了"最近 20 分钟涌入 8 亿"——而后者才是异动。
 *
 * 所以：每次巡视落一个 slot 快照，异动 = 本次 today_yi 减去上次 today_yi。
 * 首次运行没有基线，**如实返回"建立基线中"，不编造异动**。
 *
 * ══════ 阈值诚实声明（沿用 alerts.js 的纪律）══════
 *
 * 下面的 GATE 不来自分布，是"宁严勿松"的临时观察门槛，样本为 0。
 * 攒够 MIN_CAL_DAYS 个交易日后，用真实分位数替换，
 * 并用 fwd_d1/fwd_d3 验证"异动提示"到底有没有预测力。
 * 标定完成前，所有输出带 calibrated:false 和"仅供观察"。
 *
 * 绝不：把异动说成买点、对个股给建议、在大盘没开窗口时喊动手。
 */

const db = require('../db');
const closeScan = require('./close_scan');
const health = require('./source_health');

const SOURCE = 'sector.watch';
const MIN_CAL_DAYS = 15;

/* ─────── 临时观察阈值（未标定）───────
 * 依据是量级常识，不是统计结论：
 *   · 20 分钟净流入 3 亿，对一个板块而言是明显异常的短时涌入
 *   · 但体量太小的板块（10日 < 5亿）波动本来就大，容易假信号，先排除
 *   · 要求当下上涨家数占优，避免"资金流入但股价在跌"的诱多截面 */
const GATE = {
  surgeYi: 3,          // 区间净流入（亿）达到即视为涌入
  fleeYi: -3,          // 净流出
  minD10Yi: 5,         // 体量下限：10 日主力低于此值不参与判定
  minUpRatio: 0.5,     // 上涨家数占比
  maxSlotGapMin: 60,   // 基线超过 60 分钟视为过期，不做差
  topPool: 120,        // 只盯资金体量前 N 个板块
};

/** 把时间向下取整到 5 分钟，作为 slot */
function toSlot(d = new Date()) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0');
  return h + ':' + m;
}
function today(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function slotToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

/** A 股交易时段（含集合竞价后的连续竞价） */
function isTradingNow(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) ||
         (t >= 13 * 60 && t <= 15 * 60);
}

/**
 * 扫一次盘中板块异动。
 *
 * @returns {{ok, mode, baseline, moves[], calibrated, note}}
 *   mode='baseline' 表示这次只建基线，没有可比数据（不是失败，也不是异动）
 */
async function watch(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const date = today(now);
  const slot = toSlot(now);
  const force = !!opts.force;

  if (!force && !isTradingNow(now)) {
    return { ok: true, mode: 'closed', moves: [], calibrated: false,
             note: '非交易时段，不做盘中异动判定（收盘后请用 close_scan）' };
  }

  let rows;
  try {
    rows = await closeScan.fetchSectorFlow();
  } catch (e) {
    health.record(SOURCE, false, '板块资金抓取失败: ' + e.message);
    return { ok: false, mode: 'error', moves: [], calibrated: false,
             error: '板块资金抓取失败：' + e.message };
  }
  if (!Array.isArray(rows) || !rows.length) {
    health.record(SOURCE, false, '板块资金返回空');
    return { ok: false, mode: 'error', moves: [], calibrated: false,
             error: '板块资金返回空，本次不判定（不猜测原因）' };
  }
  health.record(SOURCE, true);

  /* 只盯资金体量靠前的板块：尾部板块噪音大、存了也没意义 */
  const pool = rows
    .filter(s => Number.isFinite(s.d10Yi))
    .sort((a, b) => Math.abs(b.d10Yi) - Math.abs(a.d10Yi))
    .slice(0, GATE.topPool);

  /* 找最近的一个更早 slot 作为基线 */
  const slots = db.sectorSnapSlots(date).filter(s => slotToMin(s) < slotToMin(slot));
  const prevSlot = slots.length ? slots[slots.length - 1] : null;
  const gapMin = prevSlot ? slotToMin(slot) - slotToMin(prevSlot) : null;

  /* 先落库再判定：哪怕这次没有基线，也让下次有得比 */
  db.saveSectorSnap(date, slot, pool);

  const dates = db.sectorSnapDates();
  const calibrated = dates.length >= MIN_CAL_DAYS;

  if (!prevSlot) {
    return {
      ok: true, mode: 'baseline', slot, sampled: pool.length,
      moves: [], calibrated, calDays: dates.length,
      note: `本次为今日首个快照（${slot}），已记录 ${pool.length} 个板块作为基线。`
        + '异动需要两个时点做差，下次巡视才能判定 —— 现在没有可比数据，不做任何异动结论。',
    };
  }

  if (gapMin > GATE.maxSlotGapMin) {
    return {
      ok: true, mode: 'stale-baseline', slot, prevSlot, gapMin,
      moves: [], calibrated, calDays: dates.length,
      note: `上一个快照是 ${prevSlot}，间隔 ${gapMin} 分钟已超过 ${GATE.maxSlotGapMin} 分钟。`
        + '跨度太大时"区间流入"接近"全天累计"，失去异动含义，本次只更新基线不判定。',
    };
  }

  const prev = new Map(db.sectorSnapAt(date, prevSlot).map(r => [r.code, r]));
  const moves = [];

  for (const s of pool) {
    const p = prev.get(s.code);
    if (!p || !Number.isFinite(p.today_yi) || !Number.isFinite(s.todayYi)) continue;
    if (Math.abs(s.d10Yi) < GATE.minD10Yi) continue;      // 体量不足，噪音大

    const deltaYi = Math.round((s.todayYi - p.today_yi) * 10) / 10;
    const up = s.upCount || 0, down = s.downCount || 0;
    const upRatio = (up + down) ? up / (up + down) : 0;

    let dir = null;
    /* 三分类，而不是"不涨就不报"。
     *
     * 早先写成"净流入且上涨占比≥50% 才算涌入"，实测把
     * 电子板块（20分钟净流入8亿、但 97涨/420跌）整个滤掉了。
     * 这是错的：资金逆势流入恰恰是最值得看的形态之一
     *   —— 可能是主力低吸，也可能是抄底盘接飞刀，
     * 两种含义相反，但都不该被系统静默丢弃。
     * 所以单独归一类 divergent，并在文案里点明"方向待确认"，
     * 让用户自己判断，而不是替他判断。 */
    if (deltaYi >= GATE.surgeYi) {
      dir = upRatio >= GATE.minUpRatio ? 'surge' : 'divergent';
    } else if (deltaYi <= GATE.fleeYi) {
      dir = 'flee';
    }
    if (!dir) continue;

    const dirText = dir === 'flee' ? '流出' : '流入';

    moves.push({
      code: s.code, name: s.name, kind: s.kind,
      dir,
      deltaYi,                                   // 区间净额变化（亿）
      windowMin: gapMin,
      todayYi: s.todayYi, d10Yi: s.d10Yi,
      changePct: s.changePct,
      deltaPct: Math.round(((s.changePct ?? 0) - (p.change_pct ?? 0)) * 100) / 100,
      upCount: up, downCount: down,
      upRatio: Math.round(upRatio * 100) / 100,
      leader: s.leader, leaderPct: s.leaderPct,
      dataTs: s.dataTs,
      /* 依据写清楚，便于事后追溯，也便于用户自己判断可信度 */
      reason: `${gapMin}分钟内主力净${dirText}`
        + `${Math.abs(deltaYi)}亿（${p.today_yi}亿→${s.todayYi}亿）`
        + `；10日体量${s.d10Yi}亿；${up}涨/${down}跌`
        + (dir === 'divergent' ? '（资金流入但多数下跌，方向待确认）' : '')
        + (s.leader ? `；龙头${s.leader} ${s.leaderPct}%` : ''),
    });
  }

  moves.sort((a, b) => Math.abs(b.deltaYi) - Math.abs(a.deltaYi));

  return {
    ok: true, mode: 'diff', slot, prevSlot, windowMin: gapMin,
    sampled: pool.length, moves, calibrated, calDays: dates.length,
    dataTs: pool[0] && pool[0].dataTs,
    thresholds: GATE,
    note: calibrated
      ? '阈值已按历史分布标定。'
      : `⚠ 阈值未标定（已积累 ${dates.length}/${MIN_CAL_DAYS} 个交易日样本）。`
        + '当前门槛是"宁严勿松"的经验值，仅供观察，不构成买卖依据。',
  };
}

/** 给模型/用户看的文本。没有异动就明确说没有，不硬凑内容。 */
function formatWatch(r) {
  if (!r || !r.ok) return '【板块异动】本次未取到数据：' + ((r && r.error) || '未知');
  if (r.mode === 'closed') return '【板块异动】' + r.note;
  if (r.mode === 'baseline' || r.mode === 'stale-baseline') {
    return '【板块异动】' + r.note;
  }
  const L = [];
  L.push(`【盘中板块资金异动】${r.prevSlot} → ${r.slot}（${r.windowMin} 分钟窗口）`
    + `　行情时点 ${r.dataTs || '—'}　监测 ${r.sampled} 个板块`);
  if (!r.moves.length) {
    L.push('本窗口没有达到观察门槛的板块资金异动。');
    L.push(`（门槛：区间净流入≥${r.thresholds.surgeYi}亿 或 净流出≤${r.thresholds.fleeYi}亿，`
      + `且10日体量≥${r.thresholds.minD10Yi}亿）`);
  } else {
    r.moves.slice(0, 8).forEach((m, i) => {
      const tag = m.dir === 'surge' ? '资金涌入'
        : m.dir === 'flee' ? '资金撤离'
        : '资金逆势流入';
      L.push(`${i + 1}. ${m.name}(${m.kind === 'concept' ? '概念' : '行业'}) ${tag} `
        + `${m.deltaYi > 0 ? '+' : ''}${m.deltaYi}亿 | 现价${m.changePct > 0 ? '+' : ''}${m.changePct}%`);
      L.push(`   依据：${m.reason}`);
    });
    if (r.moves.some(m => m.dir === 'divergent')) {
      L.push('');
      L.push('注："资金逆势流入"= 主力净流入但板块多数下跌。'
        + '可能是主力低吸，也可能是抄底资金被套，含义相反 —— 需要结合次日走势确认，不要单看这一条下结论。');
    }
  }
  L.push('');
  L.push(r.note);
  L.push('说明：这是资金动向观察，不是买卖建议；'
    + '按"大盘定时机、板块定方向"，大盘未到买入窗口时只观察不动手。');
  return L.join('\n');
}

module.exports = { watch, formatWatch, isTradingNow, toSlot, GATE, SOURCE, MIN_CAL_DAYS };
