'use strict';
/**
 * 思考链路（brain）
 *
 * ══════ 为什么要抽这个文件 ══════
 * 原来整条链路（检索记忆 → 组装上下文 → 工具调用循环 → 抽取新记忆）
 * 埋在 server.js 的 SSE 处理函数里，和 `res.write` 强耦合。
 *
 * 接飞书时发现根本没法复用：飞书是长连接推消息，没有 res 对象。
 *
 * 如果为飞书另写一份，两条链路会慢慢漂移 ——
 * 网页上答得好、手机上答得差，这是最难排查的一类 bug（同一个问题两种答案）。
 * 所以抽成纯函数，用 onEvent 回调代替 res.write：
 *   - 网页把事件转成 SSE
 *   - 飞书忽略中间事件，只取最终回复
 * **同一条大脑，两个出口。**
 */

const db = require('./db');
const llm = require('./llm');
const memory = require('./memory');
const mind = require('./mind');
const tools = require('./tools/registry');

const MAX_TOOL_ROUNDS = 5;      // 防止模型循环调用出不来

/**
 * 跑一次完整对话。
 *
 * @param {string} text 用户输入
 * @param {object} opts
 *   @param {function} opts.onEvent (event, data) => void  中间过程通知（可选）
 *   @param {number}   opts.maxTokens 单轮上限
 *   @param {number}   opts.historyCount 带入的历史条数
 *   @param {string}   opts.channel 来源标记：'web' | 'feishu'
 * @returns {Promise<{ok, text, toolEvents, toolRounds, learned, error}>}
 */
async function think(text, opts = {}) {
  const emit = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const maxTokens = opts.maxTokens || 2000;
  const historyCount = opts.historyCount == null ? 10 : opts.historyCount;
  const channel = opts.channel || 'web';

  const toolEvents = [];
  let finalText = '';
  let toolRound = 0;

  const userMsgId = db.addMessage('user', text);

  // 0) 告诉主动意识"用户说话了" —— 警觉度回落、心境/唤醒按语气微调
  await mind.onUserMessage(text, userMsgId);

  // 1) 检索相关记忆
  emit('state', { state: 'think' });
  const hits = await memory.search(text, 6);
  emit('recall', {
    hits: hits.map(h => ({
      id: h.id, content: h.content, entity: h.entity,
      category: h.category, score: Number(h.score.toFixed(5)),
    })),
  });

  // 2) 组装上下文
  const msgs = [{ role: 'system', content: opts.systemPrompt || '' }];
  const styleHint = mind.getStyleHint();
  if (styleHint) msgs.push({ role: 'system', content: styleHint });

  /* 渠道提示：飞书是手机端，长回复在手机上很难读。
   * 这不是换一套人格，只是告诉它输出环境变了。 */
  if (channel === 'feishu') {
    msgs.push({
      role: 'system',
      content: '【当前渠道】飞书手机端。回复要短，控制在 300 字内，'
        + '不要用 Markdown 表格（手机上会挤成一团），列表用「·」开头。'
        + '需要长内容时写进 Obsidian，只在这里回一句摘要和文件位置。',
    });
  }

  if (hits.length) {
    msgs.push({
      role: 'system',
      content: '【相关记忆】\n' + hits.map(h => `- ${h.content}`).join('\n'),
    });
  }
  for (const m of db.recentMessages(historyCount)) {
    if (m.role === 'user' || m.role === 'assistant') {
      msgs.push({ role: m.role, content: m.content });
    }
  }

  // 3) 工具调用循环
  emit('state', { state: 'speak' });
  const toolDefs = tools.listForModel();

  while (toolRound < MAX_TOOL_ROUNDS) {
    const r = await llm.chatWithTools(msgs, toolDefs, { maxTokens });
    if (!r.ok) {
      emit('error', { error: r.error });
      emit('state', { state: 'alert' });
      await mind.onAssistantReply('', false);
      return { ok: false, error: r.error, text: '', toolEvents, toolRounds: toolRound };
    }

    const msg = r.message;
    if (!msg.tool_calls || !msg.tool_calls.length) {
      finalText = msg.content || '';
      db.addMessage('assistant', finalText);
      emit('reply', { text: finalText });
      await mind.onAssistantReply(finalText, true);
      break;
    }

    // 输出被 max_tokens 截断时，tool_calls 里的 JSON 可能不完整
    if (r.finishReason === 'length') {
      const err = '模型输出被截断，无法完成工具调用';
      emit('error', { error: err });
      emit('state', { state: 'alert' });
      await mind.onAssistantReply('', false);
      return { ok: false, error: err, text: '', toolEvents, toolRounds: toolRound };
    }

    toolRound++;
    msgs.push(msg);

    for (const tc of msg.tool_calls) {
      const fnName = tc.function?.name || '';
      const rawArgs = tc.function?.arguments || '{}';
      let fnArgs = null, parseErr = null;
      try { fnArgs = JSON.parse(rawArgs); }
      catch {
        // 不静默传空参数 —— 那会让工具报"缺必填字段"，掩盖真实原因（通常是被截断）
        parseErr = `参数不是合法 JSON（长度 ${rawArgs.length}，可能被截断）`;
      }

      emit('tool_call', { id: tc.id, name: fnName, args: fnArgs || {}, round: toolRound });

      const tr = parseErr
        ? { ok: false, error: parseErr, meta: { name: fnName, ok: false } }
        : await tools.call(fnName, fnArgs);
      const resultText = tr.ok ? JSON.stringify(tr.result) : JSON.stringify({ error: tr.error });

      emit('tool_result', { id: tc.id, name: fnName, ok: tr.ok, resultSize: resultText.length });
      toolEvents.push({ id: tc.id, name: fnName, ok: tr.ok, meta: tr.meta });

      msgs.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
    }
  }

  if (toolRound >= MAX_TOOL_ROUNDS && !finalText) {
    const err = '工具调用轮次过多，已终止';
    emit('error', { error: err });
    emit('state', { state: 'alert' });
    await mind.onAssistantReply('', false);
    return { ok: false, error: err, text: '', toolEvents, toolRounds: toolRound };
  }

  // 4) 抽取新记忆
  let learned = [];
  try {
    learned = await memory.extract(text, finalText, userMsgId);
    if (learned.length) emit('learned', { memories: learned });
  } catch (e) {
    // 抽取失败不该影响已经产出的回复
    emit('warn', { warn: '记忆抽取失败: ' + e.message });
  }

  emit('state', { state: 'idle' });
  return {
    ok: true, text: finalText, toolEvents, toolRounds: toolRound, learned,
  };
}

module.exports = { think, MAX_TOOL_ROUNDS };
