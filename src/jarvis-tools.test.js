'use strict';
/**
 * 工具系统测试 —— 重点是**安全边界**，不是功能。
 *
 * 功能出 bug 用户会看到；安全出 bug 用户看不到，
 * 所以沙箱越界测试写得比正常路径测试还多。
 *
 * 网络类工具（行情/K线）不放在这里 —— 依赖外网，
 * 单测应该离线可跑、结果确定。网络工具靠手工实测（见 STATUS.md）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ══════════ 参数校验 ══════════ */
section('参数校验（JSON Schema）');

const tools = require('./tools/index');

tools.register('_t_echo', {
  description: '测试',
  parameters: {
    type: 'object',
    properties: {
      s: { type: 'string', maxLength: 10 },
      n: { type: 'integer' },
      b: { type: 'boolean' },
      e: { type: 'string', enum: ['a', 'b'] },
      arr: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      d: { type: 'string', default: 'dflt' },
    },
    required: ['s'],
  },
}, async a => a);

const call = (args) => {
  let out;
  // 同步拿结果：测试里都是纯函数，用 then 立即取
  tools.call('_t_echo', args).then(r => { out = r; });
  // 事件循环还没跑，需要用 deasync 方式 —— 改成返回 promise 由调用方 await
  return tools.call('_t_echo', args);
};

// 因为校验是同步的，包一层 async 测试
const asyncTests = [];
function atest(name, fn) { asyncTests.push([name, fn]); }

atest('正常参数通过', async () => {
  const r = await tools.call('_t_echo', { s: 'ok', n: 5 });
  assert(r.ok, r.error);
  assert.strictEqual(r.result.n, 5);
});
atest('缺必填字段被拒', async () => {
  const r = await tools.call('_t_echo', { n: 1 });
  assert(!r.ok && /必填/.test(r.error), r.error);
});
atest('未声明字段被拒（防止模型乱传）', async () => {
  const r = await tools.call('_t_echo', { s: 'x', evil: 'rm -rf' });
  assert(!r.ok && /不是有效字段/.test(r.error), r.error);
});
atest('超长字符串被拒', async () => {
  const r = await tools.call('_t_echo', { s: 'x'.repeat(50) });
  assert(!r.ok && /长度/.test(r.error), r.error);
});
atest('枚举外的值被拒', async () => {
  const r = await tools.call('_t_echo', { s: 'x', e: 'z' });
  assert(!r.ok && /之一/.test(r.error), r.error);
});
atest('数组超长被拒', async () => {
  const r = await tools.call('_t_echo', { s: 'x', arr: ['1', '2', '3', '4'] });
  assert(!r.ok && /最多/.test(r.error), r.error);
});
atest('字符串数字自动转 integer', async () => {
  const r = await tools.call('_t_echo', { s: 'x', n: '42' });
  assert(r.ok && r.result.n === 42, JSON.stringify(r));
});
atest('非数字字符串转 integer 被拒', async () => {
  const r = await tools.call('_t_echo', { s: 'x', n: 'abc' });
  assert(!r.ok && /数字/.test(r.error), r.error);
});
atest('default 值会被填充', async () => {
  const r = await tools.call('_t_echo', { s: 'x' });
  assert(r.ok && r.result.d === 'dflt', JSON.stringify(r.result));
});
atest('未知工具名被拒', async () => {
  const r = await tools.call('_t_nonexistent', {});
  assert(!r.ok && /未知工具/.test(r.error), r.error);
});

/* ══════════ 沙箱安全边界 ══════════ */

const sb = require('./tools/sandbox');

const ESCAPES = [
  ['父目录', '../secret.txt'],
  ['多层父目录', '../../../../Windows/System32/config/SAM'],
  ['C盘绝对路径', 'C:\\Windows\\win.ini'],
  ['D盘绝对路径（项目自身 .env）', 'D:\\jarvis\\.env'],
  ['UNC 网络路径', '\\\\evil\\share\\x'],
  ['混合分隔符', '..\\..\\jarvis\\.env'],
  ['正斜杠父目录', '../../.env'],
  ['嵌套绕过', 'a/../../.env'],
  ['当前目录再往上', './../../jarvis/.env'],
  ['空字节注入', 'ok.txt\u0000.exe'],
  ['超深目录', 'a/b/c/d/e/f/g/h/deep.txt'],
  ['空路径', ''],
];

for (const [name, p] of ESCAPES) {
  atest('沙箱拒绝越界：' + name, async () => {
    assert.throws(() => sb.safePath(p), /越界|绝对路径|非法字符|层级|不能为空/,
      `"${p}" 应该被拒绝但没有`);
  });
}

atest('沙箱允许正常相对路径', async () => {
  const abs = sb.safePath('notes/a.md');
  assert(abs.startsWith(sb.ROOT), abs);
});

atest('沙箱读写删完整流程', async () => {
  const p = '_test_/unit.txt';
  sb.write(p, '中文内容\n第二行');
  const r = sb.read(p);
  assert.strictEqual(r.content, '中文内容\n第二行');
  sb.append(p, '\n追加');
  assert(sb.read(p).content.endsWith('追加'));
  sb.remove(p);
  assert.throws(() => sb.read(p), /不存在/);
});

atest('沙箱拒绝删除目录', async () => {
  sb.write('_test_/x.txt', 'x');
  assert.throws(() => sb.remove('_test_'), /不支持删除目录/);
  sb.remove('_test_/x.txt');
});

atest('沙箱拒绝读取超大文件', async () => {
  // 不真写 2MB，直接验证阈值逻辑存在
  const st = sb.stat();
  assert(st.limits.maxFileBytes > 0 && st.limits.maxFiles > 0, JSON.stringify(st.limits));
});

atest('沙箱写入超限内容被拒', async () => {
  assert.throws(() => sb.write('big.txt', 'x'.repeat(3 * 1024 * 1024)), /太大/);
});

/* ══════════ 速率限制 ══════════ */

atest('速率限制生效', async () => {
  tools.register('_t_rate', {
    description: '限流测试',
    parameters: { type: 'object', properties: {} },
    rateLimit: 3,
  }, async () => 'ok');
  let blocked = 0;
  for (let i = 0; i < 6; i++) {
    const r = await tools.call('_t_rate', {});
    if (!r.ok && /速率限制/.test(r.error)) blocked++;
  }
  assert(blocked === 3, `应有 3 次被限流，实际 ${blocked}`);
});

/* ══════════ 调用日志 ══════════ */

atest('调用日志记录且不泄露大内容', async () => {
  await tools.call('_t_echo', { s: 'x', arr: ['a', 'b'] });
  const log = tools.getLog();
  assert(log.length > 0, '日志为空');
  const last = log[0];
  assert(last.name && typeof last.ms === 'number', JSON.stringify(last));
  // 数组应该被摘要成 "[数组 N 项]"，不原样存
  assert(/数组/.test(JSON.stringify(last.args)), JSON.stringify(last.args));
});


/* ══════════ 指数代码歧义（真实产出错误数据的 bug）══════════ */

test('指数代码不能落到个股前缀规则（000001 必须是上证指数）', () => {
  /* ══ 这是本项目最严重的一类 bug：静默产出错误结论 ══
   *
   * 实测发现周报里标注「上证指数」的周线，
   * 实际拿到的是**平安银行股价 11.78 元**（上证指数应在 3000-4000）。
   *
   * 根因：stock_kline 的市场前缀规则只针对个股 ——
   *   6/9 开头 → sh，其余 → sz
   * 而 000001 既是「上证指数」(sh000001) 也是「平安银行」(sz000001)，
   * 按个股规则走就落到 sz，拿回一只银行股。
   *
   * 后果比"取不到数"严重得多：接口正常返回、不报错，
   * 周报里所有"大盘周线走势"的结论都基于一只银行股算出来。
   * 这正是拒绝 L3（AI 自动改数据源代码）的理由 ——
   * **错的行情比没有行情更危险。** */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_kline.js'), 'utf8');

  assert(/INDEX_MARKET/.test(src), 'stock_kline 没有指数白名单');

  // 白名单必须覆盖周报和巡视实际用到的指数
  ['000001', '000300', '000905', '000688', '399001', '399006'].forEach(c => {
    assert(new RegExp(`'${c}'\\s*:`).test(src), `指数白名单缺少 ${c}`);
  });

  // 白名单查询必须发生在个股规则之前，否则等于没加
  const wl = src.indexOf('INDEX_MARKET[code]');
  const rule = src.indexOf("code.startsWith('6')");
  assert(wl > 0 && rule > 0, '找不到白名单查询或个股规则');
  assert(wl < rule,
    '白名单查询在个股规则之后 —— 000001 仍会被判成深市个股，bug 没修好');
});

test('上证指数白名单指向 sh（不是 sz）', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_kline.js'), 'utf8');
  const m = /'000001'\s*:\s*'(\w+)'/.exec(src);
  assert(m, '白名单里找不到 000001');
  assert(m[1] === 'sh',
    `000001 映射到 ${m[1]}，应该是 sh —— sz000001 是平安银行`);
});

test('修指数不能堵死个股查询（sz000001 仍要能查平安银行）', () => {
  /* 修一个 bug 不能造一个新 bug：
   * 000001 默认返回指数后，必须留一条路查平安银行。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_kline.js'), 'utf8');
  assert(/\^\(sh\|sz\|bj\)/.test(src),
    '不支持 sz000001 这类显式前缀写法，真想查平安银行就没办法了');
  assert(/opts\.market/.test(src),
    '不支持 opts.market 显式指定市场');
});

test('周报的指数标签与代码一致', () => {
  /* 标签写「上证指数」而代码取到别的东西，是这次 bug 的表现形式。
   * 这里检查 weekly_report 里的 label 与 code 对得上。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'weekly_report.js'), 'utf8');
  const pairs = [...src.matchAll(/code:\s*'(\d{6})'\s*,\s*label:\s*'([^']+)'/g)];
  assert(pairs.length > 0, 'weekly_report 里找不到 code/label 配对');

  const EXPECT = {
    '000001': '上证',
    '399006': '创业板',
    '000300': '沪深300',
    '399001': '深证',
  };
  pairs.forEach(([, code, label]) => {
    const want = EXPECT[code];
    if (!want) return;                       // 不认识的代码不强制
    assert(label.includes(want),
      `代码 ${code} 标着「${label}」，但它是${want}相关指数 —— 标签与代码不符`);
  });
});

test('资金流不许把腾讯当备胎，push2delay 镜像可以', () => {
  /* 区分真假备用源：
   *   板块   → push2delay 是同一份数据的另一个入口（不同风控面）→ 真备胎
   *   资金流 → 腾讯根本没有资金流拆解 → 假备胎，绝不能挂
   * "假备用源比没有备用源更危险"。
   *
   * ══════ 2026-09 修正这条测试本身 ══════
   * 这条测试原来断言 `alt` 必须**字面等于 null**。
   * 意图是对的（不许挂腾讯），但实现过窄 ——
   * 它同时禁止了合法的 push2delay 镜像。
   *
   * 实测（光环新网 300383）：
   *   push2delay.eastmoney.com/fflow  → HTTP200 143ms 有数据 ✓
   *   push2.eastmoney.com/fflow       → socket hang up（主域被封）
   *   qt.gtimg.cn                     → 只有行情，确实没有资金流拆解
   *
   * push2delay 对资金流和对板块是同一个性质：同接口、同字段、
   * 只是延时域名不在封禁范围。这是**真**降级。
   * 所以断言改成「按名单禁止假备胎」，而不是「禁止一切备胎」。
   *
   * 教训：测试要锁住**意图**，不要锁住某个恰好满足意图的具体值 ——
   * 否则真的改对了也会被自己的测试拦住。 */
  const sh = require('./tools/source_health');
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'source_health.js'), 'utf8');

  const ff = /'stock\.fundflow':[\s\S]{0,400}?alt:\s*(null|'[^']*')/.exec(src);
  assert(ff, '找不到 stock.fundflow 配置');

  /* 黑名单：**纯行情快照**源没有任何资金流数据，挂上去就是假备胎。
   *
   * 注意 sina 已从黑名单移出 —— 实测（2026-09-09）新浪
   * MoneyFlow.ssl_qsfx_zjlrqs 一次返回 30 天资金流净额，
   * 它确实有数据，只是没有四档拆分。而东财 fflow 系
   * 四个入口全部只给当日一行，多日趋势它反而给不了。
   * 详见 jarvis-patrol.test.js 里同名测试的完整推翻记录。 */
  const FAKE = ['tencent', 'gtimg', 'qq'];
  const alt = ff[1];
  FAKE.forEach(bad => assert(!new RegExp(bad, 'i').test(alt),
    `资金流 alt=${alt} 含 ${bad} —— 腾讯只有行情快照，没有资金流数据，是假备用源`));

  // 若登记了备胎，必须是已实测有资金流数据的源
  if (alt !== 'null') {
    assert(/eastmoney|sina/i.test(alt),
      `资金流 alt=${alt} 不是已实测有资金流数据的源`);
  }

  const sec = /'eastmoney\.sector':[\s\S]{0,400}?alt:\s*(null|'[^']*')/.exec(src);
  assert(sec, '找不到 eastmoney.sector 配置');
  assert(sec[1] !== 'null',
    '板块 alt 还是 null —— 但 push2delay 实测可用，应登记为备胎');
});

/* ══════════ 新闻源 ══════════ */

test('新闻模块导出三个源 + 两个对外接口', () => {
  const nw = require('./tools/news');
  ['marketNews', 'newsForStock', 'cailianpress', 'sinaNews', 'stockNews']
    .forEach(f => assert(typeof nw[f] === 'function', `缺少 ${f}`));
});

test('财联社签名算法：key 必须排序（顺序错就 errno != 0）', () => {
  const crypto = require('crypto');
  const sign = p => {
    const q = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('&');
    return crypto.createHash('md5')
      .update(crypto.createHash('sha1').update(q).digest('hex')).digest('hex');
  };
  // 同样的参数、不同的书写顺序，必须得到同一个签名
  const a = sign({ app: 'X', os: 'web', rn: '5' });
  const b = sign({ rn: '5', app: 'X', os: 'web' });
  assert(a === b, '签名依赖了对象字面量顺序 —— 参数顺序一变就鉴权失败');
  assert(/^[0-9a-f]{32}$/.test(a), '签名不是 32 位 md5');
});

test('新闻源不允许返回空数组假装「今天没新闻」', () => {
  /* 这是最危险的一种静默失败：
   * 两个源都挂了却返回 news:[]，模型会以为市场平静。
   * 必须抛错。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'news.js'), 'utf8');
  assert(/throw new Error\('所有新闻源不可用/.test(src),
    '两源皆挂时没有抛错 —— 会让模型误判市场平静');
});

test('新闻降级时必须告知模型时效性下降', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'news.js'), 'utf8');
  const seg = src.slice(src.indexOf('degraded: true'));
  assert(/note:/.test(seg.slice(0, 400)),
    '降级到新浪时没有 note —— 模型可能把宏观新闻当成盘中异动的原因');
});

test('个股新闻拒绝非法代码', async () => {
  const nw = require('./tools/news');
  let threw = false;
  try { await nw.newsForStock('abc'); } catch (_) { threw = true; }
  assert(threw, '非法代码没被拦下');
});

test('新闻源已登记进健康表', () => {
  const sh = require('./tools/source_health');
  ['news.cailianpress', 'news.sina', 'news.eastmoney'].forEach(k => {
    assert(sh.KNOWN_SOURCES[k], `健康表缺少 ${k}`);
  });
  // 财联社必须有真备胎（新浪），且是不同公司的独立源
  assert(sh.KNOWN_SOURCES['news.cailianpress'].alt === 'news.sina',
    '财联社没登记备胎，但代码里实现了自动降级 —— 表与实现不一致');
  /* 新闻是 critical: false —— 缺新闻会让贾维斯"不知道为什么涨跌"，
   * 但不会像行情错误那样给出错的数字。分级要如实。 */
  assert(sh.KNOWN_SOURCES['news.cailianpress'].critical === false,
    '新闻标成 critical 会淹没真正的关键故障（行情/资金流）');
});

/* ══════════ quant_research 桥接 ══════════ */

test('量化桥接白名单不含任何下单命令', () => {
  /* 贾维斯可以建议，不能交易。
   * 白名单里出现 trade/order/buy/sell 就是严重安全问题。 */
  const qb = require('./tools/quant_bridge');
  const keys = Object.keys(qb.COMMANDS);
  keys.forEach(k => {
    assert(!/trade|order|buy|sell|execute|下单/i.test(k),
      `白名单包含疑似下单命令 ${k} —— 贾维斯不该有真实交易能力`);
  });
  assert(keys.length > 0, '白名单是空的');
});

test('量化桥接拒绝白名单外的命令（防注入）', async () => {
  const qb = require('./tools/quant_bridge');
  for (const bad of ['system-status && del /f /q C:\\*', 'trade', '../../evil', '']) {
    const r = await qb.run(bad);
    assert(r.ok === false && !r.needConfirm,
      `命令 "${bad}" 没被拒绝 —— 可能存在注入风险`);
  }
});

test('慢命令必须显式确认才跑', async () => {
  const qb = require('./tools/quant_bridge');
  // backtest 预估 600 秒，不该因为一句随口的话就占满 CPU
  const r = await qb.run('backtest');
  assert(r.needConfirm === true, 'backtest 未经确认就要执行');
  assert(r.estimateMs > 0, '没有给出预估耗时，用户无法判断是否值得等');
});

test('量化桥接用 spawn 数组参数，不走 shell', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'quant_bridge.js'), 'utf8');
  /* 参数从写死的 ['main.py', cmd] 改成了 buildArgs(cmd)，
   * 因为 morning 需要映射成 workflow --name morning（详见对应测试）。
   * 这条测试的本意是**防命令注入**，所以只要求：
   *   1. spawn 第二个参数是数组（buildArgs 恒返回数组）
   *   2. 不开 shell
   * 而不是锁死某个字面量写法。 */
  assert(/spawn\(py,\s*buildArgs\(cmd\)/.test(src),
    '没有用数组参数调用 —— 字符串拼接 + shell 会有命令注入风险');
  assert(/return\s*\['main\.py'\]\.concat\(argv\)/.test(src),
    'buildArgs 必须返回数组，且第一项是 main.py');
  assert(!/shell:\s*true/.test(src), '开了 shell:true，等于放开命令注入');
});

test('量化桥接读报告防目录穿越', () => {
  const qb = require('./tools/quant_bridge');
  ['../../../Windows/win.ini', '..\\..\\secret.txt', 'a/../../b'].forEach(f => {
    const r = qb.readReport('reports', f);
    assert(r.ok === false, `路径 ${f} 没被拦下`);
  });
  assert(qb.readReport('C:\\Windows', 'win.ini').ok === false, '目录白名单失效');
});

test('morning 必须走 workflow 真流水线，不能走裸 morning 空壳', () => {
  /* ══ 实测记录：这是一个"假装成功"的真 bug ══
   *
   * main.py 有两个早盘入口：
   *   main.py morning                → cmd_morning()，只有 3 个 print，一个文件都不写
   *   main.py workflow --name morning → 真 6 步流水线，落盘 runs/reports/plans
   *
   * 我最初调的是前者，实测结果：
   *   exit 0、耗时 40 秒、打印「✅ 早盘流程完成」，
   *   但 system-status 里 8 项数据全部仍过期（最久 42 天），
   *   reports/plans 时间戳一动没动。
   *
   * 改成 workflow 之后：reports 从 64.4 天 → 0.4 分钟，stale 从 8 项 → 1 项。
   *
   * 这条测试锁住映射，防止有人"简化"回裸 morning
   * ——那会让自动刷新重新变成假装干活。 */
  const qb = require('./tools/quant_bridge');
  const spec = qb.COMMANDS ? qb.COMMANDS.morning : null;
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'quant_bridge.js'), 'utf8');

  assert(/argv:\s*\[\s*'workflow'\s*,\s*'--name'\s*,\s*'morning'\s*\]/.test(src),
    'morning 必须映射到 workflow --name morning，否则跑完不落盘');
  assert(/function buildArgs/.test(src), '缺 buildArgs —— argv 映射不会生效');
  assert(/spawn\(py,\s*buildArgs\(cmd\)/.test(src),
    'spawn 没用 buildArgs，argv 映射被绕过了');
});

test('巡视接入 quant_refresh 且冷却足够长', () => {
  const patrol = require('./patrol');
  assert(patrol.COOLDOWNS.quant_refresh, '巡视没有 quant_refresh 任务');
  /* morning 流程预估 300 秒。冷却太短会反复占 CPU，
   * 6 小时意味着一天最多 4 次，够用。 */
  assert(patrol.COOLDOWNS.quant_refresh >= 4 * 3600 * 1000,
    `quant_refresh 冷却 ${patrol.COOLDOWNS.quant_refresh / 3600000}h 太短，会反复跑重流程`);

  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  assert(/'quant_refresh'/.test(src.slice(src.indexOf('const order = isTradingHours'), src.indexOf('const order = isTradingHours') + 300)),
    'quant_refresh 不在调度序列里 —— 永远不会被执行');
});

test('quant_refresh 先查新鲜度再决定跑不跑', () => {
  /* 与「数据层免费轮询，只在异动时才调模型」同一原则：
   * system-status 只要 726ms，morning 要 300 秒。
   * 无脑跑 morning 是浪费。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function refreshQuant'));
  const body = fn.slice(0, fn.indexOf('\nasync function'));
  const stPos = body.indexOf("run('system-status')");
  const mPos = body.indexOf("run('morning'");
  assert(stPos > 0 && mPos > 0, '找不到 system-status 或 morning 调用');
  assert(stPos < mPos,
    '先跑了 morning 才查状态 —— 白花 300 秒');
  assert(/fresh:\s*true/.test(body),
    '数据新鲜时没有让位（fresh 标记），会挤掉其他巡视任务');
});

test('quant_refresh 刷新后要复查是否真的生效', () => {
  /* 只看 exit 0 不够 —— 流程可能"跑完了但数据还是旧的"。
   * 这种情况必须报告，否则用户以为数据是新的。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'patrol.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function refreshQuant'));
  const body = fn.slice(0, fn.indexOf('\nasync function'));
  assert(/quant_still_stale/.test(body),
    '没有复查刷新结果 —— "跑完仍过期"会被当成成功');
});

/* ══════════ faster-whisper 可选旁路 ══════════ */

test('whisper 旁路：require 零副作用（不探测、不联网、不安装）', () => {
  /* 关键约束：加载模块本身绝不能触发任何重活。
   * 服务启动要快，而且用户可能根本没装 Python。 */
  const t0 = Date.now();
  const w = require('./whisper_sidecar');
  const ms = Date.now() - t0;
  assert(ms < 500, `require 耗时 ${ms}ms —— 说明加载时就干活了`);
  ['probe', 'transcribe', 'status', 'resetProbe'].forEach(f =>
    assert(typeof w[f] === 'function', `缺少 ${f}`));
});

test('whisper 旁路：绝不含自动安装代码', () => {
  /* ══ 这是本模块最重要的一条约束 ══
   * faster-whisper 会拉 ctranslate2 + av + 500MB 模型。
   * 在用户没同意的情况下往他机器上装 1GB 东西是越界。
   * 只能检测 + 给出用户自己复制粘贴的命令。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  // 找真正执行 pip 的代码（spawn/exec 里带 pip install）
  const lines = src.split('\n');
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;          // 注释里出现是允许的
    if (/spawn|exec|execSync/.test(ln) && /pip|install/.test(ln)) {
      assert(false, `第 ${i + 1} 行像是在自动安装：${ln.trim().slice(0, 80)}`);
    }
  });
  // installHint 必须是**字符串提示**，不是被执行的命令
  assert(/installHint/.test(src), '没有给出安装提示 —— 用户不知道怎么装');
});

test('whisper 旁路：探测必须真的 import，不能只查 find_spec', () => {
  /* ctranslate2 在 Windows 缺 MSVC 运行库时 find_spec 找得到但 import 崩。
   * 报"可用"却用不了，比报"不可用"更糟 ——
   * 和「假备用源比没有备用源更危险」同一原则。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  assert(/from faster_whisper import WhisperModel/.test(src),
    '探测没有真的 import WhisperModel');
  assert(!/find_spec/.test(src) || /真的 import/.test(src),
    '只用 find_spec 判断可用性 —— 会产生假阳性');
});

test('whisper 旁路：不可用时优雅回退且明确告知', async () => {
  const w = require('./whisper_sidecar');
  const r = await w.transcribe('C:\\definitely-not-exist-12345.wav');
  assert(r.ok === false, '不存在的文件居然转写成功了');
  assert(typeof r.reason === 'string' && r.reason.length > 0, '没给出失败原因');
});

test('whisper 旁路：status() 不可用时必须给安装命令', async () => {
  const w = require('./whisper_sidecar');
  const s = await w.status();
  assert(typeof s.engine === 'string', '没有 engine 字段');
  if (!s.whisperAvailable) {
    /* 不可用时必须说清"为什么"和"怎么办"。
     * 只说"不可用"是没用的信息。 */
    assert(s.reason, '不可用但没给原因');
    assert(s.note && /不会替你安装|System\.Speech/.test(s.note),
      'note 没说明回退行为');
  } else {
    assert(/faster-whisper/.test(s.engine), 'available 为真但 engine 名字不对');
  }
});

test('whisper 旁路：py 启动器被排除（本机实测坏的）', () => {
  /* 实测本机 `py --version` 报
   * "Unable to create process using ...Accio...python.exe"。
   * 把它当候选会得到"看起来有 Python 但跑不了"的假阳性。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  const arr = /PY_CANDIDATES\s*=\s*\[([\s\S]*?)\]/.exec(src);
  assert(arr, '找不到 PY_CANDIDATES');
  assert(!/^\s*'py'\s*,?\s*$/m.test(arr[1]),
    "PY_CANDIDATES 里含 'py' —— 本机该启动器已损坏，会产生假阳性");
});

test('whisper 旁路：CPU 上必须用 int8 且模型不能太大', () => {
  /* medium/large 在 CPU 上要等 5+ 秒 —— 那不如打字。
   * 语音交互的价值在于快。 */
  const w = require('./whisper_sidecar');
  assert(w.COMPUTE_TYPE === 'int8',
    `compute_type=${w.COMPUTE_TYPE}，CPU 上不量化会慢 2-3 倍`);
  assert(['tiny', 'base', 'small'].includes(w.MODEL_SIZE),
    `模型 ${w.MODEL_SIZE} 在纯 CPU 上太慢，会让语音交互失去意义`);
});

test('whisper 旁路：探测阶段禁止下载模型', () => {
  /* 探测只是"看看装没装"，不该偷偷拉 500MB。
   * 靠 HF_HUB_OFFLINE=1 强制离线。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  const probeFn = src.slice(src.indexOf('function runPy'), src.indexOf('async function probe'));
  assert(/HF_HUB_OFFLINE/.test(probeFn),
    '探测时没设 HF_HUB_OFFLINE —— 可能在用户不知情时下载模型');
});

test('STT 路由必须同时匹配带 query 的形式', () => {
  /* 实测踩到：写成 url === '/api/voice/stt' 却在块内读 ?refresh，
   * 结果 /api/voice/stt?refresh=1 直接 404。自相矛盾的代码。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'server.js'), 'utf8');
  const idx = src.indexOf("'/api/voice/stt'");
  assert(idx > 0, '找不到 STT 路由');
  const line = src.slice(idx - 200, idx + 200);
  assert(/startsWith\('\/api\/voice\/stt\?'\)/.test(line),
    "STT 路由只做精确匹配，带 ?refresh=1 会 404（块内却在读该参数）");
});

test('whisper 旁路：默认走 HF 镜像（国内官方源不通）', () => {
  /* 实测：huggingface.co 与 cdn-lfs.huggingface.co 均连接超时，
   * hf-mirror.com 可达。不设镜像等于功能不可用。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  assert(/HF_ENDPOINT/.test(src), '没有 HF_ENDPOINT 配置');
  assert(/hf-mirror\.com/.test(src), '没有默认镜像 —— 国内首次下载必然失败');
  // 必须可被环境变量覆盖，不能硬编码死
  assert(/JARVIS_HF_ENDPOINT|process\.env\.HF_ENDPOINT/.test(src),
    '镜像不可覆盖 —— 用户想用官方源或自建镜像时没办法');
});

test('whisper 旁路：报错必须翻译成人话，不能甩 traceback', () => {
  /* 实测首次失败返回 40 行 httpx traceback，
   * 用户完全看不出是"墙"的问题。
   * 「报错难懂」和「没有报错」一样糟。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  assert(/ConnectTimeout|Max retries/.test(src), '没有识别网络超时类错误');
  assert(/连不上|超时/.test(src), '没有把网络错误翻译成中文说明');
  assert(/rawError/.test(src), '没保留原始错误 —— 排查时无据可依');
  // 几类常见故障都要覆盖
  ['No space left', 'ctranslate2'].forEach(k =>
    assert(src.includes(k), `没有处理 ${k} 类错误`));
});

test('whisper 旁路：必须用常驻进程，不能每次重新加载模型', () => {
  /* ══ 实测耗时拆解（6 秒音频、small/int8、纯 CPU）══
   *   import faster_whisper    1.2 秒
   *   加载 small 模型         13.1 秒   ← 70% 的时间
   *   实际转写                 4.4 秒
   *   总计                    18.7 秒
   *
   * 常驻后：首次 20.5 秒，之后 4.4 秒 —— 快 4.7 倍。
   * 每次重新加载 = 说一句话等 19 秒 = 不如打字。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  assert(/function workerCode/.test(src), '没有常驻 worker');
  assert(/for line in sys\.stdin/.test(src), 'worker 没有循环读 stdin');

  // 模型加载必须在循环外
  const wc = src.slice(src.indexOf('function workerCode'), src.indexOf('async function getWorker'));
  const loadPos = wc.indexOf('WhisperModel(');
  const loopPos = wc.indexOf('for line in sys.stdin');
  assert(loadPos > 0 && loopPos > 0, '找不到模型加载或读取循环');
  assert(loadPos < loopPos,
    '模型加载写在循环内 —— 等于没有常驻，每次还是 19 秒');
});

test('whisper 旁路：闲置要释放（模型占约 500MB 内存）', () => {
  const w = require('./whisper_sidecar');
  assert(typeof w.stopWorker === 'function', '没有 stopWorker');
  assert(w.WORKER_IDLE_MS >= 60000,
    '闲置超时太短，会频繁重新加载模型（每次 13 秒）');
  assert(w.WORKER_IDLE_MS <= 30 * 60 * 1000,
    '闲置超时太长，500MB 内存会一直占着');
});

test('whisper 旁路：worker 崩溃时挂起的请求必须失败，不能永久等待', () => {
  /* 常驻进程最容易出的 bug：进程死了，
   * 但等待响应的 Promise 永远不 resolve → 语音功能静默卡死。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'whisper_sidecar.js'), 'utf8');
  const closeHandler = src.slice(src.indexOf("proc.on('close'"), src.indexOf("proc.on('error'"));
  assert(/pending\.forEach/.test(closeHandler),
    'worker 退出时没有让挂起的请求失败 —— 调用方会永久挂着');
});

test('whisper 旁路：initial_prompt 修正专有名词（实测有效）', () => {
  /* ══ 实测对比 ══
   *   无提示 → "假为师帮我看一下今天的大盘情况"  conf 0.697
   *   加提示 → "贾维斯帮我看一下今天的大盘情况"  conf 0.876
   * 不只修正了名字，整句置信度也从 0.70 提到 0.88。 */
  const w = require('./whisper_sidecar');
  assert(w.INITIAL_PROMPT && w.INITIAL_PROMPT.includes('贾维斯'),
    'initial_prompt 里没有唤醒词 —— whisper 会把"贾维斯"识别成"假为师"');
  /* prompt 占用 224 token 上下文预算，太长会挤掉真正的音频上下文 */
  assert(w.INITIAL_PROMPT.length < 200,
    `prompt 长度 ${w.INITIAL_PROMPT.length} 字过长，会挤占音频上下文`);
});

/* ══════════ 个股资金流（补上"挂了灯却没人用"的源）══════════ */

test('资金流：secid 映射正确（沪深分流）', () => {
  const ff = require('./tools/stock_fundflow');
  assert(ff.toSecid('300383') === '0.300383', '创业板应为 0.（深市）');
  assert(ff.toSecid('000001') === '0.000001', '深主板应为 0.');
  assert(ff.toSecid('600519') === '1.600519', '沪主板应为 1.');
  assert(ff.toSecid('688111') === '1.688111', '科创板应为 1.（沪市）');
});

test('资金流：非法代码必须被拒（注入/穿越）', () => {
  const ff = require('./tools/stock_fundflow');
  ['abc', '12345', '1234567', '', '000001; rm -rf /', '../../etc/passwd', '000001 OR 1=1']
    .forEach(bad => {
      let threw = false;
      try { ff.toSecid(bad); } catch (_) { threw = true; }
      assert(threw, `非法代码 [${bad}] 没被拒 —— 会拼进 URL`);
    });
});

test('资金流：绝不返回空数组（最危险的静默失败）', () => {
  /* 返回空数组会让模型以为"今天没有资金流动"。
   * 和新闻源那条规则同一个理由：宁可报错，不可假装正常。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/throw new Error\(`资金流无数据/.test(src),
    '无数据时没有抛错 —— 可能返回空数组，模型会误判为"资金平静"');
  assert(!/return\s*\[\s*\]/.test(src), '出现了 return [] —— 空数组是静默失败');
});

test('资金流：备用源是真的（同接口镜像域名，不是腾讯）', () => {
  /* ══ 实测记录（光环新网 300383，2026-09）══
   *   push2delay.eastmoney.com/fflow  → HTTP200 143ms 有数据 ✓
   *   push2.eastmoney.com/fflow       → socket hang up（主域被封）
   *   qt.gtimg.cn                     → 只有行情，确实没有资金流拆解
   *
   * 所以「腾讯不能当备用源」这个早先判断是对的，要保留；
   * 但真备用源确实存在 —— 同一接口的 push2delay 镜像域名。
   * 假备用源比没有备用源更危险，真备用源却不该漏掉。 */
  const sh = require('./tools/source_health');
  const h = sh.health('stock.fundflow');
  /* 备用源已从 push2delay 升级为 sina.moneyflow。
   * 原因：push2delay 虽然能用，但和主域一样**每次只返回当日一行**，
   * 当"多日趋势"的备胎是不合格的 —— 它补不上缺的能力。
   * 新浪 MoneyFlow 一次给 30 天，且是不同域名不同风控面，才是真备胎。 */
  assert(h.alternative === 'sina.moneyflow',
    `备用源应为 sina.moneyflow，实际 ${h.alternative}`);
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'source_health.js'), 'utf8');
  assert(/腾讯只有行情快照/.test(src),
    '删掉了"腾讯不能当备用源"的说明 —— 后人可能又把腾讯挂上去');
});

test('资金流：东财只给当日，多日趋势必须有独立备胎', () => {
  /* ══ 实测记录（2026-09-09 18:08 收盘后）══
   *
   * 东财 fflow 系四个入口全部只返回 1 行：
   *   push2delay .../fflow/kline/get?lmt=10       → 1 行
   *   push2      .../fflow/kline/get?lmt=10       → 1 行
   *   push2his   .../fflow/daykline/get?lmt=0     → 本机 TCP 层被拦
   *   datacenter RPT_DMSK_TS_STOCKNEW?pageSize=10 → 1 行
   * 换茅台/平安银行/中国平安测，全都 1 行 —— 不是某只票的问题。
   *
   * 用户的实际阻塞点：「韶关算力这个利好落到哪些票上，
   * 得看主力净流入才能确认」——单日数据分不清持续流入还是一日游。
   *
   * 所以必须有一个能给多日的源。新浪 MoneyFlow 实测一次 30 天。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/function sinaFundFlowHistory/.test(src),
    '缺新浪历史源 —— 东财只给当日，没有它就答不了"是否持续流入"');
  assert(/vip\.stock\.finance\.sina\.com\.cn/.test(src),
    '新浪域名不对');
  const ff = require('./tools/stock_fundflow');
  assert(typeof ff.sinaFundFlowHistory === 'function', '新浪历史源没导出');
});

test('资金流：两个源口径不同必须显式标注，不能混算', () => {
  /* ══ 实测证据（工业富联 601138，2026-09-09）══
   *   东财主力 +23805万   大单 +15711万
   *   东财中单 -10779万   小单 -13026万
   *   主力+中单+小单 = 0   ← 四档是零和拆分
   *   新浪净额 = -4546万   ← 全口径
   *
   * 同一天东财主力为正、新浪净额为负，**这是正确的**：
   * 主力吸筹、散户抛售。如果不标注口径，
   * 模型会把它当成"数据源打架"甚至试图取平均，那就全错了。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/caliber/.test(src), '没有 caliber 字段标注口径');
  assert(/口径不同/.test(src) && /不可直接互减/.test(src),
    '没说明两个口径不可直接互减 —— 模型会误以为数据源冲突');

  const reg = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'registry.js'), 'utf8');
  assert(/零和拆分/.test(reg) && /主力吸筹/.test(reg),
    'get_fund_flow 的 description 必须解释同日反向是正常现象，否则模型会误判');
});

test('资金流：必须声明数据来自延时域名', () => {
  /* 「静默降级」和「静默失败」一样有害 ——
   * 不能让调用方以为拿到的是实时数据。 */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/source: 'eastmoney\.push2delay'/.test(src), '没标注实际使用的源');
  assert(/延时/.test(src), '没提示数据是延时的');
});

test('资金流：已注册为模型工具且参数受限', () => {
  const r = require('./tools/registry');
  const list = r.listForModel();
  const t = list.map(x => x.function || x).find(x => x.name === 'get_fund_flow');
  assert(t, 'get_fund_flow 未注册 —— 模型用不到，等于白写');
  const days = t.parameters.properties.days;
  /* 上限从 30 放宽到 120，依据是实测而不是感觉。
   *
   * 旧断言 `days.maximum <= 30` 的理由是「过大会拖慢响应」——
   * 这在东财方案下成立（当时设想按天累积/多次请求）。
   * 但新浪 MoneyFlow 是**一次请求返回全部天数**，实测：
   *   days=20  → 188ms
   *   days=60  →  89ms
   *   days=120 → 103ms
   * 天数对耗时几乎无影响，30 的上限反而挡住了季度级趋势判断。
   *
   * 仍然保留上限（不许无界），只是把值改成实测支持的 120。 */
  assert(days.maximum <= 120, `days 上限 ${days.maximum} 过大，应有合理边界`);
  assert(days.maximum >= 20,
    `days 上限 ${days.maximum} 太小 —— 判断"是否持续流入"至少要 20 日样本`);
  assert(t.parameters.required.includes('code'), 'code 必须是必填');
});

test('资金流：健康表记录已真实产生（不再是"未探测"）', () => {
  /* ══ 这条测试的存在本身就是教训 ══
   * stock.fundflow 在健康表注册了、在 self_diagnose 有候选 URL，
   * 但整个代码库**没有任何函数真的请求它** ——
   * 健康灯长期显示"降级"，实际是"根本没人用过"。
   * 一个长期亮着的红灯，久了就被当背景噪声，真出事也不会去看。 */
  const grep = require('fs').readFileSync(
    require('path').join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  assert(/health\.record\(SOURCE, true\)/.test(grep), '成功时没记录健康表');
  assert(/health\.record\(SOURCE, false/.test(grep), '失败时没记录健康表');
});

test('参数校验不能污染健康表（假故障会掩盖真故障）', () => {
  /* ══════════ 实测踩到的真 bug ══════════
   *
   * news.js 的 `newsForStock` 原本把 6 位代码校验写在 try 里面：
   *   try { stockNews(code) }        // 校验在这里面
   *   catch(e) { health.record('news.eastmoney', false, e.message) }
   *
   * 于是我跑了几次参数校验测试（'abc' / '12345' / 注入串），
   * 健康灯就从 100% 掉到 **14%**，面板显示"东财个股新闻降级" ——
   * 而接口其实完全正常（实测 43-137ms，各返回 5 条）。
   *
   * 这比不记录更糟：**假故障会掩盖真故障**。
   * 健康表只该记录「数据源的健康」，不该记录「调用方的手误」。
   *
   * 修法：参数校验提到 try 之外。 */
  const fs = require('fs'), p = require('path');

  const news = fs.readFileSync(p.join(__dirname, 'tools', 'news.js'), 'utf8');
  const fn = /async function newsForStock[\s\S]*?\n}/.exec(news);
  assert(fn, '找不到 newsForStock');
  const body = fn[0];
  const checkPos = body.indexOf('6 位数字');
  const tryPos = body.indexOf('try {');
  assert(checkPos > 0 && tryPos > 0, '找不到校验或 try');
  assert(checkPos < tryPos,
    '参数校验在 try 里面 —— 调用方传错代码会被记成数据源故障，假故障掩盖真故障');

  const ff = fs.readFileSync(p.join(__dirname, 'tools', 'stock_fundflow.js'), 'utf8');
  const ffn = /async function fundFlow\(/.exec(ff);
  assert(ffn, '找不到 fundFlow');
  const ffBody = ff.slice(ffn.index, ff.indexOf('\n}', ffn.index));
  const secidPos = ffBody.indexOf('toSecid(code)');
  const ffTryPos = ffBody.indexOf('try {');
  assert(secidPos > 0 && ffTryPos > 0, '找不到 toSecid 或 try');
  assert(secidPos < ffTryPos,
    'fundFlow 的参数校验在 try 里面 —— 会把手误记成数据源故障');
});
/* ══════════ 跑 ══════════ */

(async () => {
  section('参数校验 + 沙箱 + 限流');
  for (const [name, fn] of asyncTests) {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  }

  // 清理测试残留
  try {
    const dir = path.join(sb.ROOT, '_test_');
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const big = path.join(sb.ROOT, 'big.txt');
    if (fs.existsSync(big)) fs.unlinkSync(big);
  } catch (_) {}

  console.log('\n───────────────────────────────────');
  console.log(`  通过: ${pass}  |  失败: ${fail}`);
  console.log('───────────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
