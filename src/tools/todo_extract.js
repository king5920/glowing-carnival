'use strict';
/**
 * 未完成事项提取 —— 从智能体会话里找出"还没做完的事"
 *
 * ══════ 为什么用关键词粗筛而不是直接喂给模型 ══════
 * 8 个会话 × 400 条消息 × 平均 500 字 ≈ 160 万字。
 * 直接丢给模型一次周报烧几十万 token，成本不可接受。
 *
 * 所以两段式：
 *   第一段（本模块，零成本）：关键词 + 位置规则粗筛出候选片段
 *   第二段（模型，可控成本）：只把候选片段给模型精炼成人类可读的待办
 *
 * 粗筛的设计原则是**宁滥勿缺**——漏掉真待办比多几条误报糟糕得多，
 * 因为误报模型能筛掉，漏报就永远看不到了。
 */

/* ─────────────── 信号词 ─────────────── */

/* 明确的"未完成"表述。分组是为了给不同置信度。 */
const STRONG = [
  // 明确说没做
  '还没做', '还没有做', '尚未完成', '没有完成', '未完成', '还没写', '还没实现',
  '还没测', '还没验证', '没跑通', '跑不通', '没测过', '未验证',
  // 明确推迟
  '下次再', '以后再', '之后再', '回头再', '后面再', '稍后', '留到下次',
  '暂时跳过', '先跳过', '暂时不做', '先不做', '先放着', '放一放',
  // 明确遗留
  '遗留问题', '待办', '待处理', '待验证', '待确认', '待修复', '待补充',
  'TODO', 'FIXME', 'XXX:', 'HACK:',
];

const MEDIUM = [
  // 妥协/临时方案（说明有更好的没做）
  '先这样', '暂时这样', '临时方案', '权宜之计', '不够优雅', '有点丑',
  '简化版', '简化处理', '粗糙', '凑合', 'workaround',
  // 已知缺陷
  '已知问题', '已知缺陷', '有个坑', '这里有问题', '不太对', '可能有 bug',
  '边界情况', '极端情况', '没考虑',
  // 计划
  '下一步', '接下来要', '需要再', '应该还要', '后续', '计划',
  '可以优化', '还能优化', '值得改进',
];

/* 反向信号：出现这些说明其实已经做完了，降低置信度 */
const DONE_MARKERS = [
  '已完成', '已修复', '已解决', '已实现', '搞定', '通过了', '全部通过',
  '测试通过', '验证通过', 'done', '✓', '✅',
];

/* ─────────────── 提取 ─────────────── */

/**
 * 从一段文本里找出含信号词的句子。
 * @returns {Array<{text,signal,weight}>}
 */
function scanText(text) {
  if (!text) return [];
  const hits = [];
  // 按句子切（中英文标点都算），保留一定上下文
  const sentences = String(text)
    .split(/(?<=[。！？；\n])|(?<=[.!?;]\s)/)
    .map(s => s.trim())
    .filter(s => s.length >= 6 && s.length <= 400);

  for (const s of sentences) {
    let signal = null, weight = 0;
    for (const k of STRONG) {
      if (s.includes(k)) { signal = k; weight = 2; break; }
    }
    if (!signal) {
      for (const k of MEDIUM) {
        if (s.includes(k)) { signal = k; weight = 1; break; }
      }
    }
    if (!signal) continue;

    // 同句里有"已完成"类标记就降权（很可能是在说"这个已经做完了，那个还没"）
    const hasDone = DONE_MARKERS.some(d => s.includes(d));
    if (hasDone) weight -= 0.5;
    if (weight <= 0) continue;

    hits.push({ text: s, signal, weight });
  }
  return hits;
}

/* 无信息量的指令词。会话末尾常常是这些，
 * 实测真实数据里最后一条用户消息是"开始"、"继续"、"？？"，
 * 直接当中断点摘要毫无价值，必须往前找实质内容。 */
const FILLER = [
  '开始', '继续', '好', '好的', '嗯', '对', '是', '行', '可以', '？', '?', '？？', '??',
  '继续做', '接着来', '下一步', 'go', 'ok', 'yes', 'y', 'n', '确认', '同意',
];

function isFiller(text) {
  const t = String(text || '').trim().replace(/[。！？.!?～~\s]+$/g, '');
  if (t.length <= 1) return true;
  if (t.length > 12) return false;              // 超过 12 字就算有内容
  return FILLER.includes(t) || FILLER.includes(t.toLowerCase());
}

/* 系统/工具注入的内容，不是人真正说的话。
 * 实测这些会污染"用户最后需求"，把 <environment_context> 当成待办就荒谬了。 */
const INJECTED_PATTERNS = [
  /^<environment_context>/i,
  /^<[a-z_]+_context>/i,
  /^#\s*Files mentioned by the user/i,
  /^<system-reminder>/i,
  /^<user_instructions>/i,
  /^Caveat: The messages below/i,
  /^<local-command-stdout>/i,
  /^\[Request interrupted/i,
  /^<command-name>/i,
  /^This session is being continued from/i,
];

function isInjected(text) {
  const t = String(text || '').trimStart();
  return INJECTED_PATTERNS.some(re => re.test(t));
}

/** 从末尾往前找第一条有实质内容的消息（跳过填充词和系统注入） */
function lastSubstantive(msgs, role, minLen = 12) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (role && m.role !== role) continue;
    const t = (m.text || '').trim();
    if (t.length < minLen) continue;
    if (isFiller(t)) continue;
    if (isInjected(t)) continue;
    return { text: t, at: m.at, indexFromEnd: msgs.length - 1 - i };
  }
  return null;
}

/**
 * 从一个会话里提取候选待办。
 *
 * 除了关键词，还用了**位置信号**：会话最后几条消息里的内容，
 * 天然更可能是"没做完就停了"的地方，所以额外加权。
 *
 * @param {object} session readSession 的返回
 * @param {object} opts
 */
function fromSession(session, opts = {}) {
  const { maxCandidates = 30, tailBoostCount = 6 } = opts;
  if (!session || !session.messages) return { candidates: [], tail: null };

  const msgs = session.messages;
  const out = [];

  msgs.forEach((m, i) => {
    // 系统注入的内容里也常出现 TODO 之类的词，但那不是用户的待办
    if (isInjected(m.text)) return;
    // 只看 assistant 的话找"我还没做完什么"，
    // 也看 user 的话找"你还没做"和新需求
    const hits = scanText(m.text);
    const fromTail = i >= msgs.length - tailBoostCount;
    for (const h of hits) {
      out.push({
        text: h.text,
        signal: h.signal,
        role: m.role,
        at: m.at,
        // 会话末尾的加权：断在这里的事更可能真没做完
        weight: h.weight + (fromTail ? 1 : 0),
        position: i === msgs.length - 1 ? 'last' : fromTail ? 'tail' : 'middle',
      });
    }
  });

  // 去重（同一句话可能在多轮里重复出现）
  const seen = new Set();
  const uniq = [];
  for (const c of out.sort((a, b) => b.weight - a.weight)) {
    const key = c.text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
    if (uniq.length >= maxCandidates) break;
  }

  /* 会话中断点。
   * 关键：不能直接取最后一条消息——实测最后往往是"开始"/"继续"/"？？"这类
   * 无信息量的指令词。要往前找到最近一条有实质内容的消息。 */
  const lastUser = lastSubstantive(msgs, 'user');
  const lastAsst = lastSubstantive(msgs, 'assistant');
  const veryLast = msgs[msgs.length - 1];
  const tail = {
    // 最后一条实质用户需求（跳过 "继续" 这类）
    lastUserRequest: lastUser ? lastUser.text.slice(0, 700) : null,
    // 助手最后的实质输出——通常包含"做到哪一步了"
    lastAssistantOutput: lastAsst ? lastAsst.text.slice(0, 900) : null,
    // 会话真正的最后一条是什么角色 + 是不是填充词
    endedOnUser: veryLast ? veryLast.role === 'user' : false,
    endedOnFiller: veryLast ? isFiller(veryLast.text) : false,
    // 距离末尾多远找到的实质内容，用来判断"是不是刚开个头就停了"
    userGapFromEnd: lastUser ? lastUser.indexFromEnd : null,
  };

  return { candidates: uniq, tail };
}

/**
 * 汇总多个会话的候选，按项目分组。
 * @param {Array<{session,meta}>} sessions
 */
function aggregate(entries, opts = {}) {
  const { perSession = 12 } = opts;
  const byProject = {};

  for (const e of entries) {
    const s = e.session;
    if (!s) continue;
    const proj = e.meta?.project || (s.cwd ? s.cwd.split(/[\\/]/).pop() : 'unknown');
    if (!byProject[proj]) {
      byProject[proj] = { project: proj, cwd: s.cwd || null, sessions: 0, candidates: [], tails: [] };
    }
    const g = byProject[proj];
    g.sessions++;
    const { candidates, tail } = fromSession(s, opts);
    for (const c of candidates.slice(0, perSession)) {
      g.candidates.push({ ...c, source: e.meta?.sourceName || s.sourceName, when: e.meta?.modifiedStr });
    }
    if (tail && (tail.lastUserRequest || tail.lastAssistantOutput)) {
      g.tails.push({
        source: e.meta?.sourceName || s.sourceName,
        when: e.meta?.modifiedStr,
        endedOnUser: tail.endedOnUser,
        endedOnFiller: tail.endedOnFiller,
        lastUserRequest: tail.lastUserRequest,
        lastAssistantOutput: tail.lastAssistantOutput,
      });
    }
  }

  // 每个项目内再按权重排序
  for (const g of Object.values(byProject)) {
    g.candidates.sort((a, b) => b.weight - a.weight);
    g.candidateCount = g.candidates.length;
  }

  return Object.values(byProject).sort((a, b) => b.candidates.length - a.candidates.length);
}

module.exports = { scanText, fromSession, aggregate, STRONG, MEDIUM };
