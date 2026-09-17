'use strict';
/* 安全受限 Markdown 渲染器（ui/markdown.js）测试。
 * 最关键是 XSS：模型/外部文本里的 <script>、onerror、javascript: 必须被转义。 */
const assert = require('assert');
const md = require('../ui/markdown.js');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); } }

test('纯文本包成段落', () => {
  assert.strictEqual(md.render('你好'), '<p>你好</p>');
});

test('粗体/斜体', () => {
  assert(md.render('**收盘 1275**').includes('<strong>收盘 1275</strong>'));
  assert(md.render('这是 *强调* 字').includes('<em>强调</em>'));
});

test('行内代码', () => {
  const h = md.render('调用 `get_stock_kline` 工具');
  assert(h.includes('<code>get_stock_kline</code>'), h);
});

test('无序列表', () => {
  const h = md.render('- 第一项\n- 第二项');
  assert(h.includes('<ul><li>第一项</li><li>第二项</li></ul>'), h);
});

test('有序列表', () => {
  const h = md.render('1. 一\n2. 二');
  assert(h.includes('<ol><li>一</li><li>二</li></ol>'), h);
});

test('表格：表头+行，数字列右对齐', () => {
  const h = md.render('项目|数值\n---|--:\n收盘|1275.16\n涨跌|+0.5%');
  assert(h.includes('<table>'), h);
  assert(h.includes('<th'), h);
  assert(h.includes('text-align:right'), '应有右对齐');
  assert(h.includes('1275.16'), h);
});

test('标题与分隔线', () => {
  assert(md.render('## 结论').includes('<h2>结论</h2>'));
  assert(md.render('---').includes('<hr>'));
});

test('引用块', () => {
  assert(md.render('> 仅供观察').includes('<blockquote>仅供观察</blockquote>'));
});

test('多段落按空行分开', () => {
  const h = md.render('第一段\n\n第二段');
  assert.strictEqual(h, '<p>第一段</p><p>第二段</p>');
});

/* ── 安全红线 ── */
test('XSS：<script> 被转义', () => {
  const h = md.render('<script>alert(1)</script>');
  assert(!/<script/i.test(h), '不能含原始 script: ' + h);
  assert(h.includes('&lt;script&gt;'), h);
});

test('XSS：内联事件 onerror 不构成标签', () => {
  const h = md.render('<img src=x onerror=alert(1)>');
  // 唯一可靠的安全标准：输出里没有未转义的 '<'，浏览器就不可能解析出任何元素/事件
  assert(!/<\s*img/i.test(h), '不能产生真实 img 标签: ' + h);
  assert(!/onerror\s*=/i.test(h.replace(/&lt;[^&]*&gt;/g, '')), '尖括号内的 onerror 应随标签整体转义: ' + h);
  assert(h.includes('&lt;img'), h);
});

test('XSS：javascript: 链接无链接语法，原样显示为文本', () => {
  const h = md.render('[x](javascript:alert(1))');
  // 我们不渲染链接，方括号文本保留，且不产生 href
  assert(!/href/i.test(h), '不应生成任何链接: ' + h);
});

test('行内代码里的尖括号不被当 HTML', () => {
  const h = md.render('`</code><img src=x onerror=alert(1)>`');
  assert(!/<img/i.test(h), '代码内注入必须转义: ' + h);
});

test('粗体里的标签也被转义', () => {
  const h = md.render('**<b>x</b>**');
  assert(!/<b>/.test(h), h);
});

test('空输入安全', () => {
  assert.strictEqual(md.render(''), '');
  assert.strictEqual(md.render(null), '');
  assert.strictEqual(md.render(undefined), '');
});

/* ── A股涨跌语义：颜色 + 箭头双通道 ── */
test('涨幅：红 + ▲（A股）', () => {
  const h = md.render('上证 +1.18%');
  assert(h.includes('class="up"'), h);
  assert(h.includes('▲'), h);
});
test('跌幅：绿 + ▼', () => {
  const h = md.render('创业板 -0.49%');
  assert(h.includes('class="down"'), h);
  assert(h.includes('▼'), h);
});
test('表格单元格里的涨跌也上色', () => {
  const h = md.render('指数|涨跌\n--|--:\n上证|-1.18%');
  assert(h.includes('class="down"') && h.includes('▼'), h);
});
test('行内代码里的 +/-% 不被当涨跌（保持原文）', () => {
  const h = md.render('`+1.18%`');
  assert(!/class="(up|down)"/.test(h), h);
  assert(h.includes('+1.18%'), h);
});

console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${pass + fail}）`);
process.exit(fail ? 1 : 0);
