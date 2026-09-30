'use strict';
/* audiobus 纯函数测试：在最小 window stub 中加载脚本，验证 mergeReads。
 * 采用本仓库测试约定：test() 收集，底部统一执行并输出「通过: N | 失败: M」。 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

function loadAudioBus() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'audiobus.js'), 'utf8');
  const win = {};
  new Function('window', 'navigator', 'console', src)(win, {}, console);
  return win.AudioBus;
}

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const ok = (c, m) => assert.ok(c, m);
const eq = (a, b, m) => assert.strictEqual(a, b, m);
const approx = (a, b, m) => ok(Math.abs(a - b) < 1e-6, m + ` (got ${a}, want ${b})`);

test('mergeReads 存在', () => {
  const AB = loadAudioBus();
  ok(AB && typeof AB.mergeReads === 'function', 'AudioBus.mergeReads 应存在');
});

test('空输入：level=0、6频段全0（没信号=0电平）', () => {
  const AB = loadAudioBus();
  const e = AB.mergeReads([]);
  eq(e.level, 0);
  eq(e.bands.length, 6);
  for (let i = 0; i < 6; i++) eq(e.bands[i], 0);
});

test('null/undefined 安全', () => {
  const AB = loadAudioBus();
  eq(AB.mergeReads(null).level, 0);
  eq(AB.mergeReads(undefined).level, 0);
});

test('多路逐档取大：TTS level高、mic某频段高', () => {
  const AB = loadAudioBus();
  const tts = { level: 0.8, bands: new Float32Array([.8, .1, .1, .1, .1, .1]) };
  const mic = { level: 0.4, bands: new Float32Array([.1, .1, .9, .1, .1, .1]) };
  const m = AB.mergeReads([tts, mic]);
  approx(m.level, 0.8, 'level 取最大');
  approx(m.bands[0], 0.8, '频段0取大');
  approx(m.bands[2], 0.9, '频段2逐档取大');
});

test('不修改输入数组', () => {
  const AB = loadAudioBus();
  const tts = { level: 0.8, bands: new Float32Array([.8, .1, .1, .1, .1, .1]) };
  AB.mergeReads([tts, { level: 0, bands: new Float32Array(6) }]);
  approx(tts.bands[2], 0.1, '入参不应被改');
});

(async () => {
  for (const [n, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + n); pass++; }
    catch (e) { console.log('  ✗ ' + n + ' :: ' + e.message); fail++; }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
