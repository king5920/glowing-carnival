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
const clock = require('./clock');
const tools = require('./tools/registry');

const MAX_TOOL_ROUNDS = 5;      // 防止模型循环调用出不来

/**
 * 判断一次工具失败是不是"调用方手误"，而不是系统/工具本身的错。
 *
 * 账本要记的是"贾维斯自己会重犯的错"。用户给了个不存在的股票代码，
 * 工具如实返回 data=null —— 这是正确行为，记进去只会制造噪音。
 * 拿不准时返回 false（宁可记），只排除高置信度的手误特征。
 */
function isBenignCallerError(fnName, errText) {
  const e = String(errText || '');
  if (/代码不存在|不是有效|data=null（代码|无数据（.*代码/.test(e)) return true;
  return false;
}

/** 取"当前这条用户消息之前"的最近一轮问答，用于纠正时定位错在哪。 */
function priorTurn() {
  try {
    const msgs = db.recentMessages(8);
    // 找最后一条 assistant，再找它之前最近的 user
    let assistant = '', user = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant' && msgs[i].content) { assistant = msgs[i].content; break; }
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && msgs[i].content) { user = msgs[i].content; break; }
    }
    return { user, assistant };
  } catch (_) { return { user: '', assistant: '' }; }
}

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

  /* ① 当前时间 —— 根治"贾维斯没有时间概念"。
   *
   * 模型自己没有时钟，之前它只能去拉行情反推时间，
   * 收盘后还会错成"盘中未收盘"（实测 19:30 它说"距收盘十几分钟"）。
   * 每轮把权威时间写进 system，它就不必也不该再自己猜。
   * 必须放在最前面，和人格提示同级，不能埋在记忆里。 */
  msgs.push({ role: 'system', content: clock.nowBlock() });

  const styleHint = mind.getStyleHint();
  if (styleHint) msgs.push({ role: 'system', content: styleHint });

  /* ③ 用户纠正 → 错误账本闭环（第②.5层）。
   *
   * 检测到"你错了/不对/应该是"这类纠正语气时：
   *   - 取出上一轮问答，让模型提炼一条候选教训
   *   - 作为 system 提示注入，要求模型先【复述这条教训并询问是否记下来】，
   *     用户肯定后再调 save_lesson 落库——不能未经确认就记
   * 明确说"记住这个教训"时，提示模型可直接调 save_lesson。
   *
   * 任何一步失败都静默跳过：纠错增强绝不能挡住用户正常提问。 */
  try {
    const correction = require('./tools/correction');
    if (correction.soundsLikeSaveDirective(text)) {
      msgs.push({ role: 'system', content:
        '【用户明确要求记住教训】请把用户这句话里包含的教训结构化成 scope/pattern/expected/actual/guard，'
        + '直接调用 save_lesson 工具保存，然后简短确认你记下了什么。' });
    } else if (correction.soundsLikeCorrection(text)) {
      const prior = priorTurn();
      if (prior.assistant) {
        const cand = await correction.extractFromCorrection(prior.user, prior.assistant, text);
        if (cand) {
          emit('lesson_proposed', cand);
          msgs.push({ role: 'system', content:
            '【检测到用户在纠正你】系统从上一轮提炼出一条候选教训（见下）。\n'
            + JSON.stringify(cand, null, 1)
            + '\n\n请严格按三步回答：'
            + '1) 先明确认错（"你说得对/是我的错"），并用自己的话讲清正确做法；'
            + '2) 用一句话复述这条教训（错在哪 + 下次怎么自查）；'
            + '3) 结尾必须是一句明确的确认提问，例如"要我把这条记进错误账本吗？回复确认就记下。"。'
            + '在用户回复确认/同意之前，不要调用 save_lesson。' });
        }
      }
    }
  } catch (e) { /* 纠错增强失败不影响对话 */ }

  /* 用户对"要记进账本吗"的肯定答复 → 提示模型把上一轮那条教训存掉。
   * 不在这里直接存（教训内容在模型上一轮的复述里），只给明确指令。 */
  try {
    const correction = require('./tools/correction');
    if (/^(好|对|嗯|确认|记吧|记下|存下|可以|行|yes|ok|嗯好)[，。.!！\s]*$/i.test(String(text).trim())
        && /记.{0,6}(账本|教训)|教训.{0,4}记/.test(priorTurn().assistant || '')) {
      msgs.push({ role: 'system', content:
        '【用户确认记下教训】你上一条已经向用户复述了一条教训并询问是否记录，用户现在同意了。'
        + '请根据上一条复述的内容调用 save_lesson 保存（scope/pattern/actual/expected/guard），然后一句话确认。' });
    }
  } catch (e) { /* 忽略 */ }

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
    /* ② 记忆必须带时间 —— 根治"我记得结论，不记得哪天"。
     *
     * 数据库每条记忆都有 created_at，但之前渲染成裸 `- ${content}`，
     * 时间戳被丢掉了。实测问"上次聊韶关算力是哪天"，它答"日期查不到"。
     * 不是没时间，是时间没递到嘴边。
     *
     * 用相对时间（3天前/上周四）+ 绝对日期：
     * 模型对相对时间的推理更准，绝对日期供精确核对。 */
    const lines = hits.map(h => {
      const t = clock.relativeTime(h.created_at);
      const when = t ? `[${t.label}] ` : '';
      return `- ${when}${h.content}`;
    });
    msgs.push({
      role: 'system',
      content: '【相关记忆】（每条开头标注了发生时间，回答"什么时候/多久以前"类问题时直接使用）\n'
        + lines.join('\n'),
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
    /* P2：最终文本轮流式输出。
     *
     * chatWithToolsStream 逐段吐 content（首 token 实测 ~0.4s，
     * 非流式要等整段 ~9s）。delta 只可能出现在"最终自然语言回答"上 ——
     * 同一轮要么是 tool_calls、要么是 content，不会混。
     * 所以收到 delta 就实时转发 reply_delta 给界面/语音流水线；
     * 收齐后若发现其实是 tool_calls（本轮没吐过 content），照常走工具。 */
    let deltaCount = 0;
    const r = await llm.chatWithToolsStream(msgs, toolDefs, {
      maxTokens,
      onDelta: (piece) => {
        deltaCount++;
        emit('reply_delta', { text: piece });
      },
    });
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
      // 全文事件保留：落库、记忆抽取、飞书等仍以完整 reply 为准（向后兼容）。
      // 已按 reply_delta 实时渲染的前端会忽略/去重，不重复显示。
      emit('reply', { text: finalText, streamed: deltaCount > 0 });
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

      /* 自我进化第①层（b）：工具成功但自己报告了"可疑信号"。
       *
       * 贾维斯自己点破了一个设计缺口：只记 ok:false 的话，
       * 本项目最危险的那类错——"要20给1""成功但数据残缺"——全是 ok:true，
       * 反而记不进去。所以允许工具在返回里带一个 warning 字段主动上报：
       *
       *   result.warning = { pattern?, expected, actual, rootCause, guard }
       *
       * 这是工具"自首"通道，brain 不猜测什么算可疑，只如实记录工具声明的。
       * 记不记由工具自己判断，避免 brain 误判正常的空结果。 */
      if (tr.ok && tr.result && tr.result.warning) {
        try {
          require('./tools/lessons').recordFailure(fnName,
            tr.result.warning.actual || tr.result.warning.rootCause || '工具上报可疑结果',
            tr.result.warning);
        } catch (_) { /* 记账失败绝不影响对话 */ }
      }

      /* 自我进化第①层：工具失败自动进错误账本。
       * 只记失败，不记成功；记账本身不允许影响主流程（内部已兜底）。
       * 同 scope+pattern 复发会累加 occurrence，不会刷屏。
       *
       * 但要排除"调用方手误"类失败 —— 比如查一个不存在的股票代码，
       * 工具正确返回 data=null。这不是贾维斯/工具的错，记进去会让账本
       * 充满"用户输错代码"的噪音，真正的系统错误反而被淹没。
       * （source_health 里也是同一条原则：健康表只记数据源故障，
       *   不记调用方参数错误。） */
      if (!tr.ok && !isBenignCallerError(fnName, tr.error)) {
        try {
          require('./tools/lessons').recordFailure(fnName, tr.error, {
            expected: '工具返回 ok:true',
          });
        } catch (_) { /* 记账失败绝不影响对话 */ }
      }

      emit('tool_result', { id: tc.id, name: fnName, ok: tr.ok, resultSize: resultText.length });
      toolEvents.push({ id: tc.id, name: fnName, ok: tr.ok, meta: tr.meta });

      msgs.push({ role: 'tool', tool_call_id: tc.id, content: resultText });

      /* 自我进化第②层：同一轮里若还要再调工具，
       * 把该工具的历史教训带进上下文，让模型这次能自查。
       * （新一轮 LLM 调用发生在 while 顶部，注入到这里会被带上） */
      if (!tr.ok) {
        try {
          const hint = require('./tools/lessons').hintFor(fnName);
          if (hint) msgs.push({ role: 'system', content: hint });
        } catch (_) { /* 同上 */ }
      }
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
