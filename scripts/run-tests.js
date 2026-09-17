'use strict';
/* 测试总跑器：一条命令跑完全部套件，汇总真实通过数。
 *
 * 设计要点：
 * 1. 每套独立子进程 —— 一套崩溃（比如原生模块加载失败）不影响其余继续跑。
 * 2. 崩溃与失败要分开报 —— 「ERR_DLOPEN_FAILED 导致进程死」和
 *    「断言不成立」是两类问题，混在一起会误导排查方向。
 * 3. 先跑环境自检 —— 地基不对就没必要跑测试，直接给出修法。
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// 注册表须覆盖 src/ 下全部 *.test.js —— 漏登记的套件不会被 npm test 跑到，
// 失败就被藏起来（2026-09-16 发现 15 个套件未登记，其中 2 个在失败，
// 而 npm test 仍打印「全部通过」。断言见 jarvis-clock / jarvis-sectorwatch）。
const SUITES = [
  ['动画闸门 animgate',   'src/jarvis-animgate.test.js'],
  ['markdown',            'src/jarvis-markdown.test.js'],
  ['时钟 clock',          'src/jarvis-clock.test.js'],
  ['意识 mind',           'src/jarvis-mind.test.js'],
  ['工具 tools',          'src/jarvis-tools.test.js'],
  ['巡视 patrol',         'src/jarvis-patrol.test.js'],
  ['星图 starmap',        'src/jarvis-starmap.test.js'],
  ['星图增强 starmap-plus', 'src/jarvis-starmap-plus.test.js'],
  ['图表 charts',          'src/jarvis-charts.test.js'],
  ['着色 shader',         'src/jarvis-shader.test.js'],
  ['告警 alerts',         'src/jarvis-alerts.test.js'],
  ['市场阶段 phase',      'src/jarvis-market-phase.test.js'],
  ['板块趋势 sectortrend','src/jarvis-sectortrend.test.js'],
  ['板块盯盘 sectorwatch','src/jarvis-sectorwatch.test.js'],
  ['冰点 capitulation',   'src/jarvis-capitulation.test.js'],
  ['恐惧回填 fearbk',     'src/jarvis-fear-backfill.test.js'],
  ['fuyao',               'src/jarvis-fuyao.test.js'],
  ['缠论 chan',           'src/jarvis-chan.test.js'],
  ['minkline',            'src/jarvis-minkline.test.js'],
  ['标的池 universe',     'src/jarvis-universe.test.js'],
  ['体检 checkup',        'src/jarvis-checkup.test.js'],
  ['教训 lessons',        'src/jarvis-lessons.test.js'],
  ['选股买点 stockpick',  'src/jarvis-stockpick.test.js'],
  ['上游 jiwen',          'src/jiwen.test.js'],
  ['LLM llm',             'src/llm.test.js'],
  ['语音 voice',          'src/voice.test.js'],
  ['TTS边缘 edge',        'src/tts_edge.test.js'],
];

/* 防注册表漂移：未登记的 src/*.test.js 其失败不会被 npm test 发现。
 * 2026-09-16 实证：15 个套件漏登记（含 2 个正在失败），npm test 仍打印「全部通过」。
 * 直接 process.exit(1) 而非告警 —— 漏登记不算通过。 */
const toPosix = (s) => s.split(path.sep).join('/');
const registered = new Set(SUITES.map(([, f]) => toPosix(f)));
const onDisk = fs.readdirSync(path.join(ROOT, 'src'))
  .filter((f) => /\.test\.js$/.test(f))
  .map((f) => toPosix(path.join('src', f)));
const missing = onDisk.filter((f) => !registered.has(f));
if (missing.length) {
  console.log('\x1b[31m✗\x1b[0m 以下测试文件未登记进 run-tests.js，其失败不会被发现：');
  missing.forEach((f) => console.log(`    ${f}`));
  console.log('请把上面每一项加进 SUITES 后重跑。\n');
  process.exit(1);
}

/* ── 先验环境。地基不对，测试结果没有意义 ── */
const envCheck = spawnSync(process.execPath, [path.join(__dirname, 'check-env.js')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (envCheck.status !== 0) {
  console.log('环境自检未通过，已终止测试。修好上面标红的项目再跑。\n');
  process.exit(1);
}

console.log('─────────── 测试套件 ───────────\n');

let totalPass = 0;
let totalFail = 0;
const crashed = [];

for (const [label, file] of SUITES) {
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
  });
  const out = (r.stdout || '') + (r.stderr || '');

  /* 测试文件自己输出「通过: N | 失败: M」，直接取它的自报数 */
  const m = /通过:\s*(\d+)\s*\|\s*失败:\s*(\d+)/.exec(out);

  if (m) {
    const pass = Number(m[1]);
    const fail = Number(m[2]);
    totalPass += pass;
    totalFail += fail;
    const mark = fail === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(
      `  ${mark} ${label.padEnd(16)} 通过 ${String(pass).padStart(3)}` +
      (fail ? `  \x1b[31m失败 ${fail}\x1b[0m` : '')
    );
    if (fail > 0) {
      out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 8)
        .forEach((l) => console.log(`        ${l.trim()}`));
    }
  } else {
    /* 没有汇总行 = 进程没跑到最后就死了，这是崩溃不是失败 */
    crashed.push(label);
    const first = out.split('\n').find((l) => /Error|error:/.test(l)) || '无输出';
    console.log(`  \x1b[31m☠\x1b[0m ${label.padEnd(16)} 进程崩溃`);
    console.log(`        ${first.trim().slice(0, 100)}`);
  }
}

console.log('\n─────────────────────────────────');
const bad = totalFail > 0 || crashed.length > 0;
console.log(
  `  合计通过 \x1b[32m${totalPass}\x1b[0m` +
  (totalFail ? ` · 失败 \x1b[31m${totalFail}\x1b[0m` : '') +
  (crashed.length ? ` · 崩溃 \x1b[31m${crashed.length}\x1b[0m（${crashed.join(', ')}）` : '')
);
console.log('─────────────────────────────────\n');

if (crashed.length > 0) {
  console.log('提示：进程崩溃多为环境问题（Node ABI 不匹配），不是断言失败。');
  console.log('      先跑 npm run check-env 定位。\n');
}

process.exit(bad ? 1 : 0);
