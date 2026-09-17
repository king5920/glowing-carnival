'use strict';
/* clock.js —— 贾维斯的时间感知。
 * 测试原则：锁"能力"不锁具体值，但节假日表必须和真实行情对得上。 */

const assert = require('assert');
const clock = require('./clock');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  ✗ FAIL ' + name); console.log('    ' + e.message); }
}

/* ── nowBlock：注入的时间块必须自洽 ── */

test('nowBlock 给出权威日期星期和时分', () => {
  const d = new Date(2026, 8, 10, 19, 30);   // 周四 19:30
  const b = clock.nowBlock(d);
  assert(/2026-09-10/.test(b), '缺日期');
  assert(/周四/.test(b), '缺星期');
  assert(/19:30/.test(b), '缺时分');
  assert(/权威时间/.test(b), '必须声明这是权威时间，让模型别再反推');
  assert(/收盘后/.test(b), '19:30 应判为收盘后，而不是盘中');
});

test('收盘后绝不能判成盘中（实测犯过的错）', () => {
  /* 病根：之前 19:30 它看价格不动就猜"盘中未收盘"。
   * 时段判定只该看墙钟，不该看行情。 */
  assert.strictEqual(clock.tradingSession(new Date(2026, 8, 10, 19, 30)), '收盘后');
  assert.strictEqual(clock.tradingSession(new Date(2026, 8, 10, 14, 40)), '下午盘');
  assert.strictEqual(clock.tradingSession(new Date(2026, 8, 10, 9, 20)), '集合竞价');
  assert.strictEqual(clock.tradingSession(new Date(2026, 8, 10, 11, 45)), '午间休市');
});

/* ── 交易日历：和真实行情核对过的日期必须判对 ── */

test('交易日历：真实行情核对过的休市日', () => {
  /* 这些日期用腾讯日K确认过"无交易"（见 STATUS Phase 25）：
   *   02-23 周一无交易（春节补休，我第一版手写漏了）
   *   05-04/05-05 休市（我第一版误写成 05-02/05-03） */
  const closed = ['2026-01-01', '2026-01-02', '2026-02-16', '2026-02-20', '2026-02-23',
                  '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19'];
  for (const d of closed) {
    assert.strictEqual(clock.isTradingDay(new Date(d + 'T12:00:00')), false, d + ' 应休市');
  }
  /* 节后首个工作日必须开盘 */
  for (const d of ['2026-02-24', '2026-04-07', '2026-05-06', '2026-06-22', '2026-09-10']) {
    assert.strictEqual(clock.isTradingDay(new Date(d + 'T12:00:00')), true, d + ' 应开盘');
  }
});

test('交易日历：周末默认休市', () => {
  // 2026-09-12 周六, 09-13 周日
  assert.strictEqual(clock.isTradingDay(new Date('2026-09-12T12:00:00')), false);
  assert.strictEqual(clock.isTradingDay(new Date('2026-09-13T12:00:00')), false);
});

test('补班日机制存在（调休补班的周末要能判为交易日）', () => {
  /* 2026 暂无补班交易日，但机制必须在 ——
   * 否则后人加补班日时没地方写，会在补班周末答错"明天开盘吗"。
   * 手工注入一个验证机制有效。 */
  assert(Array.isArray(clock.MAKEUP_WORKDAYS[2026]), '补班日表缺失');
  clock.MAKEUP_WORKDAYS[2026].push('2026-09-12');   // 假设周六补班
  assert.strictEqual(clock.isTradingDay(new Date('2026-09-12T12:00:00')), true,
    '补班的周六应判为交易日');
  clock.MAKEUP_WORKDAYS[2026].pop();                // 还原，不污染
});

test('下一个交易日会跳过周末和假期', () => {
  const fri = new Date(2026, 8, 11, 15, 0);        // 周五收盘
  const nxt = clock.nextTradingDay(fri);
  assert.strictEqual(nxt.date.getDay(), 1, '周五后下一交易日应是周一');
  // 春节前 2026-02-13(周五)，下一交易日应跳到节后
  const beforeCNY = clock.nextTradingDay(new Date('2026-02-13T15:00:00'));
  assert.strictEqual(clock.dateKey(beforeCNY.date), '2026-02-24',
    '春节后首个交易日应是 02-24（02-23 也休市）');
});

/* ── 未核实假期必须诚实标注 ── */

test('超出已核实范围的节假日不能装作确定', () => {
  /* 中秋/国庆在真实行情产生之前是预填的。
   * 一个自信但猜错的开盘判断会让用户在假期做错操作，
   * 比回答"不确定"危险得多。 */
  assert(clock.DATA_VERIFIED_THROUGH, '缺 DATA_VERIFIED_THROUGH');
  assert(Array.isArray(clock.HOLIDAYS_VERIFIED[2026]), '缺已核实列表');
  // 临近国庆的判断必须带不确定性提示
  const b = clock.nowBlock(new Date(2026, 8, 28, 9, 0));
  assert(/尚未用真实行情核对|公告为准/.test(b),
    '临近未核实假期时应提示不确定性');
});

/* ── relativeTime：记忆时间标注 ── */

test('relativeTime 按日历天而非24小时滚动', () => {
  /* 昨晚 23 点到今早 9 点只隔 10 小时，但用户认知是"昨天"。
   * 滚动小时差会算成"0天前=今天"，这是常见 off-by-one。 */
  const now = new Date(2026, 8, 10, 9, 0);
  const lastNight = new Date(2026, 8, 9, 23, 0);
  const r = clock.relativeTime(lastNight, now);
  assert.strictEqual(r.rel, '昨天', '昨晚应判昨天，不是今天');
});

test('relativeTime 各档位 + 绝对日期', () => {
  const now = new Date(2026, 8, 10, 19, 0);
  const cases = [
    ['2026-09-10T10:00:00', '今天'],
    ['2026-09-09T15:00:00', '昨天'],
    ['2026-09-08T15:00:00', '前天'],
    ['2026-09-07T15:00:00', '3天前'],
  ];
  for (const [ts, rel] of cases) {
    const r = clock.relativeTime(ts, now);
    assert.strictEqual(r.rel, rel, ts + ' 应是 ' + rel + '，实际 ' + r.rel);
    assert(/2026-09-/.test(r.abs), '绝对日期缺失');
    assert(/^周[日一二三四五六]$/.test(r.dow), '星期格式错误');
    assert(/（.*2026/.test(r.label), 'label 应含相对+绝对');
  }
});

test('relativeTime 对脏输入返回 null 而不是崩溃', () => {
  assert.strictEqual(clock.relativeTime(null), null);
  assert.strictEqual(clock.relativeTime('不是日期'), null);
});

/* ── brain 必须把时间递到模型嘴边 ── */

test('brain 注入了时间块，记忆带了相对时间', () => {
  const src = require('fs').readFileSync(__dirname + '/brain.js', 'utf8');
  assert(/clock\.nowBlock\(\)/.test(src),
    'brain 没注入 nowBlock —— 模型还是没有时钟');
  assert(/clock\.relativeTime/.test(src),
    'brain 没给记忆加相对时间 —— "上次聊某事是哪天"还是答不出');
});

test('get_current_time 工具已注册', () => {
  const r = require('./tools/registry');
  const t = r.listForModel().map(x => x.function || x).find(x => x.name === 'get_current_time');
  assert(t, 'get_current_time 未注册');
  assert(/权威时间|不要用行情数据反推/.test(t.description),
    '描述里必须明确禁止"用行情反推时间"，那是收盘后出错的根源');
});

/* ══════════ 非交易时段静默（用户 2026-09-10 要求）══════════ */

test('isProactiveWindow：交易时段活跃，其余静默', () => {
  const f = d => clock.isProactiveWindow(new Date(d));
  // 周四各时段
  assert.strictEqual(f('2026-09-10T08:59'), false, '盘前应静默');
  assert.strictEqual(f('2026-09-10T09:00'), true,  '09:00 起活跃');
  assert.strictEqual(f('2026-09-10T14:00'), true,  '盘中活跃');
  assert.strictEqual(f('2026-09-10T22:59'), true,  '收盘后到23点仍可做收盘扫描');
  assert.strictEqual(f('2026-09-10T23:00'), false, '23:00 后静默');
  // 周末
  assert.strictEqual(f('2026-09-12T10:00'), false, '周六全天静默');
  assert.strictEqual(f('2026-09-13T10:00'), false, '周日全天静默');
  // 休市日（即使是工作日）
  assert.strictEqual(f('2026-10-01T10:00'), false, '国庆休市应静默');
  assert.strictEqual(f('2026-02-23T10:00'), false, '春节补休应静默');
});

test('静默只挡后台主动行为，不挡用户提问', () => {
  /* 这是边界正确性：心跳/巡视静默 ≠ 贾维斯不回答。
   * 用户主动提问走 brain.js 对话链路，根本不经过 isProactiveWindow。
   * 用代码结构锁住这个边界，防止后人图省事把整个心跳停了。 */
  const mind = require('fs').readFileSync(__dirname + '/mind.js', 'utf8');
  assert(/isProactiveWindow/.test(mind), 'mind 心跳没有时间窗口判断');
  // 静默时过滤的是 contact/find_activity 两类主动触发，不是整个 tick
  assert(/t\.action !== 'contact'/.test(mind) && /t\.action !== 'find_activity'/.test(mind),
    '静默应只压掉搭话和找事做，不能停情绪 tick');
  // jiwen.tick 必须照常执行（心境在非交易时段仍累积）
  const tickIdx = mind.indexOf('jiwen.tick');
  const gateIdx = mind.indexOf('isProactiveWindow');
  assert(tickIdx > 0 && gateIdx > tickIdx,
    '情绪 tick 应在静默判断之前执行，否则非交易时段心境不推进');
});

test('patrol 静默时放收盘扫描、拦其它巡视', () => {
  const p = require('fs').readFileSync(__dirname + '/patrol.js', 'utf8');
  // 断言意图而非字面：patrol.js 后来给 stock_pool / chan_phase 也加了收盘豁免，
  // 锁死原始文本会让测试在逻辑变得更完善时误报失败。
  const gate = p.split('\n').find(l => /!clock\.isProactiveWindow\(\)/.test(l));
  assert(gate, 'patrol 缺"非活跃窗口即跳过"闸门');
  assert(/task !== 'close_scan'/.test(gate),
    '收盘扫描必须豁免闸门——它是用户点名的每日固定动作，任何时段都要放行');
});

/* ══════════ 放音乐 / 视频：安全边界 ══════════ */

test('play_media 已注册且语义诚实（不谎称"正在播放"）', () => {
  const r = require('./tools/registry');
  const t = r.listForModel().map(x => x.function || x).find(x => x.name === 'play_media');
  assert(t, 'play_media 未注册');
  assert(/打开|浏览器/.test(t.description), '描述应说明是打开网页');
  assert(/不要说|无法控制|不能.*播放/.test(t.description),
    '必须告诉模型它只负责打开页面、控制不了播放，防止对用户谎称"正在播放"');
});

test('desktop_open：拒绝危险协议和可执行文件', () => {
  const d = require('./tools/desktop_open');
  // 这些必须被拒，不能因为"打开"能力变成执行任意程序
  return Promise.all([
    d.openUrl('file:///C:/Windows/System32/cmd.exe').then(r => {
      assert.strictEqual(r.ok, false, 'file:// 协议必须拒绝');
    }),
    d.openUrl('javascript:alert(1)').then(r => {
      assert.strictEqual(r.ok, false, 'javascript: 协议必须拒绝');
    }),
    d.openUrl('not-a-url').then(r => {
      assert.strictEqual(r.ok, false, '非法网址必须拒绝');
    }),
    d.openPath('C:/Windows/System32/cmd.exe').then(r => {
      assert.strictEqual(r.ok, false, '.exe 必须拒绝——放歌不能变成运行程序');
    }),
    d.openPath('/tmp/nonexistent.mp3').then(r => {
      assert.strictEqual(r.ok, false, '不存在的文件应报错');
    }),
  ]);
});

test('play_media 自动选平台：音乐→网易云，视频→B站', async () => {
  const r = require('./tools/registry');
  const fn = r.listForModel ? r : null;
  // 直接测平台映射逻辑（不真的打开浏览器）
  const { MEDIA_SITES } = require('./tools/registry');
  assert(MEDIA_SITES.netease && MEDIA_SITES.bilibili, '平台表缺失');
  const isVideoKw = kw => /视频|电影|剧|纪录片|番|教程/.test(kw);
  assert.strictEqual(isVideoKw('晴天'), false);
  assert.strictEqual(isVideoKw('航拍中国 纪录片'), true);
  assert(/music\.163\.com/.test(MEDIA_SITES.netease.url('test')), '网易云 URL 模板错误');
  assert(/bilibili/.test(MEDIA_SITES.bilibili.url('test')), 'B站 URL 模板错误');
  // URL 必须编码关键词
  assert(/%20/.test(MEDIA_SITES.netease.url('a b')), '关键词未 URL 编码');
});

/* ══════════ 免费联网搜索 ══════════ */

test('web_search 已注册且强制"搜不了就明说"', () => {
  const r = require('./tools/registry');
  const t = r.listForModel().map(x => x.function || x).find(x => x.name === 'web_search');
  assert(t, 'web_search 未注册');
  assert(/绝不能凭记忆编造|不能.*编造|如实告诉/.test(t.description),
    '描述必须明令禁止"搜不了时用记忆冒充搜索结果"——这是用户的核心要求');
});

test('搜索解析：0 条结果不等于"没搜到"，必须标记 degraded', () => {
  /* 最危险的失败模式：Bing 改版/弹验证码导致解析为 0 条，
   * 如果直接返回空数组，模型会告诉用户"网上没有相关信息"——
   * 其实是搜索坏了。空 ≠ 无。 */
  const src = require('fs').readFileSync(__dirname + '/tools/web_search_free.js', 'utf8');
  assert(/degraded/.test(src), '0 条结果时必须标 degraded');
  assert(/验证码|改版|结构/.test(src), '要区分"被验证"和"页面改版"两种失败');
  assert(/record\(SOURCE,\s*false/.test(src), '搜索失败要健康上报，不能静默');
});

test('搜索：不写连不上的假备用源', () => {
  /* 实测 DuckDuckGo html/lite 在本机都超时，只有 Bing 可用。
   * 把 DDG 写成"备胎"就是项目反复警惕的假备用源——
   * 真坏了切过去还是坏，却显示"有备用"。 */
  const src = require('fs').readFileSync(__dirname + '/tools/web_search_free.js', 'utf8');
  assert(!/duckduckgo\.com/i.test(src.replace(/\/\/.*$/gm, '')),
    '代码里不应实际请求 DuckDuckGo（实测连不上），避免假备用');
});

test('搜索端到端：真实查询能拿到结果（网络可用时）', async () => {
  const ws = require('./tools/web_search_free');
  const r = await ws.search('上证指数', 3);
  if (!r.ok) {
    /* 网络/风控导致失败是允许的，但必须是明确错误而不是空数组 */
    assert(r.error, '失败时必须带 error 说明');
    assert(Array.isArray(r.results), 'results 必须始终是数组');
  } else {
    assert(r.results.length > 0, 'ok=true 时必须有结果');
    assert(r.results.every(x => x.title && /^https?:/.test(x.url)),
      '每条结果必须有标题和合法 URL');
  }
});


console.log(`\n通过: ${pass} | 失败: ${fail}`);
process.exit(fail ? 1 : 0);
