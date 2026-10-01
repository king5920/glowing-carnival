'use strict';
/**
 * market_window.js —— 大盘买卖【时机总开关】。
 * ─────────────────────────────────────────────────
 * 方法论原话：用大盘来定买卖时机。
 * 这里把两个已经各自建好的维度合成一个可执行的"窗口"：
 *   结构阶段(缠论 chan) × 情绪温度(多因子情绪分)
 *
 * 只给【窗口等级 + 理由 + 成绩单】，绝不输出"可以买"。
 * 窗口是规则（先验、可解释）；窗口到底准不准，由 backtest 用
 * 严格样本外(walk-forward)方式给胜率，样本不足 → unknown，不硬凑。
 *
 * 纯函数、null 安全：任一维度缺失 → unknown，绝不当默认值。
 */

/* 窗口等级（保守语义，不含买入指令） */
const W = {
  RISK_OFF: '回避窗口',       // 退潮 + 情绪未稳：风险收益最差
  CAP_WATCH: '回补观察窗口',  // 退潮末端/磨底 + 高恐慌：左侧，仅观察，不接飞刀
  ENGAGE: '参与窗口',         // 主升/启动 + 情绪回稳：风险收益较好
  HOLD: '持有窗口',           // 高位震荡但趋势在：不追，持有为主
  WAIT: '等待窗口',           // 其余中性：方向不清
  UNKNOWN: '窗口未知',
};

/* 结构阶段 → 趋势倾向（用于规则） */
const PHASE_TREND = {
  '主升期': 'upStrong', '启动期': 'upEarly',
  '高位震荡期': 'upRange', '筑底期': 'flat',
  '磨底期': 'downEnd', '退潮期': 'down',
};

/**
 * 合成当日时机窗口。
 * @param phase 缠论阶段
 * @param score 多因子情绪分 0–100（高=恐慌）
 * @returns {window, code, reason}
 */
function windowOf(phase, score) {
  const trend = PHASE_TREND[phase];
  if (!trend || score == null) {
    return { window: W.UNKNOWN, code: 'unknown',
      reason: !trend ? '结构阶段未知' : '情绪分缺失，无法合成时机' };
  }
  const panic = score >= 70, soft = score >= 40, calm = score < 40;

  // 下跌结构
  if (trend === 'down') {
    // 退潮 + 高恐慌：左侧"回补观察"，但只观察（接飞刀风险仍高）
    if (panic) return { window: W.CAP_WATCH, code: 'cap_watch',
      reason: '退潮期且情绪分处于高位：下跌结构未改，仅观察' };
    return { window: W.RISK_OFF, code: 'risk_off',
      reason: soft ? '退潮期且情绪仍在警戒：风险释放未完成，回避为先'
                   : '退潮期：结构向下，风险收益不占优' };
  }
  if (trend === 'downEnd') {
    if (panic || soft) return { window: W.CAP_WATCH, code: 'cap_watch',
      reason: '磨底期叠加情绪低位：抵抗出现但尚未确认反转，列入观察' };
    return { window: W.WAIT, code: 'wait', reason: '磨底期情绪回稳，等待结构确认' };
  }

  // 上行结构
  if (trend === 'upStrong') {
    if (panic) return { window: W.CAP_WATCH, code: 'cap_watch',
      reason: '主升期却恐慌：多为急跌洗盘，观察情绪是否快速修复' };
    return { window: W.ENGAGE, code: 'engage',
      reason: soft ? '主升期情绪警戒：上行结构中的回踩，风险收益较好'
                   : '主升期情绪平稳：趋势内参与窗口' };
  }
  if (trend === 'upEarly') {
    if (panic) return { window: W.WAIT, code: 'wait',
      reason: '启动期遭遇恐慌：启动可能失败，等待确认' };
    return { window: W.ENGAGE, code: 'engage',
      reason: '启动期情绪不恐慌：早期参与窗口，确认度低于主升' };
  }

  // 高位/中性
  if (trend === 'upRange') {
    return { window: W.HOLD, code: 'hold',
      reason: '高位震荡：趋势未破但不宜追高，持有为主' };
  }
  return { window: W.WAIT, code: 'wait', reason: '筑底/无方向，等待结构选择' };
}

/* ───────────── 样本外成绩单 ───────────── */

function wstats(items) {
  const n = items.length;
  if (!n) return { n: 0, winRate: null, avgFwd: null };
  const wins = items.filter(x => x.fwd > 0).length;
  return { n,
    winRate: +(wins / n).toFixed(3),
    avgFwd: +(items.reduce((a, b) => a + b.fwd, 0) / n).toFixed(2) };
}

/**
 * 逐日重算两个维度并给每个窗口【样本外】胜率。
 *
 * @param daily 升序行；每行需有 fwd（T+N收益）字段，键由 fwdKey 指定
 * @param deps {
 *   phaseAt(i): 返回截至第i日(含)的缠论阶段（内部对slice计算，无未来），
 *   scoreAt(i): 返回第i日的样本外多因子情绪分（只用过去），
 * }
 * @param opt {minIndex 起评下标（等两维预热）, fwdKey='fwd_d3'}
 *
 * 两个注入函数把 chan/情绪 的实现解耦，本函数只负责合成与汇总，保持纯函数可测。
 */
function backtestWindows(daily, deps, opt = {}) {
  const rows = daily || [];
  const minIndex = opt.minIndex || 40;
  const fwdKey = opt.fwdKey || 'fwd_d3';
  const phaseAt = deps.phaseAt, scoreAt = deps.scoreAt;
  if (typeof phaseAt !== 'function' || typeof scoreAt !== 'function') {
    throw new Error('backtestWindows 需要 phaseAt / scoreAt 两个函数');
  }

  const byWindow = new Map();
  const events = [];
  for (let i = minIndex; i < rows.length; i++) {
    const fwd = rows[i][fwdKey];
    if (fwd == null) continue;
    const phase = phaseAt(i);
    const score = scoreAt(i);
    if (phase == null || score == null) continue;
    const r = windowOf(phase, score);
    if (r.code === 'unknown') continue;
    const ev = { i, date: rows[i].date, code: r.code, window: r.window, fwd };
    events.push(ev);
    if (!byWindow.has(r.code)) byWindow.set(r.code, { window: r.window, items: [] });
    byWindow.get(r.code).items.push(ev);
  }

  const report = [...byWindow.values()].map(x => ({
    code: events.find(e => e.window === x.window).code,
    window: x.window, ...wstats(x.items),
  })).sort((a, b) => b.n - a.n);

  return {
    fwdKey,
    n: events.length,
    windows: report,
    note: `样本外窗口分布 ${events.length} 次（${fwdKey}）；窗口等级不含买入指令`,
  };
}

module.exports = { windowOf, backtestWindows, W, PHASE_TREND };
