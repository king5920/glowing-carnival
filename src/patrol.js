'use strict';
/**
 * 后台巡视 —— 贾维斯"自己找事做"时真正执行的任务
 *
 * ══════ 为什么需要这个模块 ══════
 * Phase 3 做了主动意识（jiwen 五轴），但 find_activity 分支只是
 * 广播一个假标签（"整理记忆"），**实际什么都没干**。
 * Phase 4 做了 7 个工具，但只有用户主动问才会用。
 * 这个模块把两者接起来：闲下来时，真的去干活。
 *
 * ══════ 成本控制（关键设计）══════
 * 心跳每 60 秒 tick 一次。如果每次都干活，一天 1440 次，成本爆炸。
 * 所以按**成本分级 + 独立冷却**：
 *
 *   等级        任务              成本      冷却
 *   ────────────────────────────────────────────
 *   free       大盘异动扫描       0 token   15 分钟
 *   free       会话新增检测       0 token   30 分钟
 *   cheap      记忆整理           ~500      2 小时
 *   expensive  周报生成           ~8000     7 天（且只在周末）
 *
 * 只有 free 级别可以频繁跑。expensive 级别一周最多一次。
 *
 * ══════ 打扰用户的门槛 ══════
 * 用户明确说了"只报显著异动"。所以：
 *   - free 任务发现的东西，只有超过阈值才推给用户
 *   - 没超阈值就静默记录，不打扰
 */

const mk = require('./tools/market_board');
const al = require('./tools/agent_logs');
const te = require('./tools/todo_extract');
const health = require('./tools/source_health');
const memTidy = require('./tools/memory_tidy');
const quant = require('./tools/quant_bridge');

/* ─────────────── 冷却管理 ─────────────── */

const COOLDOWNS = {
  market_scan:   15 * 60 * 1000,        // 15 分钟
  session_scan:  30 * 60 * 1000,        // 30 分钟
  health_check:  60 * 60 * 1000,        // 1 小时：数据源健康检查（零成本）
  memory_tidy:    2 * 60 * 60 * 1000,   // 2 小时
  /* ══════ quant_research 数据刷新 ══════
   *
   * 实测发现用户的量化数据停在 41 天前：
   *   snapshots/runs/executions   2.6 天前   ← 还在跑
   *   reviews                    39.6 天前   ← 停了
   *   reports/plans              63.9 天前   ← 停最久
   *
   * 根因不是数据源坏了，而是**从来没有自动化**：
   * 唯一的计划任务 QuantResearchCockpit8892 只启动 Web 驾驶舱（app.run），
   * 并不更新数据；而且它在 2026-06-19 以 0x8007041B（进程被终止）失败，
   * 触发器是单次时间点，失败后再没跑过。
   * scripts/ 目录里也没有任何 .cmd/.bat/.ps1 自动化脚本。
   *
   * 数据过期 41 天意味着基于它的任何选股结论都是错的 ——
   * 比界面美化重要得多，所以让巡视接管。
   *
   * 冷却 6 小时：morning 流程较重（预估 300 秒），一天 2-3 次足够。 */
  quant_refresh:  6 * 60 * 60 * 1000,
  weekly_report:  7 * 24 * 60 * 60 * 1000,  // 7 天
};

const _lastRun = {};

function canRun(task) {
  const cd = COOLDOWNS[task];
  if (!cd) return true;
  const last = _lastRun[task] || 0;
  return Date.now() - last >= cd;
}
function markRun(task) { _lastRun[task] = Date.now(); }

/* ─────────────── 异动判定阈值 ─────────────── */

/* 用户选了"只报显著异动"。这些阈值就是"显著"的定义。 */
const THRESHOLDS = {
  indexChangePct: 1.5,        // 单个指数涨跌超过 1.5%
  indexDivergence: 2.0,       // 指数间分化超过 2 个百分点（如上证+0.5% 创业板-1.6%）
  sectorChangePct: 3.0,       // 板块涨跌超过 3%
  sectorBreadth: 0.85,        // 85% 以上板块同向（普涨或普跌）
};

/* ─────────────── free: 大盘异动扫描 ─────────────── */

/**
 * 扫一眼大盘，判断有没有值得报告的异动。
 * 零成本（只调行情接口，不调模型）。
 */
async function scanMarket() {
  let indexes;
  try { indexes = await mk.indexes(); }
  catch (e) { return { ok: false, reason: '行情接口不可用: ' + e.message }; }

  const findings = [];

  // 1) 单个指数大涨大跌
  for (const ix of indexes) {
    if (ix.changePct == null) continue;
    if (Math.abs(ix.changePct) >= THRESHOLDS.indexChangePct) {
      findings.push({
        kind: 'index_move',
        severity: Math.abs(ix.changePct) >= 3 ? 'high' : 'medium',
        text: `${ix.short} ${ix.changePct > 0 ? '涨' : '跌'} ${Math.abs(ix.changePct).toFixed(2)}%`,
        data: { name: ix.short, changePct: ix.changePct, price: ix.price },
      });
    }
  }

  // 2) 指数间分化（这个比单指数涨跌更有信息量：说明资金在切换风格）
  const pcts = indexes.filter(i => i.changePct != null);
  if (pcts.length >= 2) {
    const max = pcts.reduce((a, b) => (a.changePct > b.changePct ? a : b));
    const min = pcts.reduce((a, b) => (a.changePct < b.changePct ? a : b));
    const spread = max.changePct - min.changePct;
    if (spread >= THRESHOLDS.indexDivergence) {
      findings.push({
        kind: 'divergence',
        severity: spread >= 3 ? 'high' : 'medium',
        text: `风格分化明显：${max.short} ${max.changePct > 0 ? '+' : ''}${max.changePct.toFixed(2)}% vs ${min.short} ${min.changePct.toFixed(2)}%，差 ${spread.toFixed(2)} 个点`,
        data: { spread, high: max.short, low: min.short },
      });
    }
  }

  // 3) 板块异动（拿不到就跳过，不影响前两项）
  let sectors = null;
  try { sectors = await mk.sectors(6); } catch (_) {}
  if (sectors) {
    for (const s of sectors.top.slice(0, 3)) {
      if (s.changePct >= THRESHOLDS.sectorChangePct) {
        findings.push({
          kind: 'sector_move',
          severity: s.changePct >= 5 ? 'high' : 'medium',
          text: `${s.name} 板块涨 ${s.changePct.toFixed(2)}%${s.leader ? '，领涨 ' + s.leader : ''}`,
          data: { name: s.name, changePct: s.changePct, leader: s.leader },
        });
      }
    }
    for (const s of sectors.bottom.slice(0, 3)) {
      if (s.changePct <= -THRESHOLDS.sectorChangePct) {
        findings.push({
          kind: 'sector_move',
          severity: s.changePct <= -5 ? 'high' : 'medium',
          text: `${s.name} 板块跌 ${Math.abs(s.changePct).toFixed(2)}%`,
          data: { name: s.name, changePct: s.changePct },
        });
      }
    }
    // 市场广度：绝大多数板块同向，说明是系统性行情
    // 注意 sectors 只抓首末两页（东财 pz 服务端截断在 100），
    // 所以 upSectors/downSectors 是样本内统计。partial 时不做广度判断，避免误报。
    const total = sectors.upSectors + sectors.downSectors;
    if (total > 10 && !sectors.partial) {
      const upRatio = sectors.upSectors / total;
      if (upRatio >= THRESHOLDS.sectorBreadth) {
        findings.push({
          kind: 'breadth',
          severity: 'medium',
          text: `全线普涨：${sectors.upSectors}/${total} 个板块上涨`,
          data: { upRatio },
        });
      } else if (1 - upRatio >= THRESHOLDS.sectorBreadth) {
        findings.push({
          kind: 'breadth',
          severity: 'high',
          text: `全线普跌：${sectors.downSectors}/${total} 个板块下跌`,
          data: { upRatio },
        });
      }
    }
  }

  return {
    ok: true,
    findings,
    // 只有 high 级别才值得主动打扰用户
    worthReporting: findings.some(f => f.severity === 'high') || findings.length >= 3,
    snapshot: {
      indexes: indexes.map(i => ({ name: i.short, changePct: i.changePct })),
      sectorsAvailable: !!sectors,
    },
  };
}

/* ─────────────── free: 会话新增检测 ─────────────── */

/** 上次扫描时看到的会话文件 → 修改时间，用来发现"有新活动" */
let _sessionSnapshot = null;

/**
 * 检测最近有没有新的智能体会话活动，以及有没有新冒出来的待办。
 * 零成本（只读本地文件）。
 */
async function scanSessions() {
  let list;
  try { list = al.listSessions(3); }   // 只看最近 3 天
  catch (e) { return { ok: false, reason: '会话扫描失败: ' + e.message }; }

  const current = {};
  for (const s of list) current[s.file] = s.modified;

  // 第一次运行只建立基线，不报告
  if (!_sessionSnapshot) {
    _sessionSnapshot = current;
    return { ok: true, firstRun: true, findings: [], worthReporting: false };
  }

  const findings = [];
  const changed = [];
  for (const [file, mtime] of Object.entries(current)) {
    const prev = _sessionSnapshot[file];
    if (prev == null) {
      changed.push({ file, kind: 'new' });
    } else if (mtime > prev) {
      changed.push({ file, kind: 'updated' });
    }
  }
  _sessionSnapshot = current;

  if (!changed.length) {
    return { ok: true, findings: [], worthReporting: false };
  }

  // 对变化的会话做待办粗筛（仍然零成本，只是关键词匹配）
  let newTodos = 0;
  const samples = [];
  for (const c of changed.slice(0, 3)) {          // 最多看 3 个，控制耗时
    try {
      const s = await al.readSession(c.file);
      if (!s) continue;
      const { candidates, tail } = te.fromSession(s, { maxCandidates: 8, tailBoostCount: 8 });
      // 只关心高权重的（w>=3 表示"强信号 + 在会话末尾"）
      const strong = candidates.filter(x => x.weight >= 3);
      newTodos += strong.length;
      for (const x of strong.slice(0, 2)) {
        samples.push({ project: s.cwd ? s.cwd.split(/[\\/]/).pop() : '?', text: x.text.slice(0, 160) });
      }
      if (tail && tail.endedOnUser && tail.lastUserRequest) {
        samples.push({
          project: s.cwd ? s.cwd.split(/[\\/]/).pop() : '?',
          text: '[可能被打断] ' + tail.lastUserRequest.slice(0, 140),
        });
      }
    } catch (_) {}
  }

  if (changed.length) {
    findings.push({
      kind: 'session_activity',
      severity: newTodos >= 3 ? 'medium' : 'low',
      text: `检测到 ${changed.length} 个会话有新活动${newTodos ? `，粗筛出 ${newTodos} 条待办信号` : ''}`,
      data: { changedCount: changed.length, newTodos, samples: samples.slice(0, 4) },
    });
  }

  return {
    ok: true,
    findings,
    // 会话活动本身不值得打扰，除非有明确的待办堆积
    worthReporting: newTodos >= 3,
  };
}

/* ─────────────── 调度 ─────────────── */

/**
 * 挑一个当前可以做的后台任务并执行。
 *
 * @param {object} ctx
 * @param {string} ctx.reason jiwen 给的 find_activity 原因
 * @returns {Promise<{task,label,result,worthReporting}|null>}
 */
/* ═══════════════ 任务 3：数据源健康检查 ═══════════════
 *
 * 这个任务的存在理由很具体：
 * 用户 Obsidian 库 00-Inbox/2026-09-03 每日同步.md 的「待跟进」第 1 条写着
 *   > 光环新网补取：300383 行情/资金流接口连续多日未返回，需换源
 * 这条已经躺了 5 天。而实测发现三个候选源全通 —— 真因是采集代码
 * 的裸 except 把网络抖动吞成了「无数据」。
 *
 * 教训：**问题被记录了不等于会被解决**。
 * 所以巡视必须主动检查数据源健康，把沉默的失败变成显式告警。
 */
async function checkHealth() {
  const problems = health.problems();
  if (!problems.length) {
    return { ok: true, findings: [], worthReporting: false, healthy: true };
  }

  const findings = problems.map(p => ({
    kind: 'source_broken',
    // 关键源挂了是 high，一般源是 medium；躺超过 3 天一律升级为 high
    severity: (p.critical || p.brokenForDays >= 3) ? 'high' : 'medium',
    text: p.brokenForDays >= 1
      ? `${p.label} 已故障 ${p.brokenForDays} 天：${p.lastReason || '原因未记录'}`
      : `${p.label} 连续失败 ${p.consecutiveFailures} 次：${p.lastReason || ''}`,
    data: {
      source: p.source,
      brokenForDays: p.brokenForDays,
      hasAlternative: p.hasAlternative,
      suggestedAction: p.suggestedAction,
    },
  }));

  return {
    ok: true,
    findings,
    // 数据源故障一律值得报告 —— 沉默才是问题所在
    worthReporting: true,
    problemCount: problems.length,
    // 带上可诊断的提示，让模型知道下一步能干什么
    canDiagnose: problems.filter(p => !p.hasAlternative).map(p => p.source),
  };
}

/* ═══════════════ 任务 4：记忆整理 ═══════════════
 *
 * 这个任务在 COOLDOWNS 里挂了两个 Phase 都是空壳 —— 前端显示"整理记忆"，
 * 实际什么都没做。假装在干活比不干活更糟，所以补上。
 *
 * 实际会做三件事：
 *   1. 语义重复合并（≥0.85 自动，0.70-0.85 问模型）
 *   2. 按类别半衰期衰减权重（只降不删）
 *   3. 读得多的记忆抗衰减
 */
async function tidyMemory() {
  try {
    const r = await memTidy.tidy({ useModel: true });
    const findings = [];

    if (r.merged.length) {
      findings.push({
        kind: 'memory_merged',
        severity: 'low',
        text: `合并了 ${r.merged.length} 组重复记忆`,
        data: {
          pairs: r.merged.map(m => ({
            kept: m.keptContent, dropped: m.droppedContent,
            sim: m.sim, by: m.by,
          })),
        },
      });
    }
    if (r.decayed.length) {
      findings.push({
        kind: 'memory_decayed',
        severity: 'low',
        text: `${r.decayed.length} 条记忆权重自然衰减`,
        data: { count: r.decayed.length },
      });
    }

    return {
      ok: true,
      findings,
      summary: r.summary,
      // 记忆整理是内务，不值得打扰用户 —— 除非出错
      worthReporting: r.errors.length > 0,
      didSomething: r.didSomething,
      errors: r.errors,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false };
  }
}

/* ═══════════════ 任务 5：quant_research 数据刷新 ═══════════════
 *
 * 用户的量化系统数据停在 41 天前，根因是没有自动化（详见 COOLDOWNS 注释）。
 * 由巡视接管，每 6 小时最多一次。
 *
 * ── 关键设计：先查新鲜度，再决定要不要跑 ──
 * morning 流程预估 300 秒，无脑跑很浪费。
 * 先用 system-status（726ms 实测）看数据是否真的过期，
 * 只有确实过期才跑重流程 —— 这和「数据层免费轮询，只在异动时才调模型」同一原则。
 *
 * ── 为什么不直接改用户的 quant_research 代码 ──
 * L3（AI 自动改数据源代码）是明确拒绝过的：
 * AI 改量化代码可能静默产出错误行情，而错的报价比没有报价更危险。
 * 这里只是**调用它已有的入口**，不碰它一行代码。
 */
async function refreshQuant() {
  try {
    // 第一步：便宜的状态检查
    const st = await quant.run('system-status');
    if (!st.ok) {
      return {
        ok: false,
        error: 'quant_research 无法访问: ' + (st.error || `exit ${st.exitCode}`),
        findings: [{
          kind: 'quant_unreachable', severity: 'medium',
          text: 'quant_research 系统无法访问，量化相关问题会答不上来',
          data: { error: st.error || st.exitCode },
        }],
        worthReporting: true,
      };
    }

    const out = st.output || '';
    /* 解析 stale 告警。system-status 的输出格式（实测）：
     *   数据质量:
     *     今日指令卡: stale | 3417662秒
     *   告警:
     *     - 今日指令卡 已过期 */
    const staleRows = [...out.matchAll(/^\s*(.+?):\s*stale\s*\|\s*(\d+)秒/gm)]
      .map(m => ({ item: m[1].trim(), sec: Number(m[2]) }));
    const worstDays = staleRows.length
      ? Math.max(...staleRows.map(r => r.sec)) / 86400 : 0;

    // 数据还新鲜就不跑重流程，让位给别的任务
    if (!staleRows.length) {
      return { ok: true, findings: [], fresh: true, didSomething: false, worthReporting: false };
    }

    /* 第二步：确实过期了，跑 morning 刷新。
     * confirm:true 是因为这是巡视自己的决定 ——
     * 已经用 system-status 确认了必要性，不是随口一句话就跑。 */
    const r = await quant.run('morning', { confirm: true });

    if (!r.ok) {
      return {
        ok: false,
        error: r.timedOut ? `morning 流程超时（${Math.round(r.elapsedMs / 1000)}秒）` : r.error,
        findings: [{
          kind: 'quant_refresh_failed', severity: 'medium',
          text: `量化数据已过期 ${worstDays.toFixed(1)} 天，自动刷新失败`,
          data: {
            staleItems: staleRows.map(x => x.item),
            worstDays: +worstDays.toFixed(1),
            reason: r.timedOut ? '超时' : (r.stderr || '').slice(0, 300),
          },
        }],
        worthReporting: true,     // 刷新失败要说，否则用户以为数据是新的
      };
    }

    // 第三步：确认刷新是否真的生效（不能只看 exit 0）
    const after = await quant.run('system-status');
    const stillStale = [...((after.output || '')
      .matchAll(/^\s*(.+?):\s*stale\s*\|\s*(\d+)秒/gm))].map(m => m[1].trim());

    return {
      ok: true,
      findings: stillStale.length ? [{
        kind: 'quant_still_stale', severity: 'low',
        text: `刷新跑完了，但 ${stillStale.length} 项数据仍显示过期`,
        data: { items: stillStale.slice(0, 8), before: staleRows.length },
      }] : [{
        kind: 'quant_refreshed', severity: 'low',
        text: `量化数据已刷新（此前最久过期 ${worstDays.toFixed(1)} 天）`,
        data: { refreshed: staleRows.length, elapsedSec: Math.round(r.elapsedMs / 1000) },
      }],
      summary: stillStale.length
        ? `morning 跑完但 ${stillStale.length} 项仍过期`
        : `刷新了 ${staleRows.length} 项过期数据`,
      didSomething: true,
      /* 成功刷新是内务，不打扰用户；
       * 但"跑完仍过期"说明流程本身有问题，值得报告。 */
      worthReporting: stillStale.length > 0,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false };
  }
}

async function runOne(ctx = {}) {
  /* 任务优先级：便宜的先跑，贵的靠冷却压着。
   * 交易时段优先看盘，非交易时段优先看会话。
   * health_check / memory_tidy 排后面 —— 冷却长，不抢别人机会。 */
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const isTradingHours = day >= 1 && day <= 5 && hour >= 9 && hour < 15;

  const order = isTradingHours
    ? ['market_scan', 'session_scan', 'health_check', 'memory_tidy', 'quant_refresh']
    : ['session_scan', 'market_scan', 'health_check', 'memory_tidy', 'quant_refresh'];

  for (const task of order) {
    if (!canRun(task)) continue;
    markRun(task);
    if (task === 'market_scan') {
      const r = await scanMarket();
      return {
        task,
        label: '扫描大盘',
        result: r,
        worthReporting: !!(r.ok && r.worthReporting),
      };
    }
    if (task === 'session_scan') {
      const r = await scanSessions();
      return {
        task,
        label: '巡视会话记录',
        result: r,
        worthReporting: !!(r.ok && r.worthReporting),
      };
    }
    if (task === 'health_check') {
      const r = await checkHealth();
      // 全都健康时不算「做了有意义的事」，让位给别的任务
      if (r.healthy) continue;
      return {
        task,
        label: '检查数据源健康',
        result: r,
        worthReporting: !!r.worthReporting,
      };
    }
    if (task === 'memory_tidy') {
      const r = await tidyMemory();
      // 没东西可整理就让位，不占用这一轮
      if (!r.didSomething && r.ok) continue;
      return {
        task,
        label: '整理记忆',
        result: r,
        worthReporting: !!r.worthReporting,
      };
    }
    if (task === 'quant_refresh') {
      const r = await refreshQuant();
      /* 数据还新鲜就让位 —— 跟 health_check 一个道理，
       * 「什么都不用做」不算做了有意义的事。 */
      if (r.ok && r.fresh) continue;
      return {
        task,
        label: '刷新量化数据',
        result: r,
        worthReporting: !!r.worthReporting,
      };
    }
  }

  return null;   // 所有任务都在冷却中
}

/** 周报是否该做了（周末 + 冷却到期） */
function weeklyDue() {
  const d = new Date();
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;
  return isWeekend && canRun('weekly_report');
}
function markWeeklyDone() { markRun('weekly_report'); }

/** 调试用：看各任务的冷却状态 */
function cooldownStatus() {
  const out = {};
  for (const [task, cd] of Object.entries(COOLDOWNS)) {
    const last = _lastRun[task] || 0;
    const elapsed = Date.now() - last;
    out[task] = {
      cooldownMs: cd,
      lastRun: last ? new Date(last).toISOString().slice(11, 19) : null,
      ready: elapsed >= cd,
      readyInSec: elapsed >= cd ? 0 : Math.ceil((cd - elapsed) / 1000),
    };
  }
  return out;
}

module.exports = {
  runOne, scanMarket, scanSessions, checkHealth, tidyMemory,
  weeklyDue, markWeeklyDone, cooldownStatus,
  THRESHOLDS, COOLDOWNS,
};
