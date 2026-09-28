'use strict';
/**
 * ths_board.js —— 同花顺行业板块（普通列表页，非 ajax）
 * ─────────────────────────────────────────────────────
 * 2026-09-21 实测：东财 push2 / push2delay 全被 TCP RST。
 * 同花顺的 ajax 接口有 chameleon token（401），但**普通 HTML 列表页无需登录态**：
 *   http://q.10jqka.com.cn/thshy/   HTTP200（GBK，首屏全显 90 个行业）
 *
 * 每行字段（已实证，td 顺序）：
 *   0序号 1板块名 2涨跌幅% 3板块指数/均价 4成交额(亿) 5换手率%
 *   6上涨家数 7下跌家数 8均价 9领涨股名 10领涨现价 11领涨涨幅%
 *
 * 与东财口径差异（必须让调用方/模型看见）：
 *   - 只有 90 个同花顺行业，东财是 496 个细分行业+概念
 *   - **没有 5日/10日/今日主力净额**（东财 f164/f174/f62），这里给 null
 *   - 列表页不带领涨股代码
 * 零新增依赖，仅内置 http。
 */

const http = require('http');
const health = require('./source_health');

const SOURCE = 'ths.board';
const HOST = 'q.10jqka.com.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function fetchHtml(pathname, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({
      host: HOST, path: pathname,
      headers: { 'User-Agent': UA, Referer: 'http://q.10jqka.com.cn/' },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ch = [];
      res.on('data', d => ch.push(d));
      res.on('end', () => resolve({ html: new TextDecoder('gbk').decode(Buffer.concat(ch)), ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { req.destroy(new Error('同花顺请求超时')); });
    req.on('error', e => reject(e));
  });
}

/** 解析 tbody 行为板块对象（纯函数，便于单测）。 */
function parseBoardHtml(html, kind = 'industry') {
  const out = [];
  const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/.exec(html);
  if (!body) return out;
  const trs = body[1].split(/<\/tr>/);
  for (const tr of trs) {
    const code = (/\/thshy\/detail\/code\/(\d{6})/.exec(tr) || /\/gn\/detail\/code\/(\d{6})/.exec(tr) || [])[1];
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
      m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
    if (!code || tds.length < 12) continue;
    const num = v => {
      const n = Number(String(v).replace(/[,%]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      code,
      name: tds[1],
      level: num(tds[3]),
      changePct: num(tds[2]),
      amountYi: num(tds[4]),        // 成交额（亿）
      turnover: num(tds[5]),        // 换手率 %
      upCount: num(tds[6]) || 0,
      downCount: num(tds[7]) || 0,
      leader: tds[9] || null,
      leaderCode: null,             // 列表页不带
      leaderPrice: num(tds[10]),
      leaderPct: num(tds[11]),
      /* 东财多日主力字段：同花顺列表页没有，显式 null（不能编 0） */
      todayYi: null, d5Yi: null, d10Yi: null, mainPct: null,
      dataTs: null,
      kind,
      boardSource: SOURCE,
    });
  }
  return out;
}

/**
 * 取同花顺行业板块（90 个）。
 * 失败抛错给调用方做降级判断；绝不静默返回空。
 */
async function industryBoards() {
  const { html, ms } = await fetchHtml('/thshy/');
  const rows = parseBoardHtml(html, 'industry');
  if (!rows.length) {
    health.record(SOURCE, false, '行业页解析为空');
    throw new Error('同花顺行业板块解析为空');
  }
  health.record(SOURCE, true);
  rows.forEach(r => { r.fetchMs = ms; });
  return rows;
}

module.exports = { industryBoards, parseBoardHtml, fetchHtml, SOURCE };
