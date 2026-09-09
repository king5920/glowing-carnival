'use strict';
/**
 * 自我诊断（L2）—— 发现问题后主动找解决方案
 *
 * ══════ 这个模块的由来 ══════
 * 用户的原话：「刚才数据源没有替补，那就应该自己去 GIT 之类的平台去找一下，
 *              自己发现问题就去积极处理问题」
 *
 * 真实案例（不是假想）：用户 Obsidian 库 00-Inbox/2026-09-03 每日同步.md 里写着
 *   > 光环新网补取：300383 行情/资金流接口连续多日未返回，持仓明细长期缺失，需换源
 * 「连续多日」「长期缺失」—— 问题被记录了，但没人去解决。
 * 记录问题不等于解决问题，这中间缺的就是这个模块。
 *
 * ══════ 三级授权（用户已选 L1+L2）══════
 * L1  检测：记录成功率，连续失败标 degraded            —— source_health.js
 * L2  搜索：找替代方案，实测候选，写成报告             —— 本模块
 * L3  修复：自己改代码配置                            —— **未实现，用户选择不开**
 *
 * 为什么 L3 不开（我主动建议的）：
 * 让 AI 改自己的数据源代码，一旦逻辑错了会**静默产生错数据**。
 * 今天板块就出过这种事 —— "领跌 物业管理 +1.91%"，一个在涨的板块被当成领跌。
 * 那是我写错 pz 参数导致的，我自己测出来才发现。
 * 如果是 AI 自动改的，错的行情数据会直接进周报，而错数据比没数据危险得多。
 *
 * 所以本模块的产出是**方案报告**，改不改由用户点头。
 */

const https = require('https');
const health = require('./source_health');
const llm = require('../llm');

/* ─────────────── 候选源探测 ─────────────── */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 探测一个 URL 能不能用。这是 L2 的核心动作 —— 不光搜，还实测。 */
function probe(url, opts = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const mod = url.startsWith('https:') ? https : require('http');
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      timeout: opts.timeoutMs || 10000,
    }, res => {
      let body = '';
      let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', c => {
        bytes += c.length;
        if (body.length < 2000) body += c;      // 只留前 2KB 判断
      });
      res.on('end', () => resolve({
        url, ok: res.statusCode === 200 && bytes > 0,
        status: res.statusCode,
        ms: Date.now() - started,
        bytes,
        sample: body.slice(0, 300),
        // 判断返回的是不是有效数据（不是错误页/空壳）
        looksLikeData: /[{[]/.test(body.slice(0, 50)) || /~/.test(body.slice(0, 50)),
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ url, ok: false, error: '超时', ms: Date.now() - started }); });
    req.on('error', e => resolve({ url, ok: false, error: e.message, ms: Date.now() - started }));
  });
}

/** 批量探测（串行，避免同时打同一家的接口） */
async function probeAll(urls, opts = {}) {
  const results = [];
  for (const u of urls) {
    results.push(await probe(u, opts));
    await new Promise(r => setTimeout(r, opts.gapMs || 800));
  }
  return results;
}

/* ─────────────── 已知的候选源库 ─────────────── */

/**
 * 针对每类数据，预置一批候选源。
 *
 * 这些是我实际调研过的（部分来自本机 a-stock-data skill 的十层数据源架构），
 * 不是编的。每条都标了实测状态。
 */
const CANDIDATES = {
  'eastmoney.sector': {
    what: '行业板块涨跌榜',
    urls: [
      // 东财各域名（push2 系被 TCP RST，delay 可用 —— 已实测）
      'https://push2delay.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14',
      'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f3,f12,f14',
      // 新浪的板块接口
      'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hangye_ZL01',
      // 腾讯（实测无板块数据，留作证据）
      'https://qt.gtimg.cn/q=bk0447',
    ],
    knownLimits: '同花顺 stock_board_industry_summary 2026 年初加了 401 登录态反爬；通达信协议里没有行业板块聚合数据',
  },
  'tencent.quote': {
    what: '个股/指数实时行情',
    urls: [
      'https://qt.gtimg.cn/q=sh600519',
      'https://push2delay.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f169,f170',
      'https://hq.sinajs.cn/list=sh600519',
    ],
    knownLimits: '新浪 hq.sinajs.cn 需要 Referer: https://finance.sina.com.cn',
  },
  'stock.fundflow': {
    what: '个股资金流向（光环新网 300383 长期缺失的那个）',
    urls: [
      'https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get?secid=0.300383&klt=101&lmt=5&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55',
      'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=0.300383&klt=101&lmt=5&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55',
      'https://qt.gtimg.cn/q=sz300383',
    ],
    knownLimits: '资金流数据东财独有；腾讯只有行情没有资金流拆解',
  },
};

/* ─────────────── 诊断流程 ─────────────── */

/**
 * 对一个故障源做完整诊断。
 *
 * 流程：
 *   1. 读健康记录，确认问题真实存在、躺了多久
 *   2. 实测所有候选源，拿到硬数据
 *   3. 让模型基于实测结果给方案（不是让模型凭空猜）
 *
 * 关键：**先实测再问模型**。反过来（让模型先推荐再测）会得到一堆
 * 看起来合理但实际不通的 URL —— 模型不知道你这台机器的网络状况。
 */
async function diagnose(source, opts = {}) {
  const h = health.health(source);
  const cand = CANDIDATES[source];

  const report = {
    source,
    label: h.label || source,
    degraded: h.degraded,
    brokenForDays: h.brokenForDays,
    consecutiveFailures: h.consecutiveFailures,
    lastReason: h.lastReason,
    recentSuccessRate: h.recentSuccessRate,
  };

  if (!cand) {
    report.probes = [];
    report.conclusion = '没有预置候选源，需要人工调研或走网络搜索';
    return report;
  }

  report.what = cand.what;
  report.knownLimits = cand.knownLimits;

  // 实测所有候选
  report.probes = await probeAll(cand.urls, { gapMs: opts.gapMs || 900 });
  const working = report.probes.filter(p => p.ok && p.looksLikeData);
  report.workingCount = working.length;
  report.workingUrls = working.map(p => ({ url: p.url, ms: p.ms, bytes: p.bytes }));

  // 让模型基于**实测结果**给结论
  if (opts.useModel !== false) {
    try {
      report.analysis = await analyzeWithModel(report);
    } catch (e) {
      report.analysisError = e.message;
    }
  }

  return report;
}

const ANALYST_SYSTEM = `你是数据源故障分析师。基于给你的**实测探测结果**给出结论。

铁律：
1. 只根据实测数据下结论。probes 里 ok=false 的就是不通，不要说"可能可以试试"。
2. 如果所有候选都不通，明确说"当前无可用替代源"，不要编造 URL。
3. 区分「接口挂了」和「这个数据本来就只有一家有」——后者不是故障，是数据源垄断。
4. 给出的建议必须可执行，不要"建议进一步调研"这种空话。

输出格式（简短，不超过 300 字）：
**判定**：一句话说清是什么问题
**可用替代**：列出实测通的，带耗时；没有就写"无"
**建议动作**：具体到改哪个参数/换哪个域名，或者明确说"无解，接受降级"`;

async function analyzeWithModel(report) {
  const payload = {
    source: report.source,
    what: report.what,
    broken_for_days: report.brokenForDays,
    last_error: report.lastReason,
    known_limits: report.knownLimits,
    probes: (report.probes || []).map(p => ({
      /* URL 必须完整传给模型。
       * 之前截到 110 字符，模型看到 URL 结尾是 "&fiel" 就推断
       * "fields 参数没发全，这是明细缺失的真因" —— 完全是被截断误导的。
       * 传参丢信息会让模型给出看起来很有道理的错误结论。 */
      url: p.url,
      ok: p.ok,
      status: p.status,
      ms: p.ms,
      bytes: p.bytes,
      looks_like_data: p.looksLikeData,
      error: p.error,
      sample: (p.sample || '').slice(0, 200),
    })),
  };

  const r = await llm.chat([
    { role: 'system', content: ANALYST_SYSTEM },
    { role: 'user', content: '实测结果：\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\n\n给结论。' },
  ], { maxTokens: 900, temperature: 0.3, timeoutMs: 90000 });

  return (r && (r.content || r.text)) || null;
}

/**
 * 扫描所有故障源并逐个诊断。
 * 这是巡视会调的接口。
 */
async function diagnoseAll(opts = {}) {
  const probs = health.problems();
  if (!probs.length) return { ok: true, problems: 0, reports: [] };

  const reports = [];
  // 限制一次最多诊断 2 个，避免一轮巡视打太多请求
  for (const p of probs.slice(0, opts.max || 2)) {
    reports.push(await diagnose(p.source, opts));
  }

  return {
    ok: true,
    problems: probs.length,
    diagnosed: reports.length,
    reports,
  };
}

module.exports = { diagnose, diagnoseAll, probe, probeAll, CANDIDATES };
