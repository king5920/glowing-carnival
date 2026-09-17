'use strict';
/**
 * 免费联网搜索（Bing HTML 抓取）。
 *
 * ══════ 为什么自己抓页面 ══════
 *
 * 内置 web_search 的 API key 已失效（实测报
 * "Authentication Fails, Your api key ****467c is invalid"），
 * 用户选择：接免费源，坏了就明说，绝不编造结果。
 *
 * 实测候选源（2026-09-10，本机）：
 *   DuckDuckGo html / lite  → 超时（本网络环境连不上）
 *   Bing www.bing.com       → 302 跳 cn.bing.com，跟随重定向后 200，
 *                             能解析出 10 条真实结果
 *
 * ══════ 三条铁律（这个模块最容易踩的坑）══════
 *
 * 1. **坏了必须显式报错，绝不返回空数组假装"没搜到"。**
 *    空结果可能是"真没有"，也可能是"页面结构变了/被风控了"，
 *    两者对用户意义完全不同。解析为 0 条时要带上 HTTP 状态和页面特征，
 *    让调用方能区分"无相关结果"和"搜索挂了"。
 *
 * 2. **不写假备用源。** 只有 Bing 实测可用，就只声明 Bing。
 *    DuckDuckGo 连不上，不把它列成"备胎"——
 *    一个连不上的备用源比没有更危险（项目里已有教训）。
 *
 * 3. **非官方接口随时可能失效。** 这是解析 HTML，Bing 改版就会坏。
 *    所以解析逻辑集中、失败信息充分，坏了好修；
 *    且要健康上报，不能静默。
 */

const https = require('https');
const health = require('./source_health');

const SOURCE = 'bing.html-search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 跟随重定向的 GET */
function fetch(url, depth) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } },
      r => {
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && (depth || 0) < 5) {
          r.resume();
          resolve(fetch(new URL(r.headers.location, url).href, (depth || 0) + 1));
          return;
        }
        let b = '';
        r.on('data', d => { b += d; if (b.length > 4_000_000) r.destroy(); });
        r.on('end', () => resolve({ status: r.statusCode, body: b, finalUrl: url }));
      })
      .on('error', reject)
      .setTimeout(15000, function () { this.destroy(new Error('请求超时')); });
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&ensp;|&emsp;|&nbsp;/g, ' ')
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]+>/g, '')      // 去标签
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 搜索并解析。
 * @returns {Promise<{ok, query, results, error?, status?}>}
 */
async function search(query, count = 6) {
  if (!query || !String(query).trim()) {
    return { ok: false, query, results: [], error: '缺少搜索词' };
  }
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(String(query).trim())
    + '&setlang=zh-CN&mkt=zh-CN&count=' + Math.max(1, Math.min(count, 15));

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    health.record(SOURCE, false, '请求失败: ' + e.message);
    return { ok: false, query, results: [], error: '搜索请求失败：' + e.message };
  }

  if (resp.status !== 200) {
    health.record(SOURCE, false, 'HTTP ' + resp.status);
    return { ok: false, query, results: [], status: resp.status,
             error: `搜索返回 HTTP ${resp.status}（可能被风控），暂时不可用` };
  }

  /* Bing 有机结果块 <li class="b_algo">，标题链接在 <h2><a href>，摘要在 <p>。
   * 用宽松匹配：Bing 会给 class 加后缀（b_algo b_admOsc 之类），
   * 所以不能按精确 class 切，否则改版一个字就全挂。 */
  const blocks = resp.body.split(/<li class="b_algo[^"]*"/).slice(1);
  const results = [];

  for (const blk of blocks) {
    const seg = blk.slice(0, 4000);   // 每个结果块只看前 4KB，避免跨块误匹配
    const aM = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg);
    if (!aM) continue;
    let link = aM[1];
    /* Bing 有时把链接包成 /ck/a?...&u=a1<encoded>，提取真实地址 */
    const uM = /[?&]u=a1([^&]+)/.exec(link);
    if (uM) { try { link = Buffer.from(uM[1], 'base64').toString('utf8'); } catch (_) {} }
    if (!/^https?:/.test(link)) continue;

    const pM = /<p[^>]*>([\s\S]*?)<\/p>/.exec(seg);
    results.push({
      title: decodeEntities(aM[2]),
      url: link,
      snippet: pM ? decodeEntities(pM[1]).slice(0, 300) : '',
    });
    if (results.length >= count) break;
  }

  if (!results.length) {
    /* ⚠ 关键：0 条不等于"没搜到"。
     * 页面正常但解析为 0，多半是 Bing 改版或返回了验证码页。
     * 显式标记 degraded，让模型/用户知道搜索能力坏了，而不是"世界上没有相关信息"。 */
    const looksLikeCaptcha = /captcha|验证|verify/i.test(resp.body);
    health.record(SOURCE, false, '解析 0 条结果' + (looksLikeCaptcha ? '（疑似验证码页）' : '（页面结构可能已变更）'));
    return {
      ok: false, query, results: [], status: 200, degraded: true,
      error: looksLikeCaptcha
        ? '搜索被要求人机验证，暂时不可用'
        : '搜索页面结构变化，没解析到结果（接口可能已改版），暂时不可用',
    };
  }

  health.record(SOURCE, true);
  return { ok: true, query, results, count: results.length };
}

/** 给模型看的紧凑文本 */
function formatResults(r) {
  if (!r.ok) {
    return `联网搜索暂时不可用：${r.error}。`
      + '请直接告诉用户"现在搜不了"，不要凭记忆编造新闻或数据。';
  }
  const L = [`联网搜索"${r.query}"，找到 ${r.count} 条结果：`];
  r.results.forEach((x, i) => {
    L.push(`${i + 1}. ${x.title}\n   ${x.url}` + (x.snippet ? `\n   ${x.snippet}` : ''));
  });
  L.push('（以上来自必应搜索，时效性以原网页为准；涉及行情/数据请核对来源和日期）');
  return L.join('\n');
}

module.exports = { search, formatResults, SOURCE };
