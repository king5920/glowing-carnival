'use strict';
/**
 * 飞书接入 —— 长连接模式（无需公网 IP / 内网穿透）
 *
 * ══════ 为什么选长连接而不是 Webhook ══════
 * Webhook 需要飞书服务器能主动访问你的机器，也就是需要：
 *   公网 IP + 域名 + HTTPS 证书，或者 ngrok/cpolar 这类内网穿透。
 * 你这台是家用机器，做这些又麻烦又不稳。
 *
 * 长连接（WebSocket）模式反过来：**你的机器主动连飞书**，
 * 飞书通过这条连接把消息推给你。零配置、零穿透、零公网依赖。
 * 这也是「扫码即用」能成立的技术前提。
 *
 * ══════ 你需要做的（拿凭证）══════
 * 1. 打开 https://open.feishu.cn/app —— 用你的飞书账号登录
 * 2. 「创建企业自建应用」，填个名字（比如「贾维斯」）
 * 3. 进应用 →「凭证与基础信息」→ 复制 App ID 和 App Secret
 * 4. 「权限管理」开这几个权限：
 *      im:message                 读写消息
 *      im:message:send_as_bot     以机器人身份发消息
 *      im:chat                    获取群信息（可选）
 * 5. 「事件订阅」→ 选「使用长连接接收事件」→ 添加事件 `im.message.receive_v1`
 * 6. 「版本管理与发布」→ 创建版本 → 发布（个人使用选「仅自己可用」即可）
 * 7. 把 App ID / App Secret 填到 D:\jarvis\.feishu.json（格式见下）
 *
 * .feishu.json 格式：
 *   { "appId": "cli_xxxxx", "appSecret": "xxxxx" }
 *
 * 填好之后重启贾维斯，在飞书里搜应用名 → 加为联系人 → 直接发消息。
 *
 * ══════ 实现说明 ══════
 * 飞书官方有 SDK（@larksuiteoapi/node-sdk），但我们有「只允许 better-sqlite3
 * 一个依赖」的硬约束，所以这里用原生 https + ws 手写。
 * WebSocket 握手和帧解析都是标准协议，Node 内置模块够用。
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONF_PATH = path.join(__dirname, '..', '.feishu.json');
const BASE = 'https://open.feishu.cn';

/* ─────────────── 配置 ─────────────── */

function loadConfig() {
  try {
    if (!fs.existsSync(CONF_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
    if (!c.appId || !c.appSecret) return null;
    return c;
  } catch (_) { return null; }
}

function configured() { return !!loadConfig(); }

/** 给用户看的接入状态（前端展示 + 诊断用） */
function status() {
  const c = loadConfig();
  const st = {
    configured: !!c,
    appId: c ? c.appId.slice(0, 12) + '…' : null,
    confPath: CONF_PATH,
    connected: _ws ? _ws.connected : false,
    lastError: _lastError,
    messagesReceived: _stats.received,
    messagesSent: _stats.sent,

    /* ── 诊断字段 ──
     * framesTotal 是关键：它能区分两种完全不同的故障。
     *   framesTotal = 0  → 飞书根本没推东西（事件订阅没配对）
     *   framesTotal > 0 但 received = 0 → 推了但被丢弃（看 lastFrame.reason）
     * 没有这个字段的时候，两种情况的表现都是"没反应"，无法区分。 */
    framesTotal: _stats.framesTotal || 0,
    lastFrame: _stats.lastFrame || null,
    /* 飞书重复投递被拦下的次数。不为 0 是正常的（长连接没有 200 应答，
     * 飞书靠多次投递保证不丢），但每一次拦截都省了一次模型调用。 */
    dedupedEvents: _stats.deduped || 0,

    // 没配置时告诉用户下一步做什么
    nextStep: c ? null
      : '在 https://open.feishu.cn/app 创建自建应用，把 appId/appSecret 写入 ' + CONF_PATH,
  };

  /* 主动给出诊断结论，而不是让人自己看数字猜。 */
  if (c && st.connected && st.framesTotal === 0) {
    st.diagnosis = '长连接已建立但从未收到任何帧。最可能是事件订阅里没有添加 '
      + 'im.message.receive_v1（接收消息）。检查 '
      + `https://open.feishu.cn/app/${c.appId}/event`;
  } else if (st.framesTotal > 0 && st.messagesReceived === 0) {
    st.diagnosis = '收到过帧但没有一条被识别为文本消息。看 lastFrame.reason。';
  }
  return st;
}

/* ─────────────── HTTP 基础 ─────────────── */

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: 15000,
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code && j.code !== 0) {
            return reject(new Error(`飞书 API ${j.code}: ${j.msg || ''}`));
          }
          resolve(j);
        } catch (e) { reject(new Error('飞书返回非 JSON: ' + d.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('飞书 API 超时')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ─────────────── 鉴权 ─────────────── */

let _token = null;
let _tokenExpiry = 0;
let _lastError = null;
const _stats = { received: 0, sent: 0 };

/* 已处理的 event_id → 时间戳，用于过滤飞书的重复投递。
 * 进程内存即可：重启后飞书不会重发历史事件。 */
const _seenEvents = new Map();
const EVENT_CACHE_MAX = 500;
const EVENT_TTL_MS = 10 * 60 * 1000;   // 10 分钟足够覆盖飞书的重试窗口

/** 拿 tenant_access_token（有效期 2 小时，提前 5 分钟刷新） */
async function getToken() {
  const c = loadConfig();
  if (!c) throw new Error('飞书未配置，请先创建 ' + CONF_PATH);

  if (_token && Date.now() < _tokenExpiry - 300000) return _token;

  const r = await request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: c.appId,
    app_secret: c.appSecret,
  });
  _token = r.tenant_access_token;
  _tokenExpiry = Date.now() + (r.expire || 7200) * 1000;
  return _token;
}

async function authed(method, urlPath, body) {
  const t = await getToken();
  return request(method, urlPath, body, { Authorization: 'Bearer ' + t });
}

/* ─────────────── 发消息 ─────────────── */

/**
 * 回复一条消息。
 * @param {string} messageId 要回复的消息 ID
 * @param {string} text 内容
 */
async function reply(messageId, text) {
  const r = await authed('POST', `/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: 'text',
    content: JSON.stringify({ text: String(text).slice(0, 3000) }),
  });
  _stats.sent++;
  return r;
}

/**
 * 主动发消息（用于巡视告警推送）。
 * @param {string} receiveId 用户 open_id 或群 chat_id
 * @param {string} text
 * @param {string} idType open_id | chat_id
 */
async function send(receiveId, text, idType = 'open_id') {
  const r = await authed('POST', `/open-apis/im/v1/messages?receive_id_type=${idType}`, {
    receive_id: receiveId,
    msg_type: 'text',
    content: JSON.stringify({ text: String(text).slice(0, 3000) }),
  });
  _stats.sent++;
  return r;
}

/** 发 Markdown 卡片（周报这种长内容用，纯文本会很难看） */
async function sendCard(receiveId, title, mdContent, idType = 'open_id') {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: String(title).slice(0, 100) },
              template: 'blue' },
    elements: [{ tag: 'markdown', content: String(mdContent).slice(0, 8000) }],
  };
  const r = await authed('POST', `/open-apis/im/v1/messages?receive_id_type=${idType}`, {
    receive_id: receiveId,
    msg_type: 'interactive',
    content: JSON.stringify(card),
  });
  _stats.sent++;
  return r;
}

/* ─────────────── 长连接 ─────────────── */

let _ws = null;

/**
 * 拿长连接地址。
 * 飞书的长连接需要先调这个接口换一个带 ticket 的 wss URL。
 */
async function getConnectUrl() {
  const c = loadConfig();
  if (!c) throw new Error('飞书未配置');
  const r = await request('POST', '/callback/ws/endpoint', {
    AppID: c.appId,
    AppSecret: c.appSecret,
  });
  if (!r.data || !r.data.URL) throw new Error('未拿到长连接地址');
  return r.data;
}

/**
 * 建立长连接并监听消息。
 *
 * @param {function} onMessage async (ctx) => string|null
 *        ctx = { text, messageId, chatId, userId, chatType }
 *        返回字符串会自动回复；返回 null 不回复。
 */
async function connect(onMessage) {
  if (!configured()) {
    _lastError = '未配置凭证';
    return { ok: false, error: _lastError, nextStep: status().nextStep };
  }

  try {
    const conn = await getConnectUrl();
    _ws = new FeishuWS(conn.URL, onMessage);
    await _ws.open();
    _lastError = null;
    return { ok: true, connected: true };
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message };
  }
}

function disconnect() {
  if (_ws) { _ws.close(); _ws = null; }
}

/* ─────────────── WebSocket 客户端（原生实现）─────────────── */

/**
 * 从 protobuf 包装的帧里提取事件 JSON。
 *
 * ══════ 为什么不能用 raw.indexOf('{') ══════
 * 这是实测踩到的坑。飞书推来的帧长这样：
 *
 *   {\n instance_id lcKX533EUmby... *\n type event *6\n :x_frontier_msg_i
 *   ↑
 *   这个 { 是 protobuf 字段里恰好等于 0x7b 的字节，不是 JSON 起点
 *
 * `indexOf('{')` 找到的就是它，从那儿切开必然解析失败 ——
 * 表现是"飞书推了消息但完全没反应"。而且日志里看到的前缀
 * 以 { 开头、长得很像 JSON，极易误判成"飞书推的数据格式不对"，
 * 从而往错误的方向排查（我一开始就怀疑是订阅配置问题）。
 *
 * 正确做法：**扫描每一个 { 位置，逐个尝试括号配对**，
 * 取第一个能配平、能 JSON.parse、且带飞书事件结构的。
 *
 * 配对时跳过字符串内部的括号（消息文本里可能含 { }）并处理转义。
 *
 * @returns {object|null}
 */
function extractEventJson(raw) {
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;

    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;                    // 括号没配平，换下一个候选

    let obj;
    try { obj = JSON.parse(raw.slice(start, end + 1)); }
    catch { continue; }                       // 解析失败，换下一个候选
    if (!obj || typeof obj !== 'object') continue;

    /* 必须长得像飞书事件：有 schema 或 header.event_type。
     * 否则 protobuf 里偶然凑出的合法小 JSON 会被误当成事件。 */
    if (obj.schema || obj.header?.event_type || obj.type) return obj;
  }
  return null;
}

/**
 * 最小可用的 WebSocket 客户端。
 * 只实现飞书长连接需要的部分：握手、文本/二进制帧读取、ping/pong、掩码写入。
 * 不用 ws 库是因为「只允许 better-sqlite3 一个依赖」的硬约束。
 */
class FeishuWS {
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    this.connected = false;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    // 分片消息重组状态（长消息会被拆成多帧）
    this._fragOp = null;
    this._fragBuf = Buffer.alloc(0);
    this.reconnectDelay = 3000;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const isTLS = u.protocol === 'wss:';
      const key = crypto.randomBytes(16).toString('base64');

      const mod = isTLS ? https : http;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isTLS ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (res, socket) => {
        this.sock = socket;
        this.connected = true;
        socket.on('data', d => this._onData(d));
        socket.on('close', () => this._onClose());
        socket.on('error', e => { this.connected = false; _lastError = e.message; });
        resolve({ ok: true });
      });
      req.on('error', reject);
      req.on('response', res => reject(new Error('握手失败 HTTP ' + res.statusCode)));
      req.end();
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // 循环解析所有完整帧
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      if (frame.opcode === 0x9) { this._pong(frame.payload); continue; }   // ping → pong
      if (frame.opcode === 0x8) { this.close(); break; }                    // close

      /* ── 分片消息重组 ──
       *
       * WebSocket 允许把一条消息拆成多帧：
       *   第一帧 opcode=1/2 且 fin=false，后续帧 opcode=0（continuation），
       *   最后一帧 fin=true。
       *
       * 原来的代码只处理 opcode 1/2 且不看 fin，
       * continuation 帧（opcode=0）被完全忽略 —— 长消息的后半段直接丢失，
       * 而且因为前半段 JSON 不完整，整条消息都解析失败、静默消失。
       *
       * 是帧解析测试暴露的：构造 fin=false 的帧后发现后续帧无人接收。
       * 飞书的消息事件带 protobuf 头，长文本很容易触发分片。 */
      if (frame.opcode === 0x0) {
        // continuation：必须已经有分片在拼
        if (this._fragOp == null) continue;          // 没有起始帧，孤立的 continuation，丢弃
        this._fragBuf = Buffer.concat([this._fragBuf, frame.payload]);
        if (frame.fin) {
          const full = this._fragBuf;
          this._fragBuf = Buffer.alloc(0);
          this._fragOp = null;
          this._handlePayload(full);
        }
        continue;
      }

      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) {
          // 分片起始帧：记下 opcode，等 continuation
          this._fragOp = frame.opcode;
          this._fragBuf = Buffer.from(frame.payload);
          continue;
        }
        // 非分片的完整消息
        this._handlePayload(frame.payload);
      }
    }
  }

  /** 解析一个 WebSocket 帧。数据不够就返回 null 等下一批。 */
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      len = hi * 4294967296 + lo; off += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.slice(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;

    let payload = b.slice(off, off + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  /** 写一个帧（客户端必须加掩码） */
  _write(opcode, payload) {
    if (!this.sock || !this.connected) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len % 4294967296, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    try { this.sock.write(Buffer.concat([header, mask, masked])); } catch (_) {}
  }

  _pong(payload) { this._write(0xA, payload); }

  /**
   * 处理业务负载。
   * 飞书长连接的帧内容是 protobuf 包装的，但事件本体是 JSON。
   * 这里用「括号配对扫描」提取 —— 不引 protobuf 依赖。
   */
  _handlePayload(payload) {
    const raw = payload.toString('utf8');

    /* ── 诊断日志 ──
     * 这个函数原来有四个静默 return，任何一个都会让消息无声消失，
     * 排查时完全看不出是"飞书没推"还是"推了但解析失败"。
     *
     * 这些日志立了大功：飞书**确实推了** im.message.receive_v1，
     * 是我的 indexOf('{') 从 protobuf 字节里切错了位置。
     * 没有日志的话我会一直怀疑订阅配置（当时应用 API 也确实
     * 只返回 card.action.trigger，双重误导）。 */
    _stats.framesTotal = (_stats.framesTotal || 0) + 1;
    const diag = (reason, extra) => {
      _stats.lastFrame = {
        at: new Date().toISOString().slice(11, 19),
        reason,
        bytes: payload.length,
        extra: extra == null ? undefined : String(extra).slice(0, 200),
      };
      if (process.env.JARVIS_FEISHU_DEBUG) {
        console.log(`  [飞书帧] ${reason}` + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
      }
    };

    /* 用括号配对扫描提取事件 JSON。
     * 不能用 indexOf('{')：protobuf 里有等于 0x7b 的字节（详见 extractEventJson）。 */
    const evt = extractEventJson(raw);
    if (!evt) {
      // 心跳/控制帧没有事件体，属正常
      diag('无事件 JSON（心跳或控制帧）', raw.slice(0, 60).replace(/[^\x20-\x7e]/g, '.'));
      return;
    }

    // 飞书事件结构：{ schema, header:{event_type,...}, event:{...} }
    const type = evt?.header?.event_type || evt?.type;
    if (type !== 'im.message.receive_v1') {
      /* 收到了事件但不是消息 —— 这正是"只订阅了卡片点击"时会走到的分支。
       * 记下实际事件类型，比"没反应"有用得多。 */
      diag(`事件类型不是消息: ${type || '(无 event_type)'}`, JSON.stringify(evt).slice(0, 200));
      return;
    }

    /* ── 事件去重（这是个花钱的 bug）──
     *
     * 长连接没有 HTTP 那样的 200 应答机制，飞书为了保证不丢消息会
     * **重复投递同一个事件**（event_id 相同）。实测发了 2 条消息收到 3 帧。
     *
     * 不去重的后果不只是"回复两次"：
     *   - 每次重复都会完整跑一遍 brain.think → **调一次模型 → 花一次钱**
     *   - 记忆抽取也会跑两遍，可能存进重复记忆
     *   - 工具会被执行两次（如果是写操作就更糟）
     *
     * 所以去重必须放在**调用大脑之前**，而不是靠回复端过滤。 */
    const eid = evt?.header?.event_id;
    if (eid) {
      if (_seenEvents.has(eid)) {
        diag(`重复投递，已忽略 (event_id=${eid.slice(0, 12)}…)`);
        _stats.deduped = (_stats.deduped || 0) + 1;
        return;
      }
      _seenEvents.set(eid, Date.now());
      // 定期清理，避免无限增长
      if (_seenEvents.size > EVENT_CACHE_MAX) {
        const cutoff = Date.now() - EVENT_TTL_MS;
        for (const [k, t] of _seenEvents) {
          if (t < cutoff) _seenEvents.delete(k);
        }
        // 清完还是太多就丢最早的（Map 保持插入顺序）
        while (_seenEvents.size > EVENT_CACHE_MAX) {
          _seenEvents.delete(_seenEvents.keys().next().value);
        }
      }
    }

    const m = evt?.event?.message;
    if (!m) { diag('消息事件里没有 message 字段', JSON.stringify(evt).slice(0, 200)); return; }

    let text = '';
    let msgType = m.message_type || m.msg_type || '?';
    try {
      const c = JSON.parse(m.content || '{}');
      text = c.text || '';
    } catch (_) {}
    // 去掉 @机器人 的部分
    text = text.replace(/@_user_\d+\s*/g, '').trim();
    if (!text) {
      /* 非文本消息（图片、语音、文件、表情）会走到这里。
       * 静默丢弃会让用户以为机器人坏了，所以记下类型。 */
      diag(`非文本消息或内容为空 (message_type=${msgType})`, m.content);
      return;
    }

    _stats.received++;
    diag(`收到文本消息: ${text.slice(0, 40)}`);

    const ctx = {
      text,
      messageId: m.message_id,
      chatId: m.chat_id,
      chatType: m.chat_type,
      userId: evt?.event?.sender?.sender_id?.open_id,
    };

    Promise.resolve()
      .then(() => this.onMessage(ctx))
      .then(answer => { if (answer) return reply(ctx.messageId, answer); })
      .catch(e => {
        _lastError = '处理消息失败: ' + e.message;
        diag('处理消息失败', e.message);
      });
  }

  _onClose() {
    this.connected = false;
    if (this.closed) return;
    // 断线自动重连（飞书长连接会定期断开，这是正常的）
    setTimeout(async () => {
      if (this.closed) return;
      try {
        const conn = await getConnectUrl();
        this.url = conn.URL;
        this.buf = Buffer.alloc(0);
        // 断线时可能正拼到一半，残留分片会污染新连接的第一条消息
        this._fragOp = null;
        this._fragBuf = Buffer.alloc(0);
        await this.open();
      } catch (e) {
        _lastError = '重连失败: ' + e.message;
        this._onClose();     // 继续退避重试
      }
    }, this.reconnectDelay);
  }

  close() {
    this.closed = true;
    this.connected = false;
    try { this._write(0x8, Buffer.alloc(0)); this.sock && this.sock.end(); } catch (_) {}
  }
}

module.exports = {
  configured, status, loadConfig, CONF_PATH,
  connect, disconnect, reply, send, sendCard, getToken,
  // 单独导出便于分步排查：凭证对不对、长连接地址能不能申请，是两个独立的失败点
  getConnectUrl,
  // 给测试用：protobuf 帧里提取事件 JSON 的纯函数
  _extractEventJson: extractEventJson,
};
