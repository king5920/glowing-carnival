'use strict';
/* market_phase.js 装配层单测：注入假 getBars/snapshot/alertSamples，零网络，
 * 验证 缠论阶段 × 崩溃冰点 的合成、缺数据 unknown、措辞红线、级别汇总。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const mp = require('./tools/market_phase');

/* 用中心价造日K（复用 chan 测试思路）：先跌后涨，制造结构 */
function swingBars(centers, half = 1.0) {
  return centers.map((c, i) => ({
    date: '2026-01-' + String(i + 1).padStart(2, '0'),
    open: c, close: c + (i % 2 ? half : -half),
    high: c + half, low: c - half, volume: 1000,
  }));
}
const centers = [];
for (let i = 1; i <= 6; i++) centers.push(100 - i * 4);
for (let i = 1; i <= 6; i++) centers.push(76 + i * 4);
for (let i = 1; i <= 3; i++) centers.push(100 - i * 4);
const BARS = swingBars(centers, 1.2);

/* 平静情绪快照（无冰点） */
function calmDeps(over = {}) {
  return {
    getBars: () => Promise.resolve(BARS),
    snapshot: () => Promise.resolve({
      sentiment: {
        limitUpCount: 30, limitDownCount: 3, brokenRate: 15,
        ladderHeight: 4, ladder: { 1: 15, 2: 4, 4: 1 },
      },
      indexes: { '上证': { close: 90, rsi14: 50, aboveMa20: true, macdCross: null, error: false } },
    }),
    alertSamples: () => [],   // 无历史 → 崩溃 unknown
    ...over,
  };
}

test('assess：合成对象含 phase/chan/fear/summary，字段齐全', async () => {
  const r = await mp.assess(calmDeps());
  assert(['退潮期', '磨底期', '筑底期', '启动期', '主升期', '高位震荡期'].includes(r.phase), 'phase 合法: ' + r.phase);
  assert(r.chan && r.chan.levels && r.chan.levels.day, '有 chan.levels.day');
  assert(r.fear && typeof r.fear.tier === 'string', '有 fear.tier');
  assert(typeof r.summary === 'string' && r.summary.includes(r.phase));
});

test('assess：无历史样本时 fear.tier=unknown（诚实，不编造）', async () => {
  const r = await mp.assess(calmDeps());
  assert.strictEqual(r.fear.tier, 'unknown');
});

test('assess：日线级别汇总带 笔/中枢/买卖点/背驰计数', async () => {
  const r = await mp.assess(calmDeps());
  const d = r.chan.levels.day;
  assert(typeof d.strokeCount === 'number');
  assert(typeof d.segZoneCount === 'number');
  assert(typeof d.pointCount === 'number');
  assert(typeof d.divergenceCount === 'number');
});

test('assess：withMinute=true 时补 m60/m30 级别，失败级别置 null 不崩', async () => {
  const deps = calmDeps({
    getBars: (period) => {
      if (period === 'm60') return Promise.reject(new Error('源挂了'));
      if (period === 'm30') return Promise.resolve(BARS);
      return Promise.resolve(BARS);
    },
  });
  const r = await mp.assess(deps, { withMinute: true });
  assert(r.chan.levels.day, '日线必有');
  assert.strictEqual(r.chan.levels.m60, null, 'm60 失败安全置 null');
  assert(r.chan.levels.m30, 'm30 成功应有');
});

test('assess：日K取数失败 → phase=unknown 且 errors 记录', async () => {
  const deps = calmDeps({ getBars: () => Promise.reject(new Error('日K失败')) });
  const r = await mp.assess(deps);
  assert.strictEqual(r.phase, 'unknown');
  assert(Array.isArray(r.errors) && r.errors.length >= 1);
  assert(/无法判断/.test(r.summary));
});

test('assess：情绪快照失败不致命，phase 仍给、fear 安全降级', async () => {
  const deps = calmDeps({ snapshot: () => Promise.reject(new Error('情绪挂了')) });
  const r = await mp.assess(deps);
  assert(r.phase !== 'unknown' || r.errors.length, '要么有阶段要么有错误');
  assert(r.fear, 'fear 对象始终存在');
});

/* 极端恐慌注入：三料全中 + 历史分位极高 + RSI≤30 */
test('assess：极端恐慌快照 → fear.tier=extreme/side=left', async () => {
  const hist = Array.from({ length: 20 }, (_, i) => ({ limit_down: i % 7, broken_rate: 5 + (i % 15), ladder_height: 3 }));
  const deps = {
    getBars: () => Promise.resolve(BARS),
    alertSamples: () => hist,
    snapshot: () => Promise.resolve({
      sentiment: { limitDownCount: 500, brokenRate: 90, ladderHeight: 1, ladder: { 1: 3 } },
      indexes: { '上证': { close: 80, rsi14: 22, aboveMa20: false, macdCross: 'dead', error: false } },
    }),
  };
  const r = await mp.assess(deps);
  assert.strictEqual(r.fear.tier, 'extreme');
  assert.strictEqual(r.fear.side, 'left');
  assert(/给不出入场时机/.test(r.summary));
  assert(!/冰点|值得关注|共振|可以买/.test(r.summary));
  assert(r.sentimentTape && r.sentimentTape.rows.length === 2);
});

test('assess：带标定总账，且不把选股算进策略', async () => {
  const r = await mp.assess(calmDeps());
  assert(r.ledger && Array.isArray(r.ledger.items) && r.ledger.items.length >= 6);
  assert.ok(r.ledger.items.every(it => it.id !== 'stock_pool' && it.id !== 'stock_signal'));
  assert(/尚无选股策略/.test(JSON.stringify(r.ledger.excluded)));
  assert.strictEqual(r.ledger.items.find(it => it.id === 'display_score').label, '未标定');
  assert.strictEqual(r.ledger.items.find(it => it.id === 'chan').label, '未标定');
});

test('措辞红线：summary/label 绝不出现"可以买"，且未标定时保留观察字样', async () => {
  const r = await mp.assess(calmDeps());
  const blob = JSON.stringify(r);
  assert(!/可以买/.test(blob), '出现"可以买": ' + r.summary);
  assert(/未标定|观察|unknown|无法判断/i.test(blob), '未标定/观察字样应保留');
});

test('summarizeLevel：空入参给 null', () => {
  assert.strictEqual(mp.summarizeLevel(null), null);
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
