'use strict';
/* fear_backfill + alertSamplesDaily 单测。
 * 网络/落库部分不在这里跑（那是一次性运维动作）；这里锁：
 *  - recentWeekdays 只返回工作日、含今天、按升序、数量上限
 *  - db.alertSamplesDaily 每天只取一条，且 slot 优先级 close>midday>mid_am>open>backfill */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const fb = require('./tools/fear_backfill');

test('recentWeekdays：只含周一到周五', () => {
  const days = fb.recentWeekdays(30);
  assert(days.length > 0 && days.length <= 30);
  days.forEach(ymd => {
    const d = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
    const wd = d.getDay();
    assert(wd >= 1 && wd <= 5, ymd + ' 不是工作日');
    assert(/^\d{8}$/.test(ymd), '格式应为 YYYYMMDD');
  });
});

test('recentWeekdays：升序（旧→新）', () => {
  const days = fb.recentWeekdays(20);
  const sorted = days.slice().sort();
  assert.deepStrictEqual(days, sorted);
});

test('recentWeekdays：lookback=1 在周末给空、工作日给今天', () => {
  const today = new Date();
  const wd = today.getDay();
  const days = fb.recentWeekdays(1);
  if (wd >= 1 && wd <= 5) {
    assert.strictEqual(days.length, 1);
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    assert.strictEqual(days[0], `${y}${m}${dd}`);
  } else {
    assert.strictEqual(days.length, 0);
  }
});

/* alertSamplesDaily：读真实库（只读），验证每日一条 + slot 选择优先级。
 * 不写入、不依赖具体行数；若库为空则只验证不抛错。 */
test('alertSamplesDaily：同一天多 slot 只保留最定型一条', () => {
  const db = require('./db');
  const all = db.alertSamples();
  const daily = db.alertSamplesDaily();
  // 每日至多一条
  const dates = daily.map(r => r.date);
  assert.strictEqual(new Set(dates).size, dates.length, 'daily 存在重复日期');
  // daily 行数 ≤ 全量行数
  assert(daily.length <= all.length);
  // 若某天同时有 close 与别的 slot，应选 close
  const byDate = new Map();
  for (const r of all) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r.slot); }
  const RANK = { close: 5, midday: 4, mid_am: 3, open: 2, backfill: 1 };
  for (const r of daily) {
    const slots = byDate.get(r.date) || [];
    const bestRank = Math.max(...slots.map(s => RANK[s] ?? 0));
    assert.strictEqual(RANK[r.slot] ?? 0, bestRank, `${r.date} 应取最定型 slot，实际 ${r.slot}`);
  }
  // 升序
  for (let i = 1; i < daily.length; i++) assert(daily[i - 1].date <= daily[i].date);
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
