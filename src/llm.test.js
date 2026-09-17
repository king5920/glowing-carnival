'use strict';
/* llm 流式 SSE 解析的纯函数测试（不联网）。
 *
 * P2 把最终回答改成流式，最大的新风险是 tool_calls 在 SSE 里是**分片**的：
 * id/name 只在首片，arguments 会切成多段。归并错一个字符，
 * JSON.parse 就失败，整轮工具调用崩掉。这里把归并逻辑锁死。 */

const llm = require('./llm.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
const A = (c, m) => { if (!c) throw new Error(m); };

console.log('\n─────── llm 流式工具调用归并 ───────\n');

test('空输入返回 undefined（纯文本轮没有 tool_calls）', () => {
  A(llm.assembleToolCalls([]) === undefined, '空数组应为 undefined');
  A(llm.assembleToolCalls(null) === undefined, 'null 应为 undefined');
});

test('单个 tool_call 的 arguments 跨多片正确拼接', () => {
  const parts = [
    { index: 0, id: 'call_abc', name: 'sector_trend', args: '{"days":' },
    { index: 0, args: '5,"code"' },
    { index: 0, args: ':"BK0459"}' },
  ];
  const tc = llm.assembleToolCalls(parts);
  A(tc.length === 1, '应归并成 1 个，得到 ' + tc.length);
  A(tc[0].id === 'call_abc', 'id 丢失');
  A(tc[0].function.name === 'sector_trend', 'name 丢失');
  const args = JSON.parse(tc[0].function.arguments);
  A(args.days === 5 && args.code === 'BK0459', '参数拼坏了: ' + tc[0].function.arguments);
});

test('两个并行 tool_call 按 index 分开，参数不串台', () => {
  const parts = [
    { index: 0, id: 'c0', name: 'sector_trend', args: '{"days":5}' },
    { index: 1, id: 'c1', name: 'market_scan', args: '{"scope":' },
    { index: 1, args: '"all"}' },
  ];
  const tc = llm.assembleToolCalls(parts);
  A(tc.length === 2, '应有 2 个，得到 ' + tc.length);
  A(tc[0].function.name === 'sector_trend', '第一个名字错');
  A(tc[1].function.name === 'market_scan', '第二个名字错');
  A(JSON.parse(tc[1].function.arguments).scope === 'all', '第二参数拼坏');
});

test('分片乱序到达（index 非递增）仍按 index 归并、输出按 index 升序', () => {
  const parts = [
    { index: 1, id: 'c1', name: 'b', args: '{"x":1}' },
    { index: 0, id: 'c0', name: 'a', args: '{"y":2}' },
  ];
  const tc = llm.assembleToolCalls(parts);
  A(tc[0].function.name === 'a', '输出应按 index 升序，a 在前');
  A(tc[1].function.name === 'b', 'b 应在第二');
});

test('缺 id 的分片兜底为 call_<index>，空参数兜底为 {}', () => {
  const tc = llm.assembleToolCalls([{ index: 2, args: '' }]);
  A(tc[0].id === 'call_2', 'id 兜底错: ' + tc[0].id);
  A(tc[0].function.arguments === '{}', '空参数应兜底为 {}，得到 ' + tc[0].function.arguments);
});

test('流式入口已导出且与非流式并存（契约不破坏）', () => {
  A(typeof llm.chatWithToolsStream === 'function', '缺 chatWithToolsStream');
  A(typeof llm.chatWithTools === 'function', '非流式 chatWithTools 不能删');
});

console.log('\n───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────\n');
process.exit(fail ? 1 : 0);
