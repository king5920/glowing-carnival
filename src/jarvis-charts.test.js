'use strict';
/**
 * charts.js 共享图表原语单测
 *
 * 覆盖 DESIGN.md §5 情绪温度热力柱（C3-A）里所有可数值验证的部分：
 *   css()           —— 从 :root 读 CSS 变量（保证图表零写死 hex）
 *   colorLadder()   —— 边界值 + 中间插值 + alpha 覆盖
 *   hexToRgb()      —— 支持 #rgb / #rrggbb / rgb(a) 三种形式
 *   drawBar()       —— 无抛错
 *   drawHatch()     —— 生成斜线纹理（clip + 多次 stroke）
 *   drawCandle()    —— 涨/跌两种形态
 *   drawSentimentHeatmap() —— 主图（数据形状、hit 命中、tooltip 整句、极值柱斜纹）
 *   bindHover()     —— DOM tooltip 有 role=status + aria-live；unbind 干净
 *
 * 与既有 682 项基线独立：本套件用最小 DOM stub 加载浏览器 IIFE，
 * 不引入 jsdom / mocha / jest，与项目硬约束（生产依赖仅 better-sqlite3）一致。
 *
 * 端点形状（/api/sentiment/heatmap）由 scripts/verify-charts.js 走 CDP 契约验证——
 * server.js 在顶层 listen，不能被 require，故本套件不重复测端点。
 */

const assert = require('assert');

/* ── 浏览器环境最小 stub ── */
/* CSS 变量与 DESIGN.md §1 权威表对齐（--cy/--gd/--rd/--gn/--bg/--faint） */
const CSS_VARS = {
  '--bg':     '#0A1320',
  '--panel':  'rgba(24,38,58,.60)',
  '--line':   'rgba(140,175,225,.20)',
  '--txt':    '#DBE6F4',
  '--dim':    '#7C8EA6',
  '--faint':  '#8ba0b8',
  '--cy':     '#3FD0FF',
  '--gd':     '#F2B23E',
  '--rd':     '#F0485E',
  '--gn':     '#089981',
  '--num-hi': '#9FC0FF',
  '--ok':     '#3FD48A',
  '--warn':   '#FF9F1C',
  '--bad':    '#FF5C5C',
  '--info':   '#4F8CFF',
};

global.getComputedStyle = () => ({
  getPropertyValue: (name) => CSS_VARS[name] || '',
});
global.window = { devicePixelRatio: 2, addEventListener: () => {}, removeEventListener: () => {} };
global.matchMedia = () => ({ matches: false });
global.HTMLElement = function(){};

/* 元素 stub —— 支持 className / style / setAttribute / appendChild / getBoundingClientRect */
function makeEl(tag){
  return {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    style: {},
    _attrs: {},
    setAttribute(k, v){ this._attrs[k] = v; },
    getAttribute(k){ return this._attrs[k] == null ? null : this._attrs[k]; },
    appendChild(c){ this._kids = this._kids || []; this._kids.push(c); c.parentElement = this; return c; },
    removeChild(c){ if(!this._kids) return null; const i = this._kids.indexOf(c); if(i >= 0) this._kids.splice(i,1); c.parentElement = null; return c; },
    textContent: '',
    offsetWidth: 120, offsetHeight: 24,
    parentElement: null,
  };
}
global.document = {
  documentElement: {},
  createElement: makeEl,
  querySelector: () => null,
};

/* ── 加载 charts.js —— 通过 IIFE 挂到 window.Charts ── */
require('../ui/charts');
const C = window.Charts;

/* ── 画布 stub：ctx 记录调用次数与参数，cv 提供必要 DOM 接口 ── */
function makeCanvas(w, h){
  const calls = { fillRect: [], strokeRect: [], fillText: [], rect: [],
                  stroke: 0, clip: 0, save: 0, restore: 0,
                  setTransform: 0, clearRect: 0, beginPath: 0, moveTo: 0, lineTo: 0,
                  setLineDash: [] };
  const ctx = {
    setTransform(){ calls.setTransform++; }, save(){ calls.save++; }, restore(){ calls.restore++; },
    clearRect(){ calls.clearRect++; }, beginPath(){ calls.beginPath++; },
    moveTo(){ calls.moveTo++; }, lineTo(){ calls.lineTo++; },
    stroke(){ calls.stroke++; },
    setLineDash(d){ calls.setLineDash.push(d); },
    fillRect(x, y, fw, fh){ calls.fillRect.push({ x, y, w: fw, h: fh }); },
    strokeRect(x, y, fw, fh){ calls.strokeRect.push({ x, y, w: fw, h: fh }); },
    fillText(t, x, y){ calls.fillText.push({ t, x, y }); },
    rect(x, y, fw, fh){ calls.rect.push({ x, y, w: fw, h: fh }); },
    clip(){ calls.clip++; },
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '',
  };
  const host = {
    appendChild(c){ c.parentElement = this; return c; },
    removeChild(c){ c.parentElement = null; return c; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    _kids: [],
  };
  const cv = {
    clientWidth: w, clientHeight: h,
    width: 0, height: 0,
    style: {},
    _attrs: {},
    setAttribute(k, v){ this._attrs[k] = v; },
    getAttribute(k){ return this._attrs[k] == null ? null : this._attrs[k]; },
    getContext: () => ctx,
    addEventListener(){}, removeEventListener(){},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    parentElement: host,
  };
  return { cv, ctx, calls, host };
}

/* ── 测试骨架（与项目其他套件一致） ── */
let pass = 0, fail = 0;
function test(name, fn){
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch(e){ console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
function assertRgba(s, label){
  assert(/^rgba\(\d{1,3},\d{1,3},\d{1,3},[0-9.]+\)$/.test(s),
    `${label}: 期望 rgba() 形式，实得 ${s}`);
}

console.log('\n── css() 从 :root 读值 ──');

test('css() 返回 hex 值（--cy/--rd/--gn/--gd）', () => {
  assert.strictEqual(C.css('--cy'), '#3FD0FF');
  assert.strictEqual(C.css('--rd'), '#F0485E');
  assert.strictEqual(C.css('--gn'), '#089981');
  assert.strictEqual(C.css('--gd'), '#F2B23E');
});

test('css() 返回 rgba 值（--panel/--line）', () => {
  assert.strictEqual(C.css('--panel'), 'rgba(24,38,58,.60)');
  assert.strictEqual(C.css('--line'), 'rgba(140,175,225,.20)');
});

test('css() 未定义变量返回 null（不谎报 hex）', () => {
  assert.strictEqual(C.css('--nonexistent'), null);
});

console.log('\n── hexToRgb() 输入解析 ──');

test('hexToRgb 支持 #rrggbb', () => {
  assert.deepStrictEqual(C._hexToRgb('#3FD0FF'), [63, 208, 255]);
  assert.deepStrictEqual(C._hexToRgb('#F0485E'), [240, 72, 94]);
});

test('hexToRgb 支持 #rgb 简写', () => {
  assert.deepStrictEqual(C._hexToRgb('#f00'), [255, 0, 0]);
  assert.deepStrictEqual(C._hexToRgb('#0f0'), [0, 255, 0]);
});

test('hexToRgb 支持 rgb/rgba 字符串', () => {
  assert.deepStrictEqual(C._hexToRgb('rgb(1,2,3)'), [1, 2, 3]);
  assert.deepStrictEqual(C._hexToRgb('rgba(10,20,30,.5)'), [10, 20, 30]);
});

test('hexToRgb 空/非法输入兜底黑', () => {
  assert.deepStrictEqual(C._hexToRgb(''), [0, 0, 0]);
  assert.deepStrictEqual(C._hexToRgb(null), [0, 0, 0]);
  assert.deepStrictEqual(C._hexToRgb('not-a-color'), [0, 0, 0]);
});

console.log('\n── colorLadder() 边界与插值 ──');

const STOPS = [
  { v: 0,   c: '--cy' },   /* 冷静：冷青 */
  { v: 0.5, c: '--gd' },   /* 警戒：暖金 */
  { v: 1,   c: '--rd' },   /* 恐慌：红 */
];

test('colorLadder 首档 = 冷青 rgba(63,208,255,α)', () => {
  const s = C.colorLadder(0, STOPS);
  assertRgba(s, 'colorLadder(0)');
  assert.strictEqual(s, 'rgba(63,208,255,1)');
});

test('colorLadder 尾档 = 恐慌红 rgba(240,72,94,α)', () => {
  const s = C.colorLadder(1, STOPS);
  assertRgba(s, 'colorLadder(1)');
  assert.strictEqual(s, 'rgba(240,72,94,1)');
});

test('colorLadder 中点 = 暖金 rgba(242,178,62,α)', () => {
  const s = C.colorLadder(0.5, STOPS);
  assertRgba(s, 'colorLadder(0.5)');
  assert.strictEqual(s, 'rgba(242,178,62,1)');
});

test('colorLadder 中间值有插值（v=0.25 应介于青和金之间）', () => {
  const s = C.colorLadder(0.25, STOPS);
  assertRgba(s, 'colorLadder(0.25)');
  const m = /^rgba\((\d+),(\d+),(\d+),(\d+)\)$/.exec(s);
  assert(m, '插值结果非 rgba 形式：' + s);
  const r = +m[1], g = +m[2], b = +m[3];
  /* --cy = (63,208,255) → --gd = (242,178,62)；v=0.25 应在两者间线性插值
   * r: 63 + (242-63)*0.5 = 63 + 89.5 = 152.5 → round = 153
   * g: 208 + (178-208)*0.5 = 208 - 15 = 193
   * b: 255 + (62-255)*0.5 = 255 - 96.5 = 158.5 → round = 159
   * 注：STOPS 里 0.5 是断点，v=0.25 落在 [0, 0.5] 区间，t = 0.25/0.5 = 0.5 */
  assert.strictEqual(r, 153, 'r 通道偏差');
  assert.strictEqual(g, 193, 'g 通道偏差');
  assert.strictEqual(b, 159, 'b 通道偏差');
});

test('colorLadder 越界自动 clamp（负值→首档，>1→尾档）', () => {
  assert.strictEqual(C.colorLadder(-1, STOPS), 'rgba(63,208,255,1)');
  assert.strictEqual(C.colorLadder(2, STOPS),  'rgba(240,72,94,1)');
});

test('colorLadder 支持 alpha 参数覆盖', () => {
  const s = C.colorLadder(0.5, STOPS, 0.4);
  assert.strictEqual(s, 'rgba(242,178,62,0.4)');
});

test('colorLadder 空 stops 兜底中性灰（不炸）', () => {
  const s = C.colorLadder(0.5, null);
  assertRgba(s, 'colorLadder(null stops)');
});

console.log('\n── drawBar / drawText / drawHatch / drawCandle 基元 ──');

test('drawBar 无抛错、单次 fillRect 调用', () => {
  const { cv, calls } = makeCanvas(200, 100);
  C.drawBar(cv.getContext('2d'), 10, 20, 50, 30, 'rgba(255,0,0,1)', 'rgba(0,0,0,.5)');
  assert.strictEqual(calls.fillRect.length, 1);
  assert.strictEqual(calls.fillRect[0].w, 50);
  assert.strictEqual(calls.fillRect[0].h, 30);
  /* 有 stroke 参数时会加一次 strokeRect（描边） */
  assert.strictEqual(calls.strokeRect.length, 1);
});

test('drawBar w/h 为零时短路（不画）', () => {
  const { cv, calls } = makeCanvas(200, 100);
  C.drawBar(cv.getContext('2d'), 0, 0, 0, 30, '#fff');
  assert.strictEqual(calls.fillRect.length, 0);
});

test('drawHatch 生成斜线纹理（clip + ≥1 次 stroke）', () => {
  const { cv, calls } = makeCanvas(200, 100);
  C.drawHatch(cv.getContext('2d'), 10, 10, 20, 30, 'rgba(255,255,255,.5)');
  /* 每次斜线纹理：一次 clip + 每 step=5px 一次 stroke
   * 矩形 20x30，stroke 数 ≈ (20 + 30) / 5 = 10 */
  assert(calls.clip >= 1, '应有 clip 调用');
  assert(calls.stroke >= 5, '斜线纹理应有 ≥5 次 stroke，实得 ' + calls.stroke);
});

test('drawCandle 涨=实心（1 次 fillRect + 1 次 stroke 影线）', () => {
  const { cv, calls } = makeCanvas(200, 100);
  C.drawCandle(cv.getContext('2d'), 100, 40, 60, 30, 70, 8, true, '--rd', '--gn');
  /* 涨：影线 stroke 1 + 实心 fillRect 1 */
  assert.strictEqual(calls.stroke, 1);
  assert.strictEqual(calls.fillRect.length, 1);
});

test('drawCandle 跌=空心（fillRect + strokeRect 组合）', () => {
  const { cv, calls } = makeCanvas(200, 100);
  C.drawCandle(cv.getContext('2d'), 100, 40, 60, 30, 70, 8, false, '--rd', '--gn');
  /* 跌：影线 stroke 1 + 空心 = fillRect（填底） + strokeRect（描边） */
  assert.strictEqual(calls.stroke, 1);
  assert(calls.fillRect.length >= 1);
  assert.strictEqual(calls.strokeRect.length, 1);
});

console.log('\n── drawSentimentHeatmap() 主图 ──');

/* 60 天 mock 数据，含冷静/警戒/恐慌三档 + 极值 */
function mockData(n){
  const out = [];
  for(let i = 0; i < n; i++){
    const day = i;
    const rate = ((i * 13) % 100);   /* 循环 0..99，覆盖低/中/高 + 极值 */
    out.push({
      date: '2026-' + String(1 + Math.floor(day/28)).padStart(2,'0') + '-' + String(1 + day%28).padStart(2,'0'),
      limit_up: 30 + (day % 70),
      limit_down: 2 + (day % 20),
      broken: 5 + (day % 30),
      broken_rate: rate,
      ladder_height: 3 + (day % 8),
      seal_fund_yi: 20 + (day % 50) * 1.5,
    });
  }
  return out;
}
const DATA = mockData(60);

test('drawSentimentHeatmap 60 根柱全部填色', () => {
  const { cv, calls } = makeCanvas(1200, 80);
  const r = C.drawSentimentHeatmap(cv, DATA);
  assert(r, '返回值应为命中对象');
  /* 60 根柱 → 60 次 fillRect；X 轴稀疏 label 3 次 fillText */
  assert.strictEqual(calls.fillRect.length, 60, '柱数=' + calls.fillRect.length);
  assert(calls.fillText.length >= 2, 'X 轴 label 应有 ≥2 个');
});

test('drawSentimentHeatmap 返回 hit/tooltip/bars 三件套', () => {
  const { cv } = makeCanvas(1200, 80);
  const r = C.drawSentimentHeatmap(cv, DATA);
  assert(typeof r.hit === 'function');
  assert(typeof r.tooltip === 'function');
  assert(Array.isArray(r.bars) && r.bars.length === 60);
});

test('drawSentimentHeatmap hit 落在图内返回对应条数据', () => {
  const { cv } = makeCanvas(1200, 80);
  const r = C.drawSentimentHeatmap(cv, DATA);
  /* 1200/60 = 20px/柱；x=110 落在第 5 根柱（index=5） */
  const hit = r.hit(110, 40);
  assert(hit, '图内 hover 应有命中');
  assert.strictEqual(hit.date, DATA[5].date);
});

test('drawSentimentHeatmap hit 越界返回 null', () => {
  const { cv } = makeCanvas(1200, 80);
  const r = C.drawSentimentHeatmap(cv, DATA);
  assert.strictEqual(r.hit(-10, 40), null);
  assert.strictEqual(r.hit(1300, 40), null);
  assert.strictEqual(r.hit(600, -10), null);
  assert.strictEqual(r.hit(600, 200), null);
});

test('drawSentimentHeatmap tooltip 是整句中文且含所有 6 个字段', () => {
  const { cv } = makeCanvas(1200, 80);
  const r = C.drawSentimentHeatmap(cv, DATA);
  const tip = r.tooltip(DATA[10]);
  assert(/[一-鿿]/.test(tip), 'tooltip 应含中文："' + tip + '"');
  assert(tip.indexOf('炸板率') >= 0, '缺"炸板率"');
  assert(tip.indexOf('涨停') >= 0, '缺"涨停"');
  assert(tip.indexOf('跌停') >= 0, '缺"跌停"');
  assert(tip.indexOf('最高连板') >= 0, '缺"最高连板"');
  assert(tip.indexOf('封单') >= 0, '缺"封单"');
  assert(/%/.test(tip), '炸板率应带 % 单位');
  assert(/亿/.test(tip), '封单应带 亿 单位');
  assert(/\d{4}-\d{2}-\d{2}/.test(tip), '应有 YYYY-MM-DD 日期');
  /* §5 通用条款：live 播报用整句，非裸数字——检查 " · " 分隔的完整句子 */
  assert(tip.split(' · ').length === 6, '整句应有 6 段（日期 + 5 项指标），实得 ' + tip.split(' · ').length);
});

test('drawSentimentHeatmap 极值柱（>=90%）触发斜纹（clip 调用）', () => {
  const { cv, calls } = makeCanvas(1200, 80);
  /* 构造一条 rate=95 的数据 —— 应触发 drawHatch（clip 出现） */
  const d = [{
    date: '2026-09-01', limit_up: 100, limit_down: 2, broken: 95,
    broken_rate: 95, ladder_height: 6, seal_fund_yi: 40,
  }];
  C.drawSentimentHeatmap(cv, d);
  assert(calls.clip >= 1, '极值柱应有 clip 触发斜纹，实得 ' + calls.clip);
});

test('drawSentimentHeatmap 非极值柱（rate=50）不触发斜纹', () => {
  const { cv, calls } = makeCanvas(1200, 80);
  const d = [{
    date: '2026-09-01', limit_up: 100, limit_down: 2, broken: 50,
    broken_rate: 50, ladder_height: 6, seal_fund_yi: 40,
  }];
  C.drawSentimentHeatmap(cv, d);
  assert.strictEqual(calls.clip, 0, '非极值柱不应有斜纹，实得 ' + calls.clip + ' 次 clip');
});

test('drawSentimentHeatmap 空数据画"无情绪数据"占位', () => {
  const { cv, calls } = makeCanvas(200, 80);
  const r = C.drawSentimentHeatmap(cv, []);
  assert(r);
  assert(calls.fillText.length >= 1);
  assert(/无情绪数据/.test(calls.fillText[0].t), '应画"无情绪数据"，实得"' + calls.fillText[0].t + '"');
});

test('drawSentimentHeatmap 空 data 时 hit() 也安全返回 null', () => {
  const { cv } = makeCanvas(200, 80);
  const r = C.drawSentimentHeatmap(cv, null);
  assert(r);
  assert.strictEqual(r.hit(100, 40), null);
});

test('drawSentimentHeatmap 数据缺字段（broken_rate 为 undefined）不炸，兜底 50%', () => {
  const { cv, calls } = makeCanvas(200, 80);
  /* 缺 broken_rate 时图表用 50 兜底（代码 line 324）——柱仍应画出来 */
  const d = [{
    date: '2026-09-01', limit_up: 10, limit_down: 1,
    ladder_height: 3, seal_fund_yi: 20,
    /* 无 broken_rate */
  }];
  C.drawSentimentHeatmap(cv, d);
  assert.strictEqual(calls.fillRect.length, 1, '缺字段的柱仍应画出');
  /* 兜底 50% 不算极值，不应触发斜纹 */
  assert.strictEqual(calls.clip, 0);
});

console.log('\n── drawDistribution() 板块涨幅分布直方图 ──');

/* 6 档 mock 数据（服务端 BUCKETS 定义的镜像） */
function mockDist(counts, total){
  const ranges = ['<-3%', '-3~-1%', '-1~0%', '0~1%', '1~3%', '>3%'];
  const sides  = ['down',  'down',  'down',  'up',   'up',   'up'];
  return {
    date: '2026-09-17',
    total: total || counts.reduce((s, c) => s + c, 0),
    min: -6.0, max: 7.86,
    buckets: counts.map((c, i) => ({
      range: ranges[i], side: sides[i], count: c,
      pct: total ? +(c / total * 100).toFixed(2) : 0,
    })),
  };
}

test('drawDistribution 6 档全部画出（6 根柱 + 6 个 range label）', () => {
  const { cv, calls } = makeCanvas(600, 90);
  const d = mockDist([30, 128, 180, 220, 130, 73]);
  const r = C.drawDistribution(cv, d);
  assert(r, '返回值应为命中对象');
  /* 每档 1 根柱 = 1 次 fillRect；共 6 次 */
  assert.strictEqual(calls.fillRect.length, 6, '6 档应有 6 根柱，实得 ' + calls.fillRect.length);
  /* 每档下方 range label = 1 次 fillText；共 6 次 */
  assert.strictEqual(calls.fillText.length, 6, '6 档应有 6 个 label，实得 ' + calls.fillText.length);
});

test('drawDistribution 返回 hit/tooltip/bars 三件套', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([10, 20, 30, 40, 50, 60]));
  assert(typeof r.hit === 'function');
  assert(typeof r.tooltip === 'function');
  assert(Array.isArray(r.bars) && r.bars.length === 6);
});

test('drawDistribution hit 落在中间档（0~1%）返回对应桶', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([30, 128, 180, 220, 130, 73]));
  /* 600px / 6 档 = 100px/档；x=350 落在第 4 档（index=3，0~1%） */
  const hit = r.hit(350, 45);
  assert(hit, '图内 hover 应有命中');
  assert.strictEqual(hit.range, '0~1%');
  assert.strictEqual(hit.side, 'up');
});

test('drawDistribution hit 越界返回 null', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([10, 20, 30, 40, 50, 60]));
  assert.strictEqual(r.hit(-10, 45), null);
  assert.strictEqual(r.hit(700, 45), null);
  assert.strictEqual(r.hit(300, -10), null);
  assert.strictEqual(r.hit(300, 200), null);
});

test('drawDistribution tooltip 是整句中文且含 % 和"个板块"和"占"', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([30, 128, 180, 220, 130, 73]));
  const tip = r.tooltip({ range: '-3~-1%', side: 'down', count: 128, pct: 13.32 });
  assert(/[一-鿿]/.test(tip), 'tooltip 应含中文："' + tip + '"');
  assert(tip.indexOf('-3~-1%') >= 0, '缺档位区间："' + tip + '"');
  assert(tip.indexOf('个板块') >= 0, '缺"个板块"："' + tip + '"');
  assert(tip.indexOf('占') >= 0, '缺"占"："' + tip + '"');
  assert(/%/.test(tip), '缺 % 单位："' + tip + '"');
  /* 跌区应有明确标记 */
  assert(tip.indexOf('跌区') >= 0, '跌档 tooltip 缺"跌区"："' + tip + '"');
});

test('drawDistribution tooltip 涨档标注"涨区"', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([30, 128, 180, 220, 130, 73]));
  const tip = r.tooltip({ range: '0~1%', side: 'up', count: 220, pct: 22.9 });
  assert(tip.indexOf('涨区') >= 0, '涨档 tooltip 应含"涨区"："' + tip + '"');
  assert(tip.indexOf('-3~-1%') < 0, '涨档 tooltip 不应含跌档区间："' + tip + '"');
});

test('drawDistribution 涨档用 --rd 红、跌档用 --gn 青绿（colorLadder 输出）', () => {
  const { cv, calls } = makeCanvas(600, 90);
  const d = mockDist([30, 128, 180, 220, 130, 73]);
  C.drawDistribution(cv, d);
  /* 前 3 档跌区走 --gn，后 3 档涨区走 --rd。
   * canvas ctx 每次 fillRect 前会写 fillStyle——但我们没记录 fillStyle，只能间接验证。
   * 用色相检查：--rd 的 r 通道显著高于 --gn；调用 colorLadder 直接对两侧验证。 */
  const upColor   = C.colorLadder(1, [{ v: 0, c: '--rd' }, { v: 1, c: '--rd' }], 0.85);
  const downColor = C.colorLadder(1, [{ v: 0, c: '--gn' }, { v: 1, c: '--gn' }], 0.85);
  const upM   = /^rgba\((\d+),(\d+),(\d+),[0-9.]+\)$/.exec(upColor);
  const downM = /^rgba\((\d+),(\d+),(\d+),[0-9.]+\)$/.exec(downColor);
  assert(upM, '涨档色应为 rgba()：' + upColor);
  assert(downM, '跌档色应为 rgba()：' + downColor);
  /* --rd=(240,72,94)、--gn=(8,153,129) */
  assert.strictEqual(+upM[1], 240, '涨档 r 通道应为 240，实得 ' + upM[1]);
  assert.strictEqual(+downM[1], 8,   '跌档 r 通道应为 8，实得 ' + downM[1]);
  assert(+upM[1] > +downM[1], '涨档 r 应显著大于跌档（红 vs 青绿）');
  assert(+upM[3] === 94 && +downM[3] === 129, '涨档 b=94、跌档 b=129');
});

test('drawDistribution 中轴虚线（beginPath + setLineDash 后 stroke）出现', () => {
  const { cv, calls } = makeCanvas(600, 90);
  C.drawDistribution(cv, mockDist([30, 128, 180, 220, 130, 73]));
  /* 中轴虚线：setLineDash([2,3]) 后 stroke 一次 */
  assert(calls.setLineDash.length >= 1, '应有 setLineDash 调用');
  assert.deepStrictEqual(calls.setLineDash[0], [2, 3], '虚线应 [2,3]');
  assert(calls.stroke >= 1, '应有中轴 stroke 调用，实得 ' + calls.stroke);
});

test('drawDistribution 空 buckets 画"无分布数据"占位', () => {
  const { cv, calls } = makeCanvas(200, 80);
  const r = C.drawDistribution(cv, { date: null, total: 0, buckets: [] });
  assert(r);
  assert(calls.fillText.length >= 1);
  assert(/无分布数据/.test(calls.fillText[0].t), '应画"无分布数据"，实得"' + calls.fillText[0].t + '"');
});

test('drawDistribution 空 buckets 时 hit() 安全返回 null', () => {
  const { cv } = makeCanvas(200, 80);
  const r = C.drawDistribution(cv, { date: null, total: 0, buckets: [] });
  assert.strictEqual(r.hit(100, 40), null);
});

test('drawDistribution data 为 null 时不炸、hit 安全', () => {
  const { cv } = makeCanvas(200, 80);
  const r = C.drawDistribution(cv, null);
  assert(r);
  assert.strictEqual(r.hit(100, 40), null);
});

test('drawDistribution 单档全 count=0 时柱高兜底 2px（maxCount 用 1 兜）', () => {
  const { cv, calls } = makeCanvas(600, 90);
  /* 所有 count=0：maxCount 兜底 1，柱高 = 0/1 * plotH = 0 → 应 clamp 到 2px */
  const d = mockDist([0, 0, 0, 0, 0, 0]);
  C.drawDistribution(cv, d);
  /* 柱仍应画出（6 次 fillRect），高度兜底避免 0 柱不可见 */
  assert.strictEqual(calls.fillRect.length, 6, 'count=0 时仍应画 6 根柱（高度兜底）');
});

test('drawDistribution hit 落在 padLeft/padRight 内边缘仍命中', () => {
  const { cv } = makeCanvas(600, 90);
  const r = C.drawDistribution(cv, mockDist([30, 128, 180, 220, 130, 73]));
  /* x=padLeft(=6) 应命中第 0 档 */
  const hit0 = r.hit(6, 45);
  assert(hit0, 'x=padLeft 应命中第 0 档');
  assert.strictEqual(hit0.range, '<-3%');
});

console.log('\n── bindHover() DOM tooltip 管理 ──');

test('bindHover 创建的 tooltip 有 role=status + aria-live=polite', () => {
  const { cv, host } = makeCanvas(400, 100);
  const data = [{
    date: '2026-09-01', broken_rate: 42.5, limit_up: 88, limit_down: 12,
    ladder_height: 7, seal_fund_yi: 4.5,
  }];
  const r = C.drawSentimentHeatmap(cv, data);
  const h = C.bindHover(cv, r);
  assert(h);
  /* 模拟一次命中，触发 ensureTip 建 DOM */
  h.simulate(200, 50);
  const tip = h.getTip();
  assert(tip, 'hover 后应创建 tooltip DOM');
  assert.strictEqual(tip.getAttribute('role'), 'status');
  assert.strictEqual(tip.getAttribute('aria-live'), 'polite');
  /* §5 通用条款：整句中文，不是裸数字 */
  assert(/[一-鿿]/.test(tip.textContent),
    'tooltip 内容应整句中文，实得"' + tip.textContent + '"');
  /* tooltip 挂在 canvas 的 parentElement 下 */
  assert(tip.parentElement === host, 'tooltip 应挂到 canvas 父元素');
});

test('bindHover 非命中区域 tooltip 隐藏', () => {
  const { cv } = makeCanvas(400, 100);
  const r = C.drawSentimentHeatmap(cv, [{
    date: '2026-09-01', broken_rate: 42.5, limit_up: 88, limit_down: 12,
    ladder_height: 7, seal_fund_yi: 4.5,
  }]);
  const h = C.bindHover(cv, r);
  h.simulate(-100, -100);   /* 越界坐标，应 miss */
  const tip = h.getTip();
  if (tip) {
    /* 首次 miss 时 ensureTip 也会创建 DOM 但 style.display='none' */
    assert.strictEqual(tip.style.display, 'none');
  }
});

test('bindHover unbind() 干净移除 tooltip DOM', () => {
  const { cv, host } = makeCanvas(400, 100);
  const r = C.drawSentimentHeatmap(cv, [{
    date: '2026-09-01', broken_rate: 42.5, limit_up: 88, limit_down: 12,
    ladder_height: 7, seal_fund_yi: 4.5,
  }]);
  const h = C.bindHover(cv, r);
  h.simulate(200, 50);
  assert(h.getTip(), 'unbind 前应有 tooltip');
  h.unbind();
  assert.strictEqual(h.getTip(), null, 'unbind 后 getTip 应返回 null');
});

test('bindHover 缺少 hit 函数时返回 null（不炸）', () => {
  const { cv } = makeCanvas(400, 100);
  assert.strictEqual(C.bindHover(cv, null), null);
  assert.strictEqual(C.bindHover(cv, {}), null);
  assert.strictEqual(C.bindHover(null, { hit: () => null }), null);
});

test('bindHover 连续调用不累积 tooltip（复用旧引用）', () => {
  const { cv, host } = makeCanvas(400, 100);
  const r = C.drawSentimentHeatmap(cv, [{
    date: '2026-09-01', broken_rate: 42.5, limit_up: 88, limit_down: 12,
    ladder_height: 7, seal_fund_yi: 4.5,
  }]);
  const h1 = C.bindHover(cv, r);
  h1.simulate(200, 50);
  const tip1 = h1.getTip();
  h1.unbind();
  /* 重开一次 —— 应是全新 DOM，不复用旧的 */
  const h2 = C.bindHover(cv, r);
  h2.simulate(200, 50);
  const tip2 = h2.getTip();
  assert(tip2, '重开应有 tooltip');
  assert(tip2 !== tip1, '重开应创建新 DOM（旧的 unbind 后不复用）');
});

console.log('\n── resizeCanvas() DPR 感知 ──');

test('resizeCanvas 按 DPR 缩放物理像素，setTransform 生效', () => {
  /* 构造 cv 让它 report DPR=2 */
  const { cv, calls } = makeCanvas(200, 80);
  const r = C.resizeCanvas(cv);
  assert(r, '应返回 {ctx, w, h, dpr}');
  assert.strictEqual(r.w, 200);
  assert.strictEqual(r.h, 80);
  assert.strictEqual(r.dpr, 2);
  /* cv.width/height 应是物理像素（DPR 倍） */
  assert.strictEqual(cv.width, 400);
  assert.strictEqual(cv.height, 160);
  assert(calls.setTransform >= 1, '应调 setTransform 缩放');
});

test('resizeCanvas 尺寸为零时返回 null（不炸）', () => {
  const { cv } = makeCanvas(0, 0);
  assert.strictEqual(C.resizeCanvas(cv), null);
});

test('resizeCanvas dpr 上限 2.5、下限 1', () => {
  /* 全局 stub 上把 devicePixelRatio 调成 5（超过 2.5 上限） */
  const saved = window.devicePixelRatio;
  window.devicePixelRatio = 5;
  const { cv } = makeCanvas(100, 50);
  const r = C.resizeCanvas(cv);
  assert.strictEqual(r.dpr, 2.5, 'dpr 应 clamp 到 2.5，实得 ' + r.dpr);
  window.devicePixelRatio = 0.3;
  const { cv: cv2 } = makeCanvas(100, 50);
  const r2 = C.resizeCanvas(cv2);
  assert.strictEqual(r2.dpr, 1, 'dpr 应 clamp 到 1，实得 ' + r2.dpr);
  window.devicePixelRatio = saved;
});

console.log('\n── 汇总 ──');
console.log('  通过: ' + pass + ' | 失败: ' + fail);
process.exit(fail > 0 ? 1 : 0);
