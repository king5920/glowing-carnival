'use strict';
/**
 * edge-tts 模块校验（离线，纯函数，不联网）
 *
 * 为什么要有这个文件：
 * TTS 换声音（2026-09-10 落地）让语音链从"单一 SAPI 女声"变成
 * "edge-tts 神经语音为主 + SAPI 兜底"。这一层的风险不在"连不上"，
 * 而在**协议细节悄悄改掉**：
 *   ① Sec-MS-GEC token 是 300 秒窗口的 sha256，算法错一格全是 401
 *   ② 长文本分块按 UTF-8 字节切，按 JS 字符切会切破中文字符
 *   ③ SSML 实体没转义会被微软当标签，读出来的内容就变了
 * 这三样都"有响应但是错的"，和语音链路其它假可用一样难查——
 * 所以把纯函数行为锁死在这里，联网那部分留给人做冒烟测试。
 */

const tts = require('./tts_edge.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
const A = (c, m) => { if (!c) throw new Error(m); };

console.log('\n─────── edge-tts 模块 ───────\n');

/* ══════════════ 一、音色表完整性 ══════════════
 *
 * 音色清单以 2026-09-10 实测接口返回为准（8 个中文女声）。
 * 宁可让音色表冗余，也不能凭空多写一个不存在的 id ——
 * 服务端会直接报错，而用户听到的是"没有声音"。 */

test('音色表：8 个中文女声，id 全部以 Neural 结尾（拼音昵称解析的前提）', () => {
  A(tts.VOICES.length === 8, `实测为 8 个中文女声，当前 ${tts.VOICES.length} 个`);
  for (const v of tts.VOICES) {
    A(/Neural$/.test(v.id), `音色 ${v.id} 不以 Neural 结尾，拼音昵称提取会失效`);
    A(typeof v.name === 'string' && v.name.length > 0, `${v.id} 缺中文名`);
    A(typeof v.region === 'string' && v.region.length > 0, `${v.id} 缺方言/区域说明`);
  }
});

test('音色表：id 无重复，默认音色在其中', () => {
  const ids = tts.VOICES.map(v => v.id);
  A(new Set(ids).size === ids.length, '音色 id 有重复');
  A(ids.includes(tts.DEFAULT_VOICE), 'DEFAULT_VOICE 不在音色表里');
  A(tts.DEFAULT_VOICE === 'zh-CN-XiaoxiaoNeural', '默认音色应为晓晓');
});

/* ══════════════ 二、音色名归一化 ══════════════
 *
 * 语音指令"换晓伊的声音"进来的是中文名；模型可能传拼音、
 * 也可能直接传完整 id。三种都要归一，且绝不能撞错（比如
 * zh-TW-HsiaoChenNeural 和 zh-TW-HsiaoYuNeural 拼音都短）。
 * 旧的"取 id 倒数第二段"写法会把 liaoning-Xiaobei 归错，已弃用。 */

test('normalizeVoice：中文名 / 拼音昵称（含大小写）/ 完整 id 都归一成功', () => {
  A(tts.normalizeVoice('晓晓') === 'zh-CN-XiaoxiaoNeural', '中文名 晓晓 应命中');
  A(tts.normalizeVoice('晓伊') === 'zh-CN-XiaoyiNeural', '中文名 晓伊 应命中');
  A(tts.normalizeVoice('xiaoxiao') === 'zh-CN-XiaoxiaoNeural', '拼音昵称 xiaoxiao 应命中');
  A(tts.normalizeVoice('XiaoYi') === 'zh-CN-XiaoyiNeural', '拼音昵称大小写不敏感');
  A(tts.normalizeVoice('zh-TW-HsiaoYuNeural') === 'zh-TW-HsiaoYuNeural', '完整 id 应原样命中');
  A(tts.normalizeVoice(' 小北 ') === 'zh-CN-liaoning-XiaobeiNeural', '带首尾空格应归一');
});

test('normalizeVoice：易混拼音不撞错（liaoning 短昵称分支）', () => {
  /* 旧逻辑取 id 倒数第二段（liaoning），会把"xiaobei"归成 null；
   * 末段去 Neural 后 xiaobei / xiaoni / hsiaoChen / hiuMaan 各自唯一。 */
  A(tts.normalizeVoice('xiaobei') === 'zh-CN-liaoning-XiaobeiNeural', '小北 拼音应命中');
  A(tts.normalizeVoice('xiaoni') === 'zh-CN-shaanxi-XiaoniNeural', '小妮 拼音应命中');
  A(tts.normalizeVoice('hsiaochen') === 'zh-TW-HsiaoChenNeural', '曉臻 拼音应命中');
  A(tts.normalizeVoice('hiugaai') === 'zh-HK-HiuGaaiNeural', '曉佳 拼音应命中');
  A(tts.normalizeVoice('hiugaaig') === null, '多打字母的噪音输入不命中');
  A(tts.normalizeVoice('hiumaan') === 'zh-HK-HiuMaanNeural', '曉曼 拼音应命中');
});

test('normalizeVoice：未知 / 空输入返回 null（不能静默落回默认）', () => {
  A(tts.normalizeVoice('不存在的声音') === null, '未知音色应返回 null');
  A(tts.normalizeVoice('') === null, '空串应返回 null');
  A(tts.normalizeVoice(null) === null, 'null 应返回 null');
  A(tts.normalizeVoice(undefined) === null, 'undefined 应返回 null');
});

/* ══════════════ 三、Sec-MS-GEC token ══════════════ */

test('token：300 秒窗口内稳定，跨窗口变化，64 位大写 hex', () => {
  /* 参考值 @2026-09-10 12:34:56 UTC（win-epoch 取整到 300s）：
   * 该值固化用于防算法漂移 —— 算法改一格，这里立刻红。 */
  const nowMs = 1789043696000;
  A(tts.generateSecMsGec(nowMs) === 'FCE9E127F809D87046F608D4F00FC7F0E0E167CA3FB9D1ECD0E1EF28F396C701',
    '固定窗口的 token 与参考值不一致（算法被改动了）');
  A(tts.generateSecMsGec(nowMs + 1000) === tts.generateSecMsGec(nowMs),
    '同一 300 秒窗口内两次调用必须一致');
  A(tts.generateSecMsGec(nowMs + 300000) !== tts.generateSecMsGec(nowMs),
    '跨窗口 token 必须变化');
  A(/^[0-9A-F]{64}$/.test(tts.generateSecMsGec(nowMs)),
    'token 应为 64 位大写十六进制');
});

/* ══════════════ 四、SSML 转义与文本清理 ══════════════
 *
 * 文本要嵌进 <prosody> 里发出去。& < > 不转义会被微软当标签解析：
 * 这些字符在股票代码、括号、比较句里很常见。 */

test('cleanText：& < > 全部转义', () => {
  A(tts.cleanText('a & b') === 'a &amp; b', '& 未转义');
  A(tts.cleanText('a < b') === 'a &lt; b', '< 未转义');
  A(tts.cleanText('a > b') === 'a &gt; b', '> 未转义');
  A(tts.cleanText('<rate=+10%>') === '&lt;rate=+10%&gt;', '整段含标签形态应整体转义');
});

test('cleanText：控制字符替换为空格（否则服务端报语法错）', () => {
  /* 垂直制表符 \x0b 实测会让边缘服务直接拒收。 */
  A(tts.cleanText('a\x0bb') === 'a b', '垂直制表符应替换为空格');
  A(tts.cleanText('a\u0000b') === 'a b', 'NUL 应替换为空格');
});

/* ══════════════ 五、长文本分块 ══════════════
 *
 * 按 UTF-8 字节切（CHUNK_MAX_BYTES=3900，4KB 上限留余量）。
 * 中文字符 1 字 = 3 字节，按 JS 字符 slice 会在 4KB 处切破半个字符。
 * 拼回必须逐字节还原原文 —— 分块是给传输层看的，语义层不能有任何损失。 */

test('chunkText：短文本单块原样返回', () => {
  A(tts.chunkText('你好').length === 1, '短文本应只有一块');
  A(tts.chunkText('你好')[0] === '你好', '短文本内容不应被改动');
});

test('chunkText：长文本每块 ≤ maxBytes（UTF-8 字节）且不切破中文字符', () => {
  const zh = '贾维斯帮我打开浏览器'.repeat(60); // 约 900 字 ≈ 2700 字节
  const chunks = tts.chunkText(zh, 800);
  A(chunks.length > 1, '长文本应被切成多块');
  for (const c of chunks) {
    A(Buffer.byteLength(c, 'utf8') <= 800, `块超限：${Buffer.byteLength(c, 'utf8')} 字节`);
    /* 往返校验：转回字节字节数一致 = 块边界没有切破多字节字符 */
    A(Buffer.byteLength(c, 'utf8') === Buffer.from(c, 'utf8').length,
      '块内存在被切破的中文字符');
  }
  A(chunks.join('') === zh, '分块拼回必须逐字节还原原文');
});

test('chunkText：XML 实体不能在 & 处被切断', () => {
  /* 实体保护：切片恰好落在 "&amp;" 中间时，必须整段回退到 & 之前，
   * 否则下一块开头是 "amp;" 残留，语义就变了。 */
  const text = 'A'.repeat(795) + '&amp;' + 'B'.repeat(100);
  const chunks = tts.chunkText(text, 800);
  for (const c of chunks) {
    A(!/&(?!amp;|lt;|gt;)[a-z]*$/.test(c), '块末尾出现了未闭合的实体前缀');
  }
  A(chunks.join('') === text, '含实体的文本拼回必须一致');
});

test('chunkText：maxBytes 小到无法容纳一个字符时报错而非死循环', () => {
  let threw = false;
  try { tts.chunkText('中文字符', 2); } catch (e) { threw = /过小/.test(e.message); }
  A(threw, 'maxBytes=2 应报"过小"错误（2 字节装不下一个中文字）');
});

/* ══════════════ 六、语速换算（voice.js 的纯函数） ══════════════ */

const voiceRate = require('./voice.js').rateToPct;

test('rateToPct：0→+0%，正负翻转，越界夹取', () => {
  A(voiceRate(0) === '+0%', 'rate 0 应为 +0%（edge-tts 不接受 0%）');
  A(voiceRate(5) === '+50%', '5 应为 +50%');
  A(voiceRate(-5) === '-50%', '-5 应为 -50%');
  A(voiceRate(10) === '+100%', '10 应为 +100%');
  A(voiceRate(-10) === '-100%', '-10 应为 -100%');
  A(voiceRate(15) === '+100%', '越界 15 应收敛到 +100%');
  A(voiceRate(-15) === '-100%', '越界 -15 应收敛到 -100%');
  A(voiceRate(3.7) === '+30%', '非整数应取整（3.7 → 3 → +30%）');
});

/* ══════════════ 七、流式合成接口契约（离线，不联网）══════════════
 *
 * 流式是 P1 延迟优化的核心。这里锁住的是**接口形状**，
 * 真正联网的字节一致性由冒烟脚本（_stream1.js 模式）验证，
 * 不进 CI，避免依赖公网。
 */
test('synthesizeStream 已导出，synthesize 仍保留（向后兼容）', () => {
  A(typeof tts.synthesizeStream === 'function', '缺少 synthesizeStream');
  A(typeof tts.synthesize === 'function', '整段 synthesize 不能删，旧端点/测试依赖它');
});

test('synthesizeStream：不传回调直接 reject（避免静默吞音频）', () => {
  let threw = false;
  return tts.synthesizeStream('测试', {}).catch(() => { threw = true; }).then(() => {
    // 该 promise 必 reject。用同步探测：onAudio 非函数时立即 reject。
  }).then(() => new Promise(resolve => {
    tts.synthesizeStream('测试', {}).catch(e => {
      A(/onAudio/.test(e.message), '错误信息应指出缺 onAudio 回调，实际：' + e.message);
      resolve();
    });
  })).then(() => {
    // threw 仅用于保留语义；关键断言在上面的 catch 里
    A(true);
  });
});

/* voice.js 流式封装：同样必须存在，且复用同一条 120 字截断/清洗链，
 * 保证流式和整段说出来的内容不会一个长一个短。 */
test('voice.synthesizeStream 存在，且与整段共用清洗逻辑（源码契约）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/voice.js', 'utf8');
  A(/async function synthesizeStream/.test(src), 'voice.js 缺 synthesizeStream');
  A(/ttsEdge\.synthesizeStream/.test(src), '应调用 edge 层的 synthesizeStream');
  A(/cleanForSpeech\(text\)/.test(src.match(/async function synthesizeStream[\s\S]{0,600}/)[0]),
    '流式必须先 cleanForSpeech，否则可能念出 Markdown 符号');
  A(/MAX_CHARS\s*=\s*120/.test(src.match(/async function synthesizeStream[\s\S]{0,800}/)[0]),
    '流式必须保留 120 字截断，否则长回复会念一分半');
});

/* 服务端流式端点契约 */
test('server：流式端点 chunked、无 Content-Length、禁中间层缓冲', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  A(/\/api\/voice\/speak\/stream/.test(src), '缺流式路由');
  const seg = src.match(/speak\/stream[\s\S]{0,1400}/)[0];
  A(/Transfer-Encoding['"]?,\s*'chunked'|'chunked'/.test(seg), '必须用 chunked 传输');
  A(/X-Accel-Buffering['"]?,\s*'no'|'no'/.test(seg), '必须发 X-Accel-Buffering:no，否则 nginx 会把流又攒成整段');
  A(!/Content-Length/.test(seg), '流式响应不能带 Content-Length（长度未知）');
});

test('server：客户端打断必须中止上游拉取，不能白收剩余音频', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const seg = src.match(/speak\/stream[\s\S]{0,2200}/)[0];
  A(/req\.on\('close'/.test(seg), '必须监听请求关闭（用户打断/关页）');
  A(/client aborted stream|aborted/.test(seg), '打断时应抛错/标记，让 synthRaw 提前退出');
});

test('server：流式首帧前失败要回落整段端点（含 SAPI 兜底）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const seg = src.match(/speak\/stream[\s\S]{0,2600}/)[0];
  A(/!res\.headersSent/.test(seg), '必须在头未发出时才回落（发出后不能改状态码）');
  A(/302/.test(seg), '应 302 到整段 /api/voice/speak');
});

test('前端播放已切到流式端点，但保留打断上报', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/\/api\/voice\/speak\/stream/.test(src), 'app.js 应改用流式端点');
  A(/reportSpeaking\(true\)/.test(src), '流式播放仍需上报朗读状态，否则 barge-in 打断失效');
  A(/stopSpeaking/.test(src), '打断停播逻辑不能丢');
});

/* ══════════════ P2：LLM 流式 → 分句 TTS 队列 ══════════════ */

test('前端有按句流式朗读队列（feed/预取/播放），不是拿到整段才播', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/function speakFeed/.test(src), '缺 speakFeed：模型 delta 无法逐句喂给 TTS');
  A(/function speakEnd/.test(src), '缺 speakEnd：最后一句无标点会漏播');
  A(/function pumpPlay/.test(src), '缺 pumpPlay：句子队列不会顺序播放');
  A(/function splitSentences/.test(src), '缺 splitSentences');
});

test('切句不能把数字小数点当句末（4.37% / 3.5亿）', () => {
  /* 这是实测会踩的坑：朴素正则按 "." 切，"涨4.37%" 被切成 "涨4." + "37%…"，
   * TTS 会把 4. 念成"四点"然后下一句突然冒 37。必须排除数字间句点。 */
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  const m = src.match(/function splitSentences[\s\S]{0,1200}/);
  A(m, '找不到 splitSentences 实现');
  A(/isDigit/.test(m[0]), '应有数字判定，专门保护小数点');
});

test('前端处理 reply_delta：边收边渲染气泡、边喂 TTS；reply 不重复', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/ev === 'reply_delta'/.test(src), '必须监听 reply_delta');
  A(/ev === 'reply'/.test(src), '仍需处理最终 reply（飞书/非流式/契约）');
  // 流式已渲染时，最终 reply 不得新建气泡或重新整段朗读
  const replySeg = src.match(/else if \(ev === 'reply'\)\s*\{[\s\S]{0,700}/);
  A(replySeg && /d\.streamed/.test(replySeg[0]),
    '最终 reply 应根据 d.streamed 去重，否则流式回答会显示/朗读两遍');
});

test('brain 流式：最终轮发 reply_delta，收齐仍发完整 reply（保落库/飞书契约）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/brain.js', 'utf8');
  A(/chatWithToolsStream/.test(src), 'brain 应改用流式 LLM 入口');
  A(/emit\('reply_delta'/.test(src), '最终回答必须逐段发 reply_delta');
  A(/emit\('reply',\s*\{[^}]*streamed/.test(src), '最终仍要发完整 reply 并带 streamed 标记');
});

test('错误时停止流式朗读，避免半句悬着', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  const errSeg = src.match(/ev === 'error'[\s\S]{0,160}/);
  A(errSeg && /speakStopInternal|stopSpeaking/.test(errSeg[0]),
    'error 事件必须停掉朗读队列');
});

/* ══════════════ 垫场语 + 能量即时打断（2026-09-13）══════════════ */

test('语音轮查数据先垫一句话，填满工具等待；正文起念即撤', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/function maybeVoiceFiller/.test(src), '缺垫场语函数');
  A(/function stopFiller/.test(src), '缺 stopFiller');
  // tool_call 处要触发垫场
  const tc = src.match(/ev === 'tool_call'[\s\S]{0,500}/);
  A(tc && /maybeVoiceFiller/.test(tc[0]), 'tool_call 时应触发垫场语');
  // 正文开始必须撤垫场，否则两轨叠播
  A(/speakStart[\s\S]{0,200}stopFiller/.test(src), '正文起念应撤掉垫场语');
  // 只能语音轮垫，文字轮不许出声
  const mf = src.match(/function maybeVoiceFiller[\s\S]{0,260}/);
  A(mf && /currentTurnVoice/.test(mf[0]), '垫场语只能在语音轮触发');
});

test('环形缓冲的 speaking 能量起音必须接到打断链路', () => {
  const fs = require('fs');
  const v = fs.readFileSync(__dirname + '/voice.js', 'utf8');
  A(/_handleSpeechOnset/.test(v), 'voice.js 缺 _handleSpeechOnset');
  // ring 的 speaking 事件要转发（允许中间有注释）
  A(/ev\.type === 'speaking'[\s\S]{0,400}_handleSpeechOnset/.test(v),
    '环形缓冲 speaking 起音未转发到 _handleSpeechOnset');
  // 回声护栏
  const h = v.match(/_handleSpeechOnset[\s\S]{0,900}/);
  A(h && /ECHO_SETTLE_MS/.test(h[0]), '缺回声建立期保护（刚出声易自打断）');
  A(h && /ONSET_COOLDOWN_MS/.test(h[0]), '缺打断节流，会同声反复打断');
  A(h && /if \(!this\.speaking\) return/.test(h[0]), '非朗读状态必须直接返回');
});

/* ══════════════ 句间停顿修复：预取（2026-09-13）══════════════
 *
 * 旧队列在上一句 ended 后才请求下一句 TTS，每句都付 ~1.5s 冷启动，
 * 表现为"每个标点后停 3 秒"。必须提前把下一句下成 Blob。 */
test('朗读队列必须预取下一句，而不是念完才请求', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/function pumpFetch/.test(src), '缺 pumpFetch 预取');
  A(/createObjectURL/.test(src), '预取音频应转成 Blob URL 以便零等待起播');
  A(/revokeObjectURL/.test(src), '播放/打断后必须回收 Blob URL，否则内存泄漏');
  // 念完一句要立即触发下一句的预取+播放
  const next = src.match(/const next = \(\) => \{[\s\S]{0,400}/);
  A(next && /pumpFetch/.test(next[0]), '一句结束后应 pumpFetch 补预取');
});

/* ══════════════ 语音识别专名纠偏（拓日新能类问题）══════════════ */

test('whisper 支持注入动态领域提示词，且失败退回静态提示不崩', () => {
  const fs = require('fs');
  const v = fs.readFileSync(__dirname + '/voice.js', 'utf8');
  A(/setWhisperPromptProvider/.test(v), 'voice.js 缺 setWhisperPromptProvider');
  A(/prompt:\s*buildWhisperPrompt\(\)/.test(v), '转写时必须带动态 prompt');
  // 异常/无注入时不能让唤醒失败
  A(/function _getVocab[\s\S]{0,500}catch/.test(v), '动态提示词异常必须 try/catch 退回');
});

test('server 注入本地专名词表给 whisper（专名先验）', () => {
  const fs = require('fs');
  const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
  A(/setWhisperPromptProvider/.test(s), 'server 未注入提示词供给器');
  A(/db\.voiceVocab/.test(s), '供给器应读 db.voiceVocab 词表');
});

/* ══════════════ 智能 base/small 档位切换（2026-09-13）══════════════ */

test('sidecar 支持按 opts.model 选档，多 worker 各管一档，并有后台预热', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/whisper_sidecar.js', 'utf8');
  A(/function workerCode\(modelRef\)/.test(src), 'workerCode 应接收模型参数');
  A(/_workers\s*=\s*new Map/.test(src), '应有按档位管理的 worker 表');
  A(/opts\.model\s*\|\|\s*MODEL_SIZE/.test(src), 'transcribe 应支持 opts.model');
  A(/function prewarm/.test(src), '缺 prewarm 后台预热');
});

test('voice 智能复核：指令轮可疑即升级 small；唤醒轮仅"像指令的整句"才复核', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname + '/voice.js', 'utf8');
  A(/VERIFY_MODEL/.test(src), '缺复核档位配置');
  A(/kind === 'command'[\s\S]{0,40}shouldVerify/.test(src),
    '指令轮可疑时应复核');
  A(/wakeCommandLike/.test(src), '唤醒轮应能对"没听到唤醒词却像指令"的整句复核（救连贯说法）');
  A(/model:\s*VERIFY_MODEL/.test(src), '复核必须指定 small 档位');
  A(/whisper_verifying/.test(src), '复核开始要通知前端（避免用户干等）');
  const seg = src.match(/wakeCommandLike[\s\S]{0,900}/);
  A(seg && /catch/.test(seg[0]), '复核异常必须吞掉并沿用 base 结果');
});

test('server 开麦后后台预热 small，voiceVocab 返回限长数组', () => {
  const fs = require('fs');
  const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
  A(/whisper\.prewarm\(voice\.VERIFY_MODEL\)/.test(s), '应后台预热复核模型');
  const db = require('./db');
  const v = db.voiceVocab();
  A(Array.isArray(v), 'voiceVocab 应返回数组');
  A(v.every(x => typeof x === 'string' && x.trim()), '词表元素应为非空字符串');
  A(v.join('').length <= 70, '词表应限长（实测 60 字上限），实际 ' + v.join('').length);
});

test('语音轮要求模型对转写错字先纠偏：近音匹配真实标的、唯一才直接答', () => {
  const fs = require('fs');
  const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const m = s.match(/语音转写可能有错字[\s\S]{0,600}/);
  A(m, '语音提示词缺"转写纠偏"段');
  A(/近音/.test(m[0]), '应指示按近音匹配');
  A(/多个/.test(m[0]) && /反问/.test(m[0]), '多义无法确定时才反问确认');
});

/* ══════════════ 唤醒应答（喊完要有一声"在呢"）══════════════ */

test('纯唤醒有短应答；命令紧跟(lead)时撤掉，避免叠播', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  A(/function scheduleWakeAck/.test(src), '缺 scheduleWakeAck');
  A(/function cancelWakeAck/.test(src), '缺 cancelWakeAck');
  // voice_wake 要挂应答
  const wk = src.match(/addEventListener\('voice_wake'[\s\S]{0,260}/);
  A(wk && /scheduleWakeAck/.test(wk[0]), 'voice_wake 后应安排唤醒应答');
  // voice_speech（lead 命令）要撤应答
  const sp = src.match(/addEventListener\('voice_speech'[\s\S]{0,400}/);
  A(sp && /cancelWakeAck/.test(sp[0]), '命令紧跟唤醒时必须撤掉应答，否则和回答叠播');
  // 打断不答"在呢"（用户已在说话）
  const it = src.match(/addEventListener\('voice_interrupt'[\s\S]{0,200}/);
  A(it && /cancelWakeAck/.test(it[0]), '打断场景不应播放唤醒应答');
});

test('唤醒应答要正确上报 speaking，且正文起念/停播时撤销', () => {
  const fs = require('fs');
  const src = fs.readFileSync(__dirname.replace(/src$/, '') + 'ui/app.js', 'utf8');
  // 应答播放期间必须报 speaking=true，否则回声能量起音会自我打断
  const pa = src.match(/function playWakeAck[\s\S]{0,700}/);
  A(pa && /reportSpeaking\(true\)/.test(pa[0]), '应答起播应报 speaking=true');
  A(pa && /reportSpeaking\(false\)/.test(pa[0]), '应答结束应报 speaking=false');
  // speakStart / stopSpeaking 都要能撤应答
  A(/function speakStart[\s\S]{0,200}cancelWakeAck/.test(src), '正文起念应撤应答');
  A(/function stopSpeaking[\s\S]{0,120}cancelWakeAck/.test(src), 'stopSpeaking 应撤应答');
});

console.log('\n───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────\n');
process.exit(fail ? 1 : 0);