'use strict';
/**
 * 盘前简报 —— 交易日开盘前半小时（约 08:55）自动采集整理
 *
 * ══════ 用户 2026-09-10 要求 ══════
 * 「每天开盘前半小时进行信息的采集并整理出利好和利空，个股可以过滤掉」
 *
 * 边界：
 *   - 只采【宏观 / 政策 / 行业 / 板块】层面的信息，显式过滤个股新闻
 *   - 整理成 利好 / 利空 / 中性 三栏，每条带来源和时间
 *   - 先只在网页和记忆里，不推飞书（沿用"先看几天再开推送"）
 *   - 非交易日不跑（由 clock 交易日历决定）
 *   - 分类靠模型，但【喂给模型的素材必须是真实抓到的新闻】，
 *     模型不能凭空补新闻；抓不到就明说（坏了明说原则）
 */

const news = require('./news');
const clock = require('../clock');
const llm = require('../llm');

/* 个股特征：6位代码、"XX股份/集团"式简称、个股快讯常见前缀。
 * 过滤偏保守——拿不准是个股还是行业时，保留（宁多勿漏宏观信息）。 */
const STOCK_CODE_RE = /(?:[（(]?\s*)(?:SH|SZ|BJ)?\s*\d{6}(?:\s*[)）])?/i;
/* 常见个股新闻里的"公司动作"措辞，但宏观稿也可能用，所以只作弱信号，
 * 真正的过滤以"标题里出现6位代码"这种强特征为主。 */
function looksLikeSingleStock(item) {
  const t = `${item.title || ''} ${item.detail || ''}`;
  if (STOCK_CODE_RE.test(t)) return true;
  return false;
}

/**
 * 从快讯里筛出宏观/行业层面，去掉个股。
 * 财联社电报本身以宏观和板块为主，个股条目通常带代码。
 */
function filterMacro(rows) {
  const kept = [], dropped = [];
  for (const r of rows) {
    if (looksLikeSingleStock(r)) dropped.push(r.title);
    else kept.push(r);
  }
  return { kept, dropped };
}

const CLASSIFY_SYSTEM = `你是A股盘前信息分析师。把给你的盘前快讯分成【利好】【利空】【中性】三类，
只针对大盘、宏观政策、行业板块的影响判断，不要分析任何个股买卖。

铁律：
1. 只能使用用户提供的新闻条目，禁止补充、想象、引用你记忆里的其它新闻。
2. 每条必须保留来源时间；信息不足以判断方向的归"中性"。
3. 站在对A股整体/板块的影响角度：提振风险偏好、流动性宽松、政策扶持=利好；
   收紧、监管、外部冲突、外围大跌=利空。
4. 输出严格的 JSON：{"bullish":[{t,why}],"bearish":[{t,why}],"neutral":[{t,why}]}，
   t 用原标题，why 一句话说清对市场的影响。不要输出 JSON 以外的内容。`;

/**
 * 生成盘前简报。
 * @returns {ok,date,session,source,bullish,bearish,neutral,filteredCount,rawCount,text,error?}
 */
async function briefing(opts = {}) {
  const now = opts.now || new Date();
  const dateKey = clock.dateKey(now);

  const out = {
    ok: false, date: dateKey,
    session: clock.tradingSession(now).label || '',
  };

  let feed;
  try {
    feed = await news.marketNews(opts.limit || 40);
  } catch (e) {
    /* 两个新闻源都挂时 marketNews 抛错 —— 必须明说，绝不编造"今晨平静" */
    return { ...out, error: '盘前快讯获取失败：' + e.message + '。请稍后手动重试或查看财经终端。' };
  }

  const all = feed.news || [];
  const { kept, dropped } = filterMacro(all);
  out.source = feed.source;
  out.degraded = !!feed.degraded;
  out.rawCount = all.length;
  out.filteredCount = dropped.length;

  if (!kept.length) {
    return { ...out, ok: true, bullish: [], bearish: [], neutral: [],
      text: `今晨抓到 ${all.length} 条快讯，但过滤个股后没有宏观/板块层面的信息，不硬凑结论。` };
  }

  /* 喂给模型：标题+时间+摘要。只取最近、去重。 */
  const seen = new Set();
  const items = [];
  for (const n of kept) {
    const key = n.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(`[${n.time || ''}] ${n.title}${n.detail ? ' — ' + n.detail : ''}`);
    if (items.length >= 30) break;
  }

  let classified = null;
  try {
    const r = await llm.chat([
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: '盘前快讯如下（真实抓取，来源 ' + feed.source + '）：\n\n'
          + items.map((x, i) => `${i + 1}. ${x}`).join('\n')
          + '\n\n请分类输出 JSON。' },
    ], { maxTokens: 2000, temperature: 0.2, timeoutMs: 90000 });
    const text = (r && (r.content || r.text)) || '';
    const m = /\{[\s\S]*\}/.exec(text);
    classified = m ? JSON.parse(m[0]) : null;
  } catch (e) {
    /* 模型分类失败不能让简报报废：退化成原始快讯列表，并说明没分类 */
    out.ok = true;
    out.classifyError = e.message;
    out.bullish = []; out.bearish = [];
    out.neutral = items.map(t => ({ t, why: '' }));
    out.text = formatText(out, items, true);
    return out;
  }

  if (!classified) {
    return { ...out, error: '快讯分类结果解析失败（模型未返回合法 JSON）。' };
  }

  out.ok = true;
  out.bullish = classified.bullish || [];
  out.bearish = classified.bearish || [];
  out.neutral = classified.neutral || [];
  out.text = formatText(out, items, false);
  return out;
}

function formatText(out, rawItems, degraded) {
  const L = [];
  L.push(`【${out.date} 盘前简报】来源：${out.source}（抓 ${out.rawCount} 条，过滤个股 ${out.filteredCount} 条）`
    + (out.degraded ? '｜⚠ 主源财联社不可用，已降级新浪，宏观外盘为主' : ''));
  if (degraded) L.push('⚠ 模型分类失败，以下为未分类原始宏观快讯：');
  const sec = (name, arr) => {
    if (!arr || !arr.length) return;
    L.push('');
    L.push(`— ${name}（${arr.length}）—`);
    arr.slice(0, 8).forEach((x, i) => {
      L.push(`${i + 1}. ${x.t}` + (x.why ? `：${x.why}` : ''));
    });
  };
  sec('利好', out.bullish);
  sec('利空', out.bearish);
  sec('中性关注', out.neutral);
  L.push('');
  L.push('注：以上为信息梳理，不构成买卖建议；个股相关已过滤，具体以开盘盘面为准。');
  return L.join('\n');
}

module.exports = { briefing, filterMacro, looksLikeSingleStock, CLASSIFY_SYSTEM };
