/**
 * llm.js —— 火山方舟 Agent Plan 接入
 *
 * 实测确认的关键配置（踩了很多坑）：
 *   端点   /api/plan/v3/...      ← 不是 /api/v3/（用这把 Key 会 401）
 *   模型   ark-code-latest       ← 不是 doubao-*（试了 7 个都 404）
 *   向量   doubao-embedding-vision，2048 维
 *          input 必须是字符串数组 ["文本"]，不能是 [{type,text}]
 *
 * 安全：密钥只从 .env 读，绝不写日志。
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ── 极简 .env 解析（不引 dotenv） ── */
function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}
const ENV = loadEnv();
const KEY = ENV.ARK_API_KEY || process.env.ARK_API_KEY || '';
const BASE = (ENV.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/plan/v3')
  .replace(/\/+$/, '');
const MODEL = ENV.ARK_MODEL || 'ark-code-latest';
const EMBED_MODEL = ENV.ARK_EMBED_MODEL || 'doubao-embedding-vision';

const hasKey = () => KEY.length > 10;

/* ── 用量统计（成本可见） ── */
const usage = { calls: 0, promptTokens: 0, completionTokens: 0, embedCalls: 0, embedTokens: 0, errors: 0 };
function getUsage() { return { ...usage }; }

/** 底层 POST。返回 {ok, status, json} —— 不抛异常，避免拖垮服务 */
function post(pathname, body, timeoutMs = 60000) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const u = new URL(BASE + pathname);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON 响应 */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, json, raw: d });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * 对话。messages = [{role,content}]
 * 返回 {ok, text, error}
 */
async function chat(messages, opts = {}) {
  if (!hasKey()) return { ok: false, error: 'no_api_key', text: '' };
  const r = await post('/chat/completions', {
    model: opts.model || MODEL,
    messages,
    max_tokens: opts.maxTokens || 1024,
    temperature: opts.temperature == null ? 0.7 : opts.temperature,
  }, opts.timeoutMs || 60000);   // 长文档生成（周报）需要更久，由调用方指定
  usage.calls++;
  if (!r.ok) {
    usage.errors++;
    const msg = r.json?.error?.message || r.error || ('HTTP ' + r.status);
    return { ok: false, error: msg, text: '' };
  }
  const u = r.json.usage || {};
  usage.promptTokens += u.prompt_tokens || 0;
  usage.completionTokens += u.completion_tokens || 0;
  return { ok: true, text: r.json.choices?.[0]?.message?.content || '' };
}

/**
 * 带工具调用的对话（非流式，因为要拿到完整 tool_calls 才能执行）。
 * messages 格式同 chat，但 model 返回可能是 content（文本）也可能是 tool_calls。
 * 返回 {ok, message, error}，message = {role:'assistant', content?, tool_calls?}
 */
async function chatWithTools(messages, tools, opts = {}) {
  if (!hasKey()) return { ok: false, error: 'no_api_key', message: null };
  const body = {
    model: opts.model || MODEL,
    messages,
    tools,
    tool_choice: opts.toolChoice || 'auto',
    max_tokens: opts.maxTokens || 1200,
    temperature: opts.temperature == null ? 0.6 : opts.temperature,
  };
  const r = await post('/chat/completions', body);
  usage.calls++;
  if (!r.ok) {
    usage.errors++;
    const msg = r.json?.error?.message || r.error || ('HTTP ' + r.status);
    return { ok: false, error: msg, message: null };
  }
  const u = r.json.usage || {};
  usage.promptTokens += u.prompt_tokens || 0;
  usage.completionTokens += u.completion_tokens || 0;
  const choice = r.json.choices?.[0] || {};
  const msg = choice.message || {};
  return { ok: true,
    finishReason: choice.finish_reason || 'stop',
    message: {
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls ? msg.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
      })) : undefined,
    } };
}

/**
 * 批量取向量。texts = [string]
 * 返回 {ok, vectors:[Float32Array|null], error}
 */
async function embed(texts) {
  if (!hasKey()) return { ok: false, error: 'no_api_key', vectors: [] };
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || ''));
  if (!list.length) return { ok: true, vectors: [] };
  // 注意：input 必须是纯字符串数组
  const r = await post('/embeddings', { model: EMBED_MODEL, input: list });
  usage.embedCalls++;
  if (!r.ok) {
    usage.errors++;
    const msg = r.json?.error?.message || r.error || ('HTTP ' + r.status);
    return { ok: false, error: msg, vectors: [] };
  }
  usage.embedTokens += r.json.usage?.total_tokens || 0;
  const vectors = (r.json.data || [])
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(d => d.embedding || null);
  return { ok: true, vectors };
}

module.exports = { chat, chatWithTools, embed, hasKey, getUsage, MODEL, EMBED_MODEL };
