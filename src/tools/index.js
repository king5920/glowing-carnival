'use strict';
/**
 * 工具系统：注册 + 校验 + 执行
 *
 * 安全设计原则（从上到下层层收敛）：
 * 1. 所有工具显式注册，不在列表里的一概不执行
 * 2. 参数走 JSON Schema 校验（类型 + 必填 + 枚举 + 最大长度）
 * 3. 只读工具优先，写入工具必须显式标记可写且有沙箱边界
 * 4. 每次调用有日志（工具名、参数摘要、耗时、结果大小、是否出错）
 * 5. 速率限制：每个工具有每分钟上限，防止模型循环调用打爆
 *
 * 为什么不直接用第三方 tool-use 框架？
 * 本项目硬约束是「只有 better-sqlite3 一个依赖」，自己实现才几十行。
 */

const assert = require('assert');

const tools = new Map();          // name -> {fn, schema, writable, rateLimit}
const callLog = [];               // 最近 N 次调用记录
const MAX_LOG = 200;

const rateBuckets = new Map();    // name -> {count, windowStart}

/** 注册一个工具 */
function register(name, opts, fn) {
  if (tools.has(name)) throw new Error(`工具已存在: ${name}`);
  assert(typeof fn === 'function', 'fn 必须是函数');
  assert(opts && opts.description, 'description 必填');
  assert(opts.parameters && opts.parameters.type === 'object', 'parameters 必须是 object schema');

  tools.set(name, {
    name,
    fn,
    schema: opts.parameters,
    description: opts.description,
    writable: !!opts.writable,
    rateLimit: opts.rateLimit || 30,   // 默认每分钟 30 次
  });
}

/** 列出所有工具的 OpenAI tools 格式定义，喂给模型 */
function listForModel() {
  return Array.from(tools.values()).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.schema,
    },
  }));
}

/**
 * 执行一次工具调用。
 * 返回 { ok, result, error, meta }
 */
async function call(name, args) {
  const t0 = Date.now();
  const tool = tools.get(name);
  if (!tool) return fail(name, args, t0, `未知工具: ${name}`);

  // 速率限制：滑动窗口 60 秒
  const now = Math.floor(t0 / 60000);
  const bucket = rateBuckets.get(name) || { count: 0, window: now };
  if (bucket.window !== now) { bucket.count = 0; bucket.window = now; }
  if (bucket.count >= tool.rateLimit) {
    return fail(name, args, t0, `工具 ${name} 触发速率限制 (${tool.rateLimit}/分钟)`);
  }
  bucket.count++;
  rateBuckets.set(name, bucket);

  // 参数校验
  const v = validate(args, tool.schema);
  if (!v.ok) return fail(name, args, t0, '参数校验失败: ' + v.error);

  let result, error;
  try {
    result = await tool.fn(v.value);
    // 结果过大时截断，避免把超长内容塞回模型吃 token
    if (typeof result === 'string' && result.length > 4000) {
      result = result.slice(0, 4000) + `\n...[已截断，共 ${result.length} 字]`;
    }
    if (result && typeof result === 'object') {
      const s = JSON.stringify(result);
      if (s.length > 4000) {
        result = { truncated: true, totalLength: s.length,
                   preview: s.slice(0, 3500) + '...' };
      }
    }
  } catch (e) {
    error = String(e.message || e);
  }

  const ms = Date.now() - t0;
  const meta = { name, args: summary(args), ms, ok: !error,
                 resultSize: result != null ? (typeof result === 'string' ? result.length : JSON.stringify(result).length) : 0 };
  log(meta);
  return error
    ? { ok: false, error, meta }
    : { ok: true, result, meta };
}

function fail(name, args, t0, msg) {
  const meta = { name, args: summary(args), ms: Date.now() - t0, ok: false, error: msg };
  log(meta);
  return { ok: false, error: msg, meta };
}

/** 参数摘要：只保留字段名和小值，日志里不暴露敏感/大量数据 */
function summary(args) {
  if (!args || typeof args !== 'object') return String(args).slice(0, 80);
  const out = {};
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === 'string') out[k] = v.length > 60 ? v.slice(0, 60) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = `[数组 ${v.length} 项]`;
    else if (v && typeof v === 'object') out[k] = '[对象]';
  }
  return out;
}

function log(meta) {
  callLog.unshift(meta);
  if (callLog.length > MAX_LOG) callLog.pop();
}

/** 极简 JSON Schema 校验（只支持 object/string/number/boolean/array + required + enum + maxLength）
 *  我们的工具参数都很简单，不需要引入 Ajv。 */
function validate(value, schema, path = '') {
  if (value == null) {
    if (schema.default !== undefined) return { ok: true, value: schema.default };
    return { ok: false, error: `${path} 不能为空` };
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `${path} 必须是对象` };
      }
      const props = schema.properties || {};
      const result = {};
      for (const req of (schema.required || [])) {
        if (!(req in value)) {
          return { ok: false, error: `${path}.${req} 是必填项` };
        }
      }
      for (const key of Object.keys(value)) {
        if (!props[key]) {
          return { ok: false, error: `${path}.${key} 不是有效字段` };
        }
        const r = validate(value[key], props[key], path + '.' + key);
        if (!r.ok) return r;
        result[key] = r.value;
      }
      // 给 default 字段填值
      for (const key of Object.keys(props)) {
        if (!(key in result) && props[key].default !== undefined) {
          result[key] = props[key].default;
        }
      }
      return { ok: true, value: result };
    }
    case 'string': {
      if (typeof value !== 'string') {
        // 数字可以转字符串
        if (typeof value === 'number' || typeof value === 'boolean') {
          value = String(value);
        } else {
          return { ok: false, error: `${path} 必须是字符串` };
        }
      }
      if (schema.maxLength && value.length > schema.maxLength) {
        return { ok: false, error: `${path} 长度不能超过 ${schema.maxLength}` };
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return { ok: false, error: `${path} 必须是 ${schema.enum.join(' / ')} 之一` };
      }
      return { ok: true, value };
    }
    case 'number':
    case 'integer': {
      if (typeof value === 'string') {
        const n = Number(value);
        if (!isFinite(n)) return { ok: false, error: `${path} 不是有效数字` };
        value = n;
      }
      if (typeof value !== 'number') return { ok: false, error: `${path} 必须是数字` };
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return { ok: false, error: `${path} 必须是整数` };
      }
      return { ok: true, value };
    }
    case 'boolean': {
      if (typeof value === 'string') {
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
      }
      if (typeof value !== 'boolean') return { ok: false, error: `${path} 必须是布尔值` };
      return { ok: true, value };
    }
    case 'array': {
      if (!Array.isArray(value)) return { ok: false, error: `${path} 必须是数组` };
      if (schema.maxItems && value.length > schema.maxItems) {
        return { ok: false, error: `${path} 最多 ${schema.maxItems} 项` };
      }
      const items = [];
      for (let i = 0; i < value.length; i++) {
        const r = validate(value[i], schema.items || { type: 'string' }, path + `[${i}]`);
        if (!r.ok) return r;
        items.push(r.value);
      }
      return { ok: true, value: items };
    }
    default:
      return { ok: false, error: `${path} 不支持的类型 ${schema.type}` };
  }
}

function getLog() { return callLog.slice(); }

module.exports = { register, listForModel, call, getLog };
