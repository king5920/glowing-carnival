'use strict';
/**
 * 在用户的 Windows 桌面上打开东西 —— 浏览器、播放器。
 *
 * ══════ 为什么需要这个模块 ══════
 *
 * 用户 2026-09-10 问能不能放音乐/视频。
 * 贾维斯的沙箱**只能读写文本，没有音频输出**（它自己之前也这么答过）。
 * 但它跑在用户自己的 Windows 上，可以调用系统的"默认打开"能力：
 *
 *   openUrl(url)   → 用默认浏览器打开网页（网易云/QQ音乐/B站/YouTube）
 *   openPath(path) → 用系统默认程序打开本地文件（.mp3→播放器，.mp4→播放器）
 *
 * 这不是贾维斯自己发声，是它"替你点开"。语义上必须诚实——
 * 不能让模型对用户说"正在为您播放"，它控制不了播放状态
 * （不知道用户有没有点播放、什么时候停）。
 *
 * ══════ 安全边界（重要）══════
 *
 * 这个能力等于"让系统打开一个外部程序"，比读写沙箱危险。
 * 所以：
 *   1. openUrl 只允许 http/https —— 禁止 file://、javascript:、自定义协议
 *   2. openPath 只允许在用户明确给的路径打开，且做基本的可执行文件拦截
 *      （.exe/.bat/.cmd/.ps1 直接拒），防止"放首歌"变成"运行个程序"
 *   3. 参数全部走 spawn 的数组形式，绝不拼 shell 字符串，杜绝命令注入
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/* 可被当作媒体打开的本地扩展名白名单。
 * 不在名单里的（尤其可执行文件）一律拒绝。 */
const MEDIA_EXT = new Set([
  '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma',
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv',
  '.m3u', '.m3u8',
]);

/* 明确拒绝的可执行/脚本扩展名 —— "放歌"不该变成"运行程序" */
const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.ps1', '.com', '.scr', '.msi',
  '.js', '.vbs', '.jar', '.lnk', '.reg',
]);

/**
 * 用默认浏览器打开一个网页。
 * @returns {Promise<{ok, url, error?}>}
 */
function openUrl(url) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); }
    catch { return resolve({ ok: false, error: '不是合法网址: ' + url }); }

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({
        ok: false,
        error: `只允许 http/https 网址，拒绝 ${u.protocol}（防止借"放歌"打开危险协议）`,
      });
    }

    /* Windows: cmd /c start "" "url"
     * 用数组参数 + 空标题占位，URL 内含 & 等字符也不会被 shell 解释。 */
    const child = spawn('cmd', ['/c', 'start', '', u.href], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', e => resolve({ ok: false, url: u.href, error: e.message }));
    child.unref();
    /* start 几乎是立即返回的；给一个极短确认窗口 */
    setTimeout(() => resolve({ ok: true, url: u.href }), 300);
  });
}

/**
 * 用系统默认程序打开本地媒体文件。
 * @returns {Promise<{ok, file, error?}>}
 */
function openPath(file) {
  return new Promise(resolve => {
    if (!file || typeof file !== 'string') {
      return resolve({ ok: false, error: '缺少文件路径' });
    }
    const ext = path.extname(file).toLowerCase();

    if (BLOCKED_EXT.has(ext)) {
      return resolve({ ok: false, error: `拒绝打开可执行/脚本文件（${ext}）——这个能力只用于媒体文件` });
    }
    if (!MEDIA_EXT.has(ext)) {
      return resolve({ ok: false, error: `不支持的媒体类型 ${ext || '(无扩展名)'}，支持：mp3/mp4/flac/wav/mkv 等` });
    }
    if (!fs.existsSync(file)) {
      return resolve({ ok: false, error: '文件不存在: ' + file });
    }

    const child = spawn('cmd', ['/c', 'start', '', path.resolve(file)], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', e => resolve({ ok: false, file, error: e.message }));
    child.unref();
    setTimeout(() => resolve({ ok: true, file: path.resolve(file) }), 300);
  });
}

module.exports = { openUrl, openPath, MEDIA_EXT, BLOCKED_EXT };
