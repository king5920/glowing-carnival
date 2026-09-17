'use strict';
/**
 * chan.js —— 缠论结构识别（第一版：包含处理 → 分型 → 笔 → 笔中枢 → 走势）
 * ─────────────────────────────────────────────────────────────────────
 * 用户 2026-09-13 拍板，定义按通行标准版冻结（docs/大盘判定升级-设计基线.md §1.2）：
 *
 *   1. K线包含处理：相邻K线存在包含关系时按【当前方向】合并——
 *      向上取两者高高、低高；向下取两者低低、高低。方向由合并前的相邻关系决定。
 *   2. 分型：三根【合并后】K线，中间高点最高=顶分型；中间低点最低=底分型。
 *   3. 笔：相邻一顶一底分型之间，【独立K（含分型K）≥5 根】才成一笔（新笔标准：
 *      顶底之间至少 5 根合并K，即分型间距 index 差 ≥4）。
 *   4. 笔中枢：连续三笔的价格重叠区，ZG=min(三笔高点)、ZD=max(三笔低点)，
 *      要求 ZG>ZD（确有重叠）才成立。
 *   5. 走势：中枢依次上移=上涨趋势，下移=下跌趋势，单一中枢反复=盘整。
 *
 * 第一版【不做线段】（线段特征序列分型流派分歧大），用笔中枢。
 * 只在 bar 收盘后调用——盘中未完成K不入库结论（调用方负责，本模块只认给进来的序列）。
 *
 * 全部纯函数、零网络零依赖，同输入必得同输出。
 */

/* ───────────────────────── 1. K线包含处理 ───────────────────────── */

/**
 * 包含关系合并。返回合并后的K线数组，每根带 _i（起始原索引）/_j（结束原索引），
 * 便于分型/笔回溯到原始bar。方向：先找上一对无包含K线确定 up/down。
 */
function mergeInclusion(bars) {
  if (!bars || !bars.length) return [];
  const out = [];
  for (const b of bars) {
    if (!b || b.high == null || b.low == null) continue;
    const cur = { high: +b.high, low: +b.low, date: b.date, open: b.open, close: b.close,
      _i: out.reduce((n, x) => Math.max(n, x._j + 1), 0), _j: 0 };

    if (!out.length) { cur._j = cur._i; out.push(cur); continue; }
    let prev = out[out.length - 1];

    const includes = (a, c) =>
      (a.high >= c.high && a.low <= c.low) || (c.high >= a.high && c.low <= a.low);

    if (!includes(prev, cur)) { cur._j = cur._i; out.push(cur); continue; }

    /* 存在包含：按当前方向合并。方向取 prev 与更前一根的关系；无前导视为向上。 */
    const merged = Object.assign({}, prev);
    const up = out.length >= 2 ? out[out.length - 2].high < prev.high : true;
    if (up) { merged.high = Math.max(prev.high, cur.high); merged.low = Math.max(prev.low, cur.low); }
    else    { merged.high = Math.min(prev.high, cur.high); merged.low = Math.min(prev.low, cur.low); }
    merged._j = Math.max(prev._j, cur._i);
    merged.date = cur.date;          // 合并K以最新一根的时间为准（右端）
    if (cur.close != null) merged.close = cur.close;
    out[out.length - 1] = merged;
  }
  return out;
}

/* ───────────────────────── 2. 顶/底分型 ───────────────────────── */

/**
 * 在合并K序列上找分型。返回 [{type:'top'|'bottom', index, price, date}]
 * index 是合并K数组下标；price 顶=中间K高点、底=中间K低点。
 */
function fractals(merged) {
  const out = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1], b = merged[i], c = merged[i + 1];
    if (b.high > a.high && b.high > c.high && b.low > a.low && b.low > c.low) {
      out.push({ type: 'top', index: i, price: b.high, date: b.date });
    } else if (b.low < a.low && b.low < c.low && b.high < a.high && b.high < c.high) {
      out.push({ type: 'bottom', index: i, price: b.low, date: b.date });
    }
  }
  return out;
}

/* ───────────────────────── 3. 笔 ───────────────────────── */

/**
 * 从分型序列构造笔（标准单笔处理，结果稳定）。
 * 算法：
 *  1) 先把相邻【同类型】分型压成一个——顶取更高、底取更低（局部极值）。
 *  2) 在交替的顶底序列上顺序确认笔：
 *     - 维护"已确认的上一个端点 anchor"；
 *     - 下一个反类型分型与 anchor 间距≥MIN_GAP → 成笔，它成为新 anchor；
 *     - 间距不足：不能成笔。若来的是与 anchor 同方向更极端的分型（先经过了一个
 *       无效反类型），则把 anchor 更新为更极端者（趋势中继/破坏的常见处理），
 *       否则忽略。这样保证同输入同输出，且不会跨类型比价格。
 */
const MIN_GAP = 4;   // 合并K下标差≥4 ⇔ 含分型K共≥5根（新笔标准）

function strokes(fr) {
  if (!fr || fr.length < 2) return [];

  // 1) 相邻同向分型取极值
  const pts = [];
  for (const f of fr) {
    const last = pts[pts.length - 1];
    if (!last) { pts.push(f); continue; }
    if (f.type === last.type) {
      const better = f.type === 'top' ? f.price > last.price : f.price < last.price;
      if (better) pts[pts.length - 1] = f;
    } else {
      pts.push(f);
    }
  }

  // 2) 顺序确认笔
  const anchorPts = [];
  let anchor = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const f = pts[i];
    if (f.type === anchor.type) {
      // 同向（说明中间的反类型没能成笔）：取更极端者为新候选 anchor
      const more = f.type === 'top' ? f.price > anchor.price : f.price < anchor.price;
      if (more) anchor = f;
      continue;
    }
    // 反类型
    if (f.index - anchor.index >= MIN_GAP) {
      anchorPts.push(anchor);
      anchor = f;                 // 成笔，反类型成为新端点
    } else {
      // 间距不足不能成笔：反类型忽略，anchor 保留（等后续更远的反类型）
      // 若之后出现同向更极端分型，上面分支会更新 anchor。
    }
  }
  anchorPts.push(anchor);

  const out = [];
  for (let i = 1; i < anchorPts.length; i++) {
    const from = anchorPts[i - 1], to = anchorPts[i];
    if (from.type === to.type || to.index - from.index < MIN_GAP) continue;
    out.push({
      dir: from.type === 'bottom' ? 'up' : 'down',
      from, to,
      high: Math.max(from.price, to.price),
      low: Math.min(from.price, to.price),
    });
  }
  return out;
}

/* ───────────────────────── 4. 笔中枢 ───────────────────────── */

/**
 * 连续三笔找中枢（三笔价格重叠区）。
 * ZG = min(三笔高点)；ZD = max(三笔低点)；ZG>ZD 才成立。
 * 扫描每一组相邻三笔，产生中枢段；重叠的相邻中枢合并（延伸），不重叠则新生。
 * 返回 [{zG,zD, fromStroke, toStroke, startDate, endDate, dir}]（按时间）。
 */
function pivots(st) {
  const raw = [];
  for (let i = 0; i + 2 < st.length; i++) {
    const a = st[i], b = st[i + 1], c = st[i + 2];
    const zG = Math.min(a.high, b.high, c.high);
    const zD = Math.max(a.low, b.low, c.low);
    if (zG > zD) {
      raw.push({
        zG, zD,
        fromStroke: i, toStroke: i + 2,
        startDate: a.from.date, endDate: c.to.date,
      });
    }
  }
  // 合并相邻重叠的中枢（中枢延伸/扩展）：新区间与旧中枢有价格重叠且笔段相邻
  const zones = [];
  for (const z of raw) {
    const last = zones[zones.length - 1];
    if (last && z.fromStroke <= last.toStroke + 1 && z.zG >= last.zD && z.zD <= last.zG) {
      last.zG = Math.min(last.zG, z.zG);
      last.zD = Math.max(last.zD, z.zD);
      last.toStroke = Math.max(last.toStroke, z.toStroke);
      last.endDate = z.endDate;
    } else {
      zones.push(Object.assign({}, z));
    }
  }
  return zones;
}

/* ───────────────────────── 5. 走势类型 ───────────────────────── */

/**
 * 依据中枢相对位置判走势：
 *  - 至少两个中枢，后中枢 ZD > 前中枢 ZG（不重叠且上移）→ up 上涨趋势
 *  - 后中枢 ZG < 前中枢 ZD（下移）→ down 下跌趋势
 *  - 否则 → range 盘整（含单一中枢）
 * 另给 priceVsZone：当前价相对最后中枢的位置（above/inside/below/leaving）。
 */
function trend(zones, lastPrice) {
  let type = 'range';
  if (zones.length >= 2) {
    const prev = zones[zones.length - 2], last = zones[zones.length - 1];
    if (last.zD > prev.zG) type = 'up';
    else if (last.zG < prev.zD) type = 'down';
  }
  let pricePos = null;
  const last = zones[zones.length - 1];
  if (last && lastPrice != null) {
    if (lastPrice > last.zG) pricePos = 'above';
    else if (lastPrice < last.zD) pricePos = 'below';
    else pricePos = 'inside';
  }
  return { type, pricePos };
}

/* ───────────────────────── 6. 单级别分析 ───────────────────────── */

/**
 * 完整跑一个级别。输入 bars（已按时间升序、收盘确认）。
 * @returns {level 结构详情 + phase 仅在日线级调用时由 phaseOf 解释}
 */
function analyzeLevel(bars) {
  const merged = mergeInclusion(bars || []);
  const fr = fractals(merged);
  const st = strokes(fr);
  const zones = pivots(st);
  const lastPrice = bars && bars.length ? +bars[bars.length - 1].close : null;
  const tr = trend(zones, lastPrice);
  return {
    bars: (bars || []).length,
    mergedCount: merged.length,
    fractalCount: fr.length,
    lastFractal: fr.length ? fr[fr.length - 1] : null,
    strokeCount: st.length,
    lastStroke: st.length ? st[st.length - 1] : null,
    strokes: st,
    zones,
    trend: tr.type,
    pricePos: tr.pricePos,
    lastPrice,
  };
}

/* ───────────────────────── 7. 多级别联立 ───────────────────────── */

/**
 * 大级别定方向、小级别找时机（区间套思想，先大后小）。
 * @param {object} levels 形如 {day, h1, m30} 各级别 analyzeLevel 结果，
 *   从大到小传。缺级别自动跳过。
 * @returns {{bias:'long'|'short'|'neutral', agree:boolean, detail}}
 *   bias: 最大级别趋势决定多空倾向；小级别只决定 timing 是否到位，不翻转 bias。
 */
function combine(levels) {
  const order = ['day', 'h1', 'm30', 'm15', 'm5'];
  const have = order.filter(k => levels[k]).map(k => ({ k, v: levels[k] }));
  if (!have.length) return { bias: 'neutral', agree: false, detail: '无级别数据' };

  const big = have[0];
  const bias = big.v.trend === 'up' ? 'long' : big.v.trend === 'down' ? 'short' : 'neutral';

  // 时机：做多需要最大级别不向下，且最小级别出现 up 笔/回到中枢下沿上方
  const small = have[have.length - 1].v;
  const smallUpStroke = small.lastStroke && small.lastStroke.dir === 'up';
  const timingLong = bias === 'long' && (small.pricePos === 'above' || smallUpStroke);
  const timingShort = bias === 'short' && (small.pricePos === 'below' ||
    (small.lastStroke && small.lastStroke.dir === 'down'));

  const detail = have.map(h => `${h.k}:${h.v.trend}/${h.v.pricePos || '-'}`).join('  ');
  return {
    bias,
    agree: bias !== 'neutral',
    timingLong: !!timingLong,
    timingShort: !!timingShort,
    bigTrend: big.v.trend, bigLevel: big.k,
    detail,
  };
}

/* ───────────────────────── 8. 六阶段映射 ───────────────────────── */

/**
 * 把日线结构 + 多级别状态翻译成大白话生命阶段。
 * 六阶段：退潮 / 磨底 / 筑底 / 启动 / 主升 / 高位震荡。
 * 规则保守、可复算（不靠模型自由发挥）：
 *
 *  day trend down + 价格在中枢下沿/下方     → 退潮期
 *  day trend down 但小级别出现 up 笔/底分型  → 磨底期（下跌末端，结构开始抵抗）
 *  day range，且长期在低位（价格贴近最后中枢）→ 筑底期
 *  day trend 由下转 range/up 的初期、小级别多  → 启动期
 *  day trend up + 价格在中枢上方             → 主升期
 *  day range 但价格在高位中枢上沿附近震荡      → 高位震荡期
 */
function phaseOf(day, combo) {
  if (!day) return { phase: 'unknown', reason: '无日线数据' };
  const t = day.trend, pos = day.pricePos;
  const smallTurnUp = combo && combo.timingLong;

  if (t === 'down') {
    if (pos === 'below') return { phase: '退潮期', reason: '日线中枢下移且价在中枢下方' };
    // 下跌但价格回到中枢内/下沿，且小级别开始向上 → 末端磨底
    if (smallTurnUp) return { phase: '磨底期', reason: '日线仍在下跌结构，但小级别出现向上笔，抵抗出现' };
    return { phase: '退潮期', reason: '日线中枢下移' };
  }
  if (t === 'up') {
    if (pos === 'above') return { phase: '主升期', reason: '日线中枢上移且价在中枢上方' };
    return { phase: '启动期', reason: '日线中枢上移但价尚未远离中枢' };
  }
  // range 盘整：看价格在最后中枢的位置区分筑底/高位震荡
  if (pos === 'below') return { phase: '磨底期', reason: '盘整但价在中枢下方，偏弱寻底' };
  if (pos === 'above') return { phase: '高位震荡期', reason: '盘整但价在中枢上方，高位拉锯' };
  // 在中枢内：用是否有向上启动迹象区分
  if (smallTurnUp) return { phase: '启动期', reason: '中枢震荡中小级别转强，尝试向上' };
  return { phase: '筑底期', reason: '日线在中枢内反复，无明显方向' };
}

/** 一站式：给 {day,h1,m30} 各级别 bars，返回阶段+证据链。
 *  各级用 analyzeLevelV2：在 V1（阶段判定所需 trend/pricePos/zones）之上，
 *  再带 笔中枢/线段/买卖点/背驰/MACD，且不破坏 V1 字段（Object.assign 叠加）。 */
function analyzeMarket(levelBars) {
  const lv = {};
  for (const k of Object.keys(levelBars || {})) {
    const bars = levelBars[k];
    if (!bars || !bars.length) { lv[k] = null; continue; }   // 缺失/失败级别置 null，不伪造
    lv[k] = analyzeLevelV2(bars);
  }
  const combo = combine(lv);
  const phase = phaseOf(lv.day, combo);
  return { phase: phase.phase, reason: phase.reason, combo, levels: lv };
}

/* ════════════════════════════════════════════════════════════════════
 * 第二版（方案A，对齐用户通达信 DLL 缠论主图的视觉口径，2026-09-13）
 *   笔 → 线段 → 线段中枢 → 三类买卖点 + 智能MACD顶底背驰。
 * 说明：用户指标的精确算法编译在 cl.dll/clxg.dll 中（不可读），
 * 这里按通行"特征序列"工程化近似复刻，目标是【和人眼看图一致】，不逐位等同 DLL。
 * ════════════════════════════════════════════════════════════════════ */

/* ── EMA / MACD（智能MACD口径：12/26/9，柱=2*(DIF-DEA)，与常见软件一致）── */
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v == null || !isFinite(v)) { out.push(prev); continue; }
    prev = (prev == null) ? v : (v - prev) * k + prev;
    out.push(prev);
  }
  return out;
}
/** 返回 {dif:[], dea:[], hist:[]}，长度与 closes 对齐，前段为 null。 */
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const cs = (closes || []).map(x => (x == null ? null : +x));
  const ef = ema(cs, fast), es = ema(cs, slow);
  const dif = cs.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  // DEA = DIF 的9期EMA（跳过前导null，从首个有效DIF起算）
  const dea = new Array(cs.length).fill(null);
  let prev = null, started = false;
  const kd = 2 / (sig + 1);
  for (let i = 0; i < dif.length; i++) {
    if (dif[i] == null) continue;
    prev = started ? (dif[i] - prev) * kd + prev : dif[i];
    started = true; dea[i] = prev;
  }
  const hist = dif.map((d, i) => (d == null || dea[i] == null ? null : 2 * (d - dea[i])));
  return { dif, dea, hist };
}

/* ── 线段（工程化特征序列）────────────────────────────────────────────
 * 标准缠论：一条线段至少由3笔构成；线段的终结由"反向特征序列出现分型"确认。
 * 工程上等价且稳定的做法（这里采用，保证同输入同输出、线段首尾相接不重叠）：
 *
 *  状态机沿笔序列推进，维护当前线段方向 dir 与极值点 extreme（线段候选端点）：
 *   - 顺向笔创新高/新低 → 更新极值点；
 *   - 反向笔计数：从极值点起，反向笔已累计到【第2根】（即至少走出 下-上-下
 *     三根笔的结构），且其中某个反向笔【跌破/升破"极值点之前最近一次顺向笔
 *     的起点"】→ 确认反向特征序列分型，线段在 extreme 终结；新线段从 extreme
 *     开始、方向翻转。
 *  这样线段严格交替、端点即下一线段起点（与通达信画笔/线段主图观感一致）。
 *  末尾不足确认条件的部分作为"未确认线段"输出(open=true)，避免吞掉最新结构。
 */
const SEG_MIN_STROKES = 3;   // 一条线段至少由3笔构成

function segments(st) {
  if (!st || st.length < SEG_MIN_STROKES) return [];

  const segs = [];
  let dir = st[0].dir;               // 当前线段方向
  let anchor = st[0].from;          // 线段起点（=上一线段端点）
  let extreme = st[0].to;           // 线段极值点（候选结束点）
  let extremeStroke = 0;            // 极值点所在笔下标
  let revCount = 0;                 // 从极值起反向笔计数（顺向创新极值清零）

  const finish = (endStrokeIdx, endPoint, newDir, open) => {
    segs.push({
      dir, from: anchor, to: endPoint,
      high: Math.max(anchor.price, endPoint.price),
      low: Math.min(anchor.price, endPoint.price),
      strokes: [segs.length ? segs[segs.length - 1].strokes[1] : 0, endStrokeIdx],
      open: !!open,
    });
    anchor = endPoint;              // 首尾相接
    dir = newDir;
    extreme = endPoint;
    extremeStroke = endStrokeIdx;
    revCount = 0;
  };

  for (let i = 1; i < st.length; i++) {
    const s = st[i];
    if (s.dir === dir) {
      // 顺向笔：创新极值则推进；这也意味着之前的回撤被否定
      const better = dir === 'up' ? s.to.price > extreme.price : s.to.price < extreme.price;
      if (better) { extreme = s.to; extremeStroke = i; revCount = 0; }
      continue;
    }
    // 反向笔
    revCount++;
    // 需要确认：极值之后至少出现 2 根反向笔（即 上-下-上 / 下-上-下 三笔结构），
    // 且最新反向笔突破"极值点前最近顺向笔的起点"（特征序列分型成立）。
    if (revCount >= 2 && i - extremeStroke >= 2) {
      const ref = st[extremeStroke];  // 创出极值的那根顺向笔，其 from 即关键位
      const broken = dir === 'up' ? s.low < ref.from.price : s.high > ref.from.price;
      if (broken) {
        finish(extremeStroke, extreme, dir === 'up' ? 'down' : 'up', false);
        // 终结后，当前这根反向笔成为新线段的第1笔；其 to 作为新极值候选
        if (dir === s.dir) { extreme = s.to; extremeStroke = i; revCount = 0; }
      }
    }
  }

  // 收尾：输出尚未被反向确认的最后一段（未确认）
  const last = st[st.length - 1];
  let tailEnd = extreme;
  // 若最后一笔顺向把价格带得更远，用最后一笔端点
  if (last.dir === dir) {
    const further = dir === 'up' ? last.to.price >= extreme.price : last.to.price <= extreme.price;
    if (further) tailEnd = last.to;
  }
  const lastSeg = segs[segs.length - 1];
  if (!lastSeg || lastSeg.to.date !== tailEnd.date || lastSeg.from.date !== anchor.date) {
    segs.push({
      dir, from: anchor, to: tailEnd,
      high: Math.max(anchor.price, tailEnd.price),
      low: Math.min(anchor.price, tailEnd.price),
      strokes: [lastSeg ? lastSeg.strokes[1] : 0, st.length - 1],
      open: true,
    });
  }
  return segs;
}

/* ── 线段中枢：连续三线段重叠区 ── */
function segPivots(segs) {
  const raw = [];
  for (let i = 0; i + 2 < (segs || []).length; i++) {
    const a = segs[i], b = segs[i + 1], c = segs[i + 2];
    const zG = Math.min(a.high, b.high, c.high);
    const zD = Math.max(a.low, b.low, c.low);
    if (zG > zD) raw.push({ zG, zD, fromSeg: i, toSeg: i + 2, startDate: a.from.date, endDate: c.to.date });
  }
  const zones = [];
  for (const z of raw) {
    const last = zones[zones.length - 1];
    if (last && z.fromSeg <= last.toSeg + 1 && z.zG >= last.zD && z.zD <= last.zG) {
      last.zG = Math.min(last.zG, z.zG);
      last.zD = Math.max(last.zD, z.zD);
      last.toSeg = Math.max(last.toSeg, z.toSeg);
      last.endDate = z.endDate;
    } else zones.push(Object.assign({}, z));
  }
  return zones;
}

/* ── 顶/底背驰：价格创新高/新低，但 MACD（DIF 或 柱面积）不配合 ────────
 * @param swingPts 摆动极值点 [{type:'top'|'bottom', price, index}]（通常取线段端点）
 * @param m macd() 结果
 * 规则（可复算）：比较相邻两个同向极值——
 *   顶背驰：后高 price 更高，但后高处 DIF 更低（或 hist 峰值更小）；
 *   底背驰：后低 price 更低，但后低处 DIF 更高（或 hist 谷值更浅）。
 */
/* 取某摆动极值点对应的 MACD 动能：
 * 先看 ±half 窗口确定本极值的柱符号（顶=红正、底=绿负），再从该点【向前回溯】
 * 到同号柱簇的起点，取整簇 |hist| 峰值与 DIF 极值——这样跨十几根的衰竭也能捕捉。 */
function _macdNear(m, idx, half = 3) {
  let signHist = null;
  for (let i = Math.max(0, idx - half); i <= Math.min(m.hist.length - 1, idx + half); i++) {
    if (m.hist[i] != null && signHist == null) signHist = m.hist[i];
    else if (m.hist[i] != null && Math.abs(m.hist[i]) > Math.abs(signHist)) signHist = m.hist[i];
  }
  if (signHist == null) return { dif: null, hist: null };
  const sign = signHist >= 0 ? 1 : -1;
  let peak = signHist, difPeak = null;
  for (let i = idx; i >= 0; i--) {
    if (m.hist[i] == null) continue;
    const sameSign = sign > 0 ? m.hist[i] > 0 : m.hist[i] < 0;   // 0 视为簇边界
    if (sameSign) {
      if (Math.abs(m.hist[i]) > Math.abs(peak)) peak = m.hist[i];
      if (m.dif[i] != null) difPeak = (difPeak == null) ? m.dif[i]
        : (sign > 0 ? Math.max(difPeak, m.dif[i]) : Math.min(difPeak, m.dif[i]));
    } else if (i < idx - half) break;   // 离开本簇（含0轴）即停
  }
  return { dif: difPeak, hist: peak };
}
function divergence(swingPts, m) {
  const out = [];
  if (!swingPts || swingPts.length < 2 || !m) return out;
  let lastTop = null, lastBottom = null;   // 与【上一个同类型】极值比（中间可隔若干反向点）
  for (const b of swingPts) {
    if (b.index == null) continue;
    const a = b.type === 'top' ? lastTop : lastBottom;
    if (a) {
      const ma = _macdNear(m, a.index), mb = _macdNear(m, b.index);
      if (ma.hist != null && mb.hist != null) {
        if (b.type === 'top' && b.price > a.price && mb.hist < ma.hist) {
          out.push({ type: '顶背驰', at: b.date, index: b.index, price: b.price, prevPrice: a.price, by: 'MACD柱衰竭' });
        } else if (b.type === 'bottom' && b.price < a.price && mb.hist > ma.hist) {
          out.push({ type: '底背驰', at: b.date, index: b.index, price: b.price, prevPrice: a.price, by: 'MACD柱衰竭' });
        }
      }
    }
    if (b.type === 'top') lastTop = b; else lastBottom = b;
  }
  return out;
}

/* ── 三类买卖点（方案A：以"笔 + 笔中枢"为主，线段只做大方向）────────────
 * 笔中枢 zones 来自 pivots(strokes)，字段 {zG,zD,fromStroke,toStroke,startDate,endDate}。
 * 遍历笔（从第2根起）：
 * 买：
 *   一买：向下笔末端出现【笔级别底背驰】；
 *   二买：一买之后的下一个向下笔，低点高于一买低（不创新低）；
 *   三买：向上笔已离开某中枢(zG)，随后向下笔回抽的低点仍 > zG（不回中枢）。
 * 卖为镜像。同一时间同一类型只记一次。
 */
function buySellPoints(st, zones, divSet) {
  const out = [];
  if (!st || st.length < 3) return out;

  // 记下每个"一买/一卖"笔的下标，供二买二卖判断
  for (let i = 2; i < st.length; i++) {
    const s = st[i];
    const date = s.to.date, price = s.to.price;

    if (s.dir === 'down') {
      // 一买：笔底背驰
      if (divSet.has('底背驰@' + date)) {
        out.push({ kind: '一买', date, index: s.to.index, price, note: '向下笔末端底背驰' });
      }
      // 二买：往前找最近一个"底背驰向下笔"，本笔下不去它的低点
      for (let j = i - 2; j >= 0; j -= 2) {
        const pj = st[j];
        if (pj.dir === 'down' && divSet.has('底背驰@' + pj.to.date)) {
          if (s.low > pj.low) out.push({ kind: '二买', date, index: s.to.index, price, note: '一买后回踩不创新低' });
          break;
        }
      }
      // 三买：上一向上笔有效【升破】中枢上沿（脱离需≥0.6%，过滤只是蹭边），
      // 本向下笔回抽低点仍在 zG 上方（不回中枢）
      const up = st[i - 1];
      for (let z = zones.length - 1; z >= 0; z--) {
        const Z = zones[z];
        const brokeOut = up.dir === 'up' && up.high >= Z.zG * 1.006;
        if (brokeOut && s.low > Z.zG && date > Z.endDate) {
          out.push({ kind: '三买', date, index: s.to.index, price, note: `回抽不破中枢上沿 ${Z.zG.toFixed(1)}` });
          break;
        }
      }
    } else {
      if (divSet.has('顶背驰@' + date)) {
        out.push({ kind: '一卖', date, index: s.to.index, price, note: '向上笔末端顶背驰' });
      }
      for (let j = i - 2; j >= 0; j -= 2) {
        const pj = st[j];
        if (pj.dir === 'up' && divSet.has('顶背驰@' + pj.to.date)) {
          if (s.high < pj.high) out.push({ kind: '二卖', date, index: s.to.index, price, note: '一卖后反弹不创新高' });
          break;
        }
      }
      const dn = st[i - 1];
      for (let z = zones.length - 1; z >= 0; z--) {
        const Z = zones[z];
        const brokeDown = dn.dir === 'down' && dn.low <= Z.zD * 0.994;
        if (brokeDown && s.high < Z.zD && date > Z.endDate) {
          out.push({ kind: '三卖', date, index: s.to.index, price, note: `反弹不过中枢下沿 ${Z.zD.toFixed(1)}` });
          break;
        }
      }
    }
  }
  const seen = new Set();
  return out.filter(x => { const k = x.kind + '@' + x.date; if (seen.has(k)) return false; seen.add(k); return true; });
}
function barsDateIndex(bars, date) {
  if (!bars) return null;
  // 线性查找（数据量百级）；找不到时用前缀匹配
  let idx = bars.findIndex(b => b.date === date);
  if (idx >= 0) return idx;
  idx = bars.findIndex(b => date && b.date && (b.date.startsWith(date) || date.startsWith(b.date.slice(0, 10))));
  return idx >= 0 ? idx : null;
}

/* ── 一站式 V2（方案A）：笔中枢为主，线段做大方向，背驰在笔级别 ── */
function analyzeLevelV2(bars) {
  const v1 = analyzeLevel(bars);
  const closes = (bars || []).map(b => b.close);
  const m = macd(closes);
  const segs = segments(v1.strokes);
  const sZones = segPivots(segs);   // 粗：线段中枢（宏观带，可选展示）

  // 给笔端点补 bars 下标（分型 fractal 的 index 是合并K下标，这里用日期反查 bars）
  v1.strokes.forEach(s => {
    s.from.index = barsDateIndex(bars, s.from.date);
    s.to.index = barsDateIndex(bars, s.to.date);
  });

  // 主中枢＝笔中枢（v1.zones 即 pivots(strokes)），背驰在笔端点上判
  const strokeEnds = v1.strokes.map(s => ({
    type: s.dir === 'up' ? 'top' : 'bottom', price: s.to.price,
    date: s.to.date, index: s.to.index,
  }));
  const divs = divergence(strokeEnds, m);
  const divSet = new Set(divs.map(d => d.type + '@' + d.at));
  const points = buySellPoints(v1.strokes, v1.zones, divSet);

  return Object.assign({}, v1, {
    macd: m, segments: segs, segZones: sZones,
    segmentCount: segs.length, segZoneCount: sZones.length,
    // 主展示口径：笔中枢
    pivotZones: v1.zones, pivotZoneCount: v1.zones.length,
    divergences: divs, points,
  });
}

module.exports = {
  mergeInclusion, fractals, strokes, pivots, trend,
  analyzeLevel, combine, phaseOf, analyzeMarket, MIN_GAP,
  ema, macd, segments, segPivots, divergence, buySellPoints, analyzeLevelV2,
};
