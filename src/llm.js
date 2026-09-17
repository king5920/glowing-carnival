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
/* ══════════ 运行时可重载配置 ══════════
 *
 * 为什么不再用 const 一次性读死：
 *   用户在方舟后台换了 Agent Plan 的 API Key，改好了 .env，
 *   但服务进程是几小时前启动的，llm.js 早已把旧 Key 读进常量 ——
 *   于是「.env 是对的、界面却连不上模型」，而且看不出原因。
 *   实测就是这么发生的（进程 21:03 启动，之后换的 Key）。
 *
 * 改为放在可变对象里，配合 reload() 让设置页保存后立即生效，
 * 不必重启服务、不必让用户去理解"进程内存里还是旧值"这种事。
 */
const cfg = { key: '', base: '', model: '', embedModel: '' };

function applyEnv(e) {
  cfg.key = e.ARK_API_KEY || process.env.ARK_API_KEY || '';
  cfg.base = (e.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/plan/v3').replace(/\/+$/, '');
  cfg.model = e.ARK_MODEL || 'ark-code-latest';
  cfg.embedModel = e.ARK_EMBED_MODEL || 'doubao-embedding-vision';
}
applyEnv(loadEnv());

/** 重新读 .env 并应用（设置页保存后调用，无需重启进程） */
function reload() {
  applyEnv(loadEnv());
  return { model: cfg.model, base: cfg.base, hasKey: hasKey(), embedModel: cfg.embedModel };
}

/** 当前生效配置（绝不返回 Key 本身，只报长度与掩码） */
function getConfig() {
  const k = cfg.key || '';
  return {
    hasKey: hasKey(),
    keyMask: k ? (k.slice(0, 4) + '****' + k.slice(-4) + '（' + k.length + ' 字符）') : '',
    baseUrl: cfg.base,
    model: cfg.model,
    embedModel: cfg.embedModel,
  };
}

const hasKey = () => cfg.key.length > 10;

/* ── 用量统计（成本可见） ── */
const usage = { calls: 0, promptTokens: 0, completionTokens: 0, embedCalls: 0, embedTokens: 0, errors: 0 };
function getUsage() { return { ...usage }; }

/** 底层 POST。返回 {ok, status, json} —— 不抛异常，避免拖垮服务 */
function post(pathname, body, timeoutMs = 60000) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const u = new URL(cfg.base + pathname);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.key,
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
    model: opts.model || cfg.model,
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
    model: opts.model || cfg.model,
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
  const r = await post('/embeddings', { model: cfg.embedModel, input: list });
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

/**
 * 带工具调用的对话 —— 流式版（P2 延迟优化，2026-09-13）。
 *
 * 与 chatWithTools 的区别只在**最终文本轮**：
 *   - 模型要调工具时，tool_calls 的 JSON 必须收齐才能解析执行，
 *     流式没有意义，所以遇到 tool_calls 就照常累积、整体返回；
 *   - 模型给最终自然语言回答时，通过 onDelta 逐片段吐出，
 *     首 token 实测从 ~9s（非流式整段）降到 ~0.4s。
 *
 * 设计上仍返回和 chatWithTools 同构的 {ok, message, finishReason}，
 * 让 brain 的工具循环可以无缝替换。content 同时完整累积在 message.content，
 * 保证"最终落库的全文"和"流式吐给界面的片段"一致。
 *
 * @param {function(string):void} [opts.onDelta] 每段文本增量回调
 * @param {AbortSignal} [opts.signal] 预留：中断（当前未接，不影响功能）
 */
async function chatWithToolsStream(messages, tools, opts = {}) {
  if (!hasKey()) return { ok: false, error: 'no_api_key', message: null };
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
  const body = {
    model: opts.model || cfg.model,
    messages,
    tools,
    tool_choice: opts.toolChoice || 'auto',
    max_tokens: opts.maxTokens || 1200,
    temperature: opts.temperature == null ? 0.6 : opts.temperature,
    stream: true,
  };

  /* 流式响应是 SSE：逐行 data: {...}，结尾 data:[DONE]。
   * tool_calls 在流式下是分片的：同一 index 的 function.arguments 要拼接，
   * id/name 通常只在首片出现。 */
  const collected = await postStream('/chat/completions', body, evt => {
    const choice = evt.choices && evt.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) onDelta(delta.content);
  });

  usage.calls++;
  if (!collected.ok) {
    usage.errors++;
    return { ok: false, error: collected.error || ('HTTP ' + collected.status), message: null };
  }

  const { content, toolCallParts, finishReason, promptTokens, completionTokens } = collected;
  usage.promptTokens += promptTokens || 0;
  usage.completionTokens += completionTokens || 0;

  /* 把分片的 tool_calls 按 index 归并 */
  const tool_calls = assembleToolCalls(toolCallParts);

  return {
    ok: true,
    finishReason: finishReason || 'stop',
    message: { role: 'assistant', content: content || null, tool_calls },
  };
}

/**
 * 把流式 SSE 里分片到达的 tool_calls 归并成完整结构（纯函数，便于测试）。
 * 输入形如 [{index:0,id,name,args}, ...]，args 可能分多片。
 * 输出 chatWithTools 同构的 tool_calls；空输入返回 undefined。
 */
function assembleToolCalls(parts) {
  if (!parts || !parts.length) return undefined;
  const byIndex = new Map();
  for (const p of parts) {
    const i = (p && p.index) || 0;
    const cur = byIndex.get(i) || { id: '', name: '', args: '' };
    if (p.id) cur.id = p.id;
    if (p.name) cur.name = p.name;
    if (p.args) cur.args += p.args;
    byIndex.set(i, cur);
  }
  return [...byIndex.keys()].sort((a, b) => a - b).map(i => {
    const c = byIndex.get(i);
    return {
      id: c.id || ('call_' + i),
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    };
  });
}

/**
 * 底层流式 POST。解析 OpenAI/方舟 SSE，累积 content 与 tool_call 分片。
 * 返回 {ok,status,error, content, toolCallParts, finishReason, promptTokens, completionTokens}。
 * onChunk(evt) 对每个非空 JSON 事件回调（供上层实时转发 delta）。
 */
function postStream(pathname, body, onChunk, timeoutMs = 120000) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const u = new URL(cfg.base + pathname);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Accept': 'text/event-stream',
      },
      timeout: timeoutMs,
    }, res => {
      if (res.statusCode !== 200) {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* 非 JSON */ }
          resolve({ ok: false, status: res.statusCode,
            error: json?.error?.message || ('HTTP ' + res.statusCode) });
        });
        return;
      }
      let buf = '';
      const contentParts = [];
      const toolCallParts = [];
      let finishReason = 'stop';
      let promptTokens = 0, completionTokens = 0;

      const handleLine = (line) => {
        const s = line.trim();
        if (!s.startsWith('data:')) return;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let evt;
        try { evt = JSON.parse(data); } catch { return; }
        if (evt.usage) {
          promptTokens = evt.usage.prompt_tokens || 0;
          completionTokens = evt.usage.completion_tokens || 0;
        }
        const choice = evt.choices && evt.choices[0];
        if (choice) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          if (typeof delta.content === 'string' && delta.content) contentParts.push(delta.content);
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              toolCallParts.push({
                index: tc.index || 0,
                id: tc.id,
                name: tc.function && tc.function.name,
                args: tc.function && tc.function.arguments,
              });
            }
          }
        }
        try { onChunk(evt); } catch { /* 上层回调异常不影响接收 */ }
      };

      res.on('data', c => {
        buf += c.toString('utf8');
        let nl;
        // SSE 事件以空行分隔，但按行切也可（每行一个 data:）
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
      });
      res.on('end', () => {
        if (buf.trim()) handleLine(buf);
        resolve({
          ok: true, status: 200,
          content: contentParts.join(''),
          toolCallParts, finishReason,
          promptTokens, completionTokens,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/* MODEL / EMBED_MODEL 用 getter 暴露：
 * 以前是 const 字符串，reload() 后调用方仍会拿到旧值（例如 /api/status
 * 显示的模型名不会跟着设置页变）。getter 保证读到的永远是当前配置。 */
module.exports = {
  chat, chatWithTools, chatWithToolsStream, embed, hasKey, getUsage, reload, getConfig,
  assembleToolCalls,
  get MODEL() { return cfg.model; },
  get EMBED_MODEL() { return cfg.embedModel; },
};
