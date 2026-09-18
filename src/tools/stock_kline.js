'use strict';
/**
 * A 股 K 线：日/周/月 + 分钟级（1/5/15/30/60 分）+ 当日分时
 *
 * ── 日/周/月 ──（既有，腾讯主、新浪备）
 *
 * ── 分钟级（2026-09-11 新增，三个源都在本机真请求验证过）──
 *
 *   没有任何一个免费源能单独覆盖全部周期 + 长历史 + 指数，所以按周期选源：
 *
 *   东财 push2his  1/5/15/30/60 都给、当天最快(40-280ms)、支持前后复权；
 *                  但 1 分只给当天约240根，且**指数分钟K返0行**，住宅IP偶发风控
 *                  → 盘中盯盘主源（走 em_client 节流/换域名/熔断）
 *   同花顺 d.10jqka 码 60=1分(~60天) / 41=30分(回到2023-08,5896根)
 *                  / 51=60分(回到2023) / 01=日；**指数 hs_1A0001 可用**；
 *                  但没有 5/15 分，列序是 开-高-低-收
 *                  → 30/60 分长历史 + 指数分钟K 主源
 *   新浪(现有备用) 1/5/15/30/60 都给、指数也给，每种最多约1023根、仅不复权
 *                  → 通用兜底
 *
 *   1 分：东财(当天,最快) → 新浪 → 同花顺
 *   5/15 分：东财 → 新浪
 *   30/60 分：同花顺(历史深) → 东财 → 新浪
 *   指数分钟：同花顺 → 新浪（东财不给）
 *
 * 分时（当日逐分钟）：腾讯 minute/query（既有实测可用）。
 *
 * 字段全部归一成 { date, open, close, high, low, volume }；
 * 分钟K 的 date 是 'YYYY-MM-DD HH:mm'，日K 是 'YYYY-MM-DD'。
 *
 * ⚠ 同花顺列序是 开/高/低/收（不是东财的 开/收/高/低），接反会让 high/low 互换。
 * ⚠ 东财分钟历史：5分实测可取到约7个月，1分仅当天——别向用户承诺"几年1分历史"。
 */

const https = require('https');
/* 东财请求统一走 em_client（串行节流 + push2 域名切换 + 熔断），
 * 东财有住宅IP风控，裸 https 连打会 socket hang up。 */
let _em;
function emClient() { if (!_em) _em = require('./em_client'); return _em; }

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

/* INDEX_MARKET 的中文名。腾讯 j.data[pre+code].name 对指数经常不返回
 * （只给代码），面板标题就会显示"000001"而不是"上证指数"——与上面那个
 * "000001=银行股"的 bug 同类：**错的身份比没有身份更危险**。
 * key 与 INDEX_MARKET 一一对应，新增指数时两处一起加。 */
const INDEX_NAMES = {
  '000001': '上证指数', '000300': '沪深300', '000905': '中证500',
  '000852': '中证1000', '000016': '上证50', '000688': '科创50',
  '000010': '上证180', '399001': '深证成指', '399006': '创业板指',
  '399005': '中小100', '399300': '沪深300', '399905': '中证500',
};

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

/* ══════════════════════════════════════════════════════════════
 * 分钟级 K 线（m1/m5/m15/m30/m60）
 * ══════════════════════════════════════════════════════════════ */

/* 支持的分钟周期 → 各源周期参数 */
const MINUTE_PERIODS = {
  // tx: 腾讯 mkline 支持的周期名（m1 走别的当日分时端点，这里不给）
  m1: { minutes: 1, em: 1, sina: 1, ths: '60', tx: null },
  m5: { minutes: 5, em: 5, sina: 5, ths: null, tx: 'm5' },
  m15: { minutes: 15, em: 15, sina: 15, ths: null, tx: 'm15' },
  m30: { minutes: 30, em: 30, sina: 30, ths: '41', tx: 'm30' },
  m60: { minutes: 60, em: 60, sina: 60, ths: '51', tx: 'm60' },
};

/* 东财 secid：沪市股票 1. / 深市 0.；指数 1.000xxx(沪) 0.399xxx(深)。
 * 注意 000001 既是平安银行(0.000001)也是上证指数(1.000001) ——
 * 这里必须尊重调用方语义：isIndexCode 命中白名单的按指数取，其余按个股。 */
function emSecid(pure, market, isIndex) {
  if (isIndex) {
    /* 指数白名单给的前缀就是权威市场 */
    return (market === 'sz' ? '0.' : '1.') + pure;
  }
  return (pure.startsWith('6') || pure.startsWith('9') ? '1.' : '0.') + pure;
}

/* 同花顺指数代码：上证指数用 1A0001；深证成指 399001 等用原码（hs_ 前缀实测可用）。
 * 个股直接 6 位码。 */
function thsCode(pure, isIndex, market) {
  if (isIndex) {
    if (pure === '000001') return '1A0001';     // 上证指数
    return pure;                                 // 1A0001 之外的指数(399xxx等)用原码
  }
  return pure;
}

/** 东财分钟K（盘中主源，支持前/后复权）。只返回 bars 或 null。 */
async function fetchEastmoneyMinute(pure, period, limit, adjust, forced, isIndex) {
  const cfg = MINUTE_PERIODS[period];
  const market = forced && forced.market;
  const secid = emSecid(pure, market, isIndex);
  const fqt = adjust === 'forward' ? 1 : adjust === 'backward' ? 2 : 0;
  /* 东财 lmt 上限较大；1分接口实测只给当天，5/15/30/60 可给数月，封顶 2000 防呆 */
  const lmt = Math.min(Math.max(limit, 1), 2000);
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
    + `&klt=${cfg.em}&fqt=${fqt}&beg=0&end=20500101&lmt=${lmt}`;
  const j = await emClient().emGetJson(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
  const kl = j && j.data && j.data.klines;
  if (!kl || !kl.length) return null;
  /* 每根: "2026-09-11 10:00,开,收,高,低,量,额,振幅"（开收高低） */
  const bars = kl.map(line => {
    const p = line.split(',');
    return { date: p[0], open: num(p[1]), close: num(p[2]), high: num(p[3]), low: num(p[4]), volume: num(p[5]) };
  });
  return { code: pure, name: j.data.name || pure, period, adjust: adjust || 'none', bars, source: 'eastmoney' };
}

/** 同花顺分钟K（30/60分历史深 + 指数可用）。JSONP 剥壳。 */
function fetchThsMinute(pure, period, limit, isIndex, market) {
  const ty = MINUTE_PERIODS[period] && MINUTE_PERIODS[period].ths;
  if (!ty) return Promise.resolve(null);
  const code = thsCode(pure, isIndex, market);
  const url = `https://d.10jqka.com.cn/v6/line/hs_${code}/${ty}/last.js`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Referer: 'http://stockpage.10jqka.com.cn/' },
      timeout: 8000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = d.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
          const j = JSON.parse(json);
          const rows = String(j.data || '').split(';').filter(Boolean);
          if (!rows.length) return resolve(null);
          /* 每根: "YYYYMMDDHHmm,开,高,低,收,量,额,..."（开高低收 —— 与东财不同！） */
          let bars = rows.map(line => {
            const p = line.split(',');
            const ts = p[0];
            const date = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)} ${ts.slice(8,10)}:${ts.slice(10,12)}`;
            return { date, open: num(p[1]), high: num(p[2]), low: num(p[3]), close: num(p[4]), volume: num(p[5]) };
          });
          /* last.js 最近的在前？实测数据按时间正序；统一保证升序 */
          bars = bars.filter(b => b.close != null);
          if (bars.length >= 2 && bars[0].date > bars[1].date) bars.reverse();
          if (limit < bars.length) bars = bars.slice(bars.length - limit);
          resolve({ code: pure, name: j.name || code, period, adjust: 'none', bars, source: '10jqka' });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('同花顺分钟K超时')); });
    req.on('error', reject);
  });
}

/** 新浪分钟K（通用兜底，仅不复权，每种最多约 1023 根）。复用 fetchSina，scale 用分钟数。 */
async function fetchSinaMinute(pure, period, limit, forced) {
  const scale = MINUTE_PERIODS[period].sina;
  /* fetchSina 的 scale 表只认日/周/月，这里直接发分钟请求，单独实现以便带 limit */
  const pre = txPrefix(pure, forced);
  if (!pre) throw new Error('无效代码');
  const lmt = Math.min(Math.max(limit, 1), 1023);
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${pre}${pure}&scale=${scale}&ma=no&datalen=${lmt}`;
  const r = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA }, timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('新浪分钟K超时')); });
    req.on('error', reject);
  });
  if (!Array.isArray(r) || !r.length) return null;
  const bars = r.map(row => ({
    date: String(row.day).replace(' ', ' ').slice(0, 16),
    open: num(row.open), close: num(row.close), high: num(row.high), low: num(row.low),
    volume: num(row.volume) ? num(row.volume) / 100 : null,
  }));
  return { code: pure, name: pure, period, adjust: 'none', bars, source: 'sina' };
}

/**
 * 腾讯分钟K（2026-09-13 新增备胎）—— ifzq mkline 端点。
 * 本机实测（不封 IP、住宅 IP 稳定）：m5/m15/m30/m60 各可取约 320 根，
 * 上证 sh000001、创业板 sz399006 等**指数分钟K也给**——正好补上
 * "东财不给指数分钟、同花顺指数尾部滞后"的短板。仅不复权。
 *
 * 列序实测：[时间, 开, 收, 高, 低, 量, {}, 额]（开收高低，与东财一致）。
 * 只返回 bars 或 null，供选源链统一降级。
 */
function fetchTencentMinute(pure, period, limit, forced, isIndex) {
  const txName = MINUTE_PERIODS[period] && MINUTE_PERIODS[period].tx;
  if (!txName) return Promise.resolve(null);
  const pre = txPrefix(pure, forced);
  if (!pre) return Promise.resolve(null);
  const lmt = Math.min(Math.max(limit, 1), 1000);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${pre}${pure},${txName},,${lmt}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, timeout: 9000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const node = j.data && j.data[pre + pure];
          const rows = node && node[txName];
          if (!Array.isArray(rows) || !rows.length) return resolve(null);
          let bars = parseTencentMinuteRows(rows);
          if (bars.length >= 2 && bars[0].date > bars[1].date) bars.reverse();
          if (limit < bars.length) bars = bars.slice(bars.length - limit);
          resolve({ code: pure, name: pure, period, adjust: 'none', bars, source: 'tencent' });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('腾讯分钟K超时')); });
    req.on('error', reject);
  });
}

/** 取分钟K：按周期选源、逐个降级。isIndex 决定东财/同花顺的指数路径。 */
async function fetchMinute(pure, period, limit, adjust, forced, isIndex) {
  let chain;
  if (isIndex) {
    /* 指数分钟K：东财返0行；同花顺指数尾部会滞后到前一天（盯盘大忌）；
     * 腾讯 mkline 本机实测给指数实时分钟K且稳定 → 指数走 腾讯(实时)→新浪→同花顺(补历史)。 */
    chain = ['tencent', 'sina', 'ths'];
  } else if (period === 'm30' || period === 'm60') {
    /* 30/60 分历史深：同花顺优先；要复权时同花顺给不了，东财补；腾讯做实时备胎 */
    chain = adjust && adjust !== 'none'
      ? ['eastmoney', 'ths', 'tencent', 'sina']
      : ['ths', 'eastmoney', 'tencent', 'sina'];
  } else if (period === 'm1') {
    chain = ['eastmoney', 'sina', 'ths'];
  } else {
    /* m5/m15 同花顺没有；东财 push2his 本机会被 TCP 拦；腾讯实测稳定 → 东财→腾讯→新浪 */
    chain = ['eastmoney', 'tencent', 'sina'];
  }

  let lastErr;
  for (const src of chain) {
    try {
      let r = null;
      if (src === 'eastmoney') r = await fetchEastmoneyMinute(pure, period, limit, adjust, forced, isIndex);
      else if (src === 'ths') r = await fetchThsMinute(pure, period, limit, isIndex, forced && forced.market);
      else if (src === 'sina') r = await fetchSinaMinute(pure, period, limit, forced);
      else if (src === 'tencent') r = await fetchTencentMinute(pure, period, limit, forced, isIndex);
      if (r && r.bars && r.bars.length) return r;
      lastErr = new Error(src + ' 返回空');
    } catch (e) { lastErr = e; }
  }
  throw new Error(`分钟K(${period})获取失败：${lastErr ? lastErr.message : '未知'}`);
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
  const dayList = ['day', 'week', 'month'];
  const isMinute = Object.prototype.hasOwnProperty.call(MINUTE_PERIODS, period);
  if (!dayList.includes(period) && !isMinute) period = 'day';

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

  /* 指数判定：显式带 sz 前缀/opts.market=sz 是"我就要个股"，
   * 否则裸 000001 命中白名单按指数（上证指数）处理。 */
  const indexHit = isIndexCode(pure);
  const treatAsIndex = indexHit && !market;
  const effMarket = market || (indexHit ? INDEX_MARKET[pure] : null);
  const effForced = effMarket ? { market: effMarket } : forced;

  /* ── 分钟级走独立选源链 ── */
  if (isMinute) {
    return fetchMinute(pure, period, limit, adjust, effForced, treatAsIndex);
  }

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

module.exports = {
  kline, indicators,
  MINUTE_PERIODS,
  emSecid, thsCode,
  INDEX_MARKET, INDEX_NAMES, isIndexCode,
  parseThsMinuteRows: (rows, period) => parseThsRows(rows, period),
  parseTencentMinuteRows,
};

/* 供测试：把腾讯 mkline 行 [时间,开,收,高,低,量,...] 解析成标准 bar（开收高低） */
function parseTencentMinuteRows(rows) {
  return (rows || []).map(p => ({
    date: `${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6, 8)} ${p[0].slice(8, 10)}:${p[0].slice(10, 12)}`,
    open: num(p[1]), close: num(p[2]), high: num(p[3]), low: num(p[4]), volume: num(p[5]),
  })).filter(b => b.close != null);
}

/* 供测试：把同花顺 data 行解析成标准 bar（锁定 开高低收 列序） */
function parseThsRows(dataStr, period) {
  return String(dataStr || '').split(';').filter(Boolean).map(line => {
    const p = line.split(',');
    const ts = p[0];
    return {
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`,
      open: num(p[1]), high: num(p[2]), low: num(p[3]), close: num(p[4]), volume: num(p[5]),
    };
  });
}
