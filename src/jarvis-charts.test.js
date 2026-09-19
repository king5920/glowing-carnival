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
    /* 记录每次赋色——让"红涨绿跌""量柱 alpha"这类断言校验的是
     * 真正写进 canvas 的颜色，而不是图表返回值里的元数据。 */
    get fillStyle(){ return this._fs == null ? '' : this._fs; },
    set fillStyle(v){ this._fs = v; if(!calls.fillStyles) calls.fillStyles = []; calls.fillStyles.push(v); },
    get strokeStyle(){ return this._ss == null ? '' : this._ss; },
    set strokeStyle(v){ this._ss = v; if(!calls.strokeStyle) calls.strokeStyle = []; calls.strokeStyle.push(v); },
    lineWidth: 1,
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

console.log('\n── drawKline() 大盘 K 线图（C3-C）──');

/* 120 日 mock K 线：open 逐日递推、close 周期性摆动，
 * 保证同时出现涨（close>open）与跌（close<open）两形态，
 * 且 120 根足够 MA5/MA10/MA20 全部有连续点位。 */
function mockKBars(n){
  const out = [];
  let base = 3800;
  for(let i = 0; i < n; i++){
    const open = base;
    const close = +(base + ((i * 37) % 121 - 60)).toFixed(2);
    const high = Math.max(open, close) + ((i * 13) % 30 + 5);
    const low  = Math.min(open, close) - ((i * 17) % 25 + 3);
    out.push({
      date: '2026-' + String(1 + Math.floor(i / 30)).padStart(2, '0')
                  + '-' + String(1 + (i % 30)).padStart(2, '0'),
      open: +open.toFixed(2), close: close,
      high: +high.toFixed(2), low: +low.toFixed(2),
      volume: 400000000 + (i % 12) * 50000000,
    });
    base = close;
  }
  return out;
}
const KBARS = mockKBars(120);

test('drawKline 暴露于 window.Charts 且返回 hit/tooltip/bars/mas/layout 五件套', () => {
  assert.strictEqual(typeof C.drawKline, 'function', 'drawKline 未暴露');
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  assert(typeof r.hit === 'function', 'hit 应为函数');
  assert(typeof r.tooltip === 'function', 'tooltip 应为函数');
  assert(Array.isArray(r.bars) && r.bars.length === 120, 'bars 应 120 条，实得 ' + (r.bars && r.bars.length));
  assert(Array.isArray(r.mas) && r.mas.length === 3, 'mas 应 3 条');
  assert(r.layout && r.layout.plotW > 0 && r.layout.plotH > 0, 'layout 应有正尺寸');
});

test('drawKline 120 根蜡烛 + 120 根量柱（fillRect 240 次、stroke 125 次）', () => {
  const { cv, calls } = makeCanvas(600, 220);
  C.drawKline(cv, KBARS);
  /* 每根蜡烛恰好 1 次 fillRect（涨=实心 / 跌=空心填底），再加 120 根成交量柱 */
  assert.strictEqual(calls.fillRect.length, 240,
    '120 蜡烛实体 + 120 量柱 = 240，实得 ' + calls.fillRect.length);
  /* stroke：价格区网格 1 + 双区边框 1 + 120 影线 + 3 均线 = 125 */
  assert.strictEqual(calls.stroke, 125, 'stroke 应为 125，实得 ' + calls.stroke);
});

test('drawKline 红涨绿跌（A 股口径：close>open 用 --rd，close<open 用 --gn）', () => {
  const { cv, calls } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  const upColor = C.css('--rd'), downColor = C.css('--gn');
  let upN = 0, downN = 0;
  r.bars.forEach(b => {
    const expectUp = b.d.close > b.d.open;
    if (expectUp) upN++; else downN++;
    assert.strictEqual(b.fill, expectUp ? upColor : downColor,
      '第 ' + b.i + ' 根 fill 与涨跌不符（' + b.d.open + '→' + b.d.close + '）');
  });
  assert(upN > 0 && downN > 0, '测试数据应同时含涨与跌，实得 涨' + upN + '/跌' + downN);
  /* 校验真正写进 canvas 的颜色，而不只是返回值元数据。
   * drawCandle 的既有约定：涨=实心（fillStyle=--rd），跌=空心
   * （fillStyle=--panel 底色 + strokeStyle=--gn 边框）。
   * 所以红只出现在 fillStyle、绿只出现在 strokeStyle，两条通道分开断言。 */
  assert(calls.fillStyles.indexOf(upColor) >= 0,
    '涨柱应 fillStyle=--rd 红，实得 ' + JSON.stringify([...new Set(calls.fillStyles)]));
  assert(calls.strokeStyle.indexOf(downColor) >= 0,
    '跌柱影线/空心边框应 strokeStyle=--gn 绿，实得 ' + JSON.stringify([...new Set(calls.strokeStyle)]));
  assert(calls.fillStyles.indexOf(C.css('--panel')) >= 0,
    '空心跌柱应填 --panel 底色（形状通道，色盲兜底）');
  /* 色相可分性：红 r 通道显著大于绿 r 通道（色盲备援由"实心/空心"形状通道兜底） */
  const upRgb = C._hexToRgb(upColor), downRgb = C._hexToRgb(downColor);
  assert.strictEqual(upRgb[0], 240, '涨 --rd r 应为 240');
  assert.strictEqual(downRgb[0], 8, '跌 --gn r 应为 8');
  assert(upRgb[0] > downRgb[0], '涨(红) r 应显著大于跌(绿) r');
});

test('drawKline MA5/MA10/MA20 三色相分离、起点正确、颜色取自 CSS 变量', () => {
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  assert.deepStrictEqual(r.mas.map(m => m.k), [5, 10, 20]);
  const colors = r.mas.map(m => m.color);
  assert.strictEqual(new Set(colors).size, 3, '三条均线应三色相分离：' + colors.join(','));
  assert.strictEqual(colors[0], C.css('--cy'), 'MA5 应取 --cy');
  assert.strictEqual(colors[1], C.css('--gd'), 'MA10 应取 --gd');
  assert.strictEqual(colors[2], C.css('--info'), 'MA20 应取 --info');
  /* MA_k 从 index k-1 起：120-5+1=116，120-20+1=101 */
  assert.strictEqual(r.mas[0].pts.length, 116, 'MA5 点位应为 116');
  assert.strictEqual(r.mas[1].pts.length, 111, 'MA10 点位应为 111');
  assert.strictEqual(r.mas[2].pts.length, 101, 'MA20 点位应为 101');
  /* 三条线各自 stroke 一次（已含在 125 次总 stroke 里） */
  r.mas.forEach(m => assert(m.pts.length >= 2, 'MA' + m.k + ' 应有 >=2 点位'));
});

test('drawKline 数据不足 20 根时 MA20 为空、MA5 仍连续绘制', () => {
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS.slice(0, 8));
  assert.strictEqual(r.mas[0].pts.length, 4, '8-5+1=4');
  assert.strictEqual(r.mas[1].pts.length, 0, '8<10 无 MA10');
  assert.strictEqual(r.mas[2].pts.length, 0, '8<20 无 MA20');
});

test('drawKline 成交量柱落在底部 25% 区域、颜色带 0.5 透明度', () => {
  const { cv, calls } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  const L = r.layout;
  assert(Math.abs(L.volH / L.plotH - 0.25) < 1e-9,
    '成交量区应为 plotH 的 25%，实得 ' + (L.volH / L.plotH));
  assert(L.volTop > L.priceTop + L.priceH, '量区应在价格区之下');
  assert(L.volTop + L.volH <= L.padTop + L.plotH, '量区不得越出绘图区');
  const volRects = calls.fillRect.filter(f =>
    f.y >= L.volTop - 0.01 && f.y + f.h <= L.volTop + L.volH + 0.01);
  assert.strictEqual(volRects.length, 120, '应有 120 根量柱，实得 ' + volRects.length);
  assert(volRects.some(f => f.y <= L.volTop + 1), '应有量柱顶到量区顶（maxVol 那根）');
  /* 量柱颜色随当日涨跌同色、alpha=0.5（不与价格蜡烛抢视觉层级） */
  assert(calls.fillStyles.some(f => /^rgba\(\d+,\d+,\d+,0\.5\)$/.test(f)),
    '量柱应为 alpha 0.5 的 rgba：' + calls.fillStyles.slice(-6).join(','));
});

test('drawKline tooltip 是整句中文且含 开/高/低/收/量 + % + 亿', () => {
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  const tip = r.tooltip(KBARS[100]);
  assert(/[一-鿿]/.test(tip), 'tooltip 应含中文："' + tip + '"');
  ['开', '高', '低', '收', '量'].forEach(k =>
    assert(tip.indexOf(k) >= 0, '缺"' + k + '"："' + tip + '"'));
  assert(/%/.test(tip), '缺 % 单位："' + tip + '"');
  assert(/亿|万/.test(tip), '缺 亿/万 单位："' + tip + '"');
  assert(/\d{4}-\d{2}-\d{2}/.test(tip), '缺 YYYY-MM-DD 日期："' + tip + '"');
});

test('drawKline tooltip 数值格式（价格 1 位小数 / 涨跌带符号 / 量 亿 两位小数）', () => {
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  const tip = r.tooltip({ date: '2026-09-18', open: 3891.96, close: 3911.87,
                          high: 3919.67, low: 3888.5, volume: 485712507 });
  assert(tip.indexOf('开3892.0') >= 0, '开价应 1 位小数："' + tip + '"');
  assert(tip.indexOf('高3919.7') >= 0, '高价应 1 位小数："' + tip + '"');
  assert(tip.indexOf('低3888.5') >= 0, '低价应 1 位小数："' + tip + '"');
  assert(tip.indexOf('收3911.9') >= 0, '收价应 1 位小数："' + tip + '"');
  assert(tip.indexOf('量4.86亿') >= 0, '量应为 亿 单位两位小数："' + tip + '"');
  assert(tip.indexOf('+0.51%') >= 0, '涨幅应带 + 号："' + tip + '"');
});

test('drawKline tooltip 跌日涨跌幅为负号、中等量级用"万"', () => {
  const { cv } = makeCanvas(600, 220);
  const r = C.drawKline(cv, KBARS);
  const tip = r.tooltip({ date: '2026-09-18', open: 3900, close: 3855,
                          high: 3905, low: 3850, volume: 52000000 });
  assert(tip.indexOf('-1.15%') >= 0, '跌幅应带 - 号："' + tip + '"');
  assert(tip.indexOf('量5200.0万') >= 0, '量应为 万 单位："' + tip + '"');
});

test('drawKline hit 返回对应 bar、越界（含右轴价格刻度区）返回 null', () => {
  const { cv } = makeCanvas(1200, 220);
  const r = C.drawKline(cv, KBARS);
  /* plotW = 1200-6-48 = 1146；slotW = 1146/120 = 9.55；x=100 → idx = floor(94/9.55) = 9 */
  const hit = r.hit(100, 110);
  assert(hit, '图内 hover 应有命中');
  assert.strictEqual(hit.date, KBARS[9].date, 'x=100 应命中第 10 根');
  assert.strictEqual(r.hit(-10, 110), null, '左侧越界应 null');
  assert.strictEqual(r.hit(1250, 110), null, '右轴刻度区应 null（不参与命中）');
  assert.strictEqual(r.hit(600, -10), null, '上方越界应 null');
  assert.strictEqual(r.hit(600, 300), null, '下方越界应 null');
});

test('drawKline + bindHover tooltip 有 role=status + aria-live=polite + 整句中文', () => {
  const { cv, host } = makeCanvas(600, 220);
  const hv = C.bindHover(cv, C.drawKline(cv, KBARS));
  hv.simulate(300, 110);
  const tip = hv.getTip();
  assert(tip, 'hover 后应创建 tooltip DOM');
  assert.strictEqual(tip.getAttribute('role'), 'status');
  assert.strictEqual(tip.getAttribute('aria-live'), 'polite');
  assert(tip.style.display === 'block', '命中后 tooltip 应可见');
  assert(tip.textContent.indexOf('开') >= 0 && tip.textContent.indexOf('收') >= 0,
    'tooltip 应含开/收："' + tip.textContent + '"');
  assert(/%/.test(tip.textContent), 'tooltip 应含 %："' + tip.textContent + '"');
  assert(tip.parentElement === host, 'tooltip 应挂到 canvas 父元素');
  hv.unbind();
  assert.strictEqual(hv.getTip(), null, 'unbind 后 getTip 应为 null');
});

test('drawKline 空数据画"暂无K线数据"占位、hit/mas 安全', () => {
  const { cv, calls } = makeCanvas(200, 80);
  const r = C.drawKline(cv, []);
  assert(r && r.layout === null, '空数据 layout 应为 null');
  assert(calls.fillText.length >= 1, '应画占位文字');
  assert(/暂无K线数据/.test(calls.fillText[0].t), '应画"暂无K线数据"，实得"' + calls.fillText[0].t + '"');
  assert.strictEqual(r.hit(100, 40), null, '空数据 hit 应 null');
  assert(Array.isArray(r.mas) && r.mas.length === 0, '空数据 mas 应为空数组');
});

test('drawKline bars 为 null 时不炸、hit 安全返回 null', () => {
  const { cv } = makeCanvas(200, 80);
  const r = C.drawKline(cv, null);
  assert(r);
  assert.strictEqual(r.hit(100, 40), null);
});

test('drawKline canvas 尺寸过小（不足以布局）时画占位不炸', () => {
  const { cv, calls } = makeCanvas(10, 20);
  const r = C.drawKline(cv, KBARS);
  assert(r && r.layout === null);
  assert(/暂无K线数据/.test(calls.fillText[0].t), '应画占位，实得"' + calls.fillText[0].t + '"');
});

test('drawKline 缺少 volume 字段不炸（只画蜡烛与均线，无量柱）', () => {
  const { cv, calls } = makeCanvas(600, 220);
  const d = KBARS.map(b => ({ date: b.date, open: b.open, close: b.close, high: b.high, low: b.low }));
  const r = C.drawKline(cv, d);
  assert(r && r.layout, '应正常绘制');
  assert.strictEqual(calls.fillRect.length, 120, '无 volume 时只有 120 根蜡烛实体，实得 ' + calls.fillRect.length);
  assert(r.bars.every(x => !x.vol), '无 volume 时 volRect 应全空');
  assert.strictEqual(r.layout.maxVol, 0, 'maxVol 应为 0');
});

test('drawKline 缺少 close 字段不炸（实体退化为单点、tooltip 收价显示 —）', () => {
  const { cv } = makeCanvas(600, 220);
  const d = [{ date: '2026-09-01', open: 3800, high: 3850, low: 3790, volume: 1e8 }];
  const r = C.drawKline(cv, d);
  assert(r && r.layout, '缺 close 时仍应布局');
  const b0 = r.bars[0];
  assert.strictEqual(b0.bodyTop, b0.bodyBot, '缺 close 时实体应退化为单点');
  assert.strictEqual(b0.up, false, '缺 close 时不应判为涨');
  const tip = r.tooltip(d[0]);
  assert(tip.indexOf('收—') >= 0, '缺 close 时收价应显示 —："' + tip + '"');
  assert(tip.indexOf(' · — ·') >= 0, '缺 close 时涨跌幅应显示 —："' + tip + '"');
});

test('drawKline 全部价格字段缺失时画占位、不编造数值', () => {
  const { cv, calls } = makeCanvas(300, 120);
  const d = [{ date: '2026-09-01' }, { date: '2026-09-02' }];
  const r = C.drawKline(cv, d);
  assert(r && r.layout === null);
  assert(/暂无K线数据/.test(calls.fillText[0].t), '应画占位，实得"' + calls.fillText[0].t + '"');
  assert.strictEqual(r.hit(150, 60), null);
});

test('drawKline 右轴价格刻度存在（5 条横线 + 5 个价格 label）', () => {
  const { cv, calls } = makeCanvas(600, 220);
  C.drawKline(cv, KBARS);
  /* 价格 label 全部写在右轴外侧（x = padLeft + plotW + 4 = 6 + 546 + 4 = 556）；
   * X 轴日期 label 在 h-4 处且居中 */
  const priceLabels = calls.fillText.filter(t => t.x === 6 + 546 + 4);
  assert.strictEqual(priceLabels.length, 5, '应有 5 条价格刻度，实得 ' + priceLabels.length);
  priceLabels.forEach(t => assert(/^\d+\.\d+$/.test(t.t), '价格 label 应为数字："' + t.t + '"'));
  const dateLabels = calls.fillText.filter(t => t.y === 220 - 4);
  assert.strictEqual(dateLabels.length, 3, '应有 3 个日期 label，实得 ' + dateLabels.length);
  dateLabels.forEach(t => assert(/^\d{2}-\d{2}$/.test(t.t), '日期 label 应为 MM-DD："' + t.t + '"'));
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

/* ═══════════════════════════════════════════════════════════════════════
   §5-2 个股 K 线面板（ui/index.html 内联 IIFE 的**真实源码**）
   ─────────────────────────────────────────────────────────────────────
   策略：从 index.html 抽出 §5 K 线 IIFE 原文，放进受控 vm 沙箱执行。
   fetch / setTimeout / localStorage 全是假实现，记录真实的 URL、定时器、
   存储写入——这样测的是**上线那段代码**本身，不是它的复制品。
   （jarvis-drawer.test.js 只能内联复制，因为 render 函数无法导出；
     这里的 K 线 IIFE 整块自包含，可以整块抽出来跑。）
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const MARK = '§5 大盘/个股 K 线图';
const _mi = HTML.indexOf(MARK);
const _sStart = HTML.lastIndexOf('<script>', _mi);
const _sEnd = HTML.indexOf('</script>', _mi);
const KLINE_SRC = _sStart >= 0 && _sEnd > _sStart
  ? HTML.slice(_sStart, _sEnd).replace(/^<script>/, '').trim() : '';

/* ── 构造一段 K 线数据（个股口径：高价股 + 量纲与指数差 3 个数量级）── */
function mkBars(n, base, vol){
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = base + Math.sin(i / 5) * base * 0.05;
    const o = c + (i % 2 ? 0.003 : -0.003) * base;
    bars.push({
      date: '2026-' + String(1 + Math.floor(i / 30)).padStart(2, '0')
            + '-' + String(1 + (i % 30)).padStart(2, '0'),
      open: +o.toFixed(2),
      high: +(Math.max(o, c) + base * 0.005).toFixed(2),
      low: +(Math.min(o, c) - base * 0.005).toFixed(2),
      close: +c.toFixed(2),
      volume: (vol || 1e6) + i * 1234,
    });
  }
  return bars;
}

console.log('\n── drawKline 个股形态数据（§5-2）──');

test('drawKline 接受任意个股的 bars（高价股 1680 元 + 小成交量），返回五件套', () => {
  const { cv } = makeCanvas(440, 200);
  const bars = mkBars(120, 1680, 520000);
  const r = C.drawKline(cv, bars, {});
  assert(r, '应返回结果对象');
  ['hit', 'tooltip', 'bars', 'mas', 'layout'].forEach(k =>
    assert(r[k] != null, '缺 ' + k + ' 字段'));
  assert.strictEqual(r.bars.length, 120, 'bars 应全量保留');
  assert.strictEqual(r.mas.length, 3, 'MA5/10/20 三条');
});

test('drawKline 对个股 bars 的 tooltip 是整句中文（含日期/开高低收/量）', () => {
  const { cv } = makeCanvas(440, 200);
  const bars = mkBars(60, 1680, 520000);
  const r = C.drawKline(cv, bars, {});
  const hit = r.hit(60, 60);
  assert(hit, '图内应有命中点');
  const tip = r.tooltip(hit);
  assert(typeof tip === 'string' && /[一-鿿]/.test(tip),
    'tooltip 应为中文整句，实得 "' + tip + '"');
  assert(/\d{4}-\d{2}-\d{2}/.test(tip), 'tooltip 应含日期："' + tip + '"');
  assert(/开|高|低|收/.test(tip), 'tooltip 应含 OHLC："' + tip + '"');
});

test('drawKline 个股 bars 的成交量按该股自身量纲归一（量柱落在量区、底部齐平）', () => {
  const { cv } = makeCanvas(440, 200);
  const bars = mkBars(40, 25.6, 120000000);   /* 低价股 + 亿股级成交量 */
  const r = C.drawKline(cv, bars, {});
  const L = r.layout;
  assert.strictEqual(r.bars.length, 40, '40 根 bars 全量绘制');
  const vols = r.bars.map(b => b.vol).filter(Boolean);
  assert.strictEqual(vols.length, 40, '每根 bar 都应有量柱，实得 ' + vols.length);
  /* 量柱必须完整落在 [volTop, volTop+volH] 内，且底部齐平 */
  const bottom = L.volTop + L.volH;
  vols.forEach(v => {
    assert(v.y >= L.volTop - 0.01 && v.y + v.h <= bottom + 0.01,
      '量柱越界 y=' + v.y.toFixed(2) + ' h=' + v.h.toFixed(2)
        + '，量区是 ' + L.volTop + '~' + bottom);
    assert(Math.abs(v.y + v.h - bottom) < 0.01,
      '量柱底部应齐平，实得 ' + (v.y + v.h).toFixed(2) + ' / ' + bottom);
  });
  /* 归一基准就是该股自己的最大成交量：最高的量柱正好填满量区 */
  assert.strictEqual(L.maxVol, Math.max.apply(null, bars.map(b => b.volume)),
    'maxVol 应取该股自身最大成交量，实得 ' + L.maxVol);
  const tallest = Math.max.apply(null, vols.map(v => v.h));
  assert(Math.abs(tallest - L.volH) < 0.01,
    '最高的量柱应填满量区，实得 ' + tallest.toFixed(2) + ' / ' + L.volH.toFixed(2));
  /* 量纲再小也各自归一：量区位置不变、maxVol 换成新股的量级 */
  const r2 = C.drawKline(cv, mkBars(40, 1680, 520000), {});
  assert.strictEqual(r2.layout.volTop, L.volTop, '换标的后量区位置不变');
  assert(r2.layout.maxVol < L.maxVol, '不同标的应各自按自身量纲归一');
});

/* ── IIFE 沙箱：假 fetch / 假时钟 / 假存储 ── */
function mkSandbox(opts){
  opts = opts || {};
  const { cv, host } = makeCanvas(440, 200);

  /* select/options：忠实模拟浏览器语义。两点最容易测假：
   *  1) 给 value 赋一个 options 里不存在的值 → 选中项静默不变；
   *  2) removeChild 之后该 option 从 options 里消失（options 反映 DOM 现状）。
   * 第 2 点之前漏了，导致"占位项被移除"的断言一直是自欺欺人。 */
  const mkOpt = (value, text, extra) => Object.assign(
    { value: value, textContent: text, parentNode: null, _ph: false }, extra || {});
  const idxOpts = [
    mkOpt('000001', '上证指数 000001'),
    mkOpt('399001', '深证成指 399001'),
    mkOpt('399006', '创业板指 399006'),
  ];
  const leadGroup = {
    label: '龙头个股 · 收盘扫描',
    children: [],
    appendChild(el){ this.children.push(el); el.parentNode = this; return el; },
    removeChild(el){
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
    /* 真 DOM 只返回带该属性的节点——不是"第一个孩子"。
     * 之前写成 children[0]，导致第二个龙头补入时把第一个龙头当成占位项删掉。 */
    querySelector(sel){
      if (!/data-placeholder/.test(sel)) return null;
      for (let i = 0; i < this.children.length; i++) {
        if (this.children[i]._ph) return this.children[i];
      }
      return null;
    },
  };
  leadGroup.appendChild(mkOpt('', '（收盘扫描后自动填充）', { disabled: true, _ph: true }));
  const codeEl = {
    _sel: '000001', _changes: [],
    get value(){ return this._sel; },
    set value(v){
      const opts = this.options;
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].value === String(v)) { this._sel = opts[i].value; return; }
      }
      /* 浏览器行为：options 里没有这个值 → 选中项不变 */
    },
    get options(){ return idxOpts.concat(leadGroup.children); },
    querySelector(sel){ return /optgroup\[data-group="leaders"\]/.test(sel)
      ? leadGroup : null; },
    addEventListener(t, fn){ if (t === 'change') this._changes.push(fn); },
    change(){ this._changes.forEach(f => f()); },
  };
  const periodEl = {
    _val: 'day', _changes: [],
    get value(){ return this._val; },
    set value(v){
      /* 忠实：day/week/month 之外的赋值被静默忽略（真页面就这三个 option） */
      if (['day', 'week', 'month'].indexOf(String(v)) >= 0) this._val = String(v);
    },
    addEventListener(t, fn){ if (t === 'change') this._changes.push(fn); },
    change(){ this._changes.forEach(f => f()); },
  };

  const els = {
    klineCanvas: cv, klinebox: {}, klineTitleTxt: { textContent: '' },
    klineTime: { textContent: '' }, klineCode: codeEl, klinePeriod: periodEl,
  };

  /* 假 fetch：plans 按顺序取，manual:true 的调用留给测试手动 settle */
  const calls = [];
  const plans = opts.plans || [];
  function nextPlan(){
    if (!plans.length) return { resp: { ok: true } };
    return plans.shift();
  }
  function fetchImpl(url, init){
    const rec = nextPlan();
    const call = { url: url, id: calls.length, settled: false,
                   signal: init && init.signal };
    calls.push(call);
    const p = new Promise((resolve, reject) => {
      call.resolve = (payload) => {
        if (call.settled) return;
        call.settled = true;
        resolve({ json: () => Promise.resolve(payload) });
      };
      if (rec.manual !== true){
        /* 用 setImmediate 而不是 setTimeout：Node 的 0ms 定时器有 1ms 下限，
         * 而 settle() 只排空 immediate 队列（几十微秒），真定时器根本来不及触发。
         * 假 fetch 的"稍后回包"不需要真实耗时语义。 */
        setImmediate(() => call.resolve(rec.resp != null ? rec.resp : { ok: true }));
      }
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === 'function'){
        sig.addEventListener('abort', () => {
          if (!call.settled) { call.settled = true; reject(new Error('AbortError')); }
        });
      }
    });
    return p;
  }

  /* 假时钟：只记录、不触发（5/30 分钟的刷新链不能真的跑起来挂住进程） */
  const scheduled = [];
  let tid = 0;
  function setTimeoutImpl(fn, ms){
    const id = ++tid;
    scheduled.push({ id: id, fn: fn, ms: ms, cleared: false });
    return id;
  }
  function clearTimeoutImpl(id){
    const s = scheduled.find(x => x.id === id);
    if (s) s.cleared = true;
  }
  /* 刷新定时器（5min/30min/60s）与秒级的 abort 定时器区分开 */
  function refreshTimers(){
    return scheduled.filter(s => s.ms >= 60000 && !s.cleared);
  }

  const store = {};
  /* 预置"上次关页面"的记忆：IIFE 执行前先写进 store */
  if (opts.cfgRaw != null) store['jarvis.kline.cfg'] = String(opts.cfgRaw);
  else if (opts.cfg) store['jarvis.kline.cfg'] = JSON.stringify(opts.cfg);
  const localStorageImpl = {
    getItem(k){ return Object.prototype.hasOwnProperty.call(store, k)
      ? store[k] : null; },
    setItem(k, v){ store[k] = String(v); },
  };

  const win = { Charts: C, devicePixelRatio: 2, __closescanData: opts.closescan || null };
  const sandbox = {
    window: win,
    document: { getElementById: (id) => els[id] || null,
                createElement: (tag) => ({ tag: tag, value: '', textContent: '',
                                           parentNode: null }) },
    fetch: fetchImpl,
    localStorage: opts.noLocalStorage ? undefined : localStorageImpl,
    AbortController: AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    console: console,
  };
  vm.runInNewContext(KLINE_SRC, sandbox, { filename: 'ui/index.html#kline' });
  return { sandbox: sandbox, win: win, calls: calls, scheduled: scheduled,
           refreshTimers: refreshTimers, store: store, els: els,
           codeEl: codeEl, periodEl: periodEl, title: els.klineTitleTxt };
}

/* 排空微任务队列（跨 realm 的 Promise 同样跑在这条线程上） */
const settle = (n) => new Promise(r => {
  let i = 0;
  (function step(){ if (i++ >= (n || 8)) return r(); setImmediate(step); })();
});

/* 异步测试：test() 是同步 try/catch，抓不到 rejection，故单独排队后统一汇总 */
const _asyncQueue = [];
function atest(name, fn){ _asyncQueue.push({ name: name, fn: fn }); }
function withTimeout(p, ms, label){
  return Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error(label + '：' + ms + 'ms 未结束')), ms))]);
}

const STOCK_OK = { ok: true, code: '600519', name: '贵州茅台', period: 'day',
                   adjust: 'forward', source: 'tencent',
                   days: 120, indicators: {}, bars: mkBars(120, 1680, 520000) };
const IDX_OK = { ok: true, code: '000001', name: '上证指数', period: 'day',
                 adjust: 'forward', source: 'tencent',
                 days: 120, indicators: {}, bars: mkBars(120, 3450, 6e9) };

/* 模拟"收盘扫描回来了"：把龙头塞进下拉。
 * 不先补码就直接 codeEl.value='600519' 会被 select 语义忽略（值不在 options 里），
 * 那测的就不是切换逻辑了。 */
function addLeaders(env, sectors){
  env.win.__populateKlineCodes({ sectors: sectors });
}

console.log('\n── §5-2 K 线面板：标的/周期切换（index.html 真源码）──');

atest('源码可抽取并执行（结构自检：两个下拉 + 切换钩子 + 补码钩子都在）', async () => {
  assert(KLINE_SRC.length > 2000, 'IIFE 未抽到（marker "' + MARK + '" 失效？）');
  assert(/getElementById\('klineCode'\)/.test(KLINE_SRC), '缺 #klineCode 读取');
  assert(/getElementById\('klinePeriod'\)/.test(KLINE_SRC), '缺 #klinePeriod 读取');
  const env = mkSandbox({ plans: [{ manual: true }] });
  await settle();
  assert.strictEqual(typeof env.win.__populateKlineCodes, 'function',
    'window.__populateKlineCodes 钩子未挂出');
  assert(env.calls.length === 1, '启动应触发一次 /api/kline');
});

atest('启动默认请求上证指数：/api/kline?code=000001&period=day&limit=120', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  assert.strictEqual(env.calls.length, 1);
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120',
    '实得 ' + env.calls[0].url);
  assert.strictEqual(env.title.textContent, '大盘 K 线 · 上证指数 120 日',
    '标题应为"' + env.title.textContent + '"');
});

atest('切换标的 → 请求带新 code，标题改为"个股 K 线"', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }, { resp: STOCK_OK }] });
  await settle();
  addLeaders(env, [{ name: '白酒', leader: '贵州茅台', leaderCode: '600519' }]);
  await settle();
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.calls.length, 2);
  assert(env.calls[1].url.indexOf('code=600519') >= 0, '实得 ' + env.calls[1].url);
  assert.strictEqual(env.title.textContent, '个股 K 线 · 贵州茅台 120 日',
    '实得"' + env.title.textContent + '"');
});

atest('切换周期 → 请求带 period=week，标题单位变"周"', async () => {
  const WEEK = Object.assign({}, IDX_OK,
    { period: 'week', bars: mkBars(120, 3450, 6e9) });
  const env = mkSandbox({ plans: [{ resp: IDX_OK }, { resp: WEEK }] });
  await settle();
  env.periodEl.value = 'week';
  env.periodEl.change();
  await settle();
  assert(env.calls[1].url.indexOf('period=week') >= 0, '实得 ' + env.calls[1].url);
  assert(/周$/.test(env.title.textContent), '标题应以"周"结尾，实得"'
    + env.title.textContent + '"');
});

atest('月 K：limit 仍是 120，URL 三个参数齐全', async () => {
  const M = Object.assign({}, STOCK_OK, { period: 'month' });
  const env = mkSandbox({ plans: [
    { resp: IDX_OK },          /* 启动：上证指数 日 K */
    { resp: STOCK_OK },        /* 切标的：600519 日 K */
    { resp: M },               /* 切周期：600519 月 K */
  ]});
  await settle();
  addLeaders(env, [{ name: '白酒', leader: '贵州茅台', leaderCode: '600519' }]);
  await settle();
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  env.periodEl.value = 'month';
  env.periodEl.change();
  await settle();
  assert.strictEqual(env.calls.length, 3, '两次切换应各发一次请求');
  const last = env.calls[env.calls.length - 1];
  assert.strictEqual(last.url, '/api/kline?code=600519&period=month&limit=120',
    '实得 ' + last.url);
  assert(/月$/.test(env.title.textContent), '标题应以"月"结尾，实得"'
    + env.title.textContent + '"');
});

atest('龙头代码动态补入 leaders 分组，占位项被移除', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  const before = env.codeEl.options.length;
  assert.strictEqual(before, 4, '启动时 3 个指数 + 1 个占位项，实得 ' + before);
  env.win.__populateKlineCodes({ sectors: [
    { name: '半导体', leader: '中芯国际', leaderCode: '688981' },
    { name: '白酒', leader: '贵州茅台', leaderCode: '600519' },
  ]});
  const opts = env.codeEl.options;
  const vals = opts.map(o => o.value);
  assert(vals.indexOf('688981') >= 0 && vals.indexOf('600519') >= 0,
    '应补入 688981 与 600519，实得 ' + vals.join(','));
  assert.strictEqual(opts.length, before - 1 + 2,
    '占位项被删掉、补入 2 项，实得 ' + opts.length);
  assert(opts.every(o => !o.disabled), '占位项应已移除');
  const names = opts.map(o => o.textContent);
  assert(names.indexOf('中芯国际 688981') >= 0
    && names.indexOf('贵州茅台 600519') >= 0,
    'option 文案应是"名称 代码"，实得 ' + names.join(' | '));
});

atest('重复补入去重（同一 leaderCode 只出现一次）', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  const scan = { sectors: [
    { leader: '贵州茅台', leaderCode: '600519' },
    { leader: '万科A', leaderCode: '000002' },
  ]};
  env.win.__populateKlineCodes(scan);
  env.win.__populateKlineCodes(scan);
  const vals = env.codeEl.options.map(o => o.value);
  assert.strictEqual(vals.filter(v => v === '600519').length, 1,
    '600519 出现 ' + vals.filter(v => v === '600519').length + ' 次');
  assert.strictEqual(env.codeEl.options.length, 5,
    '3 指数 + 2 龙头，实得 ' + env.codeEl.options.length);
});

atest('脏 leaderCode 全部跳过不炸（空/非数字/位数不对/带前缀后缀）', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  const before = env.codeEl.options.length;
  env.win.__populateKlineCodes({ sectors: [
    { leader: '空', leaderCode: null },
    { leader: '无', leaderCode: undefined },
    { leader: 'abc', leaderCode: 'abc' },
    { leader: '短', leaderCode: '60051' },
    { leader: '长', leaderCode: '6005199' },
  ]});
  assert.strictEqual(env.codeEl.options.length, before, '脏数据不应产生任何 option');
  env.win.__populateKlineCodes(null);
  env.win.__populateKlineCodes({});
  env.win.__populateKlineCodes({ sectors: 'not-array' });
  assert.strictEqual(env.codeEl.options.length, before, '空/错形输入也不应产生 option');
});

atest('带 sh/sz 前缀与 .SH 后缀的 leaderCode 归一化后再补入', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  env.win.__populateKlineCodes({ sectors: [
    { leader: '贵州茅台', leaderCode: 'sh600519' },
    { leader: '五粮液', leaderCode: '000858.SZ' },
  ]});
  const vals = env.codeEl.options.map(o => o.value);
  assert(vals.indexOf('600519') >= 0, 'sh600519 应归一化为 600519');
  assert(vals.indexOf('000858') >= 0, '000858.SZ 应归一化为 000858');
});

atest('启动时回读 __closescanData 缓存（收盘扫描先于 K 线 IIFE 完成的时序）', async () => {
  const env = mkSandbox({
    plans: [{ resp: STOCK_OK }],
    closescan: { sectors: [{ leader: '贵州茅台', leaderCode: '600519' }] },
  });
  await settle();
  const vals = env.codeEl.options.map(o => o.value);
  assert(vals.indexOf('600519') >= 0, '启动即应含 600519，实得 ' + vals.join(','));
});

atest('切换作废在途请求：旧的上证指数响应回来不覆盖新图', async () => {
  const env = mkSandbox({ plans: [{ manual: true }, { manual: true }] });
  await settle();
  addLeaders(env, [{ leader: '贵州茅台', leaderCode: '600519' }]);
  /* 第一次请求（000001）还在途，用户切到 600519 */
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.calls.length, 2, '应已发出第二个请求');
  assert(env.calls[1].url.indexOf('code=600519') >= 0,
    '第二个请求应带新标的，实得 ' + env.calls[1].url);
  env.calls[1].resolve(STOCK_OK);
  await settle();
  assert.strictEqual(env.title.textContent, '个股 K 线 · 贵州茅台 120 日',
    '新响应应生效');
  /* 旧的第一个响应姗姗来迟 */
  env.calls[0].resolve(IDX_OK);
  await settle();
  assert.strictEqual(env.title.textContent, '个股 K 线 · 贵州茅台 120 日',
    '旧响应不应覆盖新图，实得"' + env.title.textContent + '"');
});

atest('切换不残留重复定时器（旧的 setTimeout 被清掉）', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }, { resp: STOCK_OK }] });
  await settle();
  assert.strictEqual(env.refreshTimers().length, 1, '首刷后应有 1 个刷新定时器');
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.refreshTimers().length, 1,
    '切换后仍应只有 1 个，实得 ' + env.refreshTimers().length);
  assert(env.scheduled.some(s => s.ms >= 60000 && s.cleared),
    '旧的刷新定时器应被 clearTimeout');
});

atest('连续快速切换两次：只留 1 个定时器、最终图是最后一次选择', async () => {
  const W2 = Object.assign({}, STOCK_OK, { code: '000002', name: '万科A' });
  const env = mkSandbox({ plans: [{ manual: true }, { manual: true }, { manual: true }] });
  await settle();
  addLeaders(env, [
    { leader: '贵州茅台', leaderCode: '600519' },
    { leader: '万科A', leaderCode: '000002' },
  ]);
  env.codeEl.value = '600519';
  env.codeEl.change();
  env.codeEl.value = '000002';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.calls.length, 3);
  assert(env.calls[1].url.indexOf('code=600519') >= 0, '第二次请求应为 600519');
  assert(env.calls[2].url.indexOf('code=000002') >= 0, '第三次请求应为 000002');
  env.calls[2].resolve(W2);
  await settle();
  env.calls[1].resolve(STOCK_OK);   /* 中间那次也来迟 */
  await settle();
  assert.strictEqual(env.title.textContent, '个股 K 线 · 万科A 120 日',
    '应显示最后一次选择，实得"' + env.title.textContent + '"');
  assert.strictEqual(env.refreshTimers().length, 1,
    '实得 ' + env.refreshTimers().length);
});

atest('切换会 abort 掉上一轮在途请求，且不把 abort 显示成"连接失败"', async () => {
  const env = mkSandbox({ plans: [{ manual: true }, { resp: STOCK_OK }] });
  await settle();
  addLeaders(env, [{ leader: '贵州茅台', leaderCode: '600519' }]);
  assert.strictEqual(env.calls[0].signal.aborted, false, '在途请求尚未被中止');
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.calls[0].signal.aborted, true,
    '切换标的应 abort 掉上一轮在途请求');
  assert.strictEqual(env.calls[1].signal.aborted, false,
    '新请求应带一个未中止的 AbortSignal');
  env.calls[1].resolve(STOCK_OK);
  await settle();
  assert.strictEqual(env.title.textContent, '个股 K 线 · 贵州茅台 120 日');
  assert(!/连接失败|数据不可用/.test(env.title.textContent),
    'abort 出来的旧请求不应改写标题，实得"' + env.title.textContent + '"');
});

atest('记忆恢复：localStorage 里的标的+周期在启动时生效', async () => {
  const env = mkSandbox({
    cfg: { code: '399006', period: 'week' },
    plans: [{ resp: Object.assign({}, IDX_OK,
      { code: '399006', name: '创业板指', period: 'week' }) }],
  });
  await settle();
  assert.strictEqual(env.codeEl.value, '399006', '应恢复上次标的');
  assert.strictEqual(env.periodEl.value, 'week', '应恢复上次周期');
  assert.strictEqual(env.calls[0].url, '/api/kline?code=399006&period=week&limit=120',
    '实得 ' + env.calls[0].url);
  assert.strictEqual(env.title.textContent, '大盘 K 线 · 创业板指 120 周',
    '指数走"大盘"前缀，实得"' + env.title.textContent + '"');
});

atest('无记忆时回到默认（上证指数 + 日 K）', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }] });
  await settle();
  assert.strictEqual(env.codeEl.value, '000001');
  assert.strictEqual(env.periodEl.value, 'day');
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120');
});

atest('记忆写回：切换标的/周期后 localStorage 记录最新选择', async () => {
  const env = mkSandbox({ plans: [
    { resp: IDX_OK }, { resp: STOCK_OK }, { resp: STOCK_OK },
  ]});
  await settle();
  addLeaders(env, [{ leader: '贵州茅台', leaderCode: '600519' }]);
  await settle();
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  env.periodEl.value = 'week';
  env.periodEl.change();
  await settle();
  const raw = env.store['jarvis.kline.cfg'];
  assert(raw, '应有 jarvis.kline.cfg 写入');
  const cfg = JSON.parse(raw);
  assert.strictEqual(cfg.code, '600519', '实得 ' + raw);
  assert.strictEqual(cfg.period, 'week', '实得 ' + raw);
});

atest('localStorage 不可用时启动不炸（私密模式/禁 cookie）', async () => {
  const env = mkSandbox({ plans: [{ resp: IDX_OK }, { resp: STOCK_OK }],
                          noLocalStorage: true });
  await settle();
  assert.strictEqual(env.title.textContent, '大盘 K 线 · 上证指数 120 日');
  addLeaders(env, [{ leader: '贵州茅台', leaderCode: '600519' }]);
  env.codeEl.value = '600519';
  env.codeEl.change();
  await settle();
  assert.strictEqual(env.calls.length, 2, '切换仍应触发新请求');
  assert.strictEqual(env.codeEl.value, '600519', '无存储也不应阻塞选择');
});

atest('接口失败时如实显示"连接失败"，不显示旧数据', async () => {
  const env = mkSandbox({ plans: [{ resp: { ok: false, error: '上游超时' } }] });
  await settle();
  assert.strictEqual(env.title.textContent, 'K 线 · 数据不可用',
    '实得"' + env.title.textContent + '"');
});

console.log('\n── §5-2 前端记忆与补码时序 ──');

atest('记忆的龙头要等收盘扫描补码后才套用（不在启动时静默退回上证指数）', async () => {
  /* 记忆 = 龙头 600519，但启动时下拉里还没有它 —— 必须先等补码。
   * plans 用会 settle 的 resp（不是 manual）：刷新成功后才会排定时器，
   * 这样"不残留旧定时器"的断言才有东西可查。 */
  const env = mkSandbox({
    cfg: { code: '600519', period: 'day' },
    plans: [{ resp: IDX_OK }, { resp: STOCK_OK }, { resp: STOCK_OK }],
  });
  await settle();
  assert.strictEqual(env.codeEl.value, '000001',
    '龙头还没补进来时不应改选中项，实得 ' + env.codeEl.value);
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120',
    '启动只能取上证指数，实得 ' + env.calls[0].url);
  /* 收盘扫描回来了 */
  env.win.__populateKlineCodes({ sectors: [
    { leader: '贵州茅台', leaderCode: '600519' }] });
  await settle();
  assert.strictEqual(env.codeEl.value, '600519',
    '补码后应套用记忆的龙头，实得 ' + env.codeEl.value);
  const last = env.calls[env.calls.length - 1];
  assert(last.url.indexOf('code=600519') >= 0, '并重新请求该标的，实得 ' + last.url);
  assert.strictEqual(env.refreshTimers().length, 1,
    '补码触发的重取不应残留旧定时器');
});

atest('记忆的 code 是垃圾数据时安全退回默认，不改周期', async () => {
  const env = mkSandbox({
    cfg: { code: 'not-a-code', period: 'weekly' },
    plans: [{ manual: true }],
  });
  await settle();
  assert.strictEqual(env.codeEl.value, '000001', '应退回默认标的');
  assert.strictEqual(env.periodEl.value, 'day', '非法周期不应生效');
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120');
});

atest('记忆的 code/period 是非字符串类型时不炸', async () => {
  const env = mkSandbox({
    cfg: { code: { a: 1 }, period: 5 },
    plans: [{ manual: true }],
  });
  await settle();
  assert.strictEqual(env.codeEl.value, '000001');
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120');
});

atest('记忆是坏 JSON 时静默退回默认（不炸、不阻塞首刷）', async () => {
  const env = mkSandbox({
    cfgRaw: '{{{not json',
    plans: [{ manual: true }],
  });
  await settle();
  assert.strictEqual(env.codeEl.value, '000001');
  assert.strictEqual(env.calls[0].url, '/api/kline?code=000001&period=day&limit=120');
});

console.log('\n── §5-2 fetcher 侧：任意 code 接受度（stock_kline 纯函数，离线）──');

test('emSecid 对任意个股代码给出正确市场前缀（6/9 开头→沪 1.，其余→深 0.）', () => {
  const kl = require('./tools/stock_kline');
  [['600519', '1.600519'], ['000002', '0.000002'], ['300750', '0.300750'],
   ['688981', '1.688981'], ['002594', '0.002594'], ['900001', '1.900001']]
    .forEach(pair => {
      assert.strictEqual(kl.emSecid(pair[0], null, false), pair[1], 'code ' + pair[0]);
    });
});

test('isIndexCode 区分指数与个股：000001 是上证指数而不是平安银行', () => {
  const kl = require('./tools/stock_kline');
  ['000001', '399001', '399006'].forEach(c =>
    assert(kl.isIndexCode(c), c + ' 应识别为指数'));
  ['600519', '000002'].forEach(c =>
    assert(!kl.isIndexCode(c), c + ' 不应识别为指数'));
});

test('drawKline 对周/月周期的 bars 同样正常绘制（周期只影响数据粒度，不影响画法）', () => {
  const { cv } = makeCanvas(440, 200);
  ['week', 'month'].forEach(() => {
    const r = C.drawKline(cv, mkBars(120, 3450, 6e9), {});
    assert(r && r.bars.length === 120, 'bars 应全量绘制');
    assert(r.layout, 'layout 应存在');
  });
});

/* ═══ §5-4 实时 TAPE（轻量轮询版）：板块三柱条带 ═══
 * drawTape(canvas, sectors, opts) —— 画布/几何/三色分离/各自归一化/hit/tooltip
 * index.html 的轮询 IIFE —— setTimeout 自调度链、AbortController、round 计数器
 */

console.log('\n── §5-4 drawTape() 板块三柱条带 ──');

/* 板块扫描数据：字段形状与 tools/close_scan.js 的 sector 记录一致 */
function mkTapeSectors(n){
  const names = ['人工智能','半导体','机器人','低空经济','创新药','固态电池',
                 '算力租赁','卫星导航','军工','消费电子','化工','贵金属'];
  const leaders = ['肯特催化','中芯国际','绿的谐波','万丰奥威','恒瑞医药','宁德时代',
                   '润泽科技','北斗星通','中航沈飞','立讯精密','万华化学','山东黄金'];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: names[i % names.length],
      leader: leaders[i % leaders.length],
      leaderCode: '60000' + i,
      leaderPct: +(10.03 - i * 1.1).toFixed(2),   /* 10.03 → -2.07（正负都有） */
      d10Yi: +(12.5 - i * 2.0).toFixed(1),        /* 12.5 → -9.5 */
      changePct: +(3.50 - i * 0.35).toFixed(2),   /* 3.50 → -0.70 */
      score: 95 - i * 2, grade: '主线候选',
    });
  }
  return out;
}

const TAPE_OK = { ok: true, dataTime: '15:05', sectors: mkTapeSectors(12) };
const RD = '#F0485E', GD = '#F2B23E', CY = '#3FD0FF';
const TAPES = ['leaderPct', 'd10Yi', 'changePct'];

test('空数据 → 画"暂无数据"占位，API 仍是 hit/tooltip/sectors/layout 四件套', () => {
  const { cv, calls } = makeCanvas(600, 120);
  const r = C.drawTape(cv, []);
  assert(r, '返回值应为对象');
  ['hit', 'tooltip', 'sectors', 'layout'].forEach(k => assert(k in r, '缺字段 ' + k));
  assert.strictEqual(r.sectors.length, 0);
  assert.strictEqual(r.layout, null, '空数据 layout 应为 null');
  assert.strictEqual(r.tooltip(), '暂无数据');
  assert.strictEqual(r.hit(100, 50), null);
  const txts = calls.fillText.map(f => f.t);
  assert(txts.indexOf('暂无数据') >= 0, '应画占位文案，实得 ' + JSON.stringify(txts));
});

test('sectors=null / 缺 sectors 字段 → 不抛错，同样走占位', () => {
  const { cv } = makeCanvas(600, 120);
  assert.strictEqual(C.drawTape(cv, null).tooltip(), '暂无数据');
  assert.strictEqual(C.drawTape(cv, undefined).tooltip(), '暂无数据');
  assert.strictEqual(C.drawTape(cv, {}).tooltip(), '暂无数据');
  assert.strictEqual(C.drawTape(cv, [{ name: 'x' }]).sectors.length, 1,
    '只有 1 条也不该走占位');
});

test('canvas 尚未布局（clientWidth=0）→ 返回 null（与 drawKline 同口径）', () => {
  const { cv } = makeCanvas(600, 120);
  const zero = Object.assign({}, cv, { clientWidth: 0, clientHeight: 0 });
  assert.strictEqual(C.drawTape(zero, mkTapeSectors(12)), null);
});

test('12 板块全量绘制 + layout 几何自洽（等分槽位、零硬编码宽度）', () => {
  const SECT = mkTapeSectors(12);
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  assert.strictEqual(r.sectors.length, 12);
  const L = r.layout;
  assert(L, 'layout 应存在');
  assert.strictEqual(L.n, 12);
  assert(L.slotW > 0 && L.barW > 0 && L.barGap >= 1 && L.groupGap >= 2, '槽/柱几何应为正');
  assert.strictEqual(Math.round(L.padLeft + L.n * L.slotW + L.padRight), 600, '槽宽应恰好铺满画布');
  assert.strictEqual(Math.round(L.padTop + L.plotH + L.padBottom), 120, '高度应恰好铺满画布');
  TAPES.forEach(k => {
    assert(Array.isArray(L.ranges[k]), '缺 ranges.' + k);
    assert(L.ranges[k][0] < L.ranges[k][1], '区间 hi 应大于 lo：' + k);
  });
  r.sectors.forEach((g, i) => {
    assert.strictEqual(g.d, SECT[i], 'sectors[i].d 应引用原数据');
    assert.strictEqual(g.bars.length, 3, '每板块应 3 柱');
    assert(Math.abs(g.x - (L.padLeft + i * L.slotW)) < 1e-6, '槽 x 应等分');
    assert.strictEqual(g.bars[0].k, 'leaderPct');
    assert.strictEqual(g.bars[1].k, 'd10Yi');
    assert.strictEqual(g.bars[2].k, 'changePct');
  });
});

test('每板块 3 竖柱：12 板块 → fillRect 恰好 36 次 + 名称 12 次 + 基线 1 次', () => {
  const { cv, calls } = makeCanvas(600, 120);
  C.drawTape(cv, mkTapeSectors(12));
  assert.strictEqual(calls.fillRect.length, 36, '36 根柱，实得 ' + calls.fillRect.length);
  assert.strictEqual(calls.fillText.length, 12, '12 个板块名，实得 ' + calls.fillText.length);
  assert.strictEqual(calls.stroke, 1, '1 条 plot 基线，实得 ' + calls.stroke);
  /* 柱底应贴 plot 基线、柱顶不应越出 plot 上边界（归一化不该溢出） */
  const L = C.drawTape(makeCanvas(600, 120).cv, mkTapeSectors(12)).layout;
  const base = L.padTop + L.plotH;
  calls.fillRect.forEach(f => {
    assert.strictEqual(Math.round(f.y + f.h), Math.round(base), '柱底应贴基线');
    assert(f.y >= L.padTop - 1e-6, '柱顶不应越出 plot 上边界');
    assert(f.w > 0 && f.h >= 2, '柱宽应为正、柱高不小于 2px');
  });
});

test('三色分离：龙头涨幅 --rd / 10日资金 --gd / 板块涨幅 --cy，三色互不相同', () => {
  const r = C.drawTape(makeCanvas(600, 120).cv, mkTapeSectors(12));
  r.sectors.forEach(g => {
    assert.strictEqual(g.bars[0].fill, RD, '龙头涨幅应 --rd，实得 ' + g.bars[0].fill);
    assert.strictEqual(g.bars[1].fill, GD, '10日资金应 --gd，实得 ' + g.bars[1].fill);
    assert.strictEqual(g.bars[2].fill, CY, '板块涨幅应 --cy，实得 ' + g.bars[2].fill);
  });
  assert.strictEqual(new Set([RD, GD, CY]).size, 3, '三色应互不相同');
  /* 校验真正写进 canvas 的填充色（不是返回值元数据） */
  const { cv, calls } = makeCanvas(600, 120);
  C.drawTape(cv, mkTapeSectors(12));
  [RD, GD, CY].forEach(c => assert(calls.fillStyles.indexOf(c) >= 0, 'canvas 缺 ' + c));
});

test('A 股红涨绿跌：龙头涨幅恒用 --rd（含负值板块），正负号走 tooltip 数值通道', () => {
  const SECT = mkTapeSectors(12);
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  const neg = r.sectors.filter(g => g.bars[0].v != null && g.bars[0].v < 0);
  assert(neg.length > 0, '测试数据应含负涨幅板块');
  neg.forEach(g => assert.strictEqual(g.bars[0].fill, RD,
    '负涨幅的龙头柱仍是 --rd（色＝指标系列），实得 ' + g.bars[0].fill));
  assert(r.tooltip(neg[0].d).indexOf('-') >= 0, '负值必须在 tooltip 里带负号');
  /* TAPE 三色里不应出现 --gn（绿只留给 K 线跌柱 / 分布跌区） */
  const { cv, calls } = makeCanvas(600, 120);
  C.drawTape(cv, SECT);
  assert(calls.fillStyles.indexOf('#089981') < 0, 'TAPE 不应出现 --gn');
});

test('柱高按各自范围归一化：max→满高、min→最小 2px，三指标独立标度', () => {
  const SECT = mkTapeSectors(12);
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  const L = r.layout;
  TAPES.forEach(f => {
    const vals = SECT.map(s => s[f]);
    const maxV = Math.max.apply(null, vals), minV = Math.min.apply(null, vals);
    const gi = vals.indexOf(maxV), mi = vals.indexOf(minV);
    const gBar = r.sectors[gi].bars.find(b => b.k === f);
    const mBar = r.sectors[mi].bars.find(b => b.k === f);
    assert.strictEqual(gBar.t, 1, f + ' 最大值应归一到 1');
    assert.strictEqual(mBar.t, 0, f + ' 最小值应归一到 0');
    assert.strictEqual(gBar.h, L.plotH, f + ' 最大柱应满高 ' + L.plotH);
    assert.strictEqual(mBar.h, 2, f + ' 最小柱应为 2px');
    assert.strictEqual(L.ranges[f][0], minV, f + ' 区间 lo 应为全局最小');
    assert.strictEqual(L.ranges[f][1], maxV, f + ' 区间 hi 应为全局最大');
  });
  /* 独立标度：三指标的最大柱同高，但对应的原始数值完全不同 */
  const hs = TAPES.map(f => r.sectors.find(g => g.bars.find(b => b.k === f && b.t === 1))
    .bars.find(b => b.k === f).h);
  assert(hs.every(h => h === hs[0]), '三指标 max 柱应同高（各自归一化），实得 ' + JSON.stringify(hs));
  /* 三指标的标度区间互不相同 → 证明是各自归一化，不是共用一把标尺 */
  const hi = TAPES.map(f => L.ranges[f][1]);
  assert.strictEqual(new Set(hi).size, 3, '三指标的标度上限应各不相同，实得 ' + JSON.stringify(hi));
});

test('单值板块（全序列同值）→ 区间抬 1 单位台阶，不除零、不糊成等高', () => {
  const SECT = mkTapeSectors(12).map(s => Object.assign({}, s, { d10Yi: 8.8 }));
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  assert.deepStrictEqual(r.layout.ranges.d10Yi, [8.8, 9.8], '应抬 1 单位台阶');
  const dBar = r.sectors[0].bars.find(b => b.k === 'd10Yi');
  assert.strictEqual(dBar.t, 0, '同值时归一到 0');
  assert.strictEqual(dBar.h, 2, '同值时画最小柱高 2px');
});

test('hit：落在槽位返回对应 sector；plot 外/左右越界返回 null', () => {
  const SECT = mkTapeSectors(12);
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  const L = r.layout;
  const c3 = L.padLeft + 3 * L.slotW + L.slotW / 2;
  assert.strictEqual(r.hit(c3, 40), SECT[3], '第 3 槽中心应命中 SECT[3]');
  assert.strictEqual(r.hit(L.padLeft + 11.5 * L.slotW, 60), SECT[11], '末槽应命中 SECT[11]');
  /* 底部板块名所在行也算命中（hover 名称仍能看到该板块数值） */
  assert.strictEqual(r.hit(c3, L.padTop + L.plotH + 10), SECT[3], '名称行应算命中');
  assert.strictEqual(r.hit(c3, -5), null, 'plot 上方应 null');
  assert.strictEqual(r.hit(c3, 130), null, 'canvas 下方应 null');
  assert.strictEqual(r.hit(-10, 40), null, '左侧越界应 null');
  assert.strictEqual(r.hit(700, 40), null, '右侧越界应 null');
});

test('tooltip 整句中文：板块名 + 龙头 + 涨幅% + 10日资金亿 + 板块涨幅%', () => {
  const SECT = mkTapeSectors(12);
  const r = C.drawTape(makeCanvas(600, 120).cv, SECT);
  const tip = r.tooltip(SECT[0]);
  assert.strictEqual(tip, '人工智能 龙头肯特催化+10.03% · 10日资金12.5亿 · 板块+3.50%');
  assert(/[一-鿿]/.test(tip), '应含中文');
  ['人工智能', '肯特催化', '10日资金'].forEach(k =>
    assert(tip.indexOf(k) >= 0, '缺 "' + k + '"'));
  assert(/%/.test(tip) && /亿/.test(tip), '应同时带 % 与 亿 两种单位');
  /* 负值板块：涨跌幅带负号，资金带负号 */
  assert(/-\d+\.\d+%/.test(r.tooltip(SECT[11])),
    '负涨幅应带负号，实得 "' + r.tooltip(SECT[11]) + '"');
});

test('缺字段 → 留空槽不画柱、tooltip 显示 —，不抛错', () => {
  const SECT = mkTapeSectors(12);
  const sparse = Object.assign({}, SECT[0], { d10Yi: undefined, leaderPct: null });
  const arr = SECT.map(s => s === SECT[0] ? sparse : s);
  const { cv, calls } = makeCanvas(600, 120);
  const r = C.drawTape(cv, arr);
  assert.strictEqual(calls.fillRect.length, 34,
    '缺 2 柱 → 34 根，实得 ' + calls.fillRect.length);
  const b = r.sectors[0].bars;
  assert.strictEqual(b[0].h, 0, 'leaderPct=null 的柱高应为 0');
  assert.strictEqual(b[1].h, 0, 'd10Yi=undefined 的柱高应为 0');
  assert(b[2].h > 0, 'changePct 柱仍应正常绘制');
  assert.strictEqual(r.tooltip(sparse),
    '人工智能 龙头肯特催化— · 10日资金— · 板块+3.50%');
});

test('板块名截断到 4 字（长名不挤压槽宽）+ 空名不抛错', () => {
  const SECT = mkTapeSectors(12);
  SECT[0].name = '人工智能+机器人+CPO概念';   /* 超长名 */
  SECT[1].name = '';
  const { cv, calls } = makeCanvas(600, 120);
  C.drawTape(cv, SECT);
  const labels = calls.fillText.map(f => f.t);
  assert.strictEqual(labels[0], '人工智能', '超长名应截断到 4 字，实得 "' + labels[0] + '"');
  assert.strictEqual(labels[1], '', '空名画空串，不抛错');
  assert.strictEqual(labels.length, 12);
});

test('drawTape + bindHover → tooltip role=status + aria-live=polite + unbind 干净', () => {
  const { cv, host } = makeCanvas(600, 120);
  const r = C.drawTape(cv, mkTapeSectors(12));
  const hv = C.bindHover(cv, r);
  assert(hv, 'bindHover 应返回句柄');
  hv.simulate(r.layout.padLeft + r.layout.slotW * 1.5, 50);
  const tip = hv.getTip();
  assert(tip, 'hover 后应有 tooltip');
  assert.strictEqual(tip.parentElement, host, 'tooltip 应挂在 canvas 的 parent');
  assert.strictEqual(tip.getAttribute('role'), 'status');
  assert.strictEqual(tip.getAttribute('aria-live'), 'polite');
  assert.strictEqual(tip.style.display, 'block');
  assert(/[一-鿿]/.test(tip.textContent), 'tooltip 应是整句中文');
  assert(tip.textContent.indexOf('龙头') >= 0
      && tip.textContent.indexOf('10日资金') >= 0
      && tip.textContent.indexOf('板块') >= 0, '整句应含 龙头/10日资金/板块');
  hv.unbind();
  assert.strictEqual(hv.getTip(), null, 'unbind 应清空 tooltip');
});

/* ── index.html 的 TAPE 轮询 IIFE（真源码，vm 沙箱）── */
console.log('\n── §5-4 轮询 IIFE（index.html 真源码）──');

const MARK_T = '§5-4 实时 TAPE（轻量轮询版）──';
const _ti = HTML.indexOf(MARK_T);
const _tStart = HTML.lastIndexOf('<script>', _ti);
const _tEnd = HTML.indexOf('</script>', _ti);
const TAPE_SRC = _tStart >= 0 && _tEnd > _tStart
  ? HTML.slice(_tStart, _tEnd).replace(/^<script>/, '').trim() : '';

/* 假时钟：只记录不触发——5/30 分钟的自调度链不能真跑起来挂住进程。
 * setInterval 做成抛错的哨兵：TAPE 一旦用了 setInterval（并发重叠），测试当场失败。 */
function mkTapeSandbox(opts){
  opts = opts || {};
  const { cv, host } = makeCanvas(600, 120);
  const els = { tapeCanvas: cv, tapebox: {}, tapeTime: { textContent: '' } };

  const calls = [];
  const plans = opts.plans || [];
  function fetchImpl(url, init){
    const rec = plans.length ? plans.shift() : { resp: { ok: true } };
    const call = { url: url, id: calls.length, settled: false,
                   signal: init && init.signal };
    calls.push(call);
    return new Promise((resolve, reject) => {
      call.resolve = (payload) => {
        if (call.settled) return;
        call.settled = true;
        resolve({ json: () => Promise.resolve(payload) });
      };
      if (rec.fail){
        /* 用 setImmediate 而不是 setTimeout：Node 的 0ms 定时器有 1ms 下限，
         * 而 settle() 只排空 immediate 队列，真定时器来不及触发。 */
        setImmediate(() => { call.settled = true; reject(rec.fail); });
        return;
      }
      if (rec.manual !== true){
        setImmediate(() => call.resolve(rec.resp != null ? rec.resp : { ok: true }));
      }
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === 'function'){
        sig.addEventListener('abort', () => {
          if (!call.settled){ call.settled = true; reject(new Error('AbortError')); }
        });
      }
    });
  }

  const scheduled = [];
  let tid = 0;
  function setTimeoutImpl(fn, ms){
    scheduled.push({ id: ++tid, fn: fn, ms: ms, cleared: false });
    return tid;
  }
  function clearTimeoutImpl(id){
    const s = scheduled.find(x => x.id === id);
    if (s) s.cleared = true;
  }

  /* 固定"现在"：默认 2026-09-18 周五 10:30（交易时段）；opts.now 可覆盖。
   * 跨 realm 的 `new Date()` 必须返回 Date 实例，故用显式构造而不是 apply。 */
  const RealDate = Date;
  const NOW = opts.now
    ? new RealDate(opts.now[0], opts.now[1], opts.now[2], opts.now[3], opts.now[4])
    : new RealDate(2026, 8, 18, 10, 30);
  function FakeDate(a, b, c, d, e){
    if (!(this instanceof FakeDate)) throw new Error('FakeDate 必须用 new 调用');
    return arguments.length
      ? new RealDate(a, b, c, d, e)
      : new RealDate(NOW);
  }
  FakeDate.now = () => NOW.getTime();

  const win = { Charts: C, devicePixelRatio: 2 };
  const _ls = {};
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({
        style: {}, _attrs: {}, textContent: '', parentElement: null,
        offsetWidth: 120, offsetHeight: 24,
        setAttribute(k, v){ this._attrs[k] = v; },
        getAttribute(k){ return this._attrs[k] == null ? null : this._attrs[k]; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 120,
                                        right: 600, bottom: 120 }),
      }),
    },
    fetch: fetchImpl,
    AbortController: AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: () => { throw new Error('TAPE 不应使用 setInterval（并发重叠）'); },
    Date: FakeDate,
    localStorage: {
      getItem: (k) => _ls[k] || null,
      setItem: (k, v) => { _ls[k] = v; },
      removeItem: (k) => { delete _ls[k]; },
      clear: () => { for (const k in _ls) delete _ls[k]; },
    },
    console: console,
  };
  vm.runInNewContext(TAPE_SRC, sandbox, { filename: 'ui/index.html#tape' });
  return { sandbox: sandbox, win: win, calls: calls, scheduled: scheduled,
           time: els.tapeTime, cv: cv, host: host };
}

atest('源码可抽取并执行：#tapeCanvas/#tapeTime 都在，__tapeRefresh 挂出', async () => {
  assert(TAPE_SRC.length > 800, 'IIFE 未抽到（marker "' + MARK_T + '" 失效？）');
  assert(/getElementById\('tapeCanvas'\)/.test(TAPE_SRC), '缺 #tapeCanvas 读取');
  assert(/getElementById\('tapeTime'\)/.test(TAPE_SRC), '缺 #tapeTime 读取');
  assert(/\/api\/closescan\?topN=/.test(TAPE_SRC), '应请求 /api/closescan?topN=');
  const env = mkTapeSandbox({ plans: [{ resp: TAPE_OK }] });
  await settle();
  assert.strictEqual(typeof env.win.__tapeRefresh, 'function',
    'window.__tapeRefresh 未挂出（CDP 验证/手动刷新依赖它）');
  assert.strictEqual(env.calls.length, 1, '启动应触发一次 /api/closescan');
});

atest('启动请求 /api/closescan?topN=12，成功后标题 = "N板块 · 数据时间"', async () => {
  const env = mkTapeSandbox({ plans: [{ resp: TAPE_OK }] });
  await settle();
  assert.strictEqual(env.calls.length, 1);
  assert.strictEqual(env.calls[0].url, '/api/closescan?topN=12',
    '实得 ' + env.calls[0].url);
  assert.strictEqual(env.time.textContent, '12板块 · 15:05',
    '实得 "' + env.time.textContent + '"');
  assert(env.calls[0].signal, 'fetch 应带 AbortController signal');
});

atest('setTimeout 自调度链（非 setInterval）：交易时段 5min / 收盘后与周末 30min', async () => {
  const on = mkTapeSandbox({ plans: [{ resp: TAPE_OK }] });
  await settle();
  const onMs = on.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(onMs.indexOf(5 * 60000) >= 0, '周五 10:30 应调度 5min，实得 ' + JSON.stringify(onMs));
  /* 60s 的 abort 定时器只在请求在途时存在，结束后必须清掉，
   * 否则下一次刷新会多一个空转定时器。 */
  assert(onMs.indexOf(60000) < 0, '60s abort 定时器应在请求结束后清掉');
  assert(on.scheduled.some(s => s.ms === 60000 && s.cleared),
    'abort 超时定时器应被创建过（60s），实得 ' +
    JSON.stringify(on.scheduled.map(s => s.ms)));

  const sat = mkTapeSandbox({ plans: [{ resp: TAPE_OK }], now: [2026, 8, 19, 10, 30] });
  await settle();
  const satMs = sat.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(satMs.indexOf(30 * 60000) >= 0, '周六 10:30 应调度 30min，实得 ' + JSON.stringify(satMs));

  const after = mkTapeSandbox({ plans: [{ resp: TAPE_OK }], now: [2026, 8, 18, 16, 0] });
  await settle();
  const afterMs = after.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(afterMs.indexOf(30 * 60000) >= 0, '工作日 16:00 收盘后应调度 30min，实得 ' + JSON.stringify(afterMs));

  const before = mkTapeSandbox({ plans: [{ resp: TAPE_OK }], now: [2026, 8, 18, 8, 30] });
  await settle();
  const beforeMs = before.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(beforeMs.indexOf(30 * 60000) >= 0, '工作日 8:30 开盘前应调度 30min，实得 ' + JSON.stringify(beforeMs));
});

atest('__tapeRefresh：abort 在途请求 + 慢的旧请求回来不覆盖新图', async () => {
  const env = mkTapeSandbox({ plans: [
    { manual: true },    /* 第 1 轮：在途，等 abort */
    { manual: true },    /* 第 2 轮：在途，等 abort */
    { resp: TAPE_OK },   /* 第 3 轮：最终数据 */
  ]});
  await settle();
  assert.strictEqual(env.calls.length, 1, '启动 1 次请求');
  env.win.__tapeRefresh();   /* round 2 → abort round 1 */
  await settle();
  env.win.__tapeRefresh();   /* round 3 → abort round 2 */
  await settle();
  assert.strictEqual(env.calls.length, 3, '共 3 次请求，实得 ' + env.calls.length);
  assert.strictEqual(env.calls[0].settled, true, '第 1 轮应被 abort 作废');
  assert.strictEqual(env.calls[1].settled, true, '第 2 轮应被 abort 作废');
  assert.strictEqual(env.calls[0].signal.aborted, true, '第 1 轮 signal 应处于 aborted');
  assert.strictEqual(env.calls[1].signal.aborted, true, '第 2 轮 signal 应处于 aborted');
  assert.strictEqual(env.calls[2].signal.aborted, false, '第 3 轮不应被 abort');
  assert.strictEqual(env.time.textContent, '12板块 · 15:05',
    '慢的旧请求不应覆盖新图，实得 "' + env.time.textContent + '"');
});

atest('fetch 失败 → 标题"连接失败"，60s 后重试（不抛出未捕获 rejection）', async () => {
  const env = mkTapeSandbox({ plans: [{ fail: new Error('ECONNRESET') }] });
  await settle();
  assert.strictEqual(env.time.textContent, '连接失败',
    '实得 "' + env.time.textContent + '"');
  const ms = env.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(ms.indexOf(60000) >= 0, '应 60s 后重试，实得 ' + JSON.stringify(ms));
  assert.strictEqual(env.calls.length, 1, '失败轮不应重发');
});

atest('空数据 / ok:false → 标题"暂无数据"（不留上一轮残留），仍继续调度', async () => {
  const env = mkTapeSandbox({ plans: [{ resp: { ok: true, dataTime: '15:05', sectors: [] } }] });
  await settle();
  assert.strictEqual(env.time.textContent, '暂无数据', '实得 "' + env.time.textContent + '"');
  const ms = env.scheduled.filter(s => !s.cleared).map(s => s.ms);
  assert(ms.indexOf(5 * 60000) >= 0, '空数据仍应继续调度下一轮');

  const bad = mkTapeSandbox({ plans: [{ resp: { ok: false, error: '板块扫描失败' } }] });
  await settle();
  assert.strictEqual(bad.time.textContent, '暂无数据',
    'ok:false 应走占位，实得 "' + bad.time.textContent + '"');
});

/* ── 汇总：先排空异步队列，再打印总数（run-tests.js 靠这行自报数）──
 * 注意 process.exit 必须在异步跑完之后：同步调用会抢在首刷 Promise 前退出。 */
(async function flushAsync(){
  for (const t of _asyncQueue) {
    try {
      await withTimeout(Promise.resolve().then(t.fn), 15000, t.name);
      console.log('  PASS ' + t.name);
      pass++;
    } catch (e) {
      console.log('  FAIL ' + t.name + '\n       ' + (e && e.stack || e));
      fail++;
    }
  }
  console.log('\n── 汇总 ──');
  console.log('  通过: ' + pass + ' | 失败: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})();

