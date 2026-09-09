'use strict';
/**
 * Obsidian 库写入 —— 严格遵守库内 AGENTS.md 契约
 *
 * ══════ 库现状（实地勘察 2026-09）══════
 * D:\图书馆\图书馆  —  1264 文件 / 4.97GB，PARA 结构
 *   00-Inbox / 10-Projects / 20-Areas / 30-Resources / 40-Archives
 *   90-MOC / 99-演化日志 / AI智能体工作记录 / 附件(2.6GB)
 *   子库：四书五经 / 术数风水 / 安脱达资料 / 缠论量化 / 股市悟道对话录
 *
 * ══════ AGENTS.md 铁律（必须遵守）══════
 * 1. 非破坏性：只允许「新建、追加、加链接」。禁止移动/重命名/删除任何已有笔记。
 * 2. 正文与 AI 产出分离：AI 内容放在 `## AI 关联建议` 或 `## AI 综合` 区块，不改写用户原句。
 * 3. 中文输出。
 * 4. 附件目录只读。
 * 5. 库存在**多智能体并发写入**（WorkBuddy 定时任务），所以写入必须幂等、必须防冲突。
 *
 * ══════ 本模块的额外自我约束 ══════
 * 库有 4.97GB 真实资产，出事无法挽回。所以：
 *   - 白名单：只能写 00-Inbox/ 和 AI智能体工作记录/，其余目录**连写都不允许尝试**
 *   - 只新建，不覆盖：同名文件存在就加序号，绝不 truncate
 *   - 不提供删除接口（想删自己去 Obsidian 里删）
 *   - dryRun 模式：先看要写什么，确认后再落盘
 */

const fs = require('fs');
const path = require('path');

/* 库根目录。写死不接受外部传参 —— 避免被诱导写到别的地方。 */
const VAULT = 'D:\\图书馆\\图书馆';

/* 允许写入的子目录白名单。
 * 只有这两个：Inbox 是收件箱（本来就是放草稿的），
 * AI智能体工作记录 是你原本就用来存 AI 对话的地方。 */
const WRITABLE = [
  '00-Inbox',
  'AI智能体工作记录',
];

/* 明确禁止触碰的目录（即使将来白名单扩大也不能碰） */
const FORBIDDEN = [
  '附件',            // 2.6GB 媒体，AGENTS.md 明确只读
  '.obsidian',       // 插件配置
  '.workbuddy',      // 别的智能体的状态
  '四书五经', '术数风水', '安脱达资料', '缠论量化', '股市悟道对话录',
];

const MAX_FILE_BYTES = 2 * 1024 * 1024;    // 单文件 2MB 上限

/* ─────────────── 路径安全 ─────────────── */

/**
 * 校验并解析相对路径。
 * 三层防护：规范化 → 白名单前缀 → 黑名单排除。
 */
function resolveSafe(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('路径不能为空');
  }
  // 拒绝绝对路径和盘符
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error('只接受库内相对路径');
  }

  const norm = path.normalize(relPath).replace(/^[\\/]+/, '');
  const abs = path.resolve(VAULT, norm);
  const vaultAbs = path.resolve(VAULT);

  // 必须在库内
  if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
    throw new Error('路径越出库范围');
  }

  const rel = path.relative(vaultAbs, abs);
  const firstSeg = rel.split(path.sep)[0];

  // 黑名单优先
  if (FORBIDDEN.includes(firstSeg)) {
    throw new Error(`「${firstSeg}」是受保护目录，禁止写入`);
  }
  // 白名单
  if (!WRITABLE.includes(firstSeg)) {
    throw new Error(`只允许写入 ${WRITABLE.join(' / ')}，不能写「${firstSeg}」`);
  }

  return { abs, rel, firstSeg };
}

/* ─────────────── 读（只读整个库都可以，读没风险）─────────────── */

/** 列目录（只读，全库可用） */
function list(relPath = '') {
  const norm = path.normalize(relPath || '.').replace(/^[\\/]+/, '');
  const abs = path.resolve(VAULT, norm);
  const vaultAbs = path.resolve(VAULT);
  if (abs !== vaultAbs && !abs.startsWith(vaultAbs + path.sep)) {
    throw new Error('路径越出库范围');
  }
  if (!fs.existsSync(abs)) throw new Error('目录不存在');

  const entries = fs.readdirSync(abs, { withFileTypes: true });
  return entries.map(e => {
    const p = path.join(abs, e.name);
    let size = null, mtime = null;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch (_) {}
    return {
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      sizeKB: size == null ? null : Math.round(size / 1024),
      modified: mtime ? new Date(mtime).toISOString().slice(0, 16).replace('T', ' ') : null,
      writable: WRITABLE.includes(e.name),
    };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
}

/** 读文件（只读，全库可用） */
function read(relPath, maxBytes = 200 * 1024) {
  const norm = path.normalize(relPath).replace(/^[\\/]+/, '');
  const abs = path.resolve(VAULT, norm);
  const vaultAbs = path.resolve(VAULT);
  if (!abs.startsWith(vaultAbs + path.sep)) throw new Error('路径越出库范围');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是目录，不是文件');
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    return { content: buf.toString('utf8') + `\n…[截断，共 ${Math.round(st.size/1024)}KB]`, truncated: true, sizeKB: Math.round(st.size/1024) };
  }
  return { content: fs.readFileSync(abs, 'utf8'), truncated: false, sizeKB: Math.round(st.size/1024) };
}

/* ─────────────── 写（严格受限）─────────────── */

/**
 * 新建笔记。**绝不覆盖** —— 同名就加序号。
 *
 * @param {string} relPath 库内相对路径
 * @param {string} content 内容
 * @param {object} opts
 * @param {boolean} opts.dryRun 只返回将要做什么，不落盘
 * @returns {{path,bytes,created,dryRun}}
 */
function createNote(relPath, content, opts = {}) {
  const { abs, rel } = resolveSafe(relPath);

  if (typeof content !== 'string') throw new Error('内容必须是字符串');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`内容 ${Math.round(bytes/1024)}KB 超过单文件 ${MAX_FILE_BYTES/1024/1024}MB 上限`);
  }

  // 同名冲突 → 加序号（防覆盖，也防和 WorkBuddy 定时任务撞车）
  let finalAbs = abs, finalRel = rel, n = 1;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  while (fs.existsSync(finalAbs)) {
    n++;
    finalAbs = path.join(dir, `${base}-${n}${ext}`);
    finalRel = path.relative(path.resolve(VAULT), finalAbs);
    if (n > 50) throw new Error('同名文件过多，放弃');
  }

  if (opts.dryRun) {
    return { path: finalRel, bytes, created: false, dryRun: true,
             renamed: finalAbs !== abs, preview: content.slice(0, 400) };
  }

  fs.mkdirSync(dir, { recursive: true });
  // wx 标志：文件已存在就报错，不覆盖（双保险）
  fs.writeFileSync(finalAbs, content, { encoding: 'utf8', flag: 'wx' });
  return { path: finalRel, bytes, created: true, dryRun: false, renamed: finalAbs !== abs };
}

/**
 * 向已有笔记**追加**内容。
 * AGENTS.md 要求 AI 产出放在专门区块里，所以强制带区块标题。
 *
 * @param {string} relPath
 * @param {string} block 要追加的内容
 * @param {object} opts
 * @param {string} opts.heading 区块标题，默认「## AI 关联建议」
 * @param {boolean} opts.dryRun
 */
function appendBlock(relPath, block, opts = {}) {
  const { abs, rel } = resolveSafe(relPath);
  if (!fs.existsSync(abs)) throw new Error('文件不存在，追加需要目标已存在（新建请用 createNote）');

  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是目录');

  const heading = opts.heading || '## AI 关联建议';
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const existing = fs.readFileSync(abs, 'utf8');
  const bytes = Buffer.byteLength(existing, 'utf8') + Buffer.byteLength(block, 'utf8');
  if (bytes > MAX_FILE_BYTES) throw new Error('追加后超过单文件上限');

  /* 幂等：同一天同一区块已经追加过就不重复写。
   * 库有多智能体并发写入，重复追加会把笔记撑爆。 */
  const marker = `<!-- jarvis:${stamp.slice(0, 10)} -->`;
  if (existing.includes(marker)) {
    return { path: rel, appended: false, reason: '今天已追加过（幂等跳过）', dryRun: !!opts.dryRun };
  }

  const addition = `\n\n${heading}\n${marker}\n> 由贾维斯于 ${stamp} 追加。以下为 AI 产出，未改动上方原文。\n\n${block}\n`;

  if (opts.dryRun) {
    return { path: rel, appended: false, dryRun: true, preview: addition.slice(0, 400) };
  }

  fs.appendFileSync(abs, addition, 'utf8');
  return { path: rel, appended: true, dryRun: false, bytes: Buffer.byteLength(addition, 'utf8') };
}

/* ─────────────── 库概览 ─────────────── */

/** 库结构概览（只读） */
function overview() {
  const vaultAbs = path.resolve(VAULT);
  if (!fs.existsSync(vaultAbs)) return { ok: false, error: '库不存在: ' + VAULT };

  const dirs = [];
  for (const e of fs.readdirSync(vaultAbs, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let count = 0;
    // 只数一层，不递归（附件目录 2.6GB 递归会很慢）
    try { count = fs.readdirSync(path.join(vaultAbs, e.name)).length; } catch (_) {}
    dirs.push({
      name: e.name,
      entries: count,
      writable: WRITABLE.includes(e.name),
      forbidden: FORBIDDEN.includes(e.name),
    });
  }

  // 最近改动的笔记（看库在被谁动）
  const recent = [];
  for (const w of WRITABLE) {
    const p = path.join(vaultAbs, w);
    if (!fs.existsSync(p)) continue;
    try {
      for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        const st = fs.statSync(path.join(p, f.name));
        recent.push({ dir: w, name: f.name, modified: st.mtimeMs });
      }
    } catch (_) {}
  }
  recent.sort((a, b) => b.modified - a.modified);

  return {
    ok: true,
    vault: VAULT,
    writableDirs: WRITABLE,
    forbiddenDirs: FORBIDDEN,
    topLevel: dirs,
    recentNotes: recent.slice(0, 8).map(r => ({
      path: r.dir + '/' + r.name,
      modified: new Date(r.modified).toISOString().slice(0, 16).replace('T', ' '),
    })),
  };
}

module.exports = {
  VAULT, WRITABLE, FORBIDDEN,
  list, read, createNote, appendBlock, overview, resolveSafe,
};
