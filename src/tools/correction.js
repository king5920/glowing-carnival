'use strict';
/**
 * 用户纠正 → 教训（错误账本第②.5层：闭环）
 *
 * ══════ 为什么需要 ══════
 * 第①层只在工具报错时记账。但最有价值的反馈常常是【用户口头纠正】：
 * 「不对」「你错了」「应该是…」「这都能搞错」。这些不经过工具失败，
 * 第①层永远抓不到。
 *
 * ══════ 为什么不直接记账 ══════
 * 用户的吐槽/反话/玩笑不是教训，自动入帐会把账本搞脏（项目原则：
 * 拿不准就别猜）。所以分两步：
 *   1) detect：检测到"纠正语气"时，把上一轮问答 + 纠正交给模型，
 *      提炼出一条候选教训（可能判定"不是纠正"→ null）
 *   2) 确认：模型必须先向用户复述这条教训并询问"要记下来吗"，
 *      用户肯定后才调 confirm_lesson 真正落库
 *
 * 用户也可以明确说「记住这个教训：…」→ 走 quickSave 直接记，不用反问。
 */

const db = require('../db');
const llm = require('../llm');
const lessons = require('./lessons');

/* 纠正语气的高置信度触发词。命中只是【触发提炼】，不等于直接记账。
 * 宁松勿紧：这里松一点没关系，因为后面还有模型判断 + 用户确认两道关。 */
const CORRECTION_RE = /(你错了|错了|不对|不正确|搞错|弄错|说错|不是这样|应该是|又错|怎么又|记错了|理解错|搞反了|胡说|瞎说)/;

/** 这句话听起来像在纠正上一轮吗 */
function soundsLikeCorrection(text) {
  return CORRECTION_RE.test(String(text || ''));
}

/** 明确要求"记住教训"的指令（可直接存，不必反问） */
function soundsLikeSaveDirective(text) {
  return /(记住这个教训|把这条教训记|记下来这个教训|以后别再犯|这条要记住)/.test(String(text || ''));
}

const EXTRACT_SYSTEM = `你在判断用户是不是在纠正助手刚犯的一个【可复用的错误】。
只根据给你的"上一轮问答"和"用户当前这句话"判断。

输出严格 JSON，不要输出别的：
- 如果当前这句话不是在指出助手的错误（闲聊、反问、玩笑、新问题），输出 {"is_correction": false}
- 如果是纠正，输出：
  {"is_correction": true,
   "scope": "出错的环节，如 web:回答 / tool:工具名 / logic:推理 / memory:记忆 / time:时间",
   "pattern": "错误类型，尽量用：把空/残缺结果当成功 / 没读真实返回结构就猜字段 / 错误被静默吞掉 / 单次观测就下结论 / 时间概念错误 / 事实错误 / 逻辑错误 / 其它",
   "expected": "正确应该怎样（一句话）",
   "actual": "助手实际错在哪（一句话）",
   "root_cause": "根本原因（一句话）",
   "guard": "下次怎么避免，必须是可执行的自查方式"}

要求：只提炼真正能帮助下次的教训，不要把用户的情绪或观点记成错误。`;

/**
 * 从"上一轮问答 + 当前纠正"提炼候选教训。
 * 模型判断不是纠正时返回 null。
 */
async function extractFromCorrection(prevUser, prevAssistant, correction) {
  const r = await llm.chat([
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content:
      '【上一轮用户问】' + String(prevUser || '').slice(0, 500)
      + '\n【上一轮助手答】' + String(prevAssistant || '').slice(0, 900)
      + '\n【用户当前这句】' + String(correction || '').slice(0, 400)
      + '\n\n输出 JSON。' },
  ], { maxTokens: 600, temperature: 0.1, timeoutMs: 60000 });

  const text = (r && (r.content || r.text)) || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || !j.is_correction) return null;
  // 字段兜底，缺关键字段就不当作有效教训
  if (!j.actual || !j.guard) return null;
  return {
    scope: String(j.scope || 'web:回答').slice(0, 120),
    pattern: String(j.pattern || '其它').slice(0, 80),
    expected: String(j.expected || '').slice(0, 400),
    actual: String(j.actual || '').slice(0, 400),
    rootCause: String(j.root_cause || '').slice(0, 400),
    guard: String(j.guard || '').slice(0, 400),
  };
}

/**
 * 真正落库（用户确认后或直接指令时调用）。
 * scope 统一加前缀，和工具失败账本区分：纠正可能针对任意环节。
 */
function confirmLesson(c) {
  if (!c || !c.actual) return { ok: false, error: '教训内容不完整' };
  // 用户纠正的 scope 不是工具名，单独命名空间，避免和 tool:* 混淆
  const scope = /^(tool|web|logic|memory|time):/.test(c.scope || '') ? c.scope : ('user:' + (c.scope || '纠正'));
  return { ok: true, ...db.addLesson({
    scope,
    pattern: c.pattern || '用户纠正',
    expected: c.expected, actual: c.actual,
    rootCause: c.rootCause, guard: c.guard,
  }) };
}

module.exports = {
  soundsLikeCorrection, soundsLikeSaveDirective,
  extractFromCorrection, confirmLesson,
  CORRECTION_RE,
};
