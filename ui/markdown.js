'use strict';
/**
 * markdown.js —— 安全的受限 Markdown → HTML 渲染器（贾维斯回复专用）
 *
 * 铁律：**先整体转义，再按白名单渲染**。绝不把原始模型文本直接塞 innerHTML（XSS）。
 * 只支持：标题 / 粗体 / 斜体 / 行内代码 / 有序无序列表 / 引用 / 分隔线 / 表格 / 段落。
 * 不支持原始 HTML、图片、链接（金融回复不需要，关掉最安全）。
 *
 * A股语义：对“带正负号的百分比/数字”（如 +1.18%、-0.84%）自动上色并加 ▲/▼，
 * 颜色 + 符号双通道，红绿色盲也能分。方向取 :root 的 --up/--down（A股红涨绿跌）。
 *
 * 纯函数、无 DOM 依赖，前端 window.JarvisMarkdown 与 Node require 都能用。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.JarvisMarkdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 带符号的百分比/涨跌数字： +1.18% / -0.84% / -5~-6%（区间）。
     只匹配以 + 或 - 开头、紧跟数字、以 % 结尾的串，避免误伤普通负数叙述。
     两条纪律（§1.1 双通道）：
       1. 颜色与 ▲/▼ 符号永远同时给出，缺一即破坏红绿色盲可分性；
       2. 模型自己已写箭头时复用，不叠加成「▼ ▼ 4.4%」。 */
  function colorize(t) {
    return t.replace(
      /(^|[(\s])([▲▼]\s+)?([+-])(\d+(?:\.\d+)?)(?:[~～]\s*[+-]?(\d+(?:\.\d+)?))?%(?=$|[)\s,，。；;])/g,
      (m, pre, hasArrow, sign, num, rangeNum) => {
        const up = sign === '+';
        const arrow = hasArrow ? hasArrow.trim() : (up ? '▲' : '▼');
        const tail = rangeNum != null ? `~${rangeNum}%` : '%';
        return `${pre}<span class="${up ? 'up' : 'down'}">${arrow} ${num}${tail}</span>`;
      }
    );
  }

  function inline(s) {
    let t = esc(s);
    // 行内代码 `...`：用私用区占位符抽走，内部不再解析其它符号（也不上涨跌色）。
    const codes = [];
    const ph = n => '' + n + '';
    t = t.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return ph(codes.length - 1); });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = colorize(t);
    t = t.replace(/(\d+)/g, (m, n) => '<code>' + codes[Number(n)] + '</code>');
    return t;
  }

  const isTableSep = s => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.includes('-');
  const splitRow = s => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

  function render(src) {
    const raw = String(src == null ? '' : src);
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 表格：本行含 | 且下一行为分隔行
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const headers = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(c =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        const th = '<tr>' + headers.map((h, c) =>
          `<th style="text-align:${aligns[c] || 'left'}">${inline(h)}</th>`).join('') + '</tr>';
        const tb = rows.map(r => '<tr>' + headers.map((_, c) =>
          `<td style="text-align:${aligns[c] || (c ? 'right' : 'left')}">${inline(r[c] || '')}</td>`).join('') + '</tr>').join('');
        out.push(`<table><thead>${th}</thead><tbody>${tb}</tbody></table>`);
        continue;
      }

      if (/^\s{0,3}#{1,4}\s+/.test(line)) {
        const m = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line);
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue;
      }
      if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>'); continue;
      }

      const ul = /^\s*[-*+]\s+/.test(line);
      const ol = /^\s*\d+[.)]\s+/.test(line);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        const re = ul ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
        const items = [];
        while (i < lines.length && re.test(lines[i])) { items.push(inline(lines[i].replace(re, ''))); i++; }
        out.push(`<${tag}>` + items.map(x => `<li>${x}</li>`).join('') + `</${tag}>`);
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // 普通段落：合并到空行/块级元素前的连续文本
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() &&
             !/^\s{0,3}#{1,4}\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) &&
             !/^\s*\d+[.)]\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push('<p>' + inline(buf.join(' ')) + '</p>');
    }
    return out.join('');
  }

  return { render, esc, inline };
});
