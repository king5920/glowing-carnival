'use strict';
/* 环境自检：在跑测试或启服务之前，先确认脚下的地基是对的。
 *
 * 存在理由：better_sqlite3.node 是编译产物，与 Node 的 ABI（process.versions.modules）
 * 死绑。用错版本的 Node 时，报错是 ERR_DLOPEN_FAILED —— 它长得像代码 bug，
 * 实际是环境问题。曾因此误判过 8 个「测试失败」。
 *
 * 本脚本的原则：不猜、不静默。每项都实测，失败时直接给出可执行的修法。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OK = '  \x1b[32m✓\x1b[0m';
const BAD = '  \x1b[31m✗\x1b[0m';
const WARN = '  \x1b[33m!\x1b[0m';

let fatal = 0;
let warned = 0;

function ok(msg) { console.log(`${OK} ${msg}`); }
function bad(msg, fix) {
  console.log(`${BAD} ${msg}`);
  if (fix) console.log(`      修法：${fix}`);
  fatal++;
}
function warn(msg, hint) {
  console.log(`${WARN} ${msg}`);
  if (hint) console.log(`      说明：${hint}`);
  warned++;
}

console.log('\n─────────── 贾维斯环境自检 ───────────\n');

/* ABI（NODE_MODULE_VERSION）→ Node 主版本对照。
 * 报错里只给 ABI 数字，人看不出该装哪个 Node，所以在这里翻译一下。 */
const ABI_MAP = { 108: '18.x', 115: '20.x', 127: '22.x', 131: '23.x', 137: '24.x', 141: '25.x' };
function abiToNode(a) { return ABI_MAP[a] || `未知（ABI ${a}）`; }

/* ── 1. Node 版本与 ABI ────────────────────────────── */
const nodeVer = process.version;
const abi = process.versions.modules;
const major = Number(process.versions.node.split('.')[0]);

if (major >= 25) {
  ok(`Node ${nodeVer}（ABI ${abi}）`);
} else {
  bad(
    `Node ${nodeVer}（ABI ${abi}）—— 本项目的原生模块需要 ABI 141 / Node ≥ 25`,
    '改用系统 Node：C:\\Program Files\\nodejs\\node.exe\n' +
    '            或就地重编：npm run rebuild'
  );
}

/* ── 2. 原生模块能否真的加载（唯一可信的判据是实际 require）── */
try {
  const Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.exec('CREATE TABLE t(x)');
  probe.close();
  ok('better-sqlite3 加载并可建表');
} catch (e) {
  /* 注意：错误信息是多行的，NODE_MODULE_VERSION 两处被换行分开，
   * 正则必须让 . 跨行匹配，否则会退化成无用的泛泛提示。 */
  const flat = e.message.replace(/\s+/g, ' ');
  const m = /compiled against a different Node\.js version using NODE_MODULE_VERSION (\d+)\. This version of Node\.js requires NODE_MODULE_VERSION (\d+)/.exec(flat);
  if (m) {
    bad(
      `better-sqlite3 编译于 ABI ${m[1]}，当前 Node 要 ABI ${m[2]}`,
      `换回编译时用的 Node（ABI ${m[1]} → Node ${abiToNode(m[1])}），或 npm run rebuild 就地重编`
    );
  } else {
    bad(`better-sqlite3 加载失败：${e.message.split('\n')[0]}`, 'npm install');
  }
}

/* ── 3. 依赖洁癖：生产依赖必须只有一个 ────────────── */
const pkg = require(path.join(ROOT, 'package.json'));
const deps = Object.keys(pkg.dependencies || {});
if (deps.length === 1 && deps[0] === 'better-sqlite3') {
  ok('生产依赖仅 better-sqlite3（硬约束守住）');
} else {
  bad(
    `生产依赖变成 ${deps.length} 个：${deps.join(', ')}`,
    '本项目硬约束是只允许 better-sqlite3。新增依赖前请先确认无法用 Node 原生能力替代'
  );
}

/* ── 4. 配置文件 ──────────────────────────────────── */
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, 'utf8');
  const need = ['ARK_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL'];
  const missing = need.filter((k) => !new RegExp(`^${k}\\s*=\\s*\\S`, 'm').test(env));
  if (missing.length === 0) {
    ok('.env 三项齐全（ARK_API_KEY / BASE_URL / MODEL）');
    if (!/\/api\/plan\/v3/.test(env)) {
      warn(
        '.env 的 ARK_BASE_URL 不含 /api/plan/v3',
        'Agent Plan 个人版必须走 /api/plan/v3 端点，普通 /api/v3 会 401'
      );
    }
  } else {
    bad(`.env 缺少：${missing.join(', ')}`, '对照 .env.example 补齐');
  }
} else {
  bad('.env 不存在', 'cp .env.example .env 后填入真实密钥');
}

const feishuPath = path.join(ROOT, '.feishu.json');
if (fs.existsSync(feishuPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(feishuPath, 'utf8'));
    if (cfg.appId && cfg.appSecret && cfg.ownerOpenId) {
      ok('.feishu.json 三项齐全');
    } else {
      warn('.feishu.json 字段不全', '飞书入口将不可用，网页端仍可正常使用');
    }
  } catch {
    warn('.feishu.json 不是合法 JSON', '飞书入口将不可用');
  }
} else {
  warn('.feishu.json 不存在', '飞书入口将不可用；只用网页端可忽略');
}

/* ── 5. 运行时目录 ────────────────────────────────── */
for (const d of ['data', 'sandbox']) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) {
    ok(`${d}/ 存在`);
  } else {
    fs.mkdirSync(p, { recursive: true });
    ok(`${d}/ 不存在，已创建`);
  }
}

/* ── 6. 密钥没有被 git 追踪（每次都验，别指望记性）──── */
try {
  const { execFileSync } = require('child_process');
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  const leaked = ['.env', '.feishu.json', 'data/jarvis.db']
    .filter((f) => tracked.split('\n').includes(f));
  if (leaked.length === 0) {
    ok('git 未追踪任何密钥/隐私文件');
  } else {
    bad(
      `以下敏感文件已被 git 追踪：${leaked.join(', ')}`,
      `git rm --cached ${leaked.join(' ')} 并确认 .gitignore 生效`
    );
  }
} catch {
  warn('无法执行 git ls-files', '仓库未初始化或 git 不在 PATH');
}

/* ── 汇总 ─────────────────────────────────────────── */
console.log('\n─────────────────────────────────────');
if (fatal > 0) {
  console.log(`  \x1b[31m${fatal} 项致命\x1b[0m` + (warned ? ` · ${warned} 项警告` : ''));
  console.log('─────────────────────────────────────\n');
  process.exit(1);
}
console.log(
  warned
    ? `  \x1b[32m环境可用\x1b[0m · ${warned} 项警告（不影响核心链路）`
    : '  \x1b[32m全部通过\x1b[0m'
);
console.log('─────────────────────────────────────\n');
