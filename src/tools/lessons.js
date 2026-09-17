'use strict';
/**
 * 错误账本 / 教训（自我进化 第①+②层）
 *
 * ══════ 这个模块解决什么问题 ══════
 *
 * 用户 2026-09-10：「能找到自己的错误并自进化」。
 *
 * 这个项目里反复出现同一类事故：错误当时被发现（靠用户或靠重测），
 * 但发现之后没有沉淀，换个地方又犯。真实记录（不是假想）：
 *   - 猜返回字段名：fundFlow 没有 ok 字段、m.id 其实直接返回 id、
 *     category:'market' 违反 CHECK 约束、/api/chat 字段是 text 不是 message
 *   - 把"非空"当成功：要20给1、绿灯但拿不到数据
 *   - 静默 catch：落盘失败表面全绿
 *   - 单次观测下结论：30亿门槛、手写节假日错3处
 *
 * 第①层：recordFailure() 把"预期 vs 现实不符"结构化存进 lessons 表
 * 第②层：hintFor() 在调用某工具前，把该工具的历史教训注入 system，
 *        让模型这次别再踩同一个坑
 *
 * 第③层（自动生成测试）**故意不做** —— 账本没攒够时只会造噪音，
 * 且让 AI 改自己的代码有静默产错数据的风险（见 self_diagnose 里 L3 的论证）。
 *
 * 边界（用户当前只开了"工具运行时失败自动记"）：
 *   - 只记录工具调用失败，不记录用户纠正、不做自检
 *   - 用户纠正识别（"你错了"）等以后单独开，避免误报
 */

const db = require('../db');

/* 错误模式分类。把五花八门的报错归并成有限的几类，
 * 才能统计"哪类错误反复犯"，否则每条都是孤立事件。 */
const PATTERNS = {
  EMPTY_AS_SUCCESS: '把空/残缺结果当成功',
  WRONG_SHAPE: '没读真实返回结构就猜字段',
  SILENT_CATCH: '错误被静默吞掉',
  SINGLE_OBSERVATION: '单次观测就下结论',
  /* 2026-09-12 真实事故：资金流告警消失后，模型回答
   * 「可能是间歇性故障，现在自愈了」—— 实际原因是人改了健康统计口径。
   * 它无从知道代码改动，却给出了听起来合理的因果。
   * 这类错误比报错更危险：报错会被发现，编造的因果会被当成结论采纳。 */
  FABRICATED_CAUSE: '状态变化时编造原因（未查证的因果）',
  BAD_ARGS: '参数不合法',
  NETWORK: '网络/接口不可用',
  PARSE: '响应解析失败',
  AUTH: '鉴权/凭证失效',
  UNKNOWN: '未分类',
};

/* 按报错文本猜模式。只做高置信度的关键词匹配，
 * 拿不准一律归 UNKNOWN —— 错误分类本身也不能瞎猜。 */
function classify(errorText, meta) {
  const e = String(errorText || '');
  /* 顺序敏感：先匹配最具体的。
   * "参数不是合法 JSON" 是【模型生成了坏参数】→ BAD_ARGS，
   * 必须排在 PARSE（上游响应解析失败）前面，否则被 JSON/parse 关键词抢先。 */
  if (/参数|required|missing|invalid|非法|缺[少必填]|不是合法/.test(e)) return PATTERNS.BAD_ARGS;
  /* 编造因果：靠推测措辞 + 状态变化词共同命中，避免误伤正常的不确定性表述。
   * 单看"可能"会把"可能需要重试"也算进来，所以要求同时出现变化语义。
   * 注意"自愈/自己好了"本身就同时是推测和变化断言，单独命中即可 ——
   * 实测漏过了真实事故原句「可能是间歇性故障，现在自愈了」。 */
  if (/自愈|自己好了|自动恢复|自行恢复/.test(e)) return PATTERNS.FABRICATED_CAUSE;
  if (/(可能是|大概是|应该是|估计是|多半是)/.test(e)
      && /(变|恢复|消失|好了|不再|归零|正常了|没有故障|problems:\s*0)/.test(e)) {
    return PATTERNS.FABRICATED_CAUSE;
  }
  if (/空|empty|0\s*条|无数据|残缺|短缺|shortfall|要\s*\d+\s*[给只]|非空/i.test(e)) return PATTERNS.EMPTY_AS_SUCCESS;
  if (/字段|undefined|property|cannot read|not a function|shape|结构/i.test(e)) return PATTERNS.WRONG_SHAPE;
  if (/json|parse|解析|unexpected token/i.test(e)) return PATTERNS.PARSE;
  if (/超时|timeout|socket|hang up|econn|getaddrinfo|fetch failed|网络|不可用/i.test(e)) return PATTERNS.NETWORK;
  if (/auth|key|凭证|401|403|unauthor/i.test(e)) return PATTERNS.AUTH;
  return PATTERNS.UNKNOWN;
}

/* 每种模式默认的"下次怎么抓"。
 * 这是让账本真正改变行为的关键 —— 不能只记"错了"，要记"怎么不再错"。 */
const DEFAULT_GUARD = {
  [PATTERNS.EMPTY_AS_SUCCESS]: '先校验返回数量/覆盖率是否符合请求预期，非空不等于成功（要20给1也是失败）',
  [PATTERNS.WRONG_SHAPE]: '调用前先读真实返回结构或打印一次样本，不要假设字段名/字段存在',
  [PATTERNS.SILENT_CATCH]: 'catch 里必须把错误冒泡到返回值或日志，不能空 catch',
  [PATTERNS.SINGLE_OBSERVATION]: '阈值/结论要基于多日或多样本，单次测量只用于排除明显错误',
  [PATTERNS.FABRICATED_CAUSE]: '状态变好/变坏时只陈述事实与数据来源；原因未查证就说"不知道为什么变了"，'
    + '并给出可验证的下一步。绝不能用"可能是…""应该是自愈了"填补空白 —— '
    + '你看不到代码改动与口径调整，"自己好了"几乎永远没有依据',
  [PATTERNS.PARSE]: '解析前确认响应是预期格式，HTML/验证码页不能当 JSON 解析',
  [PATTERNS.NETWORK]: '网络类失败要显式上报并考虑备用源，不能伪装成"无数据"',
  [PATTERNS.AUTH]: '凭证失效要明确告知用户，不能静默降级',
  [PATTERNS.BAD_ARGS]: '参数在进入请求前校验类型和取值范围',
  [PATTERNS.UNKNOWN]: '记录完整上下文，归类后补充针对性检查',
};

/**
 * 记一次工具失败（第①层）。
 *
 * 刻意保持低成本和高鲁棒：
 *   - 记账本身绝不能抛异常影响主流程（用 try 包住）
 *   - 网络类瞬时错误也记，但靠 sig 去重，不会刷屏
 *
 * @returns {{id?:number, repeated?:boolean, skipped?:boolean}}
 */
function recordFailure(toolName, errorText, extra = {}) {
  try {
    /* 归一化错误文本：可能是 Error 对象、普通对象或空。
     * 空错误不记账 —— 实测空 errorText 会产生
     * "tool:unknown / 未分类 / actual=''" 的垃圾行，污染复盘。 */
    let text = errorText instanceof Error ? errorText.message : errorText;
    if (text && typeof text === 'object') {
      try { text = JSON.stringify(text); } catch (_) { text = String(text); }
    }
    text = String(text == null ? '' : text).trim();
    if (!text) return { skipped: true, reason: 'empty-error' };
    if (!toolName || String(toolName).trim() === '') toolName = 'unknown';

    const pattern = extra.pattern || classify(text, extra.meta);
    /* 纯网络抖动第一次也记，但它主要服务于 source_health，
     * 账本里仍保留以便统计接口稳定性。 */
    const r = db.addLesson({
      scope: 'tool:' + String(toolName || 'unknown'),
      pattern,
      expected: extra.expected || '工具成功返回',
      actual: text.slice(0, 400),
      rootCause: extra.rootCause || ('运行时报错：' + text.slice(0, 200)),
      guard: extra.guard || DEFAULT_GUARD[pattern] || DEFAULT_GUARD[PATTERNS.UNKNOWN],
    });
    return r;
  } catch (e) {
    /* 记账失败绝不能影响对话主链路。
     * 但也不能完全静默 —— 打到 stderr，服务器日志里看得到。 */
    if (typeof console !== 'undefined' && console.error) {
      console.error('[lessons] 记录失败被忽略:', e.message);
    }
    return { skipped: true, error: e.message };
  }
}

/**
 * 生成注入给模型的教训提示（第②层）。
 *
 * 在模型即将调用某工具前，把这个工具反复踩的坑告诉它。
 * 返回 null 表示没有教训 —— 不注入废话。
 *
 * 只取 recurrence 高的或最近的，避免提示过长挤占上下文。
 */
function hintFor(toolName, limit = 3) {
  try {
    const rows = db.lessonsFor('tool:' + toolName, limit);
    const useful = rows.filter(r => r.guard);
    if (!useful.length) return null;
    const lines = useful.map(r => {
      const times = r.occurrence > 1 ? `（已犯 ${r.occurrence} 次）` : '';
      return `· [${r.pattern}]${times} ${r.guard}`;
    });
    return `【调用 ${toolName} 前的历史教训】\n`
      + lines.join('\n')
      + '\n这次请先按上述方式自查，再相信返回结果。';
  } catch (e) {
    return null;
  }
}

/** 总览：最近教训 + 复发最多的模式（给复盘用，第③层的输入） */
function overview(limit = 30) {
  try {
    const all = db.allLessons();
    const byPattern = {};
    const byScope = {};
    for (const l of all) {
      byPattern[l.pattern] = (byPattern[l.pattern] || 0) + l.occurrence;
      byScope[l.scope] = (byScope[l.scope] || 0) + l.occurrence;
    }
    const top = Object.entries(byPattern).sort((a, b) => b[1] - a[1]);
    const repeatOffenders = all.filter(l => l.occurrence >= 2)
      .sort((a, b) => b.occurrence - a.occurrence)
      .slice(0, 10)
      .map(l => ({ scope: l.scope, pattern: l.pattern, occurrence: l.occurrence, guard: l.guard }));
    return {
      total: db.lessonCount(),
      distinctPatterns: Object.keys(byPattern).length,
      patternCounts: Object.fromEntries(top),
      repeatOffenders,
      recent: db.recentLessons(limit).map(l => ({
        ts: l.ts, scope: l.scope, pattern: l.pattern,
        actual: l.actual, occurrence: l.occurrence, testLocked: !!l.test_locked,
      })),
      /* 第③层的触发依据：某类错误反复 ≥2 次，就值得考虑固化成测试。
       * 现在只报告、不自动生成。 */
      candidatesForTest: repeatOffenders.filter(x => x.occurrence >= 2),
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  recordFailure, hintFor, overview, classify,
  PATTERNS, DEFAULT_GUARD,
};
