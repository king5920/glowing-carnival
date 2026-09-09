'use strict';
/**
 * 沙箱文件系统 —— 让贾维斯能读写文件，但**只能在 D:\jarvis\sandbox\ 里**。
 *
 * ══════════════ 安全模型 ══════════════
 *
 * 这是整个项目里最危险的能力：模型可以决定读什么、写什么。
 * 所以边界必须由**代码**保证，而不是靠 prompt 里写"请不要越界"。
 *
 * 三道防线：
 *
 * 1. **路径归一化后前缀校验**（核心）
 *    所有路径先 path.resolve 成绝对路径，再检查是否以 ROOT + sep 开头。
 *    这一步挡住 ../、绝对路径、混合分隔符等所有常规越界写法。
 *
 * 2. **符号链接实地校验**
 *    仅靠字符串前缀不够 —— 沙箱内可以有一个符号链接指向 C:\Windows。
 *    所以对已存在的路径额外做 fs.realpathSync 再校验一次。
 *    （攻击面很窄，但既然是安全边界就做全。）
 *
 * 3. **配额限制**
 *    单文件大小、文件总数、目录深度都有上限，
 *    防止模型写出一个 10GB 文件或者百万级小文件把磁盘打满。
 *
 * 另外：**不提供删除目录、不提供重命名到沙箱外、不提供执行**。
 * 能力越少越安全，需要了再加。
 */

const fs = require('fs');
const path = require('path');

/* 沙箱根目录。写死在代码里，不从配置读 —— 配置可能被改，代码不会。 */
const ROOT = path.resolve(__dirname, '..', '..', 'sandbox');

/* 配额 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件 2MB
const MAX_FILES = 500;                     // 沙箱内最多 500 个文件
const MAX_DEPTH = 6;                       // 目录最深 6 层
const MAX_READ_CHARS = 40000;              // 单次读取返回的最大字符数

/* 操作日志，界面上可查"贾维斯动过哪些文件" */
const opLog = [];
const MAX_OPLOG = 300;

function ensureRoot() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

/**
 * 把用户/模型给的相对路径解析成沙箱内的绝对路径。
 * 任何越界都抛异常 —— 绝不返回一个"可能越界"的路径让调用方自己判断。
 */
function safePath(rel) {
  ensureRoot();
  if (typeof rel !== 'string' || !rel.trim()) {
    throw new Error('路径不能为空');
  }
  // 显式拒绝一些明显的恶意形态，早失败早报错，错误信息也更清楚
  if (rel.includes('\0')) throw new Error('路径含非法字符');
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) {
    throw new Error('不允许绝对路径或网络路径，只能用沙箱内的相对路径');
  }

  // 防线 1：归一化 + 前缀校验
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error('越界访问被拒绝：只能在 sandbox 目录内操作');
  }

  // 深度校验
  const relFromRoot = path.relative(ROOT, abs);
  if (relFromRoot) {
    const depth = relFromRoot.split(path.sep).length;
    if (depth > MAX_DEPTH) throw new Error(`目录层级超过上限 ${MAX_DEPTH}`);
  }

  // 防线 2：符号链接实地校验（只对已存在的路径）
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(ROOT);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error('越界访问被拒绝：路径指向沙箱外（符号链接）');
    }
  }
  return abs;
}

function log(op, rel, extra) {
  opLog.unshift({ op, path: rel, at: Date.now(), ...extra });
  if (opLog.length > MAX_OPLOG) opLog.pop();
}

/** 统计沙箱内文件数，用于配额检查 */
function countFiles(dir = ROOT) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

/* ─────────────── 对外操作 ─────────────── */

/** 列目录 */
function list(rel = '.') {
  const abs = safePath(rel);
  if (!fs.existsSync(abs)) return { path: rel, exists: false, entries: [] };
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('不是目录: ' + rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map(e => {
    const p = path.join(abs, e.name);
    let size = null, mtime = null;
    try { const s = fs.statSync(p); size = s.size; mtime = s.mtimeMs; } catch (_) {}
    return {
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size,
      modified: mtime ? new Date(mtime).toISOString().slice(0, 19).replace('T', ' ') : null,
    };
  });
  log('list', rel, { count: entries.length });
  return { path: rel, exists: true, entries };
}

/** 读文件 */
function read(rel) {
  const abs = safePath(rel);
  if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是目录，不是文件: ' + rel);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB），上限 ${MAX_FILE_BYTES / 1048576}MB`);
  }
  let content = fs.readFileSync(abs, 'utf8');
  let truncated = false;
  if (content.length > MAX_READ_CHARS) {
    content = content.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  log('read', rel, { bytes: st.size });
  return { path: rel, size: st.size, content, truncated };
}

/** 写文件（覆盖）。会自动建父目录。 */
function write(rel, content) {
  const abs = safePath(rel);
  const text = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`内容太大（${(bytes / 1048576).toFixed(1)}MB），上限 ${MAX_FILE_BYTES / 1048576}MB`);
  }
  // 新增文件时检查总数配额
  if (!fs.existsSync(abs) && countFiles() >= MAX_FILES) {
    throw new Error(`沙箱文件数已达上限 ${MAX_FILES}，请先清理`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  log('write', rel, { bytes });
  return { path: rel, bytes, ok: true };
}

/** 追加写 */
function append(rel, content) {
  const abs = safePath(rel);
  const text = String(content == null ? '' : content);
  const existing = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (existing + bytes > MAX_FILE_BYTES) {
    throw new Error(`追加后超过单文件上限 ${MAX_FILE_BYTES / 1048576}MB`);
  }
  if (!fs.existsSync(abs) && countFiles() >= MAX_FILES) {
    throw new Error(`沙箱文件数已达上限 ${MAX_FILES}`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, text, 'utf8');
  log('append', rel, { bytes });
  return { path: rel, appended: bytes, total: existing + bytes, ok: true };
}

/** 删文件（只删文件，不删目录 —— 目录递归删太危险） */
function remove(rel) {
  const abs = safePath(rel);
  if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    throw new Error('出于安全考虑不支持删除目录，请逐个删文件');
  }
  fs.unlinkSync(abs);
  log('delete', rel, { bytes: st.size });
  return { path: rel, deleted: true };
}

/** 沙箱状态概览 */
function stat() {
  ensureRoot();
  const files = countFiles();
  let bytes = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.statSync(p).size; } catch (_) {} }
    }
  })(ROOT);
  return {
    root: ROOT,
    files,
    bytes,
    limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, maxDepth: MAX_DEPTH },
  };
}

function getLog() { return opLog.slice(0, 60); }

module.exports = { ROOT, list, read, write, append, remove, stat, getLog, safePath };
