'use strict';
/**
 * 东财接口统一客户端 —— 防风控
 *
 * ══════ 为什么需要这个 ══════
 * 东财系接口（push2 / datacenter / push2ex / reportapi）共用一套 IP 级风控。
 * 实测阈值（社区数据）：
 *   > 5 次/秒        → 高风险
 *   单 IP 并发 ≥ 10  → 高风险
 *   1 分钟 ≥ 200 次  → 中高
 *   5 分钟 ≥ 300 次  → 触发封禁
 * 被封表现：403 / 429 / socket hang up / 返回空。临时封禁几分钟到几小时。
 *
 * 我之前的写法犯了两个错：
 *   1. 每次请求新建连接（没有 Keep-Alive）→ 连接数快速累积
 *   2. 失败后立刻短间隔重试 → 撞在风控上，把封禁时间拉得更长
 *
 * 这个模块的做法：
 *   1. 全局共享一个 keep-alive Agent（复用 TCP 连接）
 *   2. 所有请求进一个串行队列，间隔 ≥ 1.1s + 随机抖动（QPS < 1）
 *   3. 熔断：连续失败 N 次就主动歇 5 分钟，不再撞墙
 *
 * ══════ 为什么不换数据源 ══════
 * 行业板块数据**只有东财有**。通达信/腾讯/新浪都没有，
 * 同花顺的 stock_board_industry_summary 在 2026 年初加了 401 登录态反爬。
 * 所以没有"换源"这条路，只能更聪明地用东财。
 */

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ══════ 域名可用性实测（2026-09，本机住宅 IP）══════
 *
 * 这台机器到东财的连通性是**分域名**的，不是全站封禁：
 *
 *   push2.eastmoney.com          socket hang up（TCP 层直接 RST）
 *   1/7/82.push2.eastmoney.com   socket hang up（分流域名同样被切）
 *   push2his.eastmoney.com       socket hang up
 *   push2delay.eastmoney.com     ✅ HTTP 200，数据完整
 *   datacenter-web.eastmoney.com ✅ HTTP 200
 *   quote.eastmoney.com          ✅ HTTP 200
 *
 * 实测结论：换 UA / 加 Referer / 带 cookie / 换 HTTP-HTTPS **全部无效**，
 * 说明拦截发生在 TCP 层而非应用层，不是"请求太频繁"能解释的。
 *
 * 所以真正的解法不是限流，而是**换域名**：
 * push2delay 是东财的延时行情域名，不在封禁范围内。
 * 对板块/指数这类看当日涨跌幅的场景，延时几分钟完全可接受。
 */
const PUSH2_HOSTS = [
  'push2delay.eastmoney.com',   // 实测可用，优先
  'push2.eastmoney.com',        // 实测被封，留作以后恢复时自动启用
  '82.push2.eastmoney.com',
];

/* ── Keep-Alive Agent：复用 TCP 连接，这是防封的第一要素 ── */
const agentOpts = {
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 2,        // 严格限制并发。东财并发 ≥10 就高风险，我们只开 2
  maxFreeSockets: 2,
  timeout: 12000,
};
const httpsAgent = new https.Agent(agentOpts);
const httpAgent = new http.Agent(agentOpts);

/* ── 串行节流队列 ── */
const MIN_INTERVAL_MS = 1100;      // 最小间隔 1.1 秒（QPS < 1，远低于阈值）
const JITTER_MS = 400;             // 随机抖动，避免固定节奏被识别

let _lastRequestAt = 0;
let _lastGoodHost = null;           // 最近一次成功的域名，调试用
let _chain = Promise.resolve();     // 串行链：所有请求排队，绝不并发

/* ── 熔断器 ── */
const CIRCUIT = {
  failures: 0,
  openUntil: 0,
  FAIL_THRESHOLD: 3,               // 连续 3 次失败就熔断
  OPEN_MS: 5 * 60 * 1000,          // 熔断 5 分钟
};

function circuitOpen() {
  return Date.now() < CIRCUIT.openUntil;
}
function recordSuccess() {
  CIRCUIT.failures = 0;
  CIRCUIT.openUntil = 0;
}
function recordFailure() {
  CIRCUIT.failures++;
  if (CIRCUIT.failures >= CIRCUIT.FAIL_THRESHOLD) {
    CIRCUIT.openUntil = Date.now() + CIRCUIT.OPEN_MS;
    CIRCUIT.failures = 0;   // 重置计数，熔断结束后重新开始数
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 真正发一次请求（不含排队逻辑） */
function rawGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const mod = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const req = mod.get(url, {
      agent,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive',
        ...extraHeaders,
      },
      timeout: 12000,
    }, res => {
      // 403/429 是明确的风控信号，不重试（重试只会加重）
      if (res.statusCode === 403 || res.statusCode === 429) {
        res.resume();
        return reject(new Error('东财风控 HTTP ' + res.statusCode));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    req.on('error', e => reject(e));
  });
}

/**
 * 东财请求统一入口。
 * 所有对 eastmoney.com 的调用都必须走这里，自带串行限流 + 熔断 + 域名切换。
 *
 * ══════ 域名自动切换（关键）══════
 * push2 系域名在某些 IP 段被 TCP 层直接 RST。实测换 UA/加 Referer/带 cookie
 * 全部无效 —— 拦截在传输层，不是限流问题。真解法是换到 push2delay。
 * 这里检测到连接类错误就自动切下一个域名。
 *
 * @param {string} url 完整 URL
 * @param {object} opts
 * @param {number} opts.retries 同一域名的重试次数
 * @returns {Promise<string>} 响应体文本
 */
function emGet(url, opts = {}) {
  const retries = opts.retries == null ? 1 : opts.retries;

  // 熔断打开时直接拒绝，不浪费请求
  if (circuitOpen()) {
    const left = Math.ceil((CIRCUIT.openUntil - Date.now()) / 1000);
    return Promise.reject(new Error(`东财熔断中（还有 ${left}s），主动降级`));
  }

  /* 生成待尝试的域名列表。
   * 只对 push2 系做切换（datacenter-web / reportapi 等域名各自独立，没有备选）。 */
  let origHost = null;
  try { origHost = new URL(url).hostname; } catch (_) {}
  const isPush2Family = !!(origHost && /push2/.test(origHost));

  let hosts;
  if (isPush2Family) {
    // 已知可用的排前面；原域名如果不在名单里，追加到最后再试一次
    hosts = PUSH2_HOSTS.slice();
    if (origHost && !hosts.includes(origHost)) hosts.push(origHost);
  } else {
    hosts = [origHost];
  }

  // 挂到串行链尾部：保证任意时刻只有一个东财请求在飞
  const task = _chain.then(async () => {
    let lastErr;

    for (let hi = 0; hi < hosts.length; hi++) {
      const host = hosts[hi];
      const thisUrl = host && host !== origHost
        ? url.replace(/^(https?:\/\/)[^/]+/, (m, p) => p + host)
        : url;

      for (let r = 0; r <= retries; r++) {
        // 换域名或重试前先退避
        if (hi > 0 || r > 0) await sleep(500 * r + 300 * hi + Math.random() * 300);

        // 全局最小间隔（跨域名也生效，整体 QPS 始终 < 1）
        const since = Date.now() - _lastRequestAt;
        const gap = MIN_INTERVAL_MS + Math.random() * JITTER_MS - since;
        if (gap > 0) await sleep(gap);

        _lastRequestAt = Date.now();
        try {
          const body = await rawGet(thisUrl, opts.headers);
          recordSuccess();
          _lastGoodHost = host;
          return body;
        } catch (e) {
          lastErr = e;
          // 风控类（403/429）重试同域名无益，直接换域名
          if (/风控|403|429/.test(e.message)) break;
          // 连接类（RST/hang up）也是换域名更有希望
          if (/hang up|ECONNRESET|ECONNREFUSED|EPIPE/.test(e.message)) break;
        }
      }
    }
    recordFailure();
    throw lastErr;
  });

  // 无论成功失败，链都要往下走（否则一次失败会卡死整条队列）
  _chain = task.then(() => {}, () => {});
  return task;
}

/** 东财 JSON 接口 */
async function emGetJson(url, opts = {}) {
  const text = await emGet(url, opts);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('东财返回非 JSON: ' + text.slice(0, 80)); }
}

/** 状态查询（调试 + 前端展示用） */
function status() {
  return {
    circuitOpen: circuitOpen(),
    circuitOpenUntil: CIRCUIT.openUntil ? new Date(CIRCUIT.openUntil).toISOString().slice(11, 19) : null,
    consecutiveFailures: CIRCUIT.failures,
    lastRequestAt: _lastRequestAt ? new Date(_lastRequestAt).toISOString().slice(11, 19) : null,
    lastGoodHost: _lastGoodHost,
    hostCandidates: PUSH2_HOSTS,
    minIntervalMs: MIN_INTERVAL_MS,
    maxSockets: agentOpts.maxSockets,
  };
}

/** 测试用：手动重置熔断 */
function resetCircuit() {
  CIRCUIT.failures = 0;
  CIRCUIT.openUntil = 0;
}

module.exports = { emGet, emGetJson, status, resetCircuit, UA };
