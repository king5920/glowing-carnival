'use strict';
/**
 * 智能体会话扫描 —— 读取本机各个 AI 编程助手的历史对话
 *
 * 支持的格式（都是 JSONL，但结构各不相同）：
 *
 * ── Claude Code ──  ~/.claude/projects/<项目路径>/<sessionId>.jsonl
 *   每行一个事件，type 有 user / assistant / attachment / queue-operation 等
 *   真正的对话在 type=user|assistant，内容在 message.content（content blocks 数组）
 *   附带元数据：cwd（工作目录）、gitBranch、timestamp、version
 *
 * ── Codex ──  ~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl
 *   type 有 response_item / event_msg / turn_context / session_meta
 *   对话在 response_item 里
 *
 * ── OpenClaw ──  ~/.openclaw/**.jsonl（结构接近 Claude Code）
 *
 * ══════ 安全边界 ══════
 * 这个模块**只读**。它读的是沙箱外的用户目录，所以：
 * 1. 路径白名单：只允许读已知的几个智能体目录，不接受任意路径参数
 * 2. 只读文本内容，不执行、不写入、不删除
 * 3. 单文件读取上限，避免 2MB+ 的会话一次性吃光内存
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/* 白名单：只有这些目录能被扫描。写死在代码里，不接受外部传路径。 */
const SOURCES = [
  { id: 'claude-code', name: 'Claude Code', dir: path.join(HOME, '.claude', 'projects'), parser: 'claude' },
  { id: 'codex',       name: 'Codex',       dir: path.join(HOME, '.codex', 'sessions'),  parser: 'codex'  },
  { id: 'openclaw',    name: 'OpenClaw',    dir: path.join(HOME, '.openclaw'),           parser: 'claude' },
];

const MAX_FILE_BYTES = 64 * 1024 * 1024;  // 单会话上限 64MB（实测真实会话能到 22MB）
const MAX_TEXT_PER_MSG = 4000;            // 单条消息保留的最大字符数
const MAX_MSGS_KEPT = 400;                // 只保留最近 N 条消息（周报只关心近期）

/* ─────────────── 通用工具 ─────────────── */

/**
 * 流式逐行读 JSONL。
 * 不用 readFileSync —— 实测会话文件能到 22MB，一次性加载会吃光内存。
 * @param {string} file
 * @param {(obj:object)=>void} onLine 每行解析出的对象
 */
async function eachLine(file, onLine) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch { continue; }
    onLine(j);
  }
}

/** 从 content blocks 数组里抽出纯文本
 *
 * 各家的 block type 名字不一样，实测踩过的坑：
 *   Claude Code: text / thinking / tool_use / tool_result
 *   Codex:       input_text / output_text  ← 一开始漏了这两个，导致整个会话解析成空
 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const t = b.type;
    if ((t === 'text' || t === 'input_text' || t === 'output_text') && b.text) {
      parts.push(b.text);
    } else if (t === 'thinking' && b.thinking) {
      parts.push('[思考] ' + b.thinking);
    } else if (t === 'tool_use' || t === 'function_call') {
      parts.push(`[调用工具 ${b.name || '?'}]`);
    } else if (t === 'tool_result' || t === 'function_call_output') {
      // 工具结果通常很长且是机器内容，只留个标记
      parts.push('[工具返回]');
    } else if (b.text) {
      // 兜底：有 text 字段就要（新版本可能加新 type）
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function clip(s, n = MAX_TEXT_PER_MSG) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + `…[截断,共${s.length}字]` : s;
}

/* ─────────────── Claude Code / OpenClaw 解析 ─────────────── */

async function parseClaudeSession(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) return null;

  const messages = [];
  let cwd = null, gitBranch = null, version = null, sessionId = null;
  let firstAt = null, lastAt = null, totalMsgs = 0;

  await eachLine(file, j => {
    if (j.cwd && !cwd) cwd = j.cwd;
    if (j.gitBranch && !gitBranch) gitBranch = j.gitBranch;
    if (j.version && !version) version = j.version;
    if (j.sessionId && !sessionId) sessionId = j.sessionId;
    if (j.timestamp) {
      const t = Date.parse(j.timestamp);
      if (isFinite(t)) {
        if (firstAt == null || t < firstAt) firstAt = t;
        if (lastAt == null || t > lastAt) lastAt = t;
      }
    }

    if (j.type !== 'user' && j.type !== 'assistant') return;
    if (j.isSidechain) return;               // 侧链（子 agent）不算主对话
    const role = j.message?.role || j.type;
    const text = blocksToText(j.message?.content);
    if (!text.trim()) return;
    totalMsgs++;
    messages.push({ role, text: clip(text), at: j.timestamp || null });
    // 滚动窗口：只留最近 N 条，防止 22MB 会话把内存撑爆
    if (messages.length > MAX_MSGS_KEPT) messages.shift();
  });

  if (!messages.length) return null;
  return {
    file, sessionId: sessionId || path.basename(file, '.jsonl'),
    cwd, gitBranch, version,
    startedAt: firstAt, endedAt: lastAt,
    messageCount: totalMsgs,
    truncated: totalMsgs > messages.length,
    messages,
  };
}

/* ─────────────── Codex 解析 ─────────────── */

async function parseCodexSession(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) return null;

  const messages = [];
  let cwd = null, sessionId = null, gitBranch = null, version = null;
  let firstAt = null, lastAt = null, totalMsgs = 0;

  await eachLine(file, j => {
    if (j.type === 'session_meta') {
      const p = j.payload || j;
      cwd = cwd || p.cwd || null;
      sessionId = sessionId || p.session_id || p.id || null;
      version = version || p.cli_version || null;
      // Codex 把 git 信息放在 payload.git 里
      if (p.git && !gitBranch) gitBranch = p.git.branch || p.git.current_branch || null;
    }
    if (j.timestamp) {
      const t = Date.parse(j.timestamp);
      if (isFinite(t)) {
        if (firstAt == null || t < firstAt) firstAt = t;
        if (lastAt == null || t > lastAt) lastAt = t;
      }
    }

    if (j.type !== 'response_item') return;
    const p = j.payload || j;
    const role = p.role;
    // developer 角色是系统注入的指令，不是用户说的话
    if (role !== 'user' && role !== 'assistant') return;
    const text = blocksToText(p.content);
    if (!text.trim()) return;
    totalMsgs++;
    messages.push({ role, text: clip(text), at: j.timestamp || null });
    if (messages.length > MAX_MSGS_KEPT) messages.shift();
  });

  if (!messages.length) return null;
  return {
    file, sessionId: sessionId || path.basename(file, '.jsonl'),
    cwd, gitBranch, version,
    startedAt: firstAt, endedAt: lastAt,
    messageCount: totalMsgs,
    truncated: totalMsgs > messages.length,
    messages,
  };
}

/* ─────────────── 扫描 ─────────────── */

/** 递归找 jsonl 文件（带深度限制，避免扫爆） */
function findJsonl(dir, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 跳过明显不是会话的目录，省时间
      if (/^(node_modules|\.git|plugins|skills|\.tmp|\.sandbox)/.test(e.name)) continue;
      findJsonl(p, maxDepth, depth + 1, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 只读文件开头若干行，快速拿到 cwd（不解析整个会话）。
 * Codex 的目录名是日期（07/05/28），不能当项目名用，真实项目路径在 session_meta.cwd 里。
 * Claude Code 的目录名已经是编码后的路径，但也带 cwd 字段，统一走这里更准。
 */
function peekCwd(file, maxLines = 40) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(96 * 1024);          // 头 96KB 足够覆盖前几十行
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, n).toString('utf8');
    let count = 0;
    for (const line of head.split('\n')) {
      if (++count > maxLines) break;
      const s = line.trim();
      if (!s || !s.startsWith('{')) continue;
      let j;
      try { j = JSON.parse(s); } catch { continue; }   // 最后一行可能被截断，忽略
      if (j.cwd) return j.cwd;
      if (j.type === 'session_meta' && j.payload?.cwd) return j.payload.cwd;
    }
  } catch (_) {
    /* 读不到就算了，退回目录名 */
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return null;
}

/**
 * 列出所有会话的**元信息**（只读文件头拿 cwd，不解析全文，很快）。
 * @param {number} sinceDays 只要最近 N 天的
 */
function listSessions(sinceDays = 7) {
  const cutoff = Date.now() - sinceDays * 86400000;
  const out = [];
  for (const src of SOURCES) {
    if (!fs.existsSync(src.dir)) continue;
    for (const f of findJsonl(src.dir)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      if (st.size < 200) continue;             // 太小的是空会话
      const cwd = peekCwd(f);
      out.push({
        source: src.id,
        sourceName: src.name,
        file: f,
        name: path.basename(f, '.jsonl'),
        cwd,
        // 项目名优先用 cwd 的最后一段，退回目录名
        project: cwd ? path.basename(cwd) : path.basename(path.dirname(f)),
        sizeKB: Math.round(st.size / 1024),
        modified: st.mtimeMs,
        modifiedStr: new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      });
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

/** 读一个会话的完整内容 */
async function readSession(file) {
  // 安全：必须在白名单目录内
  const abs = path.resolve(file);
  const src = SOURCES.find(s => abs.startsWith(path.resolve(s.dir) + path.sep));
  if (!src) throw new Error('拒绝读取白名单外的路径');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');

  const parsed = src.parser === 'codex'
    ? await parseCodexSession(abs)
    : await parseClaudeSession(abs);
  if (!parsed) return null;
  return { ...parsed, source: src.id, sourceName: src.name };
}

/** 各源的会话统计概览 */
function overview(sinceDays = 7) {
  const sessions = listSessions(sinceDays);
  const bySource = {};
  for (const s of sessions) {
    if (!bySource[s.source]) bySource[s.source] = { name: s.sourceName, count: 0, sizeKB: 0, projects: new Set() };
    bySource[s.source].count++;
    bySource[s.source].sizeKB += s.sizeKB;
    bySource[s.source].projects.add(s.project);
  }
  return {
    sinceDays,
    total: sessions.length,
    sources: Object.entries(bySource).map(([id, v]) => ({
      id, name: v.name, sessions: v.count, sizeKB: v.sizeKB,
      projects: Array.from(v.projects).slice(0, 20),
    })),
    latest: sessions.slice(0, 10).map(s => ({
      source: s.sourceName, project: s.project, cwd: s.cwd,
      sizeKB: s.sizeKB, modified: s.modifiedStr,
    })),
  };
}

module.exports = { listSessions, readSession, overview, SOURCES };
