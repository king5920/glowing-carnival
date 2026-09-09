'use strict';
/**
 * 周报生成器 —— 把"会话扫描 + 大盘行情 + 待办提取"打包成一键生成。
 *
 * 流程：
 *   1. 读最近 N 天的智能体会话
 *   2. 关键词粗筛待办候选 + 提取中断点
 *   3. 取大盘指数 + 行业板块（拿不到就跳过）
 *   4. 把候选数据喂给模型，让它提炼成可读的周报
 *   5. 输出 Markdown，调用方决定写哪
 *
 * ══════ 为什么是"粗筛 + 模型精炼"而不是直接喂原文 ══════
 * 7 天会话原文几百万字，直接喂成本不可接受。
 * 粗筛把 4000 字候选喂给模型，模型来做"去重、归并、排序、写成人话"，
 * 一次周报 ≈ 5000 token，完全可控。
 *
 * 粗筛的召回率（宁滥勿缺）比精确率重要——误报模型能筛，漏报就没了。
 */

const al = require('./agent_logs');
const te = require('./todo_extract');
const mk = require('./market_board');
const llm = require('../llm');
const obsidian = require('./obsidian');

const SYSTEM = `你是贾维斯，用户的桌面助手。
你的任务是把一堆"从 AI 编程助手的历史对话里粗筛出来的待办候选 + 中断点"，
整理成一份清晰、可读、有优先级的周报。

风格要求：
- 不要客套话，直接给内容。
- 按项目分组，每个项目内按优先级排序。
- 候选是粗筛出来的，会有重复、有噪音、有上下文缺失，
  你需要合并同类项、去掉明显误报、把片段信息拼成完整句子。
- 对于"中断点"类的信息（聊到一半断了），要明确标注"未完成"。
- 如果候选里有明显冲突或说不通的地方，标注"[信息不足，需确认]"。

输出结构：
# 本周工作回顾（YYYY-MM-DD 至 YYYY-MM-DD）

## 一、大盘概览
（如果提供了行情数据，就写一段市场情绪总结 + 指数表格。
如果没有，就写"本周行情数据不可用"，不要瞎编。）

## 二、各项目进展
### <项目名>
- **进行中 / 未完成**：列最主要的 2-5 件事，按优先级排序。
  每条一句话说清楚"做了什么、卡在哪、下一步做什么"。
- **已完成**：如果候选里能看出来已经做完的事，列出来。
  （粗筛主要抓"没做完"，所以已完成的可能很少，有多少写多少。）
- **遗留问题 / 风险**：候选里提到的 bug、坑、技术债务。
- **中断点**：最近一次会话聊到哪断了（非常重要——用户可能忘了）。

## 三、待办清单（下周）
把所有未完成的事汇总成一张清单，按优先级从高到低：
P0: （必须做的）
P1: （应该做的）
P2: （有空再做的）

## 四、备注
- 候选条目总数、会话数等元信息。
- 数据来源说明。

篇幅控制（重要）：
- 全文控制在 2500 字以内。宁可每条写得短，也必须把四个章节**全部写完**。
- 「各项目进展」里每个项目最多 5 条未完成事项，每条 2-3 句话说完。
- 不要为了详尽而牺牲结构完整性——写不完整的周报没有价值。`;

/**
 * 生成周报
 * @param {object} opts
 * @param {number} opts.days 回溯多少天
 * @param {number} opts.maxCandidates 每个项目最多给模型多少候选
 */
async function generateWeekly(opts = {}) {
  const days = opts.days || 7;
  const maxCandidates = opts.maxCandidates || 20;

  /* 1+2: 读会话 + 粗筛待办（并行） */
  const list = al.listSessions(days);
  const entries = [];
  for (const meta of list) {
    const s = await al.readSession(meta.file);
    if (s) entries.push({ session: s, meta });
  }
  const groups = te.aggregate(entries, { perSession: maxCandidates });

  /* 3: 大盘指数 + 板块 + 指数周线（拿不到就跳过，不让整个周报失败） */
  let market = null;
  try {
    const idx = await mk.indexes();
    const sec = await mk.sectors(8);
    /* 只给单日快照的话，模型会（正确地）抱怨"这不是整周涨跌"。
     * 补上周线 K 线，让它能算出真正的区间表现。 */
    let weekly = null;
    try {
      const kl = require('./stock_kline');
      const picks = [
        { code: '000001', label: '上证指数' },
        { code: '399006', label: '创业板指' },
      ];
      weekly = [];
      for (const p of picks) {
        try {
          const r = await kl.kline(p.code, 'week', 6, 'none');
          if (r && r.bars.length) {
            weekly.push({
              label: p.label,
              recentWeeks: r.bars.slice(-4).map(b => ({
                weekEnd: b.date, close: b.close, high: b.high, low: b.low,
              })),
            });
          }
        } catch (_) {}
      }
      if (!weekly.length) weekly = null;
    } catch (_) { weekly = null; }

    market = { indexes: idx, sectors: sec, indexWeekly: weekly };
  } catch (_) { market = null; }

  /* 4: 精炼成周报 */
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  const dateRange = start.toISOString().slice(0, 10) + ' 至 ' + now.toISOString().slice(0, 10);

  // 裁剪候选：给模型的不能太多，每个项目最多 maxCandidates 条
  const trimmed = groups.map(g => ({
    project: g.project,
    cwd: g.cwd,
    sessions: g.sessions,
    candidates: g.candidates.slice(0, maxCandidates).map(c => ({
      text: c.text,
      signal: c.signal,
      role: c.role,
      position: c.position,
      weight: c.weight,
      source: c.source,
      when: c.when,
    })),
    interruptions: g.tails.slice(0, 5).map(t => ({
      when: t.when,
      source: t.source,
      endedOnFiller: t.endedOnFiller,
      lastUserRequest: t.lastUserRequest ? t.lastUserRequest.slice(0, 500) : null,
      lastAssistantOutput: t.lastAssistantOutput ? t.lastAssistantOutput.slice(0, 700) : null,
    })),
  }));

  const userPrompt =
    `日期范围：${dateRange}\n\n` +
    `【数据概览】\n` +
    `- 扫描 ${entries.length} 个会话，共 ${groups.length} 个项目\n` +
    `- 待办候选总数：${groups.reduce((s,g)=>s+g.candidateCount,0)} 条\n` +
    `- 中断点总数：${groups.reduce((s,g)=>s+g.tails.length,0)} 个\n\n` +
    `【各项目待办候选 + 中断点】\n` +
    JSON.stringify(trimmed, null, 2).slice(0, 12000) + '\n\n' +
    (market ?
      `【本周市场数据】\n` + JSON.stringify(market, null, 2).slice(0, 4000) + '\n\n' :
      `【本周市场数据】不可用（接口限流）\n\n`) +
    `请按上面的输出格式生成周报。`;

  const r = await llm.chat([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt },
  ], { maxTokens: 8000, temperature: 0.5, timeoutMs: 300000 });   // 长文档，给 5 分钟

  if (!r.ok) {
    return { ok: false, error: r.error };
  }

  /* 5: 输出 + 完整性检查
   * 上一版 4000 token 不够，周报断在第二章、缺"待办清单"和"备注"。
   * 静默交付半截文档比报错更糟——用户会以为那就是全部内容。 */
  const md = r.text.trim();
  const requiredSections = ['## 一、', '## 二、', '## 三、', '## 四、'];
  const missingSections = requiredSections.filter(s => !md.includes(s));
  return {
    ok: true,
    markdown: md,
    dateRange,
    // 章节缺失说明被 max_tokens 截断了，调用方应该提醒用户而不是当成正常结果
    incomplete: missingSections.length > 0,
    missingSections,
    stats: {
      sessionsScanned: entries.length,
      projects: groups.length,
      candidatesTotal: groups.reduce((s, g) => s + g.candidateCount, 0),
      interruptionsTotal: groups.reduce((s, g) => s + g.tails.length, 0),
      marketAvailable: market != null,
      sectorsAvailable: !!(market && market.sectors),
      inputChars: userPrompt.length,
      outputChars: md.length,
    },
  };
}

module.exports = { generateWeekly, toObsidianNote, writeToVault };

/* ═════════════════════════════════════════════════════════
   Obsidian 输出 —— 沿用库内既有的「每日同步」格式
   ═════════════════════════════════════════════════════════ */

/**
 * 把周报包装成符合库内规范的 Obsidian 笔记。
 *
 * 格式参照 00-Inbox/2026-09-03 每日同步.md（你已有的自动化产出）：
 *   - YAML frontmatter：tags / 日期 / 来源 / 关联 / 状态
 *   - 正文用 `> 窗口：...` 说明时间范围
 *   - 四段结构
 *
 * 不另创格式的理由：库里已经有成熟规范，多一套只会让 Dataview 查询变复杂。
 */
function toObsidianNote(report, opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const s = report.stats || {};

  const fm = [
    '---',
    'tags: [同步/贾维斯周报]',
    `日期: ${today}`,
    '来源: 贾维斯自动巡视',
    '关联: "[[AI智能体工作记录/00-总索引(MOC)|AI智能体工作记录]]"',
    '状态: 草稿',
    '---',
    '',
  ].join('\n');

  const header = [
    `# ${today} 贾维斯周报（${report.dateRange}）`,
    '',
    `> 窗口：${report.dateRange}`,
    `> 数据来源：本机 ${s.sessionsScanned || 0} 个智能体会话（Claude Code / Codex / OpenClaw）` +
      `，粗筛 ${s.candidatesTotal || 0} 条待办候选、${s.interruptionsTotal || 0} 个中断点。`,
    `> 本笔记由贾维斯自动生成，属 AI 产出，未改动库内任何既有笔记。`,
    '',
  ].join('\n');

  /* 模型输出的正文。它已经是四段 Markdown 结构，
   * 但一级标题会和上面的 # 冲突，降一级。 */
  let body = (report.markdown || '').trim();
  body = body.replace(/^#\s+.*$/m, '').trim();     // 去掉模型自己的一级标题

  const footer = [
    '',
    '---',
    '',
    '## 元信息',
    '',
    `- 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `- 扫描会话：${s.sessionsScanned || 0} 个，涉及 ${s.projects || 0} 个项目`,
    `- 待办候选：${s.candidatesTotal || 0} 条（关键词粗筛，含噪音，已由模型合并去重）`,
    `- 行情数据：${s.marketAvailable ? '可用' : '不可用'}` +
      `${s.sectorsAvailable ? '，含行业板块' : '，板块数据未取到'}`,
    report.incomplete ? `- ⚠️ 本篇章节不完整，缺：${(report.missingSections || []).join(' ')}` : '',
    '',
  ].filter(Boolean).join('\n');

  return fm + header + body + footer;
}

/**
 * 生成周报并写入 Obsidian 库。
 *
 * @param {object} opts
 * @param {number} opts.days
 * @param {boolean} opts.dryRun 只看要写什么，不落盘
 * @param {string} opts.dir 目标目录，默认 00-Inbox
 */
async function writeToVault(opts = {}) {
  const r = await generateWeekly({ days: opts.days || 7 });
  if (!r.ok) return { ok: false, error: r.error };

  const note = toObsidianNote(r);
  const today = new Date().toISOString().slice(0, 10);
  const dir = opts.dir || '00-Inbox';
  const relPath = `${dir}/${today} 贾维斯周报.md`;

  try {
    const w = obsidian.createNote(relPath, note, { dryRun: !!opts.dryRun });
    return {
      ok: true,
      vaultPath: w.path,
      bytes: w.bytes,
      created: w.created,
      dryRun: w.dryRun,
      renamed: w.renamed,
      preview: opts.dryRun ? note.slice(0, 800) : undefined,
      stats: r.stats,
      incomplete: r.incomplete,
    };
  } catch (e) {
    // 写库失败不能把生成结果丢了
    return { ok: false, error: '写入库失败: ' + e.message, markdown: r.markdown };
  }
}
