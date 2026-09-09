'use strict';
/**
 * A 股实时行情 —— 腾讯财经主源 + 东财备用源
 *
 * ── 为什么腾讯是主源 ──
 * 实测东财 push2 有间歇性风控：同一请求连打 8 次，2 次直接 socket hang up，
 * 而且失败时连试 4 次全挂（按时间窗封禁，短时重试无效），成功率仅 75%。
 * 腾讯 qt.gtimg.cn 实测每次都通，且 a-stock-data skill 明确写了「腾讯不封 IP」。
 *
 * ── GBK 编码问题的解决 ──
 * 腾讯返回 GBK，我一开始以为 Node 原生不支持、必须引入 iconv-lite（违反零依赖约束），
 * 差点为此放弃腾讯改用东财。实测发现 **Node 原生 TextDecoder 支持 'gbk'**，
 * 一行 new TextDecoder('gbk').decode(buffer) 就解决了，零依赖。
 *
 * ── 腾讯字段索引（实测校准 2026-08，共 88 字段）──
 *   [1]  名称（GBK）        [2]  代码
 *   [3]  当前价             [4]  昨收         [5]  今开
 *   [6]  成交量（手）
 *   [31] 涨跌额             [32] 涨跌幅 %
 *   [33] 最高               [34] 最低
 *   [37] 成交额（万元）     [38] 换手率 %
 *   [39] PE(TTM)
 *   [44] 总市值（万元）     [45] 流通市值（万元）
 *   [46] PB
 */

const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ─────────────── 主源：腾讯财经 ─────────────── */

/** 代码 → 腾讯市场前缀 */
function txPrefix(code) {
  if (!/^\d{6}$/.test(code)) return null;
  if (code.startsWith('6') || code.startsWith('9')) return 'sh';
  if (code.startsWith('4') || code.startsWith('8')) return 'bj';   // 北交所
  return 'sz';
}

function fetchTencent(codes) {
  return new Promise((resolve, reject) => {
    const params = codes.map(c => txPrefix(c) + c).filter(Boolean).join(',');
    const req = http.get(`http://qt.gtimg.cn/q=${params}`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`腾讯行情 HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          // Node 原生支持 gbk，无需 iconv-lite
          const text = new TextDecoder('gbk').decode(Buffer.concat(chunks));
          const rows = [];
          for (const line of text.split('\n')) {
            const m = /v_\w+="([^"]*)"/.exec(line);
            if (!m || !m[1]) continue;
            const f = m[1].split('~');
            if (f.length < 47) continue;      // 停牌/退市数据不全，跳过
            rows.push({
              code:      f[2] || '',
              name:      (f[1] || '').trim(),
              price:     num(f[3]),
              prevClose: num(f[4]),
              open:      num(f[5]),
              volume:    num(f[6]),                       // 手
              change:    num(f[31]),
              changePct: num(f[32]),                      // %
              high:      num(f[33]),
              low:       num(f[34]),
              amount:    mul(num(f[37]), 10000),          // 万元 → 元
              turnover:  num(f[38]),                      // %
              pe:        num(f[39]),
              mcap:      mul(num(f[44]), 100000000),      // 亿元 → 元
              fmcap:     mul(num(f[45]), 100000000),      // 亿元 → 元
              pb:        num(f[46]),
              source:    'tencent',
            });
          }
          resolve(rows);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('腾讯行情超时')); });
    req.on('error', reject);
  });
}

/* ─────────────── 备用源：东财 push2 ─────────────── */

function emSecid(code) {
  if (!/^\d{6}$/.test(code)) return null;
  return (code.startsWith('6') || code.startsWith('9') ? '1.' : '0.') + code;
}

function fetchEastmoney(codes) {
  return new Promise((resolve, reject) => {
    const secids = codes.map(emSecid).filter(Boolean).join(',');
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
      + `?fltt=2&invt=2&secids=${encodeURIComponent(secids)}`
      + '&fields=f2,f3,f4,f5,f6,f8,f9,f12,f14,f15,f16,f17,f18,f20,f21,f23';
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`东财行情 HTTP ${res.statusCode}`));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const diff = JSON.parse(d)?.data?.diff;
          if (!diff) return resolve([]);
          const arr = Array.isArray(diff) ? diff : Object.values(diff);
          // 东财 ulist.np/get 返回的价格已是元（不是分），实测 f2=1309.59
          resolve(arr.map(it => ({
            code:      it.f12 || '',
            name:      it.f14 || '',
            price:     num(it.f2),
            changePct: num(it.f3),
            change:    num(it.f4),
            volume:    num(it.f5),
            amount:    num(it.f6),
            turnover:  num(it.f8),
            pe:        num(it.f9),
            high:      num(it.f15),
            low:       num(it.f16),
            open:      num(it.f17),
            prevClose: num(it.f18),
            mcap:      num(it.f20),
            fmcap:     num(it.f21),
            pb:        num(it.f23),
            source:    'eastmoney',
          })));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('东财行情超时')); });
    req.on('error', reject);
  });
}

/* ─────────────── 对外接口 ─────────────── */

/**
 * 批量查询实时行情。腾讯主源失败自动降级到东财。
 * @param {string[]} codes 6 位代码列表
 */
async function quote(codes) {
  const list = (Array.isArray(codes) ? codes : [codes])
    .map(c => String(c).trim())
    .filter(c => /^\d{6}$/.test(c));
  if (!list.length) return [];

  const errs = [];
  // 主源腾讯，失败重试 1 次
  for (let i = 0; i < 2; i++) {
    try {
      const rows = await fetchTencent(list);
      if (rows.length) return rows;
      errs.push('腾讯返回空');
    } catch (e) { errs.push('腾讯: ' + e.message); }
    if (i === 0) await sleep(300);
  }
  // 降级到东财，同样重试 1 次
  for (let i = 0; i < 2; i++) {
    try {
      const rows = await fetchEastmoney(list);
      if (rows.length) return rows;
      errs.push('东财返回空');
    } catch (e) { errs.push('东财: ' + e.message); }
    if (i === 0) await sleep(500);
  }
  throw new Error('两个行情源都失败 —— ' + errs.join('; '));
}

/** 单只查询，返回 null 表示查不到 */
async function single(code) {
  const rows = await quote([code]);
  return rows[0] || null;
}

function num(v) {
  if (v === '-' || v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function mul(v, k) { return v == null ? null : v * k; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { quote, single };
