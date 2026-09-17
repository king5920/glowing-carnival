'use strict';
/**
 * 时间感知（clock）—— 贾维斯的"现在"从这里来。
 *
 * ══════════ 为什么需要这个模块 ══════════
 *
 * 用户 2026-09-10 指出："jarvis 没有时间概念"。
 *
 * 实测三个问题暴露三层缺陷（真实时间 周四 19:30 收盘后）：
 *
 *   问「现在几点」
 *     → 它去拉行情，还猜成"盘中未收盘，距收盘十几分钟"
 *     → 病根①：模型本身没有时钟，代码也没把当前时间喂给它
 *
 *   问「上次聊韶关算力是哪天」
 *     → "日期查不到，我记得结论不记得哪天"
 *     → 病根②：数据库每条记忆都存了 created_at，
 *        但 brain.js 喂给模型时是 `- ${content}`，时间戳被丢了。
 *        不是没时间，是**时间没被递到嘴边**。
 *
 *   问「明天开盘吗」
 *     → 答对了，但结尾补一句"以你的表为准"
 *     → 病根③：对自己的时间没把握，因为时间是从行情间接推的
 *
 * 修法三层：
 *   ① 每轮注入真实时间（nowBlock）—— 本模块提供
 *   ② 记忆带相对时间（relativeTime）—— 本模块提供
 *   ③ get_current_time 工具兜底 —— registry 调用 nowBlock
 *
 * 模型对「3天前」这类相对时间的推理，比「2026-09-07」这种
 * 绝对日期更准（绝对日期还要自己做减法、还容易数错），
 * 所以记忆时间用相对表述，但绝对日期也一并给出供核对。
 */

/* ══════════ A股交易日历 ══════════
 *
 * 用户选择：内置节假日表，每年更一次。
 *
 * 为什么不用联网查：每次都发网络请求，且交易所接口哪天被封又得修，
 * 违背"免费轮询、不挑网络"的原则。
 * 代价：每年初要手动更新一次。所以把表放在最显眼的位置，
 * 并在 nowBlock 里对"超出表覆盖年份"的情况明确说"不确定"，
 * 绝不装作知道（见 yearCoverage 检查）。
 *
 * 数据口径：以上海证券交易所休市安排为准。
 * 休市日 = 法定假日 + 调休出来的连休。
 * 注意**补班的周末不在休市表里** —— 那种周六/周日要正常开盘，
 * 所以 tradingSession 不能只看星期几，必须先查休市表。
 *
 * 2026 年休市日（已用上证指数真实日K核对，数据源：腾讯，截至 2026-09-10）：
 *
 * ══ 为什么不手写日历 ══
 * 第一版我凭记忆写，实测核对**错了 3 处**：
 *   春节我写 02-16~02-22，真实是 02-16~02-20 + 02-23（02-23 无交易）
 *   元旦我写只 01-01，真实 01-01~01-02
 *   五一我写 05-02~05-03 休市，真实是 05-04~05-05
 * 凭记忆写日历必然出错，而且错误会让用户在假期做错操作。
 *
 * 09-10 之前的日期全部经过真实行情核对（见下方 verified 标记）。
 * 09-10 之后（中秋、国庆）真实数据尚不存在，按国务院放假安排预填，
 * **标记为 unverified** —— 到期必须用真实行情复核，不能一直当已验证用。
 */
const MARKET_HOLIDAYS = {
  2026: [
    /* 元旦 [已核对] */ '2026-01-01', '2026-01-02',
    /* 春节 [已核对] 02-16~02-20 连休 + 02-23 周一补休 */
    '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-02-19', '2026-02-20', '2026-02-23',
    /* 清明 [已核对] */ '2026-04-06',
    /* 劳动节 [已核对] 05-01 + 05-04~05-05 */
    '2026-05-01', '2026-05-04', '2026-05-05',
    /* 端午 [已核对] */ '2026-06-19',
    /* ── 以下为预填，真实行情尚未产生，到期必须复核 ── */
    /* 中秋 [待核对] */ '2026-09-25',
    /* 国庆 [待核对] 预填 10-01~10-07，实际以交易所公告+行情为准 */
    '2026-10-01', '2026-10-02', '2026-10-03',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
};

/* 已用真实行情核对过的休市日（截至数据末日 2026-09-10）。
 * 不在这个集合里的日期属于"预填待核对"，
 * nowBlock 对临近这些日期的开盘判断要保留不确定性。 */
const HOLIDAYS_VERIFIED = {
  2026: [
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
  ],
};
/* 真实行情已覆盖到的日期 —— 超过它的节假日判断都是预填 */
const DATA_VERIFIED_THROUGH = '2026-09-10';

/* 补班日：这些周末 A股**正常交易**（调休补班）。
 * 2026 年若有周末补班开盘，加在这里。
 * key=年份，value=日期数组。
 *
 * ⚠ 为什么要单独维护：光看"周六"会误判成休市，
 * 但调休补班的周六是开盘的。漏掉这个，
 * "明天开盘吗"在补班周末会答错。 */
const MAKEUP_WORKDAYS = {
  2026: [
    /* 2026 年国庆假期与周末衔接，暂无周末补班交易日；
     * 若上交所公告补班，在此添加，如 '2026-10-10'。 */
  ],
};

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC） */
function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateKeyPlus(d, days) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return dateKey(x);
}

/** 某天是不是 A股交易日（周一到周五且非休市；补班周末也算） */
function isTradingDay(d = new Date()) {
  const key = dateKey(d);
  const year = d.getFullYear();
  const holidays = MARKET_HOLIDAYS[year] || [];
  const makeup = MAKEUP_WORKDAYS[year] || [];
  if (holidays.includes(key)) return false;
  if (makeup.includes(key)) return true;
  const wd = d.getDay();
  return wd >= 1 && wd <= 5;
}

/**
 * 现在处于交易时段的哪个阶段。
 * 只做客观分段，不预测涨跌。
 */
function tradingSession(d = new Date()) {
  const hhmm = d.getHours() * 100 + d.getMinutes();
  if (!isTradingDay(d)) return '休市日';
  if (hhmm < 915) return '盘前';
  if (hhmm < 930) return '集合竞价';
  if (hhmm < 1130) return '上午盘';
  if (hhmm < 1300) return '午间休市';
  if (hhmm < 1500) return '下午盘';
  if (hhmm < 1530) return '收盘竞价刚结束';
  return '收盘后';
}

/** 找下一个交易日（跳过周末和休市日，含补班日） */
function nextTradingDay(d = new Date()) {
  for (let i = 1; i <= 15; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (isTradingDay(x)) return { date: x, offsetDays: i };
  }
  return null;   // 15 天内都没有（节假日表缺失时会这样，见 yearCoverage）
}

/** 节假日表覆盖到的年份；超出则对远期判断保持诚实 */
function coveredYears() { return Object.keys(MARKET_HOLIDAYS).map(Number); }

/**
 * 贾维斯现在该不该"主动干活/巡视/搭话"。
 *
 * ══════ 用户 2026-09-10 的明确要求 ══════
 * 「在不是交易时间段别巡视，除非我主动提问或安排其它具体工作」
 *
 * 语义边界（很重要，不能一刀切停心跳）：
 *   - 用户**主动提问 / 派活**：永远响应，不受这个开关影响
 *     （那是 brain.js 的对话链路，根本不经过这里）
 *   - 这里只控制**后台主动行为**：自己扫盘、巡会话、没事搭话
 *   - 收盘扫描（close_scan）是用户点名要的每日动作，
 *     在 runOne 里单独放行，不受这个总开关限制
 *
 * 窗口：交易日 09:00–23:00。
 *   09:00 起可以看盘前/盘中；23:00 后到次日开盘前完全静默，
 *   避免深夜和清晨弹消息。周末/休市日全天静默。
 */
function isProactiveWindow(d = new Date()) {
  if (!isTradingDay(d)) return false;
  const h = d.getHours();
  return h >= 9 && h < 23;
}

/**
 * 注入给模型的「当前时间」系统块。
 *
 * 这是根治"没有时间概念"的核心：模型自己没有时钟，
 * 但每轮都把真实时间写进 system prompt，它就永远知道"现在"，
 * 不用再去拉行情反推（那种反推收盘后会错成"盘中"）。
 */
function nowBlock(d = new Date()) {
  const key = dateKey(d);
  const dow = '周' + WEEK_CN[d.getDay()];
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const session = tradingSession(d);
  const trading = isTradingDay(d);
  const nxt = nextTradingDay(d);

  const lines = [
    '【当前时间】',
    `现在是 ${key}（${dow}）${hm}，本机本地时间（北京时间）。这是权威时间，不需要再通过行情或其他工具推算。`,
    `A股状态：${trading ? '今天是交易日' : '今天休市'}，当前「${session}」。`,
  ];

  const years = coveredYears();
  const yearKnown = years.includes(d.getFullYear());

  if (nxt && yearKnown) {
    const nd = nxt.date;
    const nDow = '周' + WEEK_CN[nd.getDay()];
    const tomorrow = nxt.offsetDays === 1;
    /* 下一个交易日如果落在"待核对"的假期附近，提示不确定性。
     * 判据：下一交易日的前一天是未核实的节假日预填项。 */
    const verified = (HOLIDAYS_VERIFIED[d.getFullYear()] || []);
    const all = MARKET_HOLIDAYS[d.getFullYear()] || [];
    const unverified = all.filter(x => !verified.includes(x));
    const nearUnverified = unverified.some(h => {
      const hd = new Date(h + 'T00:00:00');
      const gap = (nd - hd) / 86400000;
      return gap >= -1 && gap <= 8;
    });
    const caution = nearUnverified
      ? '（注意：近期含尚未用真实行情核对的假期预填，若与交易所公告不符以公告为准）'
      : '';
    lines.push(
      (tomorrow
        ? `明天（${dateKey(nd)} ${nDow}）是交易日，A股正常开盘。`
        : `下一个交易日是 ${dateKey(nd)}（${nDow}），距今 ${nxt.offsetDays} 天（中间是周末或假期休市）。`)
      + caution
    );
  } else if (!yearKnown) {
    /* 表没覆盖到的年份：绝不装作知道开不开盘。
     * 一个"看起来很自信但其实是猜的"开盘判断，
     * 会让用户在假期做错操作 —— 比回答"不确定"危险得多。 */
    lines.push(`注意：内置交易日历只覆盖到 ${Math.max(...years)} 年，${d.getFullYear()} 年的休市安排未知，涉及"开不开盘"请显式说明不确定。`);
  }

  lines.push('回答时间相关问题时直接以此为准，不要再让用户"以你的表为准"。');
  return lines.join('\n');
}

/**
 * 把一个时间戳转成模型好用的相对表述。
 *
 * 同时给相对和绝对：相对时间帮模型做"多久以前"的推理，
 * 绝对日期供精确核对。
 *
 * @param ts 可被 Date 解析的值（'YYYY-MM-DD HH:MM:SS' 或 ISO）
 * @param now 评估基准（默认现在）
 */
function relativeTime(ts, now = new Date()) {
  if (!ts) return null;
  /* 同时接受 Date 对象和字符串。
   * 字符串把空格换成 T 是为了让 'YYYY-MM-DD HH:MM:SS' 按本地时区解析
   * （不加 T 在部分环境会被当 UTC）。Date 对象直接用，别先转字符串 ——
   * 否则 String(date) 得到的是 "Thu Sep 10 2026 ..." 无法 parse。 */
  const then = ts instanceof Date ? ts : new Date(String(ts).replace(' ', 'T'));
  if (isNaN(then.getTime())) return null;

  /* 按"日历天"算差，而不是 24 小时滚动差 ——
   * 昨晚 23 点到今早 9 点只隔 10 小时，但用户认为是"昨天"。 */
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const dayDiff = Math.round((a - b) / 86400000);

  let rel;
  if (dayDiff <= 0) rel = '今天';
  else if (dayDiff === 1) rel = '昨天';
  else if (dayDiff === 2) rel = '前天';
  else if (dayDiff < 7) rel = `${dayDiff}天前`;
  else if (dayDiff < 30) rel = `${Math.floor(dayDiff / 7)}周前`;
  else if (dayDiff < 365) rel = `${Math.floor(dayDiff / 30)}个月前`;
  else rel = `${Math.floor(dayDiff / 365)}年前`;

  const dow = '周' + WEEK_CN[then.getDay()];
  return { rel, dayDiff, abs: dateKey(then), dow,
           label: `${rel}（${dateKey(then)} ${dow}）` };
}

module.exports = {
  nowBlock, relativeTime, isTradingDay, tradingSession,
  nextTradingDay, dateKey, dateKeyPlus, coveredYears,
  isProactiveWindow,
  MARKET_HOLIDAYS, MAKEUP_WORKDAYS, HOLIDAYS_VERIFIED,
  DATA_VERIFIED_THROUGH,
};
