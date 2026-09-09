'use strict';
/**
 * A 股 K 线（腾讯 ifzq 主源 + 新浪备用）
 *
 * 为什么不用东财？东财 push2his 跟 push2 一样有间歇性风控，
 * 实测连打会 socket hang up，腾讯 ifzq 稳得多。
 *
 * 腾讯接口格式：
 *   { code:0, data:{ sh600519:{ day:[["2026-06-15","1292.700","1271.100","1292.700","1270.100","41586.000"], ...] } } }
 *   每根: [日期, 开盘, 收盘, 最高, 最低, 成交量(手)]
 *
 * qfqday = 前复权，day = 不复权
 */

const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ══════════ 指数代码白名单 ══════════
 *
 * 这是一个静默产出错误数据的真 bug，实测发现：
 *
 *   周报里标注「上证指数」的周线，实际拿到的是**平安银行股价 11.78 元**
 *   （上证指数应在 3000-4000 量级）
 *
 * 根因：指数代码不遵守个股的市场前缀规则。
 *   个股规则：6/9 开头 → sh，其余 → sz
 *   但 000001 既是「上证指数」(sh000001) 也是「平安银行」(sz000001)
 *   按个股规则走，000001 落到 sz → 拿回平安银行
 *
 * 后果比"取不到数"严重得多：接口正常返回、不报错，
 * 周报里所有"大盘周线走势"的结论都是基于一只银行股算的。
 * **错的行情比没有行情更危险** —— 这正是拒绝 L3 自动改数据源代码的理由。
 *
 * 修法：显式白名单。指数数量有限且固定，穷举比猜规则可靠。
 * key 是纯 6 位代码，value 是正确的市场前缀。 */
const INDEX_MARKET = {
  '000001': 'sh',   // 上证指数   ← 与平安银行(sz000001)同号，最危险的一个
  '000300': 'sh',   // 沪深300
  '000905': 'sh',   // 中证500
  '000852': 'sh',   // 中证1000
  '000016': 'sh',   // 上证50
  '000688': 'sh',   // 科创50
  '000010': 'sh',   // 上证180
  '399001': 'sz',   // 深证成指
  '399006': 'sz',   // 创业板指
  '399005': 'sz',   // 中小100
  '399300': 'sz',   // 沪深300（深市代码，与 sh000300 同一指数）
  '399905': 'sz',   // 中证500（深市代码）
};

/** 这个代码是指数吗（用于决定要不要走指数专用逻辑） */
function isIndexCode(code) {
  return Object.prototype.hasOwnProperty.call(INDEX_MARKET, String(code));
}

function txPrefix(code, forced) {
  if (!/^\d{6}$/.test(code)) return null;
  // 显式指定的市场优先级最高（调用方明确知道自己要什么）
  if (forced && forced.market) return forced.market;
  /* 指数优先查白名单 —— 必须放在个股规则之前，
   * 否则 000001 会被当成深市个股（就是上面说的那个 bug）。 */
  if (INDEX_MARKET[code]) return INDEX_MARKET[code];
  if (code.startsWith('6') || code.startsWith('9')) return 'sh';
  return 'sz';
}

function fetchTencent(code, period, limit, adjust, forced) {
  return new Promise((resolve, reject) => {
    const pre = txPrefix(code, forced);
    if (!pre) return reject(new Error('无效代码: ' + code));
    // 周期: day / week / month
    // 复权: qfq=前复权 hfq=后复权 空=不复权
    const fq = adjust === 'forward' ? 'qfq' : adjust === 'backward' ? 'hfq' : '';
    const field = fq ? fq + period : period;
    // 腾讯 kline 接口一次最多 320 根左右
    const lmt = Math.min(limit, 280);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${pre}${code},${period},,,${lmt},${fq}`;
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const stock = j?.data?.[pre + code];
          if (!stock) return resolve(null);
          // 腾讯的字段名可能是 day / week / month / qfqday / hfqday
          const arr = stock[field] || stock[period];
          if (!arr || !arr.length) return resolve(null);
          const name = stock.name || code;
          const bars = arr.map(row => ({
            date:  row[0],
            open:  num(row[1]),
            close: num(row[2]),
            high:  num(row[3]),
            low:   num(row[4]),
            volume:num(row[5]),
          }));
          resolve({ code, name, period, adjust: fq || 'none', bars, source: 'tencent' });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('腾讯K线超时')); });
    req.on('error', reject);
  });
}

/** 备用源：新浪，字段齐全但接口结构不同 */
function fetchSina(code, period, limit, forced) {
  return new Promise((resolve, reject) => {
    const pre = txPrefix(code, forced);   // 新浪也用 sh/sz 前缀
    if (!pre) return reject(new Error('无效代码'));
    // scale: 240=日线 120=周线 30=月线 ...
    const scale = { day: 240, week: 120, month: 30 }[period] || 240;
    const lmt = Math.min(limit, 260);
    const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${pre}${code}&scale=${scale}&ma=no&datalen=${lmt}`;
    const req = https.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(d);
          if (!Array.isArray(arr) || !arr.length) return resolve(null);
          const bars = arr.map(row => ({
            date:  row.day,
            open:  num(row.open),
            close: num(row.close),
            high:  num(row.high),
            low:   num(row.low),
            volume: num(row.volume) ? num(row.volume) / 100 : null,  // 新浪单位是股，转手 /100
          }));
          resolve({ code, name: code, period, adjust: 'none', bars, source: 'sina' });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('新浪K线超时')); });
    req.on('error', reject);
  });
}

/**
 * 取 K 线，腾讯主源失败降级到新浪。
 * @param {string} code 6位代码
 * @param {string} period day/week/month
 * @param {number} limit 根数
 * @param {string} adjust none/forward/backward
 */
/**
 * 拉 K 线。
 *
 * @param {string} code   6 位代码。**指数与个股同号时默认取指数**
 *                        （000001 → 上证指数）。要强制取个股，
 *                        用带前缀写法 'sz000001'，或传 opts.market='sz'。
 * @param {object} [opts] { market:'sh'|'sz' } 显式指定市场，覆盖白名单判断
 */
async function kline(code, period = 'day', limit = 60, adjust = 'none', opts = {}) {
  const list = ['day', 'week', 'month'];
  if (!list.includes(period)) period = 'day';

  /* 支持 'sz000001' / '000001.SZ' 这类显式写法 ——
   * 修完指数 bug 后 000001 默认返回上证指数，
   * 必须留一条路让"真想查平安银行"仍然可行，
   * 否则就是修一个 bug 造一个新 bug。 */
  let market = opts.market || null;
  let pure = String(code).trim();
  let m;
  if ((m = /^(sh|sz|bj)(\d{6})$/i.exec(pure))) { market = m[1].toLowerCase(); pure = m[2]; }
  else if ((m = /^(\d{6})\.(sh|sz|bj)$/i.exec(pure))) { market = m[2].toLowerCase(); pure = m[1]; }
  const forced = market ? { market } : null;

  let lastErr;
  // 腾讯（前复权/后复权/不复权都支持）
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetchTencent(pure, period, limit, adjust, forced);
      if (r && r.bars.length) return r;
      lastErr = new Error('腾讯返回空');
    } catch (e) { lastErr = e; }
    if (i === 0) await new Promise(r => setTimeout(r, 300));
  }
  // 新浪（只支持不复权）
  if (adjust === 'none') {
    try {
      const r = await fetchSina(pure, period, limit, forced);
      if (r && r.bars.length) return r;
    } catch (_) {}
  }
  throw new Error(`K线获取失败：${lastErr?.message || '未知'}`);
}

/** 在 K 线上算常用指标，喂给模型省得它自己算 */
function indicators(bars) {
  if (!bars || bars.length < 3) return null;
  const closes = bars.map(b => b.close).filter(v => v != null);
  const n = closes.length;
  const ma = k => {
    if (n < k) return null;
    return +(closes.slice(-k).reduce((a, b) => a + b, 0) / k).toFixed(2);
  };
  const last = closes[n - 1];
  const high = Math.max(...bars.map(b => b.high).filter(v => v != null));
  const low = Math.min(...bars.map(b => b.low).filter(v => v != null));
  const first = closes[0];
  const totalPct = first ? +(((last - first) / first) * 100).toFixed(2) : null;

  // 年化波动率
  const rets = [];
  for (let i = 1; i < n; i++) {
    if (closes[i - 1]) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  let vol = null;
  if (rets.length > 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    vol = +(Math.sqrt(varc) * Math.sqrt(250) * 100).toFixed(2);
  }

  return {
    bars_count: n,
    latest_close: last,
    period_high: high,
    period_low: low,
    period_change_pct: totalPct,
    ma5: ma(5), ma10: ma(10), ma20: ma(20), ma60: ma(60),
    annualized_volatility_pct: vol,
    position_in_range_pct: (high > low) ? +(((last - low) / (high - low)) * 100).toFixed(1) : null,
  };
}

function num(v) {
  if (v == null || v === '-' || v === '') return null;
  const x = Number(v);
  return isFinite(x) ? x : null;
}

module.exports = { kline, indicators };
