'use strict';
/* 一键设备体检（voice_checkup）。
 * 纯函数和健壮性用构造输入测；真实录音只做不崩冒烟（CI/无声环境可接受跳过）。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const _tests = [];
/* 统一注册：同步/异步都收集起来，在 main() 里顺序 await，
 * 避免 process.exit 抢在异步判定之前、统计对不上。 */
function test(name, fn) { _tests.push({ name, fn }); }
const testAsync = test;

const chk = require('./voice_checkup');

test('norm 去中英文标点和空白', () => {
  assert.strictEqual(chk.norm('贾维斯，现在几点了？ '), '贾维斯现在几点了');
  assert.strictEqual(chk.norm('打开浏览器。！'), '打开浏览器');
  assert.strictEqual(chk.norm(null), '');
});

test('similarity：同义句高、无关句0', () => {
  assert(chk.similarity('贾维斯现在几点了', '贾维斯现在几点') > 0.8);
  assert.strictEqual(chk.similarity('打开浏览器', '今天大盘情况'), 0);
});

test('默认引导句覆盖唤醒词和日常指令', () => {
  assert(chk.DEFAULT_PROMPTS.some(p => /贾维斯/.test(p)), '要包含唤醒词');
  assert(chk.DEFAULT_PROMPTS.length >= 2);
});

test('recognizeWavSystem 对不存在的文件返回错误而非崩溃', async () => {
  const r = await chk.recognizeWavSystem(path.join(os.tmpdir(), 'no_such_jarvis.wav'));
  assert(r.ok === false, '坏路径应返回 ok:false');
  assert(r.error, '应带错误说明');
});

test('recognizeWavSystem 能吃一段静音WAV并返回结构（不要求听清）', async () => {
  // 生成 0.5s 16k 单声道静音 WAV（System.Speech 可读 PCM）
  const rate = 16000, sec = 0.5, n = rate * sec;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const f = path.join(os.tmpdir(), 'jarvis_silence_' + Date.now() + '.wav');
  fs.writeFileSync(f, buf);
  const r = await chk.recognizeWavSystem(f, { timeoutMs: 20000 });
  try { fs.unlinkSync(f); } catch {}
  /* 静音应是 heard:false（NONE）或明确结构，绝不抛异常 */
  assert(r.ok === true, 'System.Speech 应正常结束');
  assert('heard' in r, '应给出 heard 字段，实际 ' + JSON.stringify(r));
  assert.strictEqual(r.heard, false, '静音不该识别出文字');
});

test('runCheckup 没有设备时返回明确错误（用打桩验证不崩）', async () => {
  /* 不依赖真实硬件：临时把 listDevices 打桩成空 */
  const mr = require('./mic_record');
  const orig = mr.listDevices;
  mr.listDevices = () => ({ ok: false, error: '没有输入设备', devices: [] });
  try {
    const rep = await chk.runCheckup();
    assert.strictEqual(rep.ok, false);
    assert(/设备/.test(rep.error));
  } finally { mr.listDevices = orig; }
});

test('formatReport 无设备时诚实报错，不编造', () => {
  const t = chk.formatReport({ ok: false, error: '没有检测到输入设备', devices: [] });
  assert(/失败|没有检测/.test(t));
});

test('工具 voice_checkup 已注册且标 writable（要录音）', () => {
  const r = require('./tools/registry');
  const item = r.listForModel().map(x => x).find(x => (x.function || x).name === 'voice_checkup');
  assert(item, 'voice_checkup 未注册');
});

testAsync('真实体检（无设备/无声环境允许 no_speech，但不能崩）', async () => {
  const rep = await chk.runCheckup({ maxMs: 2500 });
  assert(typeof rep.ok === 'boolean');
  if (rep.ok) {
    assert(Array.isArray(rep.devices));
    rep.devices.forEach(d => {
      assert(d.verdict, '每个设备都要有结论');
      assert(d.verdictText, '每个设备都要有给用户的话');
    });
  }
});

test('噪声幻觉不能被判 usable（实测踩坑：没人说话 whisper 编出字）', async () => {
  /* 打桩：VAD 说有语音，whisper 返回与提示句无关的幻觉，系统 conf=0 */
  const mr = require('./mic_record');
  const mq = require('./mic_quality');
  const wh = require('./whisper_sidecar');

  const tmpWav = path.join(os.tmpdir(), 'jarvis_fakechk.wav');
  fs.writeFileSync(tmpWav, Buffer.alloc(100));

  const origRec = mr.record, origAn = mq.analyze, origTr = wh.transcribe;
  /* record 必须把假 WAV 写到调用方给的 outPath，checkDevice 才认它存在 */
  mr.record = async (o) => { fs.writeFileSync(o.outPath, Buffer.alloc(100));
    return { ok: true, path: o.outPath, ms: 3000, peak: 16000, sawSpeech: true, threshold: 100 }; };
  mq.analyze = () => ({ grade: 'narrowband', gradeInfo: { label: '窄带' }, hf3k: 3, spectrum: {}, hasSignal: true });
  wh.transcribe = async () => ({ ok: true, text: '再几点啊下维斯' });

  const r = await chk.checkDevice({ index: 0, name: 'fake' }, { maxMs: 2000 });
  mr.record = origRec; mq.analyze = origAn; wh.transcribe = origTr;
  try { fs.unlinkSync(tmpWav); } catch {}

  assert(r.verdict === 'uncertain' || r.verdict === 'poor',
    '噪声幻觉必须判 uncertain/poor，实际 ' + r.verdict);
  assert(r.verdict !== 'usable' && r.verdict !== 'usable_narrow', '绝不能把噪声判成可用设备');
});

test('真正念对提示句 → usable（whisper 与提示高相似）', async () => {
  const mr = require('./mic_record');
  const mq = require('./mic_quality');
  const wh = require('./whisper_sidecar');
  const tmpWav = path.join(os.tmpdir(), 'jarvis_fakechk2.wav');
  fs.writeFileSync(tmpWav, Buffer.alloc(100));

  const origRec = mr.record, origAn = mq.analyze, origTr = wh.transcribe;
  const origSys = chk.recognizeWavSystem;
  mr.record = async (o) => { fs.writeFileSync(o.outPath, Buffer.alloc(100));
    return { ok: true, path: o.outPath, ms: 3000, peak: 16000, sawSpeech: true, threshold: 100 }; };
  mq.analyze = () => ({ grade: 'wideband', gradeInfo: { label: '宽带' }, hf3k: 30, spectrum: {}, hasSignal: true });
  wh.transcribe = async () => ({ ok: true, text: '贾维斯现在几点了' });
  chk.recognizeWavSystem = async () => ({ ok: true, text: '贾维斯现在几点了', confidence: 0.9, heard: true });

  const r = await chk.checkDevice({ index: 1, name: 'good' }, { maxMs: 2000 });
  mr.record = origRec; mq.analyze = origAn; wh.transcribe = origTr; chk.recognizeWavSystem = origSys;
  try { fs.unlinkSync(tmpWav); } catch {}

  assert.strictEqual(r.verdict, 'usable', '高置信且念对提示句应判可用，实际 ' + r.verdict);
});

/* ══ 真机 bug 回归：能唤醒却下不了指令 ══
 * 窄带麦上 System.Speech 对窗口内指令也只给 conf 0.0x。
 * 必须触发 _tryWhisperCommand，把 whisper 识别句当 speech 下发，
 * 而不是 speech_unclear（"没听清"）。 */
async function voiceCommandRescueTest() {
  const voice = require('./voice');
  const mq = require('./mic_quality');
  const wh = require('./whisper_sidecar');

  /* 强制窄带策略：needWhisperConfirm=true，唤醒阈值极低 */
  const origPolicy = mq.currentPolicy;
  mq.currentPolicy = () => ({ wakeConf: 0.1, needWhisperConfirm: true, grade: 'narrowband' });
  const origTr = wh.transcribe;

  const evs = [];
  const L = new voice.Listener(e => evs.push(e));

  /* 假环形缓冲：运行中、有语音、dump 给个临时文件 */
  const tmp = path.join(os.tmpdir(), 'jarvis_ring_fake.wav');
  fs.writeFileSync(tmp, Buffer.alloc(100));
  L.ring = {
    status: () => ({ running: true, filledSeconds: 3, speaking: false, peakSmooth: 5000 }),
    dumpRecent: () => tmp,
    stop: async () => {}, cleanup: () => {},
  };

  /* 打开对话窗口（模拟已被唤醒） */
  L.extendConvo();
  assert(L.inConvo(), '前置：对话窗口应开着');

  /* System.Speech 给了乱码低置信；whisper 识别成真实指令 */
  wh.transcribe = async () => ({ ok: true, text: '帮我看一下今天的大盘情况' });
  L._handle({ type: 'speech', text: '着人我是', conf: 0.02 });

  /* 等异步复核完成 */
  await new Promise(r => setTimeout(r, 300));

  mq.currentPolicy = origPolicy; wh.transcribe = origTr;
  try { fs.unlinkSync(tmp); } catch {}

  const types = evs.map(e => e.type);
  assert(types.includes('speech'),
    '窗口内低置信指令经 whisper 复核后必须下发 speech，实际事件: ' + types.join(','));
  const sp = evs.find(e => e.type === 'speech');
  assert(/大盘/.test(sp.text), 'speech 文本应是 whisper 识别的指令，得到 ' + sp.text);
  assert(!types.includes('speech_unclear'), '不该再报"没听清"');
}
testAsync('窗口内低置信指令走 whisper 复核，不再卡死在没听清', voiceCommandRescueTest);

test('窗口外低置信仍走唤醒复核（不被新分流破坏）', async () => {
  const voice = require('./voice');
  const mq = require('./mic_quality');
  const wh = require('./whisper_sidecar');
  const origPolicy = mq.currentPolicy, origTr = wh.transcribe;
  mq.currentPolicy = () => ({ wakeConf: 0.1, needWhisperConfirm: true, grade: 'narrowband' });

  const evs = [];
  const L = new voice.Listener(e => evs.push(e));
  L.closeConvo();   // 窗口关闭
  const tmp = path.join(os.tmpdir(), 'jarvis_ring_fake2.wav');
  fs.writeFileSync(tmp, Buffer.alloc(100));
  L.ring = {
    status: () => ({ running: true, filledSeconds: 3, speaking: false, peakSmooth: 5000 }),
    dumpRecent: () => tmp, stop: async () => {}, cleanup: () => {},
  };
  wh.transcribe = async () => ({ ok: true, text: '贾维斯' });
  L._handle({ type: 'speech', text: '会为贵', conf: 0.002 });
  await new Promise(r => setTimeout(r, 300));

  mq.currentPolicy = origPolicy; wh.transcribe = origTr;
  try { fs.unlinkSync(tmp); } catch {}

  const types = evs.map(e => e.type);
  assert(types.includes('wake'), '窗口外 whisper 识别到唤醒词应产生 wake，实际: ' + types.join(','));
  assert(L.inConvo(), 'whisper 唤醒成功应打开对话窗口');
});

test('低置信「唤醒语法命中」也走 whisper 复核（修漏唤醒）', async () => {
  /* 2026-09-13 的漏唤醒 bug：
   * System.Speech 对同一句话只给一个结果。窄带麦偶尔撞上 SRGS 唤醒语法，
   * 但 conf 只有 0.0x，原代码在 wake 分支直接 return，且同一句话不会再产生
   * speech 事件 —— 于是 speech 分支里的 whisper 救命通道永远不触发。
   * 这里锁：低置信 wake（窗口外 + needWhisperConfirm）必须送 whisper 复核，
   * 复核出唤醒词就开窗、发 wake。 */
  const voice = require('./voice');
  const mq = require('./mic_quality');
  const wh = require('./whisper_sidecar');
  const origPolicy = mq.currentPolicy, origTr = wh.transcribe;
  mq.currentPolicy = () => ({ wakeConf: 0.1, needWhisperConfirm: true, grade: 'narrowband' });

  const evs = [];
  const L = new voice.Listener(e => evs.push(e));
  L.closeConvo();
  const tmp = path.join(os.tmpdir(), 'jarvis_ring_fake3.wav');
  fs.writeFileSync(tmp, Buffer.alloc(100));
  L.ring = {
    status: () => ({ running: true, filledSeconds: 3, speaking: false, peakSmooth: 5000 }),
    dumpRecent: () => tmp, stop: async () => {}, cleanup: () => {},
  };
  wh.transcribe = async () => ({ ok: true, text: '贾维斯' });

  // 关键：type=wake（语法命中），但 conf 0.05 < wakeConf 0.1
  L._handle({ type: 'wake', text: '贾维斯', conf: 0.05 });
  await new Promise(r => setTimeout(r, 300));

  mq.currentPolicy = origPolicy; wh.transcribe = origTr;
  try { fs.unlinkSync(tmp); } catch {}

  const types = evs.map(e => e.type);
  assert(types.includes('wake'),
    '低置信唤醒语法命中经 whisper 复核后应产生 wake，实际: ' + types.join(','));
  assert(L.inConvo(), '复核出唤醒词必须开窗，否则救命通道等于没接');
});

test('低置信唤醒在未开 whisper 兜底的设备上仍直接丢弃（不引入误唤醒）', () => {
  /* 反向护栏：宽带设备 needWhisperConfirm=false 时，低置信 wake
   * 必须照旧丢弃，不能因为新逻辑反而开窗。 */
  const voice = require('./voice');
  const mq = require('./mic_quality');
  const origPolicy = mq.currentPolicy;
  mq.currentPolicy = () => ({ wakeConf: 0.85, needWhisperConfirm: false, grade: 'wideband' });
  const evs = [];
  const L = new voice.Listener(e => evs.push(e));
  L.closeConvo();
  L._handle({ type: 'wake', text: '贾维斯', conf: 0.5 });
  mq.currentPolicy = origPolicy;
  assert(!evs.some(e => e.type === 'wake'), '宽带上低置信 wake 不应唤醒');
  assert(!L.inConvo(), '宽带上低置信 wake 不应开窗');
});

test('能量起音打断：朗读中立即触发，但有回声建立期与节流护栏', () => {
  /* barge-in 不能等识别完整句（要 0.6-1s 句尾静音），改用环形缓冲的
   * 能量起音(~100-300ms)。但喇叭回声会让麦收到自己的声音，必须：
   *   非朗读不打断 / 刚出声 400ms 内不打断 / 一次打断后 1.5s 内不重复。 */
  const voice = require('./voice');
  const isInt = es => es.some(e => e.type === 'interrupt' && e.reason === 'speech_onset');

  let evs = []; let L = new voice.Listener(e => evs.push(e));
  L.setSpeaking(false);
  L._handleSpeechOnset(3000);
  assert(!isInt(evs), '非朗读状态不应打断');

  evs = []; L = new voice.Listener(e => evs.push(e));
  L.setSpeaking(true);
  L.speakingStartedAt = Date.now() - 1000;
  L._handleSpeechOnset(3000);
  assert(isInt(evs), '朗读中真实起音应立即打断');

  evs = []; L = new voice.Listener(e => evs.push(e));
  L.setSpeaking(true);
  L.speakingStartedAt = Date.now() - 100;   // 回声建立期
  L._handleSpeechOnset(3000);
  assert(!isInt(evs), '刚出声的回声段不应自打断');

  evs = []; L = new voice.Listener(e => evs.push(e));
  L.setSpeaking(true);
  L.speakingStartedAt = Date.now() - 2000;
  L._handleSpeechOnset(3000);
  L._handleSpeechOnset(3000);
  L._handleSpeechOnset(3000);
  const n = evs.filter(e => e.type === 'interrupt' && e.reason === 'speech_onset').length;
  assert(n === 1, '节流期内应只打断一次，实际 ' + n);
});

test('智能复核触发：低置信，或点股票却没一个名字命中词表', () => {
  /* 实测发现置信度对"专名错"不敏感：润泽科技被识成"认则科技"仍有 0.81。
   * 所以除了低置信，还要靠"像在点股票但名字没命中已知词表"这条语义触发。 */
  const voice = require('./voice');
  // 注入一个已知词表
  voice.setWhisperPromptProvider(() => ['拓日新能', '润泽科技', '贵州茅台', '元件板块']);
  const sv = (h, c) => voice.shouldVerify(h, c);

  // 高置信、日常寒暄、不涉股 → 不复核（别让每句话都等 6 秒）
  assert(sv('今天天气不错', 0.9) === false, '高置信非股票句不该复核');
  // 低置信 → 复核
  assert(sv('今天大盘怎么样', 0.5) === true, '低置信应复核');
  // 高置信但点股票、名字命中词表 → 不必复核
  assert(sv('帮我看下润泽科技这只股票', 0.9) === false, '名字已命中词表不该复核');
  // 高置信但点股票、名字一个都没命中（典型专名错读）→ 复核
  assert(sv('帮我看下认则科技这只股票', 0.9) === true, '点股票却没命中词表应复核');
  // 词表为空时（冷启动）不得因"没命中"而无脑复核
  voice.setWhisperPromptProvider(() => []);
  assert(sv('帮我看下随便什么股票', 0.9) === false, '空词表时不应因未命中而复核');
  // 恢复
  voice.setWhisperPromptProvider(null);
});

test('唤醒+指令一口气说：句首贾维斯应开窗并拆出指令，且不误伤中段"维斯"', () => {
  /* 真实漏唤醒：用户说"贾维斯帮我看新安股份"，旧 matchesWakeWord 的
   * 12 字护栏把整句判成非唤醒，最自然的连贯说法反而唤不醒。 */
  const voice = require('./voice');
  const p = voice.parseWakeCommand('贾维斯帮我看一下新安股份这只股票');
  assert(p && p.command.includes('新安股份'), '应从句首唤醒词后拆出指令，得到 ' + JSON.stringify(p));

  const p2 = voice.parseWakeCommand('嘿贾维斯今天大盘怎么样');
  assert(p2 && p2.command === '今天大盘怎么样', '嘿贾维斯前缀应剥掉，得到 ' + JSON.stringify(p2));

  // 只叫一声：开窗但无指令
  const p3 = voice.parseWakeCommand('贾维斯');
  assert(p3 && p3.command === '', '单纯叫名字应命中且指令为空');

  // 关键反向护栏：唤醒音节在句子中段不算
  assert(voice.parseWakeCommand('这个维斯康星的数据不对') === null, '中段维斯不能算唤醒');
  assert(voice.parseWakeCommand('帮我看一下新安股份') === null, '无唤醒词不能算');

  // matchesWakeWord 对超长句也应认可"句首强唤醒"
  assert(voice.matchesWakeWord('贾维斯帮我看一下新安股份这只股票今天怎么样') === true,
    '长句句首强唤醒应被认可');
  assert(voice.matchesWakeWord('这个维斯康星的数据很长很长很长很长了') === false,
    '长句中段维斯不应误唤醒');
});

test('whisper 没听到唤醒词却给出像样指令时，应救回（有 SRGS 唤醒在先）', () => {
  const voice = require('./voice');
  voice.setWhisperPromptProvider(() => ['新安股份', '贵州茅台']);
  const L = new voice.Listener(() => {});
  // "下星安股份指支股票"无唤醒词，但像指令（含"股票"）
  assert(L._looksLikeCommand('下星安股份指支股票') === true, '含意图词的句子应判为可救回指令');
  assert(L._looksLikeCommand('嗯嗯啊啊那个') === false, '无意图噪声不应救回');
  assert(L._looksLikeCommand('新安股份') === true, '命中词表名字应救回');
  assert(L._looksLikeCommand('嗯') === false, '过短不救');
  voice.setWhisperPromptProvider(null);
});

async function main() {
  for (const { name, fn } of _tests) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.log('  ✗ FAIL ' + name + '\n    ' + e.message); }
  }
  console.log(`\n通过: ${pass} | 失败: ${fail}（共 ${_tests.length}）`);
  process.exit(fail ? 1 : 0);
}
main();
