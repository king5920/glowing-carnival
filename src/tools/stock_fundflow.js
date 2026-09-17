'use strict';
/**
 * ══════════════ 个股资金流拆解 ══════════════
 *
 * 补上健康表里挂了很久却**从没有人调用**的那个源。
 *
 * ══ 为什么它一直是"未探测" ══
 * `stock.fundflow` 在 source_health 里注册了、在 self_diagnose 里有候选 URL，
 * 但整个代码库里**没有任何函数真的去请求它**。
 * 于是健康灯显示"降级/不可用"，实际是"根本没人用过"。
 *
 * 这比真的坏掉更有害：面板上一个红灯长期亮着，
 * 时间久了人就把它当背景噪声，真出问题时也不会去看。
 *
 * ══ 数据来源与备用源（实测，2026-09，光环新网 300383）══
 *   push2delay.eastmoney.com/fflow  → HTTP200 143ms **有数据** ✅
 *   push2.eastmoney.com/fflow       → socket hang up（主域被封）
 *   qt.gtimg.cn                     → 只有行情，**确实没有**资金流拆解
 *
 * 所以：
 *   - 腾讯**不能**当备用源（这是之前的正确判断，保留）
 *   - 真备用源是同一接口的 push2delay 镜像域名
 *     —— 同字段、同语义，只是延时行情域名，和 sector 用的是同一套降级思路
 *
 * em_client 已经知道 push2delay 优先且带防风控队列，直接复用。
 */

const em = require('./em_client');
const health = require('./source_health');
const db = require('../db');
const https = require('https');

const SOURCE = 'stock.fundflow';

/* 东财 fflow 接口的字段含义（f51-f55）。
 * 顺序是固定的，靠位置解析 —— 官方没有文档，这是实测确认的：
 *   f51 日期
 *   f52 主力净流入（元）
 *   f53 小单净流入
 *   f54 中单净流入
 *   f55 大单净流入
 * 注意单位是**元**，不是万元 —— 实测 -48256823.0 这种量级。 */
const FIELDS2 = 'f51,f52,f53,f54,f55';
const FIELDS1 = 'f1,f2,f3,f7';

/** 6 位代码 → 东财 secid。0=深市 1=沪市 */
function toSecid(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) throw new Error('股票代码必须是 6 位数字：' + code);
  /* 沪市：60/68 开头（主板/科创板）；其余（00/30/002/300）为深市。
   * 这里不处理指数 —— 指数没有资金流拆解，
   * 传指数代码会拿到空数据，属于调用方的错。 */
  const sh = /^(60|68|9)/.test(c);
  return (sh ? '1.' : '0.') + c;
}

/* ══════ 新浪资金流历史（真备用源，独立风控面）══════
 *
 * 为什么需要它：东财 fflow 系接口**每次只返回当天一行**。
 * 实测（2026-09-09 18:08 收盘后，茅台/平安银行/中国平安/中科曙光全试）：
 *   push2delay .../fflow/kline/get?lmt=10      → 1 行
 *   push2      .../fflow/kline/get?lmt=10      → 1 行
 *   push2his   .../fflow/daykline/get?lmt=0    → 本机 TCP 层被拦（连接被意外关闭）
 *   datacenter RPT_DMSK_TS_STOCKNEW?pageSize=10 → 1 行
 *
 * 而新浪 MoneyFlow 一次给 30 天，**且是完全不同的域名和风控面** ——
 * 东财被封时它不受牵连。这符合本项目对"真备用源"的定义：
 * 不同域名、独立风控、同类数据。
 *
 * ── 口径差异必须说清楚，不能混为一谈 ──
 * 新浪 netamount 是**净流入总额**，没有主力/大单/中单/小单四档拆分。
 * 东财的 main（主力）才有四档口径。所以：
 *   · 当日四档拆解 → 用东财
 *   · 多日趋势     → 用新浪
 * 两者的数值不可直接相减比较，返回里用 caliber 字段标注来源口径。
 */
const SINA_HOST = 'vip.stock.finance.sina.com.cn';

function sinaPrefix(code) {
  const c = String(code);
  if (c.startsWith('6') || c.startsWith('9')) return 'sh';
  if (c.startsWith('8')) return 'bj';
  return 'sz';
}

/**
 * 取新浪资金流历史（多日）。
 *
 * @returns [{date, netAmount, close, turnover}] 旧→新排序
 * 失败抛异常（同 fundFlow 的规则：绝不静默返回空）
 */
function sinaFundFlowHistory(code, days = 30) {
  const daima = sinaPrefix(code) + String(code);
  const path = '/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs'
    + `?page=1&num=${Math.max(1, Math.min(Number(days) || 30, 120))}`
    + `&sort=opendate&asc=0&daima=${daima}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: SINA_HOST, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://finance.sina.com.cn/',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const s = text.indexOf('['), e = text.lastIndexOf(']');
        if (s < 0 || e <= s) {
          return reject(new Error('新浪返回结构异常（找不到 JSON 数组）'));
        }
        let arr;
        try { arr = JSON.parse(text.slice(s, e + 1)); }
        catch (err) { return reject(new Error('新浪 JSON 解析失败: ' + err.message)); }

        const rows = arr.map(x => ({
          date: String(x.opendate || '').slice(0, 10),
          netAmount: Number(x.netamount),
          close: Number(x.trade),
          turnover: Number(x.turnover),
        })).filter(r => r.date && Number.isFinite(r.netAmount));

        if (!rows.length) return reject(new Error('新浪资金流解析后为空'));
        rows.reverse();                        // 新浪是新→旧，反成旧→新
        resolve(rows);
      });
    });
    req.on('error', err => reject(new Error('新浪请求失败: ' + err.message)));
    req.setTimeout(15000, () => { req.destroy(new Error('新浪请求超时')); });
    req.end();
  });
}

/**
 * 查个股资金流拆解。
 *
 * @param code 6 位股票代码
 * @param days 取最近几天（默认 5）
 * @returns { code, secid, days: [{date, main, small, medium, large}], source }
 *
 * 失败时抛异常并记入健康表 —— **绝不返回空数组**。
 * 返回空数组会让模型以为"今天没有资金流动"，
 * 这是最危险的静默失败（和新闻源那条规则同一个理由）。
 */
async function fundFlow(code, days = 5) {
  /* ⚠ 参数校验必须在 try/health.record 之外。
   * 实测在 news.js 里踩过：校验写在 try 里，
   * 调用方传错代码会被记成**数据源故障**，
   * 跑几次参数测试健康灯就从 100% 掉到 14%，
   * 而接口其实完全正常。假故障会掩盖真故障。
   * 健康表只记录「数据源的健康」，不记录「调用方的手误」。 */
  const secid = toSecid(code);
  const lmt = Math.max(1, Math.min(Number(days) || 5, 60));
  const path = '/api/qt/stock/fflow/kline/get'
    + `?secid=${secid}&klt=101&lmt=${lmt}`
    + `&fields1=${FIELDS1}&fields2=${FIELDS2}`;

  let j;
  try {
    /* 走 em_client 的防风控队列（串行、keep-alive、熔断）。
     * 传完整 push2 URL —— em_client 会识别 push2 系列，
     * 自动先试 push2delay（已实测可用，主域 push2 被封）。 */
    const fullUrl = 'https://push2.eastmoney.com' + path;
    j = await em.emGetJson(fullUrl, { headers: { Referer: 'https://data.eastmoney.com/' } });
  } catch (e) {
    health.record(SOURCE, false, '请求失败: ' + e.message);
    throw new Error(`资金流接口不可用（${code}）：${e.message}`);
  }

  const klines = j && j.data && Array.isArray(j.data.klines) ? j.data.klines : null;
  if (!klines || !klines.length) {
    /* data 为 null 通常意味着：代码不存在、是指数、或当天还没有数据。
     * 必须区分"接口坏了"和"这只票确实没数据" ——
     * 前者要报警，后者不该污染健康统计。
     * 这里保守处理：记为失败但在消息里说明可能原因。 */
    const why = j && j.data === null
      ? '接口返回 data=null（代码不存在、是指数、或当日暂无数据）'
      : '返回结构异常';
    health.record(SOURCE, false, why);
    throw new Error(`资金流无数据（${code}）：${why}`);
  }

  const rows = klines.map(line => {
    const p = String(line).split(',');
    return {
      date: p[0],
      main: Number(p[1]),      // 主力净流入（元）
      small: Number(p[2]),
      medium: Number(p[3]),
      large: Number(p[4]),
    };
  }).filter(r => r.date && Number.isFinite(r.main));

  if (!rows.length) {
    health.record(SOURCE, false, 'klines 解析后为空');
    throw new Error(`资金流数据解析失败（${code}）`);
  }

  /* ══════ 数量短缺断言（用户 2026-09-09 定为第一优先）══════
   *
   * ── 用户的原话 ──
   * 「我连续两次告诉你"只有一天"，第三次才拿到 20 日序列……
   *   这个不修，我会继续给你错的判断，而且我自己不知道错了。
   *   这是最危险的一类 bug。」
   *
   * ── 但根因和最初的判断不同，必须写清楚 ──
   * 用户提的修法是 `len(klines) > 0`。**这条检查其实早就有**（上面 173 行），
   * 而且它**拦不住这个 bug** —— 因为返回的不是空数组。
   *
   * 实测：请求 `lmt=20`，klines 长度 = **1**。非空，所以旧检查全部通过，
   * 一路 health.record(true)，调用方拿到「成功 + 1 行」，
   * 于是我得出"数据本来就只有一天"的错误结论，并连着两次这样告诉用户。
   *
   * 真正的根因是：**要 20 给 1，没有任何人比较过 请求量 vs 返回量**。
   * 静默数量短缺比静默空返回更隐蔽 —— 空数组好歹显眼，
   * 「非空但远少于请求」看起来完全正常。
   *
   * ── 所以断言必须是"短缺"而不是"为空" ──
   * 请求 n 天却只回 1 天且 n 明显更大时，
   * 不能报成功，必须把这个事实**显式带出去**让调用方看见。
   *
   * 为什么不直接 throw：东财这个接口**设计上就只给当日**
   * （四个入口全试过，见文件头注释），throw 会让本来可用的当日数据也拿不到。
   * 所以改为：返回里带 shortfall 字段 + note 说明。
   *
   * ── 2026-09-11 修正：短缺 ≠ 故障 ──
   * 上面这套断言当初是对的（要 20 给 1 必须让人看见），
   * 但它把两件事混为一谈了，造成了一个更坏的后果：
   *
   *   东财 fflow **设计上就只给当日**（四个入口全试过，见文件头）。
   *   所以"请求 5 天只给 1 天"是这个接口的**固有能力上限**，不是故障。
   *   把固有特性 record(false)，等于让健康表**永远**降级：
   *   只要有人调用就报警，而且永远好不了。
   *
   * 实测后果：连续 36 次失败、横幅"已持续 2.5 天"，
   * 但同一时刻 fundFlow('600519') 明明成功返回了当日真实数据，
   * 新浪备用源也正常给出 10 天序列 —— 整条链路是通的。
   * 这就是"狼来了"：真出故障时用户已经不看这个横幅了。
   *
   * 修法：区分「接口坏了」和「接口能力有限」。
   *   · 当日数据拿到了            → 记成功（这是它的本职，做到了）
   *   · 多日缺口                  → 由 shortfall 字段 + note 显式带出去，
   *                                 调用方必须走 fundFlowSummary 用备用源补
   * 「让人看得见」的目标由返回值达成，不必靠污染健康表。
   * 健康表只回答一个问题：**这个源现在还能不能取到数据**。
   */
  const shortfall = (lmt >= 3 && rows.length < Math.min(lmt, 3))
    ? { requested: lmt, received: rows.length,
        reason: '上游只返回当日数据，多日历史需改用备用源（新浪 MoneyFlow）' }
    : null;

  /* 取到了当日数据就是成功 —— 哪怕只有一行。
   * 多日缺口是已知的接口上限，通过返回值里的 shortfall/note 告知调用方，不记为故障。
   * （health.record 在 ok=true 时不保存 reason，所以缺口说明只能走返回值，
   *   这也正是本次修正的用意：健康表管"通不通"，返回值管"全不全"。）*/
  health.record(SOURCE, true);

  /* ══ 每次取到就落库 ══
   *
   * 东财这个接口只给当天一行（实测见 db.js 里 fundflow_daily 的注释），
   * 所以历史只能自己攒。存了之后 fundFlowSummary 就能拼出真实趋势，
   * 回答"这波利好是持续流入还是一日游"。
   *
   * 落库失败不能影响取数 —— 用户要的是当天数据，
   * 攒历史是附带收益，不该因为写库出错就让整个查询失败。 */
  for (const d of rows) {
    try {
      db.saveFundFlow({
        code: String(code), date: d.date,
        name: (j.data && j.data.name) || null,
        main: d.main, small: d.small, medium: d.medium, large: d.large,
        source: 'eastmoney.push2delay',
      });
    } catch (e) { /* 落库失败不影响返回 */ }
  }

  return {
    code: String(code),
    secid,
    name: (j.data && j.data.name) || null,
    days: rows,
    requested: lmt,
    received: rows.length,
    /* 数量短缺必须出现在返回值里，不能只写在日志。
     * 调用方（含模型）看到 shortfall 非空就知道
     * 「这不是全部数据」，而不是误以为上游只有这么多。 */
    shortfall,
    /* warning：给"错误账本"的自首通道（brain.js 会记入 lessons）。
     * 本项目最危险的一类错就是"成功但数据残缺、表面全绿"——
     * 要20给1 正是 ok:true，普通的失败记账抓不到，只能靠工具自己上报。 */
    warning: shortfall ? {
      pattern: '把空/残缺结果当成功',
      expected: `请求 ${lmt} 天资金流序列`,
      actual: `上游只返回 ${rows.length} 天`,
      rootCause: '东财 fflow 仅给当日，多日序列需走新浪备用源',
      guard: '多日趋势必须用 fundFlowSummary（含新浪备用源），不能拿单日当历史；断言 received 与 requested',
    } : undefined,
    /* 明确告知用的是延时域名 —— 不能让调用方以为是实时数据。
     * 「静默降级」和「静默失败」一样有害。 */
    source: 'eastmoney.push2delay',
    note: '主力/大单口径为东财独家；数据来自延时行情域名（主域 push2 已被封）'
      + (shortfall
        ? `｜⚠ 请求 ${lmt} 天但上游只返回 ${rows.length} 天，这不是全部历史，多日趋势请用 fundFlowSummary（走新浪备用源）`
        : ''),
  };
}

/**
 * 给模型看的摘要：当日四档拆解 + 多日趋势。
 *
 * ══ 双源合并，各取所长 ══
 * 用户的原话：「韶关算力这个利好落到哪些票上，得看主力净流入才能确认，
 * 现在我只能从涨幅和换手倒推」。
 *
 * 单日数据答不了这个问题 —— 分不清**持续流入**还是**一日游**。
 * 但东财 fflow 每次只给当天一行（四个域名全试过，见文件头注释）。
 *
 * 解法是双源：
 *   · 东财 → 当日主力/大单/中单/小单四档拆解（它独有）
 *   · 新浪 → 30 天净流入历史（独立风控面，东财被封也能用）
 *
 * 口径不同不能混算：新浪只有净流入总额，没有主力口径。
 * 所以趋势用新浪算，四档拆解用东财报，返回里分别标注。
 *
 * 新浪挂了就退回本地累积的历史（fundflow_daily 表），
 * 三层都没有才只报当日 —— 并**明确说明趋势不可判**，不假装有结论。
 */
async function fundFlowSummary(code, days = 5) {
  const r = await fundFlow(code, days);
  const fmt = v => (v / 1e4).toFixed(1) + '万';
  const today = r.days[r.days.length - 1] || null;

  /* ── 多日趋势：新浪优先，本地库兜底 ── */
  let series = [], caliber = null, trendSource = null;
  try {
    const sina = await sinaFundFlowHistory(code, Math.max(days, 20));
    series = sina.map(d => ({ date: d.date, net: d.netAmount, close: d.close }));
    caliber = '净流入总额（新浪口径，无主力/大单拆分）';
    trendSource = 'sina.moneyflow';
  } catch (e) {
    try {
      const local = db.fundFlowHistory(code, Math.max(days, 20)).slice().reverse();
      if (local.length) {
        series = local.map(d => ({ date: d.date, net: d.main, close: null }));
        caliber = '主力净流入（东财口径，本地累积）';
        trendSource = 'local.fundflow_daily';
      }
    } catch (_) { /* 本地库也没有就留空 */ }
  }

  /* ── 趋势判断：样本不足就不给结论 ── */
  let trend = null;
  if (series.length >= 3) {
    const last3 = series.slice(-3);
    const inDays = series.filter(d => d.net > 0).length;
    trend = last3.every(d => d.net > 0) ? '连续 3 日净流入'
      : last3.every(d => d.net < 0) ? '连续 3 日净流出'
        : `震荡（${series.length} 日中 ${inDays} 日净流入）`;
  }

  /* ── 组装文本 ── */
  const parts = [];
  if (today) {
    parts.push(`${r.name || r.code} ${today.date} 当日四档（东财）：`
      + `主力${fmt(today.main)} 大单${fmt(today.large)} `
      + `中单${fmt(today.medium)} 小单${fmt(today.small)}`);
  }
  if (series.length) {
    const total = series.reduce((s, d) => s + d.net, 0);
    parts.push(`近 ${series.length} 日${trend ? '：' + trend : '（不足 3 日，不做趋势判断）'}`
      + `，累计 ${fmt(total)}　[${caliber}]`);
    parts.push(series.slice(-10).map(d =>
      `  ${d.date} ${fmt(d.net)}` + (d.close ? ` 收${d.close}` : '')).join('\n'));
  } else {
    parts.push('多日历史暂不可用（新浪与本地库均无数据），**无法判断是否持续流入**');
  }

  return {
    code: r.code,
    name: r.name,
    text: parts.join('\n'),
    today: today ? {
      date: today.date, main: today.main, large: today.large,
      medium: today.medium, small: today.small,
    } : null,
    trend,
    trendDays: series.length,
    trendSource,
    caliber,
    totalNet: series.length ? series.reduce((s, d) => s + d.net, 0) : null,
    source: r.source,
    note: r.note
      + '；东财 fflow 每次只返回当日，多日趋势取自新浪 MoneyFlow（独立风控面）'
      + '。两者口径不同：东财有主力/大单四档，新浪只有净流入总额，数值不可直接互减',
  };
}

module.exports = { fundFlow, fundFlowSummary, sinaFundFlowHistory, toSecid, SOURCE };
