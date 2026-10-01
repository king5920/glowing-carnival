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
const clock = require('./clock');

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
  /* 收盘扫描：一天一次就够。
   * 15:00 收盘后数据才定型，盘中跑没意义（资金流还在变）。
   * 冷却设 20 小时而不是 24 —— 24 小时会因为巡逻是 60 秒一跳、
   * 每次只跑一个任务，慢慢漂移到越来越晚，最后错过当天。 */
  close_scan:     20 * 60 * 60 * 1000,      // 20 小时
  /* 盯盘预警：盘中每 20 分钟看一次大盘时机（信号本身要稳，不能每分钟喊） */
  market_alert:   20 * 60 * 1000,           // 20 分钟
  /* 情绪样本采集：为标定攒数据，盘中每 30 分钟一条（同日同 slot 覆盖） */
  alert_sample:   30 * 60 * 1000,           // 30 分钟
  /* 板块资金异动：盘中每 15 分钟一次。
   * 比 market_alert 略快 —— 板块资金变化比大盘时机切换快，
   * 但也不能太快：间隔太短时"区间流入"淹没在噪音里，
   * 而且 sector_watch 自带 60 分钟基线过期保护。 */
  sector_watch:   15 * 60 * 1000,           // 15 分钟
  /* 盘前简报：交易日 08:55 左右一次。20h 冷却防漂移（同 close_scan） */
  morning_brief:  20 * 60 * 60 * 1000,      // 20 小时
  /* 持续选股：收盘后跟随 close_scan（先定方向再选个股），一天一次就够 */
  stock_pool:     20 * 60 * 60 * 1000,      // 20 小时
  /* 个股买卖点提示：盘中 20 分钟看一次池内个股技术状态（与 market_alert 同频） */
  stock_signal:   20 * 60 * 1000,           // 20 分钟
  /* 缠论生命阶段：收盘K走完才有定论，收盘后跑一次（20h 冷却防漂移，同 close_scan） */
  chan_phase:     20 * 60 * 60 * 1000,      // 20 小时
  /* 散户崩溃冰点：恐慌是日内事，盘中每 20 分钟算一次（与 market_alert 同频） */
  fear_scan:      20 * 60 * 1000,           // 20 分钟
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

/**
 * 收盘扫描：指数判时机 · 板块定方向 · 龙头选个股。
 *
 * 用户 2026-09-09 提出的框架，替代了原先「只扫算力票、趋势转正就提醒」
 * 的窄方案 —— 原方案的问题是**预设了算力是主线**，
 * 而主线本来就是要扫出来的，不该由我先钦定。
 *
 * 只落盘不推送：用户明确说「先只在网页显示，等我看几天觉得靠谱再开推送」。
 * 这条选择是今天飞书垃圾消息事故之后做的，必须尊重。
 */
async function runCloseScan() {
  try {
    const cs = require('./tools/close_scan');
    /* topN 给 60：报告只展示前 12，但校准样本要存更多。
     *
     * 原因：回归时最需要看的恰恰是**假阴性**——
     * 「被判体量不足/不活跃的板块，后来是不是反而涨了」。
     * 只存前 12 名（全是高分板块）就只能验证假阳性，
     * 等于把最重要的那半边证据丢掉了。 */
    const r = await cs.scan({ topN: 60 });
    if (!r.ok) {
      return { ok: false, error: '扫描无结果', findings: [], worthReporting: false };
    }

    const text = cs.formatScan(r);

    /* 收盘扫描已把当日板块定格进 sector_daily（见 close_scan 的落库段）。
     * 这里顺手回填前向收益：昨天那批行现在有"次日点位"了，可以算 fwd_d1。
     * 不回填的话，fwd_* 永远是 NULL，"主线判断准不准"就永远没法验证。
     * 失败不影响扫描结果 —— 但要如实带出来，不静默吞。 */
    let fwdFilled = null, fwdError = null;
    try {
      const st = require('./tools/sector_trend');
      const fr = st.backfillForward();
      fwdFilled = fr.filled;
    } catch (e) { fwdError = e.message; }

    /* 存成记忆，这样网页和后续对话都能查到，也便于日后回看
     * 「当时判的主线后来走出来了吗」—— 这是校准阈值的唯一途径。 */
    let memId = null, memError = null;
    try {
      const db = require('./db');
      const date = new Date().toISOString().slice(0, 10);
      const head = r.mainlineCount
        ? `${date} 收盘扫描：主线候选 ${r.mainlines.join('、')}`
        : `${date} 收盘扫描：无主线候选（资金体量均不达标）`;
      /* db.addMemory 直接返回 lastInsertRowid（数字），不是对象。
       *
       * category 必须是 person/place/event/interest/project 之一 ——
       * 表上有 CHECK 约束。第一版我写了 'market'，
       * 直接 CHECK constraint failed，而 catch 把错误吞了 →
       * memId 恒为 null 但扫描照常返回 ok:true。
       * 这正是本项目最怕的「看起来在工作但实际没连上」。
       * 所以现在**把错误记进 memError 并向上报**，不再静默。 */
      memId = db.addMemory({
        content: head + `｜指数${r.timing ? r.timing.stance : '未知'}`
          + `｜扫描${r.scanned}个板块\n` + text,
        category: 'event',
        entity: '收盘扫描',
        weight: 0.7,
      });
    } catch (e) { memError = e.message; }

    /* ══ 校准样本落盘（用户第四优先）══
     *
     * 用户的原话：「每天扫完存一份到沙箱，攒够样本再回归」。
     * 这是补上「过滤阈值必须来自实测样本」的空缺 ——
     * 50亿 门槛目前只有单日样本支撑。
     *
     * 落盘失败必须显式带出（memError 那个静默 catch 刚咬过一次）。 */
    let calib = null, calibError = null, backfill = null;
    try {
      const cal = require('./tools/calibration');
      calib = cal.record(r);
      /* 记完当天就立刻回填 —— 今天的点位正是昨天/前天样本的
       * d1/d3 参照物。放在同一个任务里做，避免"存了但永远没人回填"。
       *
       * 回填必须在 record 之后：先把今天存进去，
       * 才能给之前的样本当参照。顺序反了会永远差一天。 */
      backfill = cal.backfill();
    } catch (e) { calibError = e.message; }

    return {
      ok: true,
      findings: [{
        kind: 'close_scan', severity: 'low',
        text: r.mainlineCount
          ? `主线候选 ${r.mainlineCount} 个：${r.mainlines.join('、')}`
          : '今日无主线候选（高分板块资金体量均不足）',
        data: {
          timing: r.timing ? r.timing.stance : null,
          mainlines: r.mainlines,
          scanned: r.scanned,
          top: r.sectors.slice(0, 5).map(s => ({
            name: s.name, score: s.score, grade: s.grade,
            d10Yi: s.d10Yi, leader: s.leader, leaderPct: s.leaderPct,
          })),
        },
      }],
      summary: r.mainlineCount
        ? `收盘扫描完成，主线候选 ${r.mainlineCount} 个`
        : '收盘扫描完成，今日无主线候选',
      text, memId, memError, scan: r,
      calib, calibError, backfill,
      didSomething: true,
      /* 恒为 false：用户选了只在网页看。改之前必须先问。 */
      worthReporting: false,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false };
  }
}

/* ════════════════════════════════════════════════════════════════
 * 盯盘预警（用户 2026-09-10）：大盘定时机，板块定方向
 *
 * 两件事，刻意分开：
 *   1) runAlertSample —— 盘中定时把情绪+技术快照落 alert_samples（标定底座）
 *   2) runMarketAlert  —— 判断大盘时机；开窗口时再看主线板块调整，满足才提示
 *
 * 阈值未标定前（样本<15天）一律"仅供观察"，且 runMarketAlert 默认不打扰，
 * 只把状态广播到网页；真的买入信号满足时才值得提示（且仍标注未标定）。
 * ════════════════════════════════════════════════════════════════ */

/** 盘中采一条情绪+技术样本。静默、零打扰，纯为标定攒数据。 */
async function runAlertSample() {
  try {
    const sentiment = require('./tools/sentiment');
    const dbm = require('./db');
    const snap = await sentiment.snapshot();
    if (!snap.sentiment) return { ok: false, error: snap.sources.poolsError || '情绪缺失', didSomething: false };

    /* slot 按钟点分段，同一天同一段覆盖（靠主键去重），不刷屏。 */
    const h = new Date().getHours();
    const slot = h < 10 ? 'open' : h < 13 ? 'mid_am' : h < 14.3 ? 'midday' : 'close';
    const date = clock.dateKey(new Date());
    dbm.saveAlertSample(date, slot, snap);
    return { ok: true, slot, didSomething: true,
             limitUp: snap.sentiment.limitUpCount, brokenRate: snap.sentiment.brokenRate };
  } catch (e) {
    return { ok: false, error: e.message, didSomething: false };
  }
}

/**
 * 大盘买入窗口 + 主线调整预警。
 * 返回 worthReporting 由调用方按"用户要求只在网页看"强制压成 false，
 * 但 findings 会进网页状态栏。
 */
async function runMarketAlert() {
  try {
    const sentiment = require('./tools/sentiment');
    const alerts = require('./tools/alerts');
    const dbm = require('./db');

    /* 顺手采一条样本（盘中跑预警时不浪费这次请求） */
    const snap = await sentiment.snapshot();
    const days = dbm.alertSampleDates().length;
    const market = alerts.judgeMarket(snap, days);

    const findings = [];
    findings.push({
      kind: 'market_timing', severity: market.buy ? 'high' : 'low',
      text: market.buy
        ? `大盘买入窗口信号（${market.passed}/${market.total} 项满足）`
        : `大盘时机未到（${market.passed}/${market.total}），只观察`,
      data: { buy: market.buy, calibrated: market.calibrated, sampleDays: days, checks: market.checks },
    });

    let sectors = null;
    /* 只有大盘在买入窗口时，板块"调整到位"才有动手意义；
     * 否则也扫，但结论是"只观察"。为省东财请求，未开窗口时不扫板块。 */
    if (market.buy) {
      sectors = await alerts.scanMainlineAdjustments({ market, maxSectors: 6 });
      if (sectors.ok && sectors.ready.length) {
        findings.push({
          kind: 'sector_adjusted', severity: 'high',
          text: `主线板块回踩到位：${sectors.ready.join('、')}（大盘窗口已开，可作方向关注）`,
          data: { ready: sectors.ready, sectors: sectors.sectors },
        });
      }
    }

    return {
      ok: true, didSomething: true,
      buy: market.buy, calibrated: market.calibrated, sampleDays: days,
      sectors: sectors ? sectors.ready : [],
      findings,
      summary: market.buy
        ? `大盘买入窗口开（${market.passed}/${market.total}）` + (sectors && sectors.ready.length ? `，方向：${sectors.ready.join('、')}` : '')
        : `大盘时机未到（${market.passed}/${market.total}），阈值${market.calibrated ? '已标定' : '未标定(供观察)' }`,
      /* 未标定阶段即使开窗口也不算"可打扰"——先在网页看，标定后再说。 */
      worthReporting: false,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false, didSomething: false };
  }
}

/**
 * 缠论生命阶段（收盘后，每日一次）。
 * 只在收盘K走完后判定，避免盘中未完成K造成分型闪烁。
 * 未标定前恒 worthReporting:false，只把阶段写进 findings/网页，不打扰。
 */
async function runChanPhase() {
  try {
    const sentiment = require('./tools/sentiment');
    const kline = require('./tools/stock_kline');
    const dbm = require('./db');
    const mp = require('./tools/market_phase');
    const r = await mp.assess({
      getBars: (period) => kline.kline('000001', period, period === 'day' ? 240 : 320).then(k => k.bars),
      snapshot: () => sentiment.snapshot(),
      alertSamples: () => dbm.alertSamplesDaily(),
    }, { withMinute: true });

    const findings = [{
      kind: 'market_phase', severity: 'low',
      text: `大盘缠论阶段「${r.phase}」`
        + (r.chan ? `（${(r.chan.levels.day || {}).trend || '?'}走势，笔${r.chan.strokeCount}/笔中枢${r.chan.segZoneCount}/买卖点${(r.chan.levels.day || {}).pointCount}/背驰${(r.chan.levels.day || {}).divergenceCount}）` : '')
        + '｜' + ((r.sentimentTape && r.sentimentTape.note) || '未标定。这两列数给不出入场时机。'),
      data: { phase: r.phase, fear: r.fear ? r.fear.tier : null },
    }];
    return {
      ok: r.phase !== 'unknown', didSomething: true,
      phase: r.phase, fearTier: r.fear ? r.fear.tier : null,
      summary: r.summary, findings,
      worthReporting: false,     // 恒 false：未标定只上网页，改前必须问用户
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false, didSomething: false };
  }
}

/**
 * 盘中情绪不再按档位播报。
 * 两列数在网页上，这里不把某一档说成可以动手。
 */
async function runFearScan() {
  return { ok: true, didSomething: false, findings: [], worthReporting: false };
}

/**
 * 盘中板块资金异动（每 15 分钟）。
 *
 * 与 runMarketAlert 的分工：
 *   runMarketAlert  → 大盘时机（该不该出手）
 *   runSectorWatch  → 板块方向（资金在往哪去）
 *
 * 打扰纪律沿用 market_alert：阈值未标定前 worthReporting 恒为 false，
 * 只在网页上看得到，不推送。标定完成（≥15 个交易日样本）后，
 * 才允许把"强异动"升级成可打扰级别。
 */
async function runSectorWatch() {
  try {
    const sw = require('./tools/sector_watch');
    const r = await sw.watch();

    if (!r.ok) {
      return { ok: false, error: r.error, findings: [], worthReporting: false, didSomething: false };
    }
    /* 非交易时段/建基线/基线过期：都不是异动，也不算失败，静默带过。
     * 这里必须如实区分，不能把"没数据可比"说成"没有异动"。 */
    if (r.mode !== 'diff') {
      return {
        ok: true, didSomething: r.mode === 'baseline',
        mode: r.mode, findings: [], worthReporting: false,
        summary: r.note,
      };
    }

    const findings = r.moves.slice(0, 6).map(m => ({
      kind: 'sector_flow_' + m.dir,
      severity: m.dir === 'flee' ? 'medium' : 'high',
      text: `${m.name} ${m.dir === 'surge' ? '资金涌入' : m.dir === 'flee' ? '资金撤离' : '资金逆势流入'}`
        + ` ${m.deltaYi > 0 ? '+' : ''}${m.deltaYi}亿（${m.windowMin}分钟）`,
      data: m,
    }));

    return {
      ok: true, didSomething: true,
      mode: 'diff', window: r.windowMin, slot: r.slot,
      moveCount: r.moves.length, calibrated: r.calibrated, calDays: r.calDays,
      findings,
      summary: r.moves.length
        ? `板块资金异动 ${r.moves.length} 个（${r.prevSlot}→${r.slot}）：`
          + r.moves.slice(0, 3).map(m => `${m.name}${m.deltaYi > 0 ? '+' : ''}${m.deltaYi}亿`).join('、')
          + (r.calibrated ? '' : '（阈值未标定，仅供观察）')
        : `板块资金无明显异动（${r.prevSlot}→${r.slot}）`,
      /* 未标定阶段一律不打扰 —— 和 market_alert 同一条纪律。 */
      worthReporting: false,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false, didSomething: false };
  }
}

/**
 * 盘前简报（交易日 ~08:55 一次）。
 * mind 心跳里在盘前窗口调用；产出进网页+记忆，不推飞书（用户选择先只在网页看）。
 */
async function runMorningBrief() {
  try {
    const mb = require('./tools/morning_brief');
    const r = await mb.briefing();
    if (!r.ok) return { ok: false, error: r.error, findings: [], worthReporting: false };

    /* 存记忆，方便开盘对话时模型能直接引用，也便于事后核对"晨报说的对不对" */
    let memId = null;
    try {
      const dbm = require('./db');
      memId = dbm.addMemory({
        content: `${r.date} 盘前简报（来源${r.source}，过滤个股${r.filteredCount}条）\n` + r.text,
        category: 'event', entity: '盘前简报',
      });
    } catch (e) { /* 记忆失败不影响简报展示 */ }

    return {
      ok: true, didSomething: true, memId,
      findings: [{ kind: 'morning_brief', severity: 'low',
        text: `盘前简报已生成（利好${r.bullish.length}/利空${r.bearish.length}）` }],
      summary: `盘前简报：利好${r.bullish.length} 利空${r.bearish.length}`,
      brief: r,
      /* 用户明确：先只在网页显示，不推飞书。要推必须先问。 */
      worthReporting: false,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false };
  }
}

/**
 * 持续选股：收盘后跟随 close_scan 跑（先定方向再选个股）。
 * 产出候选池落 stock_pool 表 + 一条网页 finding。
 * 用户 2026-09-12：「同一天相同条件的股票很多，如何精准找到好的」——
 * 候选锁死在主线/强势板块领涨股 + 连板≥2，四维评分排序取 top N，精准而非罗列。
 */
async function runStockPool() {
  try {
    const sp = require('./tools/stock_pool');
    const r = await sp.run({ topN: 15, persist: true });
    if (!r.ok) {
      return { ok: false, error: '选股无候选入池', findings: [], didSomething: false, worthReporting: false };
    }

    const top = r.pool.slice(0, 5).map(s => `${s.name}(${s.code})${s.score}分`).join('、');
    return {
      ok: true,
      didSomething: r.pool.length > 0,
      findings: [{
        kind: 'stock_pool_new', severity: 'low',
        text: r.pool.length
          ? `候选池 ${r.pool.length} 只（扫描${r.scanned}，入池${r.scored}）：${top}`
          : '选股扫描完成，无候选入池（候选全部不达评分门槛）',
        data: {
          scanned: r.scanned, scored: r.scored, inPool: r.pool.length,
          failed: r.failedCount, top: r.pool.slice(0, 5),
          sources: r.sources, calibrated: r.calibrated,
          staleWarning: r.staleWarning, dataTime: r.dataTime,
        },
      }],
      summary: `选股完成：候选池 ${r.pool.length} 只`,
      stockPool: r,
      persistError: r.persistError,   // 落库失败必须带出来，不静默
      /* 恒为 false：用户选了只在网页看。改之前必须先问。 */
      worthReporting: false,
    };
  } catch (e) {
    return { ok: false, error: e.message, findings: [], worthReporting: false };
  }
}

/**
 * 个股买卖点条件式提示：盘中定时跑。
 * 大盘闸门：不在买入窗口时买点类信号降级"仅观察"，卖点类恒报（风险提示不设闸）。
 */
async function runStockSignal() {
  try {
    const ss = require('./tools/stock_signal');
    const r = await ss.run({ persist: true });
    if (!r.ok) {
      return { ok: false, error: r.error, findings: [], didSomething: false, worthReporting: false };
    }
    if (r.poolEmpty) {
      /* 池子为空不算失败：可能今天还没跑选股。静默让位。 */
      return { ok: true, didSomething: false, findings: [], stockSignal: r, worthReporting: false };
    }

    return {
      ok: true,
      didSomething: r.signalCount > 0,
      findings: r.findings,
      summary: r.signalCount
        ? `个股信号 ${r.signalCount} 条（大盘${r.market.buy ? '买入窗口' : '未开窗'})`
        : '个股信号 0 条',
      stockSignal: r,
      /* 恒为 false：用户选了只在网页看。改之前必须先问。 */
      worthReporting: false,
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

  /* 收盘扫描窗口：交易日 15:00-23:00。
   * 下限 15:00 因为收盘后数据才定型；上限 23:00 避免半夜跑完
   * 用户第二天早上看到的是"昨天"的扫描却以为是今天的。
   * 周末不跑 —— 没有新数据，跑了只是重复昨天。 */
  const isAfterClose = day >= 1 && day <= 5 && hour >= 15 && hour < 23;

  const order = isTradingHours
    /* 盘中：先看大盘时机（总开关），再看个股买卖点（池内技术状态），
     * 再扫板块资金异动（方向）、采情绪样本、扫盘。
     * stock_signal 放 market_alert 之后：它要读大盘窗口结果做闸门。 */
    ? ['market_alert', 'fear_scan', 'stock_signal', 'sector_watch', 'alert_sample', 'market_scan', 'session_scan', 'health_check', 'memory_tidy', 'quant_refresh']
    : isAfterClose
      /* 收盘后把 close_scan 排最前 —— 它是用户明确要的每日固定动作，
       * 不能让 session_scan 之类天天把它的机会抢掉。
       * chan_phase 紧跟其后：收盘K走完才判缠论阶段；stock_pool 再后（先定方向再选股）。 */
      ? ['close_scan', 'chan_phase', 'stock_pool', 'session_scan', 'market_scan', 'health_check', 'memory_tidy', 'quant_refresh']
      : ['session_scan', 'market_scan', 'health_check', 'memory_tidy', 'quant_refresh'];

  for (const task of order) {
    if (!canRun(task)) continue;

    /* ══ 非交易时段静默（用户 2026-09-10 要求）══════
     *
     * close_scan 是用户点名要的每日动作，且它本身只在 15:00-23:00
     * 的 isAfterClose 窗口才会出现在 order 里，所以无条件放行。
     *
     * 其余所有任务（扫盘/巡会话/健康/记忆整理/quant）在主动窗口外
     * 一律不跑。这些任务即使 worthReporting=false 也会产生网络请求和
     * 状态噪音，用户要的是"非交易时段彻底安静"。
     *
     * 注意：心跳没停、情绪还在累积，只是不主动外放。
     * 用户随时提问，brain.js 那条链路完全不受影响。 */
    if (task !== 'close_scan' && task !== 'stock_pool' && task !== 'chan_phase' && !clock.isProactiveWindow()) {
      continue;
    }

    markRun(task);
    if (task === 'close_scan') {
      const r = await runCloseScan();
      return {
        task,
        label: '收盘扫描（指数·板块·龙头）',
        result: r,
        /* 用户明确选了「先只在网页显示，等我看几天觉得靠谱再开推送」，
         * 所以这里恒为 false —— 结果进网页和记忆，不推飞书。
         * 改成 true 之前必须先问用户。 */
        worthReporting: false,
      };
    }
    if (task === 'chan_phase') {
      const r = await runChanPhase();
      if (!r.ok && r.error) continue;   // 取数失败静默让位，下一轮重试
      return {
        task,
        label: '缠论生命阶段（收盘判定）',
        result: r,
        /* 恒为 false：画法/阈值未标定，只进网页状态，不推送。改之前必须先问用户。 */
        worthReporting: false,
      };
    }
    if (task === 'stock_pool') {
      const r = await runStockPool();
      return {
        task,
        label: '持续选股（候选池）',
        result: r,
        /* 恒为 false：用户选了只在网页看。改之前必须先问。 */
        worthReporting: false,
      };
    }    if (task === 'stock_signal') {
      const r = await runStockSignal();
      /* 池子为空或 0 信号时静默让位，不占这一拍 */
      if (r.ok && !r.didSomething) continue;
      return {
        task,
        label: '个股买卖点提示',
        result: r,
        worthReporting: false,
      };
    }
    if (task === 'market_alert') {
      const r = await runMarketAlert();
      return { task, label: '盯盘预警（大盘时机·主线方向）', result: r, worthReporting: false };
    }
    if (task === 'fear_scan') {
      const r = await runFearScan();
      /* 无冰点/无法判断时静默让位，不占这一拍 */
      if (!r.didSomething) continue;
      return { task, label: '散户崩溃冰点（情绪反向）', result: r, worthReporting: false };
    }
    if (task === 'sector_watch') {
      const r = await runSectorWatch();
      /* 建基线阶段（今日首拍）没有可播报内容，静默让位给别的任务。
       * 这不是失败 —— 它把基线写进库了，下一拍才有得比。 */
      if (r.mode === 'baseline' || r.mode === 'closed' || r.mode === 'stale-baseline') continue;
      return { task, label: '板块资金异动（盘中）', result: r, worthReporting: false };
    }
    if (task === 'alert_sample') {
      const r = await runAlertSample();
      /* 纯采集：跑完继续看还有没有别的任务，不占这一拍、不产生活动播报。
       * 失败也静默，下一轮自然重试。 */
      continue;
    }
    if (task === 'morning_brief') {
      const r = await runMorningBrief();
      return { task, label: '盘前简报', result: r, worthReporting: false };
    }
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

/**
 * 盘前简报到点没：交易日 08:40–09:05 窗口 + 20h 冷却。
 *
 * 窗口从 08:40 起而不是精确 08:55：心跳 60s 一跳、每分钟只跑一个任务，
 * 给排队留余量；到 09:05 截止避免开盘后才补发"盘前"。
 * 非交易日（周末/节假日）不跑 —— 复用 clock 真实日历。
 * 开机补做：如果进程 08:40 没开、08:50 才开，冷却没记录过仍会补一次。
 */
function morningBriefDue() {
  const d = new Date();
  if (!clock.isTradingDay(d)) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  const inWindow = hm >= 8 * 60 + 40 && hm <= 9 * 60 + 5;
  return inWindow && canRun('morning_brief');
}
function markMorningBriefDone() { markRun('morning_brief'); }

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
  runOne, scanMarket, scanSessions, checkHealth, tidyMemory, runCloseScan,
  runMarketAlert, runAlertSample, runMorningBrief, runSectorWatch,
  runStockPool, runStockSignal, runChanPhase, runFearScan,
  morningBriefDue, markMorningBriefDone,
  weeklyDue, markWeeklyDone, cooldownStatus,
  THRESHOLDS, COOLDOWNS,
};
