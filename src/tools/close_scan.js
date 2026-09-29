'use strict';
/**
 * 收盘扫描：指数判时机 · 板块定方向 · 龙头选个股
 *
 * ══════════ 这个模块的设计依据全部来自实测 ══════════
 *
 * 用户的原话（2026-09-09）：
 *   「收盘后自动扫描指数和热门板块，并整理出近10日内资金活跃的板块，
 *     并判断哪些板块会成为主线，指数判时机，板块定方向，龙头选个股」
 *
 * ── 关键数据发现：不需要本地攒历史 ──
 * 我先以为「近10日资金活跃」必须自己按天累积（个股资金流就是这么被迫做的），
 * 但实测东财 clist 接口**同一个请求里就带多日字段**：
 *
 *   f62  = 今日主力净额
 *   f164 = 5 日主力净额
 *   f174 = 10 日主力净额
 *
 * 实测样例（2026-09-09 收盘后，按 f174 排序）：
 *   元件         今日 49.6亿  5日 155.8亿  10日 148.7亿
 *   印制电路板    今日 43.6亿  5日 133.2亿  10日 140.6亿
 *   电子         今日 -18.3亿 5日 -126.9亿 10日 -293.8亿
 *
 * 所以 10 日资金活跃度**一次请求就能拿到**，零累积零等待。
 * （对比：个股 fflow 接口四个入口全部只给当日，见 stock_fundflow.js）
 *
 * ── 板块覆盖面 ──
 * 实测 m:90+t:2（行业）496 个、m:90+t:3（概念）504 个。
 * push2his 在本机被 TCP 层拦截，但 clist 走 push2delay 正常。
 *
 * ── 为什么规则和模型都出 ──
 * 用户明确要「两者都出，并列展示」。
 * 规则分数可追溯、每天可比；模型能看到政策/题材联动这类规则写不出的东西。
 * 不一致时**显式标出分歧**，而不是偷偷选一个 —— 分歧本身就是信息。
 */

const em = require('./em_client');
const health = require('./source_health');

const SOURCE = 'eastmoney.sector';

/* 东财 clist 字段。f174/f164 是这个模块的核心，别改。 */
const FIELDS = [
  'f12',   // 板块代码 BKxxxx
  'f14',   // 板块名称
  'f2',    // 最新价（板块指数）
  'f3',    // 涨跌幅 %
  'f62',   // 今日主力净额（元）
  'f164',  // 5 日主力净额（元）
  'f174',  // 10 日主力净额（元）
  'f184',  // 今日主力净占比 %
  'f104',  // 上涨家数
  'f105',  // 下跌家数
  'f128',  // 领涨股名称
  'f140',  // 领涨股代码
  'f136',  // 领涨股涨跌幅 %
  'f124',  // 数据时点（unix 秒）—— 用来证明这份数据是不是收盘后的
].join(',');

/* ══════ 主线判定阈值（已用单日全样本校准）══════
 *
 * ⚠ 阈值来自**实测分布**，不是拍脑袋。
 * 2026-09-09 收盘后扫描 80 个板块（行业40+概念40，均按10日资金降序取样），
 * 实测 10 日主力净额分布：
 *
 *   ≥100亿    9 个   ← 真正的资金重仓区
 *   50-100亿  5 个
 *   30-50亿   8 个
 *   10-30亿  53 个   ← 绝大多数堆在这里，说明 30亿 门槛毫无区分度
 *   0-10亿    5 个
 *
 * ── 第一版为什么错 ──
 * 我最初把 MAINLINE_10D_YI 定在 30亿，结果 80 个板块里
 * **16 个被判"主线候选"（20%）** —— 主线不可能有 16 条。
 * 而且出现「10日主力+9.4亿(偏小)」却拿 83 分的荒谬结果：
 * 因为另外三个维度（加速/普涨/龙头涨停）满分就能盖过体量不足。
 *
 * ── 修法 ──
 * 1. 体量门槛按实测抬到 50亿（对应前 14 个），100亿 给满分
 * 2. **体量设为硬门槛**：10日资金 < 门槛的，无论其他维度多漂亮，
 *    最高只能评"强势板块"，不能评"主线候选"。
 *    理由：主线的定义就是钱多且持续，龙头涨停但没资金进的是情绪盘，
 *    第二天就散。这是"一票否决"而不是"加权求和"。
 * 3. 分数分级同步上调（75→82），压到实测前 5% 左右
 *
 * 仍然标注 calibrated:'single-day' —— 单日样本只够排除明显不合理，
 * 不同市场环境（普涨/普跌日）分布会变，多日样本后需再调。
 */
const TH = {
  MAINLINE_10D_YI: 50,      // 主线候选的**硬门槛**：10日主力净额 ≥ 50 亿
  BIG_10D_YI: 100,          // 体量满分线（实测仅 9 个板块达到）
  ACCEL_RATIO: 1.0,         // 5日均量 / 10日均量 ≥ 1.0 视为加速
  MIN_UP_RATIO: 0.5,        // 上涨家数占比，低于此说明是少数股拉抬
  LEADER_STRONG_PCT: 7,     // 龙头涨幅 ≥ 7% 视为强势（接近涨停）
  MAINLINE_SCORE: 82,       // 主线候选分数线（配合硬门槛）
  STRONG_SCORE: 60,         // 强势板块分数线
  TOP_N: 12,                // 取前 N 个板块做详细分析
};

function currentThresholds() { return Object.assign({}, TH); }

/** 亿元，保留 1 位 */
const yi = v => +(Number(v || 0) / 1e8).toFixed(1);

/**
 * 拉板块资金流（分页抓全）。
 *
 * ══════ 为什么必须分页（用户 2026-09-09 第二优先）══════
 *
 * 用户的原话：
 *   「现在 496 个板块只抓 196 个，中间三百个我看不见。
 *     今天这五个主线候选恰好都在涨幅前端所以能抓到，
 *     但如果某条线正在低位启动、涨幅排在中段，我会完全漏掉。」
 *
 * 实测比用户说的更糟：**只抓了 80 / 1000**
 * （行业 40/496 + 概念 40/504），因为 pz=40 且只请求第 1 页。
 *
 * 这个漏洞的危险性在于**它只在特定情况下暴露**：
 * 主线已经涨起来时排在前面，抓得到；
 * 主线正在低位吸筹时（这恰恰是最有价值的时点）排在中段，抓不到。
 * 也就是说，越是想早发现主线，这个 bug 越会挡住你。
 *
 * 改为按 pz=100 循环抓完所有页，并断言总数匹配。
 *
 * @param kind 'industry'(t:2) | 'concept'(t:3)
 * @param maxPages 安全上限，防止上游 total 异常导致无限循环
 */
async function fetchSectorFlow(kind = 'industry', maxPages = 12) {
  const fs = kind === 'concept' ? 'm:90+t:3' : 'm:90+t:2';
  const PZ = 100;
  const out = [];
  let total = null, dataTs = null;

  for (let pn = 1; pn <= maxPages; pn++) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get'
      + `?pn=${pn}&pz=${PZ}&po=1&np=1&fltt=2&invt=2`
      + `&fid=f174&fs=${fs}&fields=${FIELDS}`;

    let j;
    try {
      j = await em.emGetJson(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
    } catch (e) {
      /* 已经抓到一部分就保留部分数据（下面覆盖率会诚实标 complete=false）；
       * 一帧都没有也不在此 throw —— 跳出循环走函数末尾的同花顺内部降级，
       * 让本函数（而非仅外层 scan）本身就是可靠的。 */
      health.record(SOURCE, false, `第 ${pn} 页请求失败: ${e.message}`);
      break;
    }

    const diff = j && j.data && Array.isArray(j.data.diff) ? j.data.diff : null;
    if (!diff || !diff.length) break;          // 正常翻到末页
    if (total === null) total = Number(j.data.total) || null;

    for (const d of diff) {
      if (dataTs === null && d.f124) {
        dataTs = new Date(Number(d.f124) * 1000)
          .toLocaleTimeString('zh-CN', { hour12: false });
      }
      out.push({
        code: d.f12,
        name: d.f14,
        /* 板块指数点位。回填前向收益**只能靠它** ——
         * 实测板块历史K线全都拿不到：
         *   push2his /stock/kline/get  → TCP 层被拦
         *   push2delay 同上            → 返回 0 行
         *   push2 同上                 → TCP 层被拦
         * 龙头个股的历史K线也是 0 行。
         * 所以唯一可行的办法是：每天存下当日点位，
         * 日后用「今天的点位 vs 当初的点位」算涨幅。
         * 少了这个字段，第四优先的回归就永远做不了。 */
        level: Number(d.f2),
        changePct: Number(d.f3),
        todayYi: yi(d.f62),
        d5Yi: yi(d.f164),
        d10Yi: yi(d.f174),
        mainPct: Number(d.f184),
        upCount: Number(d.f104) || 0,
        downCount: Number(d.f105) || 0,
        leader: d.f128 || null,
        leaderCode: d.f140 || null,
        leaderPct: Number(d.f136),
        dataTs,
        kind,
      });
    }

    if (total !== null && out.length >= total) break;
    if (diff.length < PZ) break;               // 不满一页 = 末页
  }

  if (!out.length) {
    /* ══ 内部降级：东财整源失败（封IP/风控）→ 同花顺普通列表页 ══
     * 只有行业有备胎；同花顺无概念列表。
     * 降级行带 source='ths.board' 与 boardFallback 口径说明，
     * 绝不把 50 个粗口径行业伪装成东财 496 个全覆盖。 */
    if (kind === 'industry') {
      const ths = require('./ths_board');
      let thsRows = null;
      try { thsRows = await ths.industryBoards(); } catch (e2) {
        health.record(SOURCE, false, '东财与同花顺均不可用: ' + e2.message);
        throw new Error('板块资金流不可用：东财风控，同花顺备胎也失败（' + e2.message + '）');
      }
      const tTotal = thsRows.length;
      /* THS 列表页不带服务器时间戳：诚实口径是【我们实际抓到这份数据的本地时间】。
         盖观测时间而非 null——数据是真实的，只是无法证明它是交易所终盘快照
         （口径差异已在 boardFallback.note 里说明）。 */
      const fetchTs = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const rows = thsRows.map(s => Object.assign({
        code: s.code, name: s.name, level: s.level, changePct: s.changePct,
        todayYi: null, d5Yi: null, d10Yi: null, mainPct: null,
        upCount: s.upCount, downCount: s.downCount,
        leader: s.leader, leaderCode: null, leaderPct: s.leaderPct,
        dataTs: fetchTs, kind, source: 'ths.board',
      }, {
        total: tTotal, coverage: 1, complete: true,
        boardFallback: {
          source: 'ths.board',
          reason: '东财行业板块整源不可用（push2 全系列 TCP RST）',
          note: '已内部降级同花顺：仅 ' + tTotal + ' 个带行情行业、无概念、无主力多日净额，口径较粗，请以实时软件为准',
        },
      }));
      return rows;
    }
    health.record(SOURCE, false, '概念板块返回空（东财风控，且无概念备胎）');
    throw new Error('概念板块资金流返回空（东财可能在风控，同花顺无概念列表可降级）');
  }

  /* ══ 覆盖率断言（和资金流的数量短缺同一类 bug）══
   *
   * 抓到的板块数必须接近上游 total。差太多说明分页断了，
   * 而这种"抓到一部分但看起来正常"的状态最容易骗过所有人。
   * 允许 2% 误差：上游 total 会随盘中新增板块微动。 */
  const coverage = total ? out.length / total : 1;
  const complete = !total || coverage >= 0.98;
  if (!complete) {
    health.record(SOURCE, false,
      `板块覆盖不全：抓到 ${out.length}/${total}（${(coverage * 100).toFixed(0)}%）`);
  } else {
    health.record(SOURCE, true);
  }

  out.forEach(r => { r.total = total; r.coverage = +coverage.toFixed(3); r.complete = complete; });
  return out;
}

/**
 * 规则打分：这个板块像不像主线。
 *
 * 满分 100，四个维度各 25 分。**每一分都能追溯到具体数字**，
 * 这是它和模型判断的根本区别 —— 明天再跑一次，同样输入必得同样分数。
 */
function scoreMainline(s) {
  const reasons = [];
  let score = 0;

  /* ① 10 日资金体量（25）—— 主线的钱不会只来一天 */
  if (s.d10Yi >= TH.BIG_10D_YI) { score += 25; reasons.push(`10日主力+${s.d10Yi}亿(体量极大)`); }
  else if (s.d10Yi >= TH.MAINLINE_10D_YI) { score += 18; reasons.push(`10日主力+${s.d10Yi}亿`); }
  else if (s.d10Yi > 0) { score += 8; reasons.push(`10日主力+${s.d10Yi}亿(体量不足)`); }
  else { reasons.push(`10日主力${s.d10Yi}亿(净流出)`); }

  /* ② 资金是否在加速（25）
   * 5日日均 vs 10日日均：>1 说明近一周比前一周更猛。
   * 这是"主线正在形成"和"主线已经走完"的分界。 */
  const avg5 = s.d5Yi / 5, avg10 = s.d10Yi / 10;
  if (avg10 > 0 && avg5 / avg10 >= 1.5) { score += 25; reasons.push(`资金加速(5日均${avg5.toFixed(1)}亿 vs 10日均${avg10.toFixed(1)}亿)`); }
  else if (avg10 > 0 && avg5 / avg10 >= TH.ACCEL_RATIO) { score += 15; reasons.push('资金持续流入'); }
  else if (avg5 > 0 && avg10 <= 0) { score += 20; reasons.push('资金由流出转流入(拐点)'); }
  else { reasons.push('资金未加速'); }

  /* ③ 上涨面（25）—— 普涨才是板块行情，个别股拉抬不算 */
  const tot = s.upCount + s.downCount;
  const upRatio = tot > 0 ? s.upCount / tot : 0;
  if (upRatio >= 0.8 && tot >= 5) { score += 25; reasons.push(`普涨(${s.upCount}涨/${s.downCount}跌)`); }
  else if (upRatio >= TH.MIN_UP_RATIO) { score += 15; reasons.push(`多数上涨(${s.upCount}涨/${s.downCount}跌)`); }
  else { reasons.push(`上涨面不足(${s.upCount}涨/${s.downCount}跌)`); }

  /* ④ 龙头强度（25）—— 主线必有涨停或准涨停的领头羊 */
  if (s.leaderPct >= 9.8) { score += 25; reasons.push(`龙头${s.leader}涨停(${s.leaderPct}%)`); }
  else if (s.leaderPct >= TH.LEADER_STRONG_PCT) { score += 18; reasons.push(`龙头${s.leader}强势(${s.leaderPct}%)`); }
  else if (s.leaderPct > 0) { score += 8; reasons.push(`龙头${s.leader}(+${s.leaderPct}%)`); }
  else { reasons.push(`龙头${s.leader}(${s.leaderPct}%)`); }

  /* ══ 分级：体量是硬门槛，不是加权项 ══
   *
   * 为什么要一票否决而不是纯加分：
   * 实测出现过「10日主力+9.4亿」却拿 83 分的板块（航运港口）——
   * 因为加速/普涨/龙头涨停三项满分，盖过了体量不足。
   * 但主线的定义就是**钱多且持续**；龙头涨停而资金没进的是情绪盘，
   * 第二天大概率就散了。把它标成"主线候选"会直接误导仓位决策。
   *
   * 所以：体量不达标 → 最高只能到"强势板块"，措辞也改成"情绪驱动"。 */
  const volumeOk = s.d10Yi >= TH.MAINLINE_10D_YI;
  let grade;
  if (score >= TH.MAINLINE_SCORE && volumeOk) grade = '主线候选';
  else if (score >= TH.MAINLINE_SCORE && !volumeOk) grade = '强势板块(情绪驱动,资金体量不足)';
  else if (score >= TH.STRONG_SCORE) grade = '强势板块';
  else if (score >= 35) grade = '有资金关注';
  else grade = '不活跃';

  return {
    score, grade, reasons, volumeOk,
    upRatio: +upRatio.toFixed(2),
    accel: avg10 !== 0 ? +(avg5 / avg10).toFixed(2) : null,
  };
}

/**
 * 指数判时机：能不能做、该多重的仓。
 *
 * 只用**当日可得**的客观数据，不预测点位。
 * 判的是"环境允不允许出手"，不是"明天涨不涨"。
 */
function judgeTiming(indexes) {
  const get = n => indexes.find(x => (x.name || '').includes(n) || (x.short || '') === n);
  const sh = get('上证'), cy = get('创业板'), kc = get('科创');

  const list = [sh, cy, kc].filter(Boolean);
  const upCount = list.filter(x => x.changePct > 0).length;
  const avgPct = list.length
    ? +(list.reduce((a, x) => a + Number(x.changePct || 0), 0) / list.length).toFixed(2) : 0;

  /* 分歧度：主板和成长板方向相反 = 风格切换中，这时候追高最容易挨打 */
  const diverge = sh && cy
    && Math.sign(Number(sh.changePct)) !== Math.sign(Number(cy.changePct));

  let stance, reason;
  if (avgPct >= 1.0 && upCount === list.length) {
    stance = '积极'; reason = `指数全线上涨(均${avgPct}%)，环境支持进攻`;
  } else if (diverge) {
    stance = '谨慎'; reason = `主板与成长板分歧(上证${sh.changePct}% vs 创业板${cy.changePct}%)，风格切换中，只做最强主线`;
  } else if (avgPct <= -1.0) {
    stance = '防守'; reason = `指数普跌(均${avgPct}%)，等企稳再说，不逆势加仓`;
  } else {
    stance = '中性'; reason = `指数窄幅震荡(均${avgPct}%)，可做结构性机会但控制仓位`;
  }

  return {
    stance, reason, avgPct, diverge: !!diverge,
    detail: list.map(x => ({ name: x.name || x.short, pct: Number(x.changePct) })),
  };
}

/**
 * 完整扫描：指数 + 板块 + 龙头。
 *
 * 不在这里调模型 —— 模型解读交给 patrol/registry 层，
 * 这样这个函数**零成本、可任意频率调用**，也便于测试。
 */
async function scan(opts = {}) {
  const topN = opts.topN || TH.TOP_N;
  const board = require('./market_board');

  /* 指数 */
  let indexes = [], timing = null, indexError = null;
  try {
    indexes = await board.indexes();
    timing = judgeTiming(indexes);
  } catch (e) { indexError = e.message; }

  /* 板块资金流：行业 + 概念都扫，分页抓全 */
  const sectors = [];
  const errors = [];
  const coverage = {};
  for (const kind of ['industry', 'concept']) {
    try {
      const rows = await fetchSectorFlow(kind);
      coverage[kind] = rows.length
        ? { got: rows.length, total: rows[0].total, complete: rows[0].complete }
        : { got: 0, total: null, complete: false };
      rows.forEach(s => sectors.push(Object.assign({}, s, scoreMainline(s))));
    } catch (e) {
      errors.push(`${kind}: ${e.message}`);
      coverage[kind] = { got: 0, total: null, complete: false };
    }
  }

  /* ══════ 真备胎：东财整源失败 → 降级同花顺行业 ══════
   * 2026-09-21 实测 push2/push2delay 全 RST，上面行业+概念都抓不到。
   * 同花顺普通列表页（ths_board）给 50 个带完整行情的行业。
   * 只在东财 sectors 全空时触发；口径差异必须显式标注（见 boardFallback）：
   *   仅行业无概念、无今日/5日/10日主力净额、覆盖面与东财不同。 */
  let boardFallback = null;
  if (!sectors.length) {
    try {
      const ths = require('./ths_board');
      const thsRows = await ths.industryBoards();
      coverage.industry = { got: thsRows.length, total: 90, complete: false };
      coverage.concept = { got: 0, total: null, complete: false };
      thsRows.forEach(s => sectors.push(Object.assign({}, s, scoreMainline(s))));
      boardFallback = {
        source: 'ths.board',
        reason: '东财行业板块整源不可用：' + errors.join(' / '),
        note: '已降级同花顺行业（仅 50 个带行情行业、无概念、无主力多日净额），口径与东财不同，请以实时行情软件为准',
      };
      errors.length = 0;            // 已成功兜底，不再把它当致命错误
    } catch (e) {
      errors.push('ths: ' + e.message);
    }
  }

  /* 数据时点：任取一条即可（同批请求时点一致）。
   * 报告里必须带上 —— 否则读者无法判断这是盘中快照还是终盘数据。 */
  const dataTs = sectors.length ? sectors[0].dataTs : null;

  /* 口径提升：fetchSectorFlow 内部降级同花顺时，每行带 boardFallback。
     sectors 非空（外层旧兜底不触发），必须在此把口径说明提到顶层，
     否则面板只看到行情、看不到"这是同花顺粗口径"。 */
  if (!boardFallback) {
    const fbRow = sectors.find(s => s && s.boardFallback && s.source === 'ths.board');
    if (fbRow) boardFallback = fbRow.boardFallback;
  }

  /* ══════ 时点校验（用户 2026-09-09 第三优先）══════
   *
   * 用户的原话：
   *   「你说"收盘了"，我拿到的是 11:00 的数据。
   *     应该在盘后调用时校验数据时间是否 ≥15:00，
   *     不匹配就明确提示，而不是等我自己发现。」
   *
   * 这是「不要让用户替你做校验」原则的直接应用。
   * 之前那次虽然数据其实是 15:39 的（是我的 at 字段用了 UTC 显示成 10:59），
   * 但用户的要求是对的：**光靠人眼比对两个时间戳，早晚会漏**。
   *
   * 判定逻辑：
   *   · 本机时间已过 15:00（交易日）而数据时点 < 15:00 → 明确警告
   *   · 数据时点缺失 → 也要警告（不能默认它是好的）
   * 警告不阻断返回 —— 盘中调用拿盘中数据是合理的，
   * 但必须让调用方**看见**这是不是终盘口径。 */
  const now = new Date();
  const isTradingDay = now.getDay() >= 1 && now.getDay() <= 5;
  const afterClose = isTradingDay && now.getHours() >= 15;
  let staleWarning = null;
  if (!dataTs) {
    staleWarning = '数据时点缺失，无法确认是否为终盘数据';
  } else {
    const hh = Number(String(dataTs).split(':')[0]);
    if (afterClose && hh < 15) {
      staleWarning = `⚠ 现在是收盘后（${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}）`
        + `，但行情数据时点为 ${dataTs}，属于**盘中快照而非终盘数据**。`
        + '上游可能未刷新，结论请勿当作收盘口径使用。';
    }
  }

  /* ══ 去重：东财的分级板块会重复出现 ══
   *
   * 实测：「航海装备Ⅱ」和「航海装备Ⅲ」两条数据**完全一致**
   * （同为 +4.67%、今日8.6亿、10日19.5亿、龙头亚星锚链），
   * 因为东财按申万一二三级都建了板块。
   * 不去重的话前 10 名里会被同一个题材塞进两三条，挤掉真正不同的方向。
   *
   * 判定同一板块：去掉末尾罗马数字后名称相同，且 10 日资金相同。
   * 只按名称去重不安全（可能真有不同板块前缀相同），加上资金校验。 */
  const seen = new Map();
  const deduped = [];
  for (const s of sectors) {
    const baseName = String(s.name).replace(/[ⅠⅡⅢⅣⅤ]+$/u, '').trim();
    const key = baseName + '|' + s.d10Yi + '|' + s.leaderCode;
    if (seen.has(key)) {
      seen.get(key).mergedNames.push(s.name);
      continue;
    }
    const row = Object.assign({}, s, { mergedNames: [s.name] });
    seen.set(key, row);
    deduped.push(row);
  }

  /* 按规则分数排序，同分看 10 日资金 */
  deduped.sort((a, b) => (b.score - a.score) || (b.d10Yi - a.d10Yi));
  const top = deduped.slice(0, topN);
  const mainlines = deduped.filter(s => s.grade === '主线候选');

  /* ══ 定格当日板块，供跨日主线追踪 ══
   *
   * 用户 2026-09-12：「主线板块不是一天就能看出来的」。
   * 在此之前 close_scan 每天算完就扔（连 db 都没 require），
   * 于是「连续 8 天净流入」这种判断永远答不出来，
   * 只能重复东财给的 5日/10日累计 —— 不可回溯、不可验证。
   *
   * 只在**收盘后且数据确为终盘**时落库：
   * 盘中落库会把 10:30 的中间态当成当日结果定格，
   * 之后再也分不清那天到底收在哪 —— 错数据比没数据更糟。
   *
   * 落全量 deduped 而不是 top：今天排 200 名的板块，
   * 可能正是下周的主线，只存前 12 个等于提前把它删了。
   *
   * 落库失败绝不能影响扫描返回 —— 报告本身是用户要的东西。 */
  let persisted = null, persistError = null;
  if (afterClose && !staleWarning && deduped.length) {
    try {
      const db = require('../db');
      const d = new Date();
      const date = d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
      persisted = db.saveSectorDaily(date, deduped);
    } catch (e) {
      persistError = e.message;
    }
  }

  return {
    ok: deduped.length > 0,
    /* ⚠ 必须用本地时间，不能用 toISOString()。
     *
     * 第一版写 `new Date().toISOString()...`，UTC 比北京时间早 8 小时，
     * 19:00 收盘后扫描显示成 "10:59" —— 模型看到就质疑
     * 「这是上午盘中数据不是收盘数据」，并据此在回答开头
     * 加了一整段"数据时点有问题"的警告。
     *
     * 数据本身是对的（东财 f124 时间戳 = 15:39:32，确实是收盘后），
     * 错的是我的时间戳格式。一个时区 bug 让整份报告的可信度打折。 */
    at: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    dataTime: dataTs,
    /* 时点校验结果：非 null 表示数据不是终盘口径 */
    staleWarning,
    afterClose,
    /* 覆盖率：抓到多少 / 上游总共多少。不全时必须让调用方看见。 */
    coverage,
    coverageComplete: Object.values(coverage).every(c => c.complete),
    /* 非 null 表示已降级同花顺（口径差异在 note 里），面板必须让用户看见 */
    boardFallback,
    timing, indexes, indexError,
    sectors: top,
    mainlineCount: mainlines.length,
    mainlines: mainlines.map(s => s.name),
    scanned: deduped.length,
    rawCount: sectors.length,
    errors,
    /* 当日定格结果：persisted=落库板块数，null 表示未落（盘中或数据非终盘）。
     * persistError 非空表示落库真失败了，必须让调用方看见，不能静默。 */
    persisted, persistError,
    /* 诚实标注校准状态：单日全样本校准过（排除了明显不合理），
     * 但不同市场环境分布会变，多日样本后仍需再调。 */
    calibrated: 'single-day',
    thresholds: currentThresholds(),
    note: '10日/5日主力净额来自东财 clist 的 f174/f164 字段（一次请求即得，无需本地累积）'
      + '；主线分数为规则打分，可追溯可复现'
      + '；体量为硬门槛：10日资金不足 50亿 的即使高分也只评"强势板块(情绪驱动)"'
      + '；阈值按 2026-09-09 单日全样本校准，多日样本后需再校',
  };
}

/** 给模型看的紧凑文本。
 *
 * @param showN 只展示前几个（scan 可能带回 60 个用于校准样本，
 *              但报告里列 60 个板块没人看得下去）
 */
function formatScan(r, showN = 12) {
  const L = [];
  /* 时点必须放最前面 —— 读者第一眼就要知道这是不是收盘数据。
   * 实测：不写数据时点，模型会自己拿 at 字段推断，
   * 一旦 at 有时区问题就会得出"这是盘中数据"的错误结论。 */
  L.push(`【数据时点】扫描于 ${r.at}，行情数据时点 ${r.dataTime || '未知'}`
    + (r.dataTime && /^1[5-9]:|^2[0-3]:/.test(r.dataTime) ? '（收盘后，终盘数据）' : ''));
  /* 时点不匹配必须**顶格显示**，不能埋在末尾的免责声明里 ——
   * 用户明确要求「不匹配就明确提示，而不是等我自己发现」。 */
  if (r.staleWarning) L.push(r.staleWarning);
  /* 覆盖率同理：抓不全就直说，否则用户以为看到了全市场 */
  const cov = Object.entries(r.coverage || {})
    .map(([k, c]) => `${k === 'concept' ? '概念' : '行业'} ${c.got}/${c.total || '?'}`).join('，');
  L.push(`【覆盖范围】${cov}`
    + (r.coverageComplete ? '（已抓全）' : ' ⚠ **未抓全，可能漏掉低位启动的板块**'));
  L.push('');
  if (r.timing) {
    L.push(`【指数判时机】${r.timing.stance} —— ${r.timing.reason}`);
    L.push('  ' + r.timing.detail.map(d => `${d.name} ${d.pct > 0 ? '+' : ''}${d.pct}%`).join('  '));
  } else if (r.indexError) {
    L.push(`【指数】取数失败：${r.indexError}`);
  }
  L.push('');
  L.push(`【板块定方向】扫描 ${r.scanned} 个板块，主线候选 ${r.mainlineCount} 个`);
  r.sectors.slice(0, showN).forEach((s, i) => {
    L.push(`${i + 1}. ${s.name}(${s.kind === 'concept' ? '概念' : '行业'}) `
      + `${s.grade} ${s.score}分 | 今日${s.changePct > 0 ? '+' : ''}${s.changePct}% `
      + `| 主力 今日${s.todayYi}亿 5日${s.d5Yi}亿 10日${s.d10Yi}亿`);
    L.push(`   龙头选个股：${s.leader || '—'}${s.leaderCode ? '(' + s.leaderCode + ')' : ''} `
      + `${s.leaderPct > 0 ? '+' : ''}${s.leaderPct}%`);
    L.push(`   依据：${s.reasons.join('；')}`);
  });
  if (r.errors.length) { L.push(''); L.push('取数异常：' + r.errors.join(' / ')); }
  L.push('');
  L.push('⚠ 主线分数为规则打分，阈值尚未经多日实盘校准，仅供筛选参考，不构成交易建议');
  return L.join('\n');
}

module.exports = {
  scan, formatScan, fetchSectorFlow, scoreMainline, judgeTiming,
  currentThresholds, SOURCE, TH,
};
