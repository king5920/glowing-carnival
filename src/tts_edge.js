'use strict';
/**
 * edge-tts 神经语音合成 —— 微软 Edge 在线朗读服务（零依赖实现）
 *
 * 为什么存在这个模块：System.Speech(SAPI) 的中文语音只有 Huihui 一个（机械音），
 * 本项目硬约束"生产依赖只允许 better-sqlite3"，所以用 Node 原生能力
 * （node:https + 手写 WebSocket 帧）直连微软的 readaloud 端点。实测可行：
 * 与 edge-tts(python) 对同一句文本产出**逐字节一致**的 mp3（17856 B）。
 *
 * ── 协议要点（2026-09-10 实测 + 对照 edge-tts 开源实现）──
 * 1. 端点：wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 *    查询参数必须带 TrustedClientToken / ConnectionId / Sec-MS-GEC / Sec-MS-GEC-Version。
 * 2. Sec-MS-GEC token（2024-05 起强制）：
 *    取当前 UTC unix 秒 → +11644473600（切到 Windows 文件时间纪元 1601）→
 *    向下取整到 5 分钟 → ×1e7（转 100ns 单位）→ 拼 TrustedClientToken →
 *    SHA256 → 大写 hex。token 在 5 分钟窗口内有效，会 403 于窗口过期。
 * 3. WS 握手头：Origin 必须是 chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold，
 *    User-Agent 是 Chrome/Edge 143 系，Cookie 带 muid。免费接口靠这些伪装识别。
 *    实测**不带** Sec-WebSocket-Extensions(permessage-deflate) 也能正常收流。
 * 4. 连上后先发 speech.config（选定 24kHz/48kbps CBR mp3 输出格式），
 *    再发一组 Path:ssml 文本消息。文本 >4096 字节必须按 UTF-8 安全边界分块，
 *    每块一条新 ssml、服务端回一个 turn.end。音频在二进制帧里。
 * 5. 二进制帧格式：前 2 字节大端 = 头长度 H，随后 H 字节头（Path:audio,
 *    Content-Type:audio/mpeg），再往后全是 mp3 数据。文本帧 Path:turn.end 收尾。
 * 6. 响应中 X-Timestamp 带一个多余的 Z 是微软的 bug，照抄，别"修正"。
 *
 * ── 已知限制 ──
 * - 每次合成都新建 TLS 连接（约 1-2s 开销），不做连接复用。JARVIS 播报频率低，值。
 * - 实时接口依赖公网；断网/403 时应由调用方降级到 SAPI（见 voice.js 降级链）。
 * - 音色清单以实测接口返回为准（2026-09-10 共 8 个中文女声，见 VOICES）。
 */

const https = require('https');
const crypto = require('crypto');

/* ═══ 常量（来自 edge-tts 开源实现的当前值，微软改了要跟着更） ═══ */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const WSS_HOST = 'speech.platform.bing.com';
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'; // CBR, 48kbps
const CHUNK_MAX_BYTES = 3900; // 4KB 上限留余量，避免 ssml 壳把消息顶超
const WIN_EPOCH_S = 11644473600; // 1601-01-01 到 1970-01-01 的秒差
const FIVE_MIN_S = 300;
const NANO100_PER_S = 1e7;

/* ═══ 音色表（2026-09-10 实测接口返回，仅女声） ═══ */
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', region: '普通话（推荐，最自然）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', region: '普通话' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '小北', region: '东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '小妮', region: '陕西方言' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', region: '台湾腔' },
  { id: 'zh-TW-HsiaoYuNeural', name: '仙雲', region: '台湾腔' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼', region: '粤语' },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', region: '粤语' },
];

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/* ═══ 工具函数 ═══ */

/** 生成 Sec-MS-GEC token（可注入 nowMs 便于测试）。见头部注释第 2 条。 */
function generateSecMsGec(nowMs = Date.now()) {
  let ticks = nowMs / 1000 + WIN_EPOCH_S;
  ticks -= ticks % FIVE_MIN_S;
  ticks *= NANO100_PER_S;
  return crypto
    .createHash('sha256')
    .update(`${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** 音色名归一化：接受完整 id / 中文名 / 拼音昵称（xiaoxiao），找不到返回 null。 */
function normalizeVoice(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  const hit = VOICES.find(v => {
    if (v.id.toLowerCase() === low || v.name === s) return true;
    // 拼音昵称：id 末段去 Neural 后缀（XiaoxiaoNeural -> xiaoxiao）
    const short = v.id.split('-').pop().replace(/Neural$/i, '').toLowerCase();
    return low === short;
  });
  return hit ? hit.id : null;
}

/** SSML 文本转义 + 清掉服务端不支持的 ASC 控制字符（垂直制表符等）。 */
function cleanText(text) {
  let s = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s;
}

/** 从 end 起向前回退，找到合法的 UTF-8 字节边界（不切断多字节字符）。 */
function safeUtf8End(buf, end) {
  while (end > 0) {
    // 往返验证：切片转字符串再转回字节，长度一致即边界合法
    if (Buffer.byteLength(buf.subarray(0, end).toString('utf8'), 'utf8') === end) return end;
    end--;
  }
  return end;
}

/** 按 UTF-8 字节数分块，优先整块切分且不切破多字节字符/XML 实体。 */
function chunkText(text, maxBytes = CHUNK_MAX_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  const chunks = [];
  let pos = 0;
  while (buf.length - pos > maxBytes) {
    let end = safeUtf8End(buf, pos + maxBytes);
    let cut = buf.subarray(pos, end).toString('utf8');
    // 实体保护：切片末尾的 & 未闭合则回退到 & 之前（把 & 留给下一块）
    const amp = cut.lastIndexOf('&');
    if (amp !== -1 && !cut.slice(amp + 1).includes(';')) {
      end = safeUtf8End(buf, pos + Buffer.byteLength(cut.slice(0, amp), 'utf8'));
      cut = buf.subarray(pos, end).toString('utf8');
    }
    if (!cut) {
      throw new Error(`chunkText: maxBytes=${maxBytes} 过小，无法安全切分`);
    }
    chunks.push(cut);
    pos = end;
  }
  if (buf.length > pos) chunks.push(buf.subarray(pos).toString('utf8'));
  return chunks;
}

/** 构造 JS 风格日期串（微软要求的固定格式）。 */
function jsDateString(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = n => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${h(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${h(d.getUTCHours())}:${h(d.getUTCMinutes())}:${h(d.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`;
}

function uuid32() {
  return crypto.randomUUID().replace(/-/g, '');
}

/* ═══ WebSocket 帧 ═══ */

/** 客户端帧必须带 mask；payload 全量 mask。 */
function clientFrame(opcode, payload) {
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.from([0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * 服务端帧增量解析器（服务端不 mask）。每次 push 返回新解析出的完整帧。
 * 用法：const acc = {}; for (const f of WsReader.push(buf, acc)) {...}
 */
const WsReader = {
  push(buf, acc) {
    acc.buf = acc.buf ? Buffer.concat([acc.buf, buf]) : buf;
    const frames = [];
    while (true) {
      const b = acc.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (b.length < off + len) break;
      frames.push({ fin, opcode, payload: b.subarray(off, off + len) });
      acc.buf = b.subarray(off + len);
    }
    return frames;
  },
};

function buildSsmll(voice, escapedText, ratePct) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${ratePct}' volume='+0%'>` +
    `${escapedText}</prosody></voice></speak>`
  );
}

function buildConfigMsg() {
  return (
    `X-Timestamp:${jsDateString()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":` +
    `{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},` +
    `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
  );
}

function buildSsmllMsg(voice, escapedText, ratePct) {
  return (
    `X-RequestId:${uuid32()}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${jsDateString()}Z\r\n` + // 末尾多一个 Z 是微软的 bug，照抄
    `Path:ssml\r\n\r\n` +
    buildSsmll(voice, escapedText, ratePct)
  );
}

/* ═══ 主入口 ═══ */

/**
 * 连接 Edge readaloud WebSocket 并合成。
 *
 * 这是 buffered / streaming 两个公共入口共用的核心：
 *   · onAudio(chunk) 每来一个二进制音频帧就回调一次（流式靠它尽早出声）；
 *   · resolve 只在收到全部 turn.end 后触发（调用方据此知道流结束）。
 *
 * @returns {Promise<{bytes:number, engine:'edge-tts'}>}
 */
function synthRaw(text, opts = {}, onAudio = null) {
  const voice = normalizeVoice(opts.voice) || DEFAULT_VOICE;
  const ratePct = opts.ratePct || '+0%';
  const timeoutMs = opts.timeoutMs || 30000;
  const escaped = cleanText(text);
  const chunks = chunkText(escaped);
  let totalBytes = 0;

  return new Promise((resolve, reject) => {
    const url =
      `https://${WSS_HOST}${WSS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&ConnectionId=${uuid32()}&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const secKey = crypto.randomBytes(16).toString('base64');
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Origin: ORIGIN,
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Cookie: `muid=${uuid32().toUpperCase()};`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': secKey,
        'Sec-WebSocket-Version': '13',
      },
    });

    let settled = false;
    const timer = setTimeout(() => fail(new Error('edge-tts 合成超时')), timeoutMs);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ bytes: totalBytes, engine: 'edge-tts' });
    }

    req.on('error', fail);
    req.on('upgrade', (res, socket) => {
      const expect = crypto
        .createHash('sha1')
        .update(secKey + WS_GUID)
        .digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        return fail(new Error(`WS 握手校验失败: ${res.statusCode || ''}`));
      }

      const acc = { buf: null };
      let turnEnds = 0;

      socket.on('error', fail);
      socket.on('data', d => {
        for (const f of WsReader.push(d, acc)) {
          if (f.opcode === 0x8) {
            // 服务端主动关闭（正常路径也会 pre-close）
            if (turnEnds < chunks.length) return fail(new Error('edge-tts 连接提前关闭'));
            break;
          }
          if (f.opcode === 0x1) {
            const msg = f.payload.toString('utf8');
            if (msg.includes('Path:turn.end')) {
              turnEnds++;
              if (turnEnds >= chunks.length) return done();
            } else if (msg.includes('Path:response')) {
              // 非 turn.start/end 的文本帧里可能有错误信息
              const errGrab = msg.match(/"error"[^}]*/);
              if (errGrab) return fail(new Error(`edge-tts 服务端错误: ${errGrab[0].slice(0, 120)}`));
            }
            continue;
          }
          if (f.opcode === 0x2) {
            if (f.payload.length < 2) continue;
            const hlen = f.payload.readUInt16BE(0);
            const data2 = f.payload.subarray(hlen + 2);
            if (data2.length) {
              totalBytes += data2.length;
              /* 流式回调：边收边吐。onAudio 抛错要能中止合成，
               * 否则客户端断开后服务端还在傻收音频。 */
              if (onAudio) {
                try { onAudio(data2); }
                catch (e) { return fail(e); }
              }
            }
          }
        }
      });

      // 连接成功即发送：config 一次 + 每块一条 ssml
      socket.write(clientFrame(0x1, Buffer.from(buildConfigMsg())));
      for (const c of chunks) {
        socket.write(clientFrame(0x1, Buffer.from(buildSsmllMsg(voice, c, ratePct))));
      }
    });

    req.end();
  });
}

/**
 * 流式合成：WS 音频帧每到一批就通过 onAudio 吐出，不必等整段拼完。
 *
 * 用途：服务端把音频以 chunked 直接写给浏览器，浏览器在第一个音频帧
 * （约几百毫秒）就能起播，而不是等 1.6 秒后拿到完整 mp3。
 *
 * @param {function(Buffer):void} onAudio
 * @returns {Promise<{bytes:number, engine:string}>}
 */
function synthesizeStream(text, opts = {}, onAudio) {
  if (typeof onAudio !== 'function') {
    return Promise.reject(new Error('synthesizeStream 需要 onAudio 回调'));
  }
  return synthRaw(text, opts, onAudio);
}

/**
 * 合成语音（整段缓冲，返回完整 mp3）。
 * @param {string} text 要朗读的文本（调用方应已做人格化清洗，本函数再兜底转义）
 * @param {object} [opts]
 * @param {string} [opts.voice] 音色 id / 中文名（经 normalizeVoice 归一化，缺省 DEFAULT_VOICE）
 * @param {number} [opts.ratePct] 语速百分比字符串 "+0%" / "-20%"（缺省 "+0%"）
 * @param {number} [opts.timeoutMs] 总超时（缺省 30000）
 * @returns {Promise<{buffer: Buffer, mime: string, engine: string, bytes: number}>}
 */
function synthesize(text, opts = {}) {
  const audioChunks = [];
  return synthRaw(text, opts, chunk => audioChunks.push(chunk)).then(
    ({ bytes, engine }) => {
      const buf = Buffer.concat(audioChunks);
      return { buffer: buf, mime: 'audio/mpeg', engine, bytes };
    }
  );
}

module.exports = {
  VOICES,
  DEFAULT_VOICE,
  normalizeVoice,
  generateSecMsGec,
  synthesize,
  synthesizeStream,
  chunkText,
  cleanText,
  TRUSTED_CLIENT_TOKEN,
  SEC_MS_GEC_VERSION,
};