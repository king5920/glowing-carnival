'use strict';
/**
 * 数据源健康跟踪（自我修复 L1）
 *
 * ══════ 为什么需要这个 ══════
 * 今天板块数据源挂了，我一开始判断成"限流"，做了三样限流优化，结果 0/10。
 * 真因是 TCP 层拉黑，得换域名。这个误判浪费了一轮。
 *
 * 更关键的是：**如果我没主动去测，这个问题会一直躺着**。
 * 实际证据 —— 你 Obsidian 库 00-Inbox/2026-09-03 每日同步.md 的「待跟进」第 1 条：
 *   > 光环新网补取：300383 行情/资金流接口连续多日未返回，持仓明细长期缺失，需换源
 * 「连续多日」「长期缺失」—— 这个问题至少躺了几天没人管。
 *
 * 所以 L1 的职责就一件事：**让沉默的失败变成显式的告警**。
 * 不修，只报。修的部分归 L2/L3。
 *
 * ══════ 设计 ══════
 * - 每次数据源调用都记一笔（成功/失败 + 原因），滚动窗口保留最近 N 次
 * - 连续失败达阈值 → 标记 degraded，并记录首次失败时间（算出"躺了几天"）
 * - 状态落 SQLite，重启不丢（否则重启就"忘了"问题，等于没有）
 */

const db = require('../db');

const STATE_KEY = 'source_health';
const WINDOW = 30;                 // 每个源保留最近 30 次调用记录
const DEGRADE_THRESHOLD = 3;       // 连续失败 3 次就标记 degraded

/* 已知数据源清单。
 * 不在这个表里的源也能记录，但没有描述信息。 */
const KNOWN_SOURCES = {
  'tencent.quote':   { label: '腾讯行情（个股/指数）', critical: true,  alt: 'eastmoney.push2' },
  'tencent.kline':   { label: '腾讯K线',              critical: true,  alt: 'baidu.kline' },
  'eastmoney.index': { label: '东财指数（备用）',       critical: false, alt: 'tencent.quote' },
  /* alt 写 push2delay 不是"假备用源" —— 它是**不同域名、独立风控面**。
   * 实测（2026-10）：push2.eastmoney.com 连续三次 socket hang up 被封时，
   * push2delay.eastmoney.com 仍正常返回全部 496 个板块。
   * em_client 的 PUSH2_HOSTS 已把它设为首选，降级是自动的。
   *
   * 与 stock.fundflow 的区别很关键：
   *   这里是「同一份数据、另一个入口」   → 真备胎
   *   那里是「腾讯根本没有资金流拆解」   → 假备胎，所以保持 null */
  'eastmoney.sector':{ label: '东财行业板块',          critical: true,
                       alt: 'eastmoney.push2delay',
                       note: '板块数据只有东财有（通达信/腾讯/新浪都没有，同花顺 2026 初加了 401 反爬）；'
                           + '但 push2delay 延时域名是独立风控面，实测主域名被封时它仍可用' },
  /* critical: true —— 这是贾维斯自己诊断时提的建议，我采纳了。
   * 理由（它的原话）：「资金流拆解是东财独家，腾讯只有行情，
   * 挂上去会造成『有备用源』的假象，真出问题时降级到腾讯等于拿不到数据」。
   * 所以 alt 也保持 null，不写腾讯 —— 假备用源比没有备用源更危险。
   *
   * ══ 2026-09 实测修正 ══
   * 上面的判断（腾讯不能当备用源）依然成立，但当时漏了一个**真**备用源。
   * 实测三个候选（光环新网 300383）：
   *   push2delay.eastmoney.com/fflow  → HTTP200 143ms **有数据**
   *   push2.eastmoney.com/fflow       → socket hang up（被封）
   *   qt.gtimg.cn                     → 只有行情，确实没有资金流拆解
   *
   * 所以真备用源是**同一接口的 push2delay 镜像域名** ——
   * 和 eastmoney.sector 用的是同一套降级思路（同数据、不同域名与风控面）。
   * 这是真降级，不是假的：数据字段完全一致，只是延迟稍高。 */
  'stock.fundflow':  { label: '个股资金流拆解',        critical: true,
                       alt: 'sina.moneyflow',
                       note: '主力/超大单/大单四档拆分只有东财 fflow 接口有，腾讯只有行情快照。'
                           + '实测 push2 主域被封、push2delay 镜像可用（同字段稍延迟）；'
                           + '但东财 fflow 系**每次只返回当日一行**'
                           + '（push2/push2delay/daykline/datacenter 四个入口全试过，'
                           + '换茅台/平安银行/中国平安验证过不是个股问题），'
                           + 'push2his 在本机被 TCP 层拦截。'
                           + '多日趋势改用新浪 MoneyFlow（一次 30 天、不同域名不同风控面，真备胎）。'
                           + '⚠ 口径不同：东财主力只含超大单+大单，新浪净额是全口径，同日可反向' },
  'agent.logs':      { label: '本机智能体会话日志',     critical: false, alt: null },

  /* ── 新闻源（用户指出的真缺口，2026-09 接入）──
   *
   * 财联社是真主源（官方签名、零 key、实测 errno=0），
   * 新浪是**真备胎** —— 不同公司、不同域名、不同风控面，
   * 而且 marketNews() 里实现了自动降级，不是摆设。
   *
   * 两者内容侧重不同（财联社偏 A 股盘中，新浪偏宏观国际），
   * 所以降级时会明确告诉模型"已降级、时效性下降"，
   * 免得它把宏观新闻当成盘中异动的原因。
   *
   * critical: false —— 新闻缺失会让贾维斯"不知道为什么涨跌"，
   * 但不会像行情错误那样**给出错的数字**。分级要如实。 */
  'news.cailianpress': { label: '财联社电报',   critical: false, alt: 'news.sina',
                         note: '全市场快讯主源；签名算法 md5(sha1(排序query))，零密钥' },
  'news.sina':         { label: '新浪财经要闻', critical: false, alt: null,
                         note: '财联社的降级备胎；偏宏观/国际，A股盘中快讯不如财联社及时' },
  'news.eastmoney':    { label: '东财个股新闻', critical: false, alt: null,
                         note: '按股票代码搜新闻；东财系有 IP 风控，挂了就没有个股新闻' },
};

function loadAll() {
  return db.loadState(STATE_KEY) || {};
}
function saveAll(all) {
  db.saveState(STATE_KEY, all);
}

/**
 * 记一次数据源调用结果。
 * @param {string} source 源标识，如 'eastmoney.sector'
 * @param {boolean} ok
 * @param {string} [reason] 失败原因
 */
function record(source, ok, reason) {
  const all = loadAll();
  const now = Date.now();

  let s = all[source];
  if (!s) {
    s = { calls: [], consecutiveFailures: 0, firstFailureAt: null, degraded: false,
          totalCalls: 0, totalFailures: 0, lastOkAt: null };
  }

  s.totalCalls = (s.totalCalls || 0) + 1;
  s.calls.push({ at: now, ok: !!ok, reason: ok ? null : String(reason || '').slice(0, 120) });
  if (s.calls.length > WINDOW) s.calls = s.calls.slice(-WINDOW);

  if (ok) {
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
    s.degraded = false;
    s.lastOkAt = now;
  } else {
    s.totalFailures = (s.totalFailures || 0) + 1;
    s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;
    if (!s.firstFailureAt) s.firstFailureAt = now;
    if (s.consecutiveFailures >= DEGRADE_THRESHOLD) s.degraded = true;
    s.lastReason = String(reason || '').slice(0, 200);
  }

  all[source] = s;
  saveAll(all);
  return s;
}

/** 包装一个异步取数函数，自动记录健康状态 */
function track(source, fn) {
  return async function tracked(...args) {
    try {
      const r = await fn(...args);
      // 返回 null 也算失败（sectors() 失败时返回 null 而不是抛错）
      if (r == null) { record(source, false, '返回空'); }
      else { record(source, true); }
      return r;
    } catch (e) {
      record(source, false, e.message);
      throw e;
    }
  };
}

/** 某个源的健康状况 */
function health(source) {
  const s = loadAll()[source];
  if (!s) return { source, known: !!KNOWN_SOURCES[source], noData: true };

  const recent = s.calls || [];
  const recentOk = recent.filter(c => c.ok).length;
  const meta = KNOWN_SOURCES[source] || {};

  return {
    source,
    label: meta.label || source,
    critical: !!meta.critical,
    degraded: !!s.degraded,
    consecutiveFailures: s.consecutiveFailures || 0,
    recentSuccessRate: recent.length ? Math.round(recentOk / recent.length * 100) : null,
    recentCalls: recent.length,
    totalCalls: s.totalCalls || 0,
    totalFailures: s.totalFailures || 0,
    lastReason: s.lastReason || null,
    lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString().slice(0, 16).replace('T', ' ') : null,
    // 前端用 epoch 毫秒算"多久以前"，避免截断的 UTC 字符串带来时区歧义
    lastOkMs: s.lastOkAt || null,
    lastCheckMs: recent.length ? recent[recent.length - 1].at : null,
    firstFailureMs: s.firstFailureAt || null,
    // 最近一次探测（无论成败）与首次连续失败的原始时间戳（前端要如实显示"多久没成功"，
    // 不能让 UI 自己拿页面加载时刻猜"刚刚"——那会在源已坏两天时还显示"刚刚异常"，误导）。
    lastCheckAt: recent.length ? new Date(recent[recent.length - 1].at).toISOString().slice(0, 16).replace('T', ' ') : null,
    firstFailureAt: s.firstFailureAt ? new Date(s.firstFailureAt).toISOString().slice(0, 16).replace('T', ' ') : null,
    // 关键指标：这个问题躺了多久
    brokenForDays: s.firstFailureAt && s.degraded
      ? Math.round((Date.now() - s.firstFailureAt) / 86400000 * 10) / 10
      : 0,
    hasAlternative: !!meta.alt,
    alternative: meta.alt || null,
    note: meta.note || null,
  };
}

/** 全部源的健康状况 */
function healthAll() {
  const all = loadAll();
  const list = Object.keys(all).map(health);
  // degraded 的排前面，critical 的更前
  list.sort((a, b) => {
    if (a.degraded !== b.degraded) return a.degraded ? -1 : 1;
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    return (a.recentSuccessRate || 0) - (b.recentSuccessRate || 0);
  });
  return list;
}

/**
 * 需要处理的问题清单 —— 这是给巡视用的核心接口。
 * 只返回真正需要人/AI 介入的，不返回噪音。
 */
function problems() {
  return healthAll()
    .filter(h => h.degraded)
    .map(h => ({
      source: h.source,
      label: h.label,
      critical: h.critical,
      brokenForDays: h.brokenForDays,
      consecutiveFailures: h.consecutiveFailures,
      lastReason: h.lastReason,
      // 有没有已知备选源，决定了该怎么处理
      hasAlternative: h.hasAlternative,
      alternative: h.alternative,
      note: h.note,
      // 建议动作
      suggestedAction: h.hasAlternative
        ? `切换到备用源 ${h.alternative}`
        : '无已知备用源，需要搜索替代方案（L2）',
    }));
}

/** 手动登记一个外部已知问题（比如从 Obsidian 待跟进里读到的） */
function registerExternalIssue(source, label, reason, brokenSinceDays) {
  const all = loadAll();
  const now = Date.now();
  all[source] = {
    calls: [],
    consecutiveFailures: DEGRADE_THRESHOLD,
    firstFailureAt: now - (brokenSinceDays || 0) * 86400000,
    degraded: true,
    totalCalls: 0,
    totalFailures: 0,
    lastOkAt: null,
    lastReason: reason,
    externalLabel: label,
    external: true,
  };
  saveAll(all);
  return health(source);
}

function reset(source) {
  const all = loadAll();
  if (source) delete all[source]; else Object.keys(all).forEach(k => delete all[k]);
  saveAll(all);
}

module.exports = {
  record, track, health, healthAll, problems, registerExternalIssue, reset,
  KNOWN_SOURCES, DEGRADE_THRESHOLD,
};
