'use strict';
/* 缠论结构识别（chan.js）。全部用手构造的 K 序列离线测，结果确定。
 * 重点锁：包含合并方向、分型、笔的5根约束、笔中枢重叠、走势与阶段。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const C = require('./tools/chan');

/* 造一根 bar */
function bar(high, low, close, date) {
  return { date: date || '', open: close, close: close == null ? (high + low) / 2 : close, high, low };
}

/* 造一段"逐级摆动"的K线：给定一系列中心价，每根K高低都和相邻根【不构成包含】，
 * 这样合并后仍是独立K，分型/笔才成立。下行段每个新中心更低但高点略高于前低点。 */
function swingBars(centers, half = 3) {
  const out = [];
  for (let i = 0; i < centers.length; i++) {
    const c = centers[i], prev = centers[i - 1];
    let hi = c + half, lo = c - half;
    if (prev != null) {
      if (c < prev) hi = prev - half - 0.5;   // 下行：本根高点压到前低点之下 → 不包含
      if (c > prev) lo = prev + half + 0.5;   // 上行：本根低点抬到前高点之上
    }
    out.push(bar(hi, lo, c, 'k' + i));
  }
  return out;
}

/* ── 包含处理：向上取高高/低高 ── */
test('包含合并：相邻包含K按方向合并', () => {
  // 第1根(10,8)，第2根向上(12,9)（更高高更高低=无包含，方向up），
  // 第3根(11,9.5)被第2根(12,9)包含（12>11 且 9<9.5）→ 向上取高高、低高 →(12,9.5)
  const bars = [bar(10, 8, 9, 'd1'), bar(12, 9, 11, 'd2'), bar(11, 9.5, 10.5, 'd3')];
  const m = C.mergeInclusion(bars);
  assert.strictEqual(m.length, 2, '应合并成2根: ' + m.length);
  assert.strictEqual(m[1].high, 12);
  assert.strictEqual(m[1].low, 9.5, '向上取低高 max(9,9.5)=9.5');
});
test('包含合并：向下取低低/高低', () => {
  // (10,8) 然后向下(9,7)（无包含，方向down），第3根(8.5,7.5)被(9,7)包含
  // （9>=8.5 且 7<=7.5）→ 向下取低低、高低 → high=min(9,8.5)=8.5, low=min(7,7.5)=7
  const bars = [bar(10, 8, 9, 'd1'), bar(9, 7, 8, 'd2'), bar(8.5, 7.5, 8.2, 'd3')];
  const m = C.mergeInclusion(bars);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[1].high, 8.5, '向下取高低 min(9,8.5)=8.5');
  assert.strictEqual(m[1].low, 7, '向下取低低 min(7,7.5)=7');
});
test('包含合并：空/坏输入不崩', () => {
  assert.deepStrictEqual(C.mergeInclusion([]), []);
  assert.deepStrictEqual(C.mergeInclusion(null), []);
  assert.deepStrictEqual(C.mergeInclusion([{ high: null, low: 1 }]), []);
});

/* ── 分型：在合并K上识别顶/底 ── */
test('分型：识别一个顶分型', () => {
  // 构造明确的三根合并K：中间最高
  const merged = [
    { high: 10, low: 8 }, { high: 12, low: 9 }, { high: 11, low: 8.5 },
  ];
  const fr = C.fractals(merged);
  assert(fr.some(f => f.type === 'top' && f.index === 1), '中间应为顶分型');
});
test('分型：识别一个底分型', () => {
  const merged = [
    { high: 11, low: 9 }, { high: 10, low: 7 }, { high: 10.5, low: 8 },
  ];
  const fr = C.fractals(merged);
  assert(fr.some(f => f.type === 'bottom' && f.index === 1));
});

/* ── 笔：相邻顶底需 ≥5 根合并K（下标差≥4）── */
test('笔：构造一个清晰的上涨结构，至少识别出笔', () => {
  // 下→上→下 三段摆动，中间形成"底分型→顶分型"（顶之后必须有回落才确认）。
  const centers = [];
  for (let i = 1; i <= 6; i++) centers.push(100 - i * 4);   // 下行到底
  for (let i = 1; i <= 6; i++) centers.push(76 + i * 4);   // 上行到顶
  for (let i = 1; i <= 3; i++) centers.push(100 - i * 4);   // 顶后回落，确认顶分型
  const bars = swingBars(centers, 1.2);
  const merged = C.mergeInclusion(bars);
  assert(merged.length >= 12, '合并后应保留大部分独立K，实际 ' + merged.length);
  const fr = C.fractals(merged);
  assert(fr.some(f => f.type === 'bottom') && fr.some(f => f.type === 'top'),
    '应同时有底分型与顶分型，实际 ' + JSON.stringify(fr.map(f => f.type)));
  const st = C.strokes(fr);
  const up = st.find(s => s.dir === 'up');
  assert(up, '应包含一笔向上笔（底→顶），笔数=' + st.length);
  assert(up.to.index - up.from.index >= C.MIN_GAP, '笔端点间距须≥MIN_GAP');
});

test('笔：太近的顶底不构成笔（间距<5根）', () => {
  // 直接构造分型，index 只差 2
  const fr = [
    { type: 'bottom', index: 0, price: 10, date: 'a' },
    { type: 'top', index: 2, price: 12, date: 'b' },
  ];
  const st = C.strokes(fr);
  assert.strictEqual(st.length, 0, '间距不足不能成笔');
});

/* ── 中枢：三笔重叠 ── */
test('中枢：三笔价格重叠才成中枢，ZG>ZD', () => {
  const mk = (dir, h, l) => ({ dir, high: h, low: l, from: { date: 'x' }, to: { date: 'y' } });
  // 三笔都在 [20,30] 区间摆动 → 有重叠
  const overlap = [mk('up', 30, 20), mk('down', 29, 21), mk('up', 30, 20)];
  const z1 = C.pivots(overlap);
  assert.strictEqual(z1.length, 1);
  assert.strictEqual(z1[0].zG, 29);   // min(30,29,30)
  assert.strictEqual(z1[0].zD, 21);   // max(20,21,20)
});
test('中枢：三笔无重叠则无中枢', () => {
  const mk = (dir, h, l) => ({ dir, high: h, low: l, from: { date: 'x' }, to: { date: 'y' } });
  // 逐笔抬高、区间不重叠
  const sep = [mk('up', 30, 20), mk('down', 45, 40), mk('up', 55, 46)];
  const z = C.pivots(sep);
  // 三笔 ZG=min(30,45,55)=30, ZD=max(20,40,46)=46 → 30<46 无中枢
  assert.strictEqual(z.length, 0);
});

/* ── 走势：中枢上移=上涨，下移=下跌，单一=盘整 ── */
test('走势：中枢上移判 up / 下移判 down / 单个判 range', () => {
  const zonesUp = [{ zG: 20, zD: 10 }, { zG: 40, zD: 30 }];   // 后 ZD(30)>前 ZG(20)
  assert.strictEqual(C.trend(zonesUp, 45).type, 'up');
  const zonesDown = [{ zG: 50, zD: 40 }, { zG: 25, zD: 15 }]; // 后 ZG(25)<前 ZD(40)
  assert.strictEqual(C.trend(zonesDown, 12).type, 'down');
  assert.strictEqual(C.trend([{ zG: 20, zD: 10 }], 15).type, 'range');
});

/* ── 多级别：大级别定方向，小级别不翻转 ── */
test('combine：日线 down 时 bias=short，30分小反弹不翻多', () => {
  const day = { trend: 'down', pricePos: 'below', lastStroke: { dir: 'down' } };
  const m30 = { trend: 'up', pricePos: 'above', lastStroke: { dir: 'up' } };
  const r = C.combine({ day, m30 });
  assert.strictEqual(r.bias, 'short', '大级别向下，小级别再强也不翻多');
  assert.strictEqual(r.bigLevel, 'day');
});
test('combine：日线 up 且小级别转强 → timingLong', () => {
  const day = { trend: 'up', pricePos: 'above', lastStroke: { dir: 'up' } };
  const m30 = { trend: 'up', pricePos: 'above', lastStroke: { dir: 'up' } };
  const r = C.combine({ day, m30 });
  assert.strictEqual(r.bias, 'long');
  assert(r.timingLong);
});

/* ── 阶段映射 ── */
test('phaseOf：日线下跌且价在中枢下方 → 退潮期', () => {
  const r = C.phaseOf({ trend: 'down', pricePos: 'below' }, { timingLong: false });
  assert.strictEqual(r.phase, '退潮期');
});
test('phaseOf：日线上涨且价在中枢上方 → 主升期', () => {
  const r = C.phaseOf({ trend: 'up', pricePos: 'above' }, { timingLong: true });
  assert.strictEqual(r.phase, '主升期');
});
test('phaseOf：无数据给 unknown 不编造', () => {
  assert.strictEqual(C.phaseOf(null, null).phase, 'unknown');
});

/* ── 端到端：analyzeMarket 不崩且返回完整证据链字段 ── */
test('analyzeMarket：给 day/m30 空与非空都稳定', () => {
  const PHASES = ['unknown', '筑底期', '退潮期', '磨底期', '启动期', '主升期', '高位震荡期'];
  const r1 = C.analyzeMarket({});
  assert(PHASES.includes(r1.phase), '空输入应给合法阶段，实际=' + r1.phase);
  assert(r1.combo && typeof r1.combo.detail === 'string');
  const centers = [];
  for (let i = 1; i <= 6; i++) centers.push(100 - i * 4);
  for (let i = 1; i <= 6; i++) centers.push(76 + i * 4);
  for (let i = 1; i <= 3; i++) centers.push(100 - i * 4);
  const upBars = swingBars(centers, 1.2);
  const r2 = C.analyzeMarket({ day: upBars, m30: upBars.slice() });
  assert(r2.levels.day && typeof r2.levels.day.strokeCount === 'number');
  assert(PHASES.includes(r2.phase));
});

/* ═══════════ 第二版：MACD / 线段 / 线段中枢 / 背驰 / 三类买卖点 ═══════════ */

/* 由中心价造 bars，供 MACD 等需要 close 序列的函数 */
function barsFromCloses(closes) {
  return closes.map((c, i) => ({ date: 'd' + i, open: c, close: c, high: c + 1, low: c - 1 }));
}

/* ── MACD ── */
test('MACD：长度对齐、首点 DIF≈0、hist=2*(DIF-DEA)', () => {
  const closes = []; let p = 100;
  for (let i = 0; i < 80; i++) { p += Math.sin(i / 3) * 1.5; closes.push(p); }
  const m = C.macd(closes);
  assert.strictEqual(m.dif.length, closes.length);
  assert.strictEqual(m.dea.length, closes.length);
  assert.strictEqual(m.hist.length, closes.length);
  assert(Math.abs(m.dif[0]) < 1e-9, '首点DIF应≈0');
  const i = 60;
  assert(Math.abs(m.hist[i] - 2 * (m.dif[i] - m.dea[i])) < 1e-9);
});
test('MACD：null 入参不崩、等长输出', () => {
  const m = C.macd([]);
  assert.strictEqual(m.dif.length, 0);
});

/* ── 线段：严格交替、首尾相接 ── */
test('线段：输出交替且端点首尾相接', () => {
  // 直接构造笔：下-上-下-上-下 大摆动，每笔够长
  const mk = (dir, f, t, fd, td) => ({ dir, from: { date: fd, price: f }, to: { date: td, price: t },
    high: Math.max(f, t), low: Math.min(f, t) });
  const st = [
    mk('down', 100, 80, 'a0', 'a1'), mk('up', 80, 105, 'a1', 'a2'), mk('down', 105, 85, 'a2', 'a3'),
    mk('up', 85, 130, 'a3', 'a4'), mk('down', 130, 90, 'a4', 'a5'), mk('up', 90, 140, 'a5', 'a6'),
    mk('down', 140, 70, 'a6', 'a7'),
  ];
  const segs = C.segments(st);
  assert(segs.length >= 2, '应识别出多段，实际 ' + segs.length);
  for (let i = 1; i < segs.length; i++) {
    assert.strictEqual(segs[i].from.date, segs[i - 1].to.date, '线段须首尾相接 #' + i);
    assert.notStrictEqual(segs[i].dir, segs[i - 1].dir, '相邻线段方向须交替 #' + i);
  }
});
test('线段：笔不足3根时返回空', () => {
  assert.deepStrictEqual(C.segments([]), []);
  assert.deepStrictEqual(C.segments([{ dir: 'up' }, { dir: 'down' }]), []);
});

/* ── 线段中枢 ── */
test('线段中枢：三段重叠给 ZG/ZD，无重叠不给', () => {
  const mk = (h, l) => ({ high: h, low: l, from: { date: 'x' }, to: { date: 'y' } });
  const z1 = C.segPivots([mk(30, 20), mk(29, 21), mk(30, 20)]);
  assert.strictEqual(z1.length, 1);
  assert.strictEqual(z1[0].zG, 29);
  assert.strictEqual(z1[0].zD, 21);
  const z0 = C.segPivots([mk(30, 20), mk(45, 40), mk(55, 46)]);
  assert.strictEqual(z0.length, 0);
});

/* ── 背驰：价创新高/新低但 MACD柱峰值衰竭（手工构造）── */
test('背驰：手工摆动点+MACD，识别顶/底背驰', () => {
  // 顶：两个峰，后峰价更高，但红柱峰值更小 → 顶背驰
  const top = [
    { type: 'top', price: 110, index: 10, date: 'd10' },
    { type: 'top', price: 120, index: 40, date: 'd40' },
  ];
  const histUp = new Array(60).fill(0);
  for (let i = 6; i <= 14; i++) histUp[i] = 4 * Math.exp(-Math.pow((i - 10) / 3, 2));  // 前峰红柱4
  for (let i = 36; i <= 44; i++) histUp[i] = 2 * Math.exp(-Math.pow((i - 40) / 3, 2)); // 后峰红柱2（衰竭）
  const d = C.divergence(top, { dif: histUp, dea: histUp, hist: histUp });
  assert(d.some(x => x.type === '顶背驰'), '价更高、红柱更小 → 顶背驰');

  // 底：两个谷，后谷价更低，但绿柱谷值变浅（绝对值更小）→ 底背驰
  const bot = [
    { type: 'bottom', price: 90, index: 10, date: 'e10' },
    { type: 'bottom', price: 80, index: 40, date: 'e40' },
  ];
  const histDn = new Array(60).fill(0);
  for (let i = 6; i <= 14; i++) histDn[i] = -5 * Math.exp(-Math.pow((i - 10) / 3, 2)); // 前谷绿柱-5
  for (let i = 36; i <= 44; i++) histDn[i] = -2 * Math.exp(-Math.pow((i - 40) / 3, 2)); // 后谷-2（变浅）
  const d2 = C.divergence(bot, { dif: histDn, dea: histDn, hist: histDn });
  assert(d2.some(x => x.type === '底背驰'), '价更低、绿柱更浅 → 底背驰');

  // 反例：柱也同步放大，则不算背驰
  const histStrong = new Array(60).fill(0);
  for (let i = 6; i <= 14; i++) histStrong[i] = -2;
  for (let i = 36; i <= 44; i++) histStrong[i] = -6;
  const d3 = C.divergence(bot, { dif: histStrong, dea: histStrong, hist: histStrong });
  assert(!d3.some(x => x.type === '底背驰'), '绿柱更深不构成底背驰');
});

/* ── V2 端到端不崩、字段齐全 ── */
test('analyzeLevelV2：返回线段/中枢/买卖点/背驰/MACD 全套字段', () => {
  const centers = [];
  for (let i = 1; i <= 6; i++) centers.push(100 - i * 4);
  for (let i = 1; i <= 6; i++) centers.push(76 + i * 4);
  for (let i = 1; i <= 3; i++) centers.push(100 - i * 4);
  const bars = swingBars(centers, 1.2);
  const v = C.analyzeLevelV2(bars);
  assert(typeof v.segmentCount === 'number');
  assert(Array.isArray(v.segments) && Array.isArray(v.segZones));
  assert(Array.isArray(v.points) && Array.isArray(v.divergences));
  assert(v.macd && v.macd.dif.length === bars.length);
});

async function main() {
  for (const { name, fn } of _t) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_t.length}）`);
  process.exit(fail ? 1 : 0);
}
main();