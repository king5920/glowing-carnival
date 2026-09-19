'use strict';
/* cs_warm.js 纯决策单测：零网络、零服务，喂任意"交易时段 × 缓存年龄"组合，
 * 锁定收盘扫描预热规则：
 *   仅上午盘/下午盘预热；该时段内无缓存→预热、缓存将冷→预热、缓存新鲜→跳过；
 *   非竞价时段（盘前/集合竞价/午休/收盘后/休市日）一律不预热；非法时间戳不预热。 */

const assert = require('assert');
let pass = 0, fail = 0;
const _t = [];
function test(name, fn) { _t.push({ name, fn }); }

const {
  WARMABLE_SESSIONS,
  isWarmableSession,
  shouldWarmCloseScan,
} = require('./tools/cs_warm');

const NOW = 1_000_000_000_000;            // 固定基准时间，避免依赖真实时钟
const MAX_AGE = 75_000;
const dec = (over) => shouldWarmCloseScan(Object.assign(
  { session: '上午盘', slotAt: NOW - 1000, now: NOW, maxAgeMs: MAX_AGE }, over));

/* ── 时段闸门：只有连续竞价两段可预热 ── */
test('isWarmableSession：仅上午盘/下午盘为真', () => {
  assert.strictEqual(isWarmableSession('上午盘'), true);
  assert.strictEqual(isWarmableSession('下午盘'), true);
  ['盘前', '集合竞价', '午间休市', '收盘竞价刚结束', '收盘后', '休市日', '', null, undefined]
    .forEach(s => assert.strictEqual(isWarmableSession(s), false, '不应预热: ' + s));
  assert.deepStrictEqual(WARMABLE_SESSIONS, ['上午盘', '下午盘']);
});

test('非竞价时段一律 non-session，即使缓存已很冷也不扫（节假日零外部请求）', () => {
  ['盘前', '集合竞价', '午间休市', '收盘竞价刚结束', '收盘后', '休市日'].forEach(s => {
    const r = dec({ session: s, slotAt: NOW - 999_999_999 });
    assert.strictEqual(r.warm, false, s + ' 不应预热');
    assert.strictEqual(r.reason, 'non-session');
  });
});

/* ── 竞价时段内：缓存状态三态 ── */
test('竞价时段 + 无缓存 → warm/no-cache（首个访客前主动建热缓存）', () => {
  const r = dec({ slotAt: null });
  assert.strictEqual(r.warm, true);
  assert.strictEqual(r.reason, 'no-cache');
});

test('竞价时段 + 缓存年龄超过阈值 → warm/stale', () => {
  const r = dec({ slotAt: NOW - (MAX_AGE + 1) });
  assert.strictEqual(r.warm, true);
  assert.strictEqual(r.reason, 'stale');
});

test('竞价时段 + 缓存恰在阈值边界（> 才续，等于不续）', () => {
  // 规则用严格大于：年龄 == maxAgeMs 仍算新鲜，避免边界抖动重复扫
  const atEdge = dec({ slotAt: NOW - MAX_AGE });
  assert.strictEqual(atEdge.warm, false);
  assert.strictEqual(atEdge.reason, 'fresh');
  const overEdge = dec({ slotAt: NOW - (MAX_AGE + 1) });
  assert.strictEqual(overEdge.warm, true);
});

test('竞价时段 + 缓存新鲜 → 不预热/fresh（真实用户请求顺带续期后省外部调用）', () => {
  const r = dec({ slotAt: NOW - 1000 });
  assert.strictEqual(r.warm, false);
  assert.strictEqual(r.reason, 'fresh');
});

/* ── 健壮性：非法输入不能触发外部扫描 ── */
test('非法 slotAt / maxAgeMs → invalid-age，不预热', () => {
  assert.strictEqual(dec({ slotAt: 'not-a-number' }).reason, 'invalid-age');
  assert.strictEqual(dec({ slotAt: NaN }).reason, 'invalid-age');
  assert.strictEqual(dec({ maxAgeMs: -1, slotAt: NOW - 1000 }).reason, 'invalid-age');
});

test('空参数不抛错（默认 now、缺省阈值）', () => {
  const r = shouldWarmCloseScan({ session: '上午盘', slotAt: null });
  assert.strictEqual(r.warm, true);
  assert.strictEqual(r.reason, 'no-cache');
  const r2 = shouldWarmCloseScan({ session: '休市日' });
  assert.strictEqual(r2.warm, false);
  assert.strictEqual(r2.reason, 'non-session');
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
