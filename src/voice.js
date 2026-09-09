'use strict';
/**
 * 本地语音：TTS 合成 + ASR 识别（唤醒词 + 听写）
 *
 * 全部走 Windows 内置 System.Speech，离线、零成本、零第三方依赖。
 *
 * 实测能力（本机，见 STATUS.md）：
 *   TTS  Microsoft Huihui Desktop (zh-CN)  7.33s 语音仅 96ms 合成 = 0.013x 实时率
 *   ASR  MS-2052-80-DESK (zh-CN)           唤醒词 3/3 识别，置信度 >0.99
 *
 * ── 为什么用 PowerShell 子进程而不是 node 原生绑定 ──
 * System.Speech 是 .NET Framework API，node 侧要用它得引入 edge-js / node-api-dotnet
 * 之类的原生模块，而本项目的硬约束是"只有 better-sqlite3 一个依赖"。
 * PowerShell 是 Windows 自带的 .NET 宿主，用它当胶水层零新增依赖。
 *
 * ── 关键陷阱（都是实测踩到的）──
 * 1. GrammarBuilder + Choices 在 PowerShell 里会按线程 culture(en-US) 构建语法，
 *    加载到 zh-CN 识别器时报 "language does not match"。
 *    必须改用 SRGS XML 并显式写 xml:lang="zh-CN"。
 *    GrammarBuilder('', culture) 这个重载不存在，别试。
 * 2. 脚本文件必须 UTF-8 **无 BOM** 写入，否则中文变乱码。
 * 3. Grammar.Name 是**只读**属性，赋值抛 "找不到属性 Name" 并终止脚本。
 *    区分唤醒/听写两套语法要用 Grammar.RuleName：
 *    实测 SRGS(root="wake") 的 RuleName 为 'wake'，DictationGrammar 为空串。
 * 4. 生成的 PowerShell 脚本里**绝对不能写中文注释**。
 *    最小复现证实：同一段代码加一行中文注释，
 *    `New-Object ...Grammar(path)` 就返回 null（"值不能为 null，参数名: grammar"），
 *    删掉注释立刻正常 —— 全角标点会破坏 PowerShell 解析。
 *    这个坑我误判了两轮（先怀疑路径转义、又以为已删干净），
 *    最后靠 A/B/C 三段最小复现才锁定。所有中文说明只写在 JS 侧。
 * 5. 路径用 PowerShell 单引号包裹即可，单引号字符串不处理反斜杠转义，
 *    传原始 Windows 路径，只需把单引号本身写成两个。
 * 6. 唤醒词对近音词有 25% 误触发且置信度高达 0.99（见 WAKE_MIN_CONFIDENCE）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
/* 麦克风音量自愈 —— 真因是输入音量被设成 0%（-96dB 静音），
 * 每次启动监听前自动检查并修正。详见 mic_volume.js 顶部注释。 */
const micVolume = require('./mic_volume');
/* 设备质量分级 + 自适应唤醒阈值 ——
 * 用户原话「语音交互不应该挑设备」。硬编码 WAKE_MIN_CONFIDENCE=0.90
 * 在差设备上等于永久锁死唤醒功能。详见 mic_quality.js 顶部注释。 */
const micQuality = require('./mic_quality');
/* whisper 侧车 —— 系统识别器在差设备上完全不可用时的兜底。
 * 同一段音频：whisper 抓到「维斯」，系统识别器给「会为贵」conf=0.002。 */
let _whisper;
function getWhisper() {
  if (!_whisper) _whisper = require('./whisper_sidecar');
  return _whisper;
}
/* 录音 —— whisper 要原始 WAV 才能工作。
 * 注意：只能用 waveIn，绝不能用 MCI（实测 MCI 在这台机器返回假数据）。 */
let _micRec;
function getMicRec() {
  if (!_micRec) _micRec = require('./mic_record');
  return _micRec;
}

/* ══ 常驻环形缓冲（Phase 1 的核心）══
 *
 * 反应式录音有 1.6 秒启动开销，等录起来话已经说完了 ——
 * 实测 whisper 复核拿到的全是静音。
 * 改成麦克风常驻开着、最近 6 秒音频留在内存，
 * 唤醒词在触发前就已被录进缓冲，所以取得到。 */
const ringBuf = require('./mic_ring');

/* 判定"缓冲里有语音"的振幅地板。
 *
 * ⚠ 故意取得很低（不是 400 那种"正常说话"的值）。
 * 实测同一设备的灵敏度会大幅漂移：peak 从 18037 掉到 848（20倍）。
 * 这里只是要挡住**纯静音**（实测底噪 peak≈1-30），
 * 不是要判断"声音够不够大" —— 那是 whisper 的事。
 * 写死一个高阈值会让功能在灵敏度变化后静默失效。 */
const VOICE_FLOOR = 60;

const TTS_VOICE = 'Microsoft Huihui Desktop';
const ASR_CULTURE = 'zh-CN';

/* 唤醒词列表。
 *
 * 实测教训：加入越多变体，近音词误触发面越大。
 * "嘿贾维斯" / "贾维斯在吗" 这类长变体反而更安全（音节多、更难撞），
 * 单独的"贾维斯"最容易被"家维斯/假维斯/加维斯特"顶掉。 */
const WAKE_WORDS = ['贾维斯', '嘿贾维斯', '贾维斯在吗'];

/* ══════════ whisper 复核出来的文本怎么算命中唤醒词 ══════════
 *
 * whisper 在窄带音频上不会给出完美的「贾维斯」，
 * 实测它给过：「为了维斯」「为了维克维斯」「小维斯呢」「维、维、维」。
 *
 * 所以必须接受常见的同音/近音变体，否则差设备上还是唤不醒 ——
 * 那就等于 whisper 白接。
 *
 * 但**不能放得太宽**：窗口外的误唤醒会让麦克风开始收音并调模型，
 * 既是隐私问题也是花钱问题。所以只收「维斯/维希/为斯」这类
 * 确实包含核心音节的，不收单个「维」。 */
const WAKE_VARIANTS = [
  /贾维斯/, /加维斯/, /家维斯/, /嘉维斯/,
  /贾维/, /加维/, /家维/,
  /维斯/, /维希/, /为斯/, /威斯/,
  /jarvis/i,
];

/** whisper 复核文本是否算命中唤醒词 */
function matchesWakeWord(text) {
  const t = String(text || '').replace(/[\s，。、！？,.!?]/g, '');
  if (!t) return false;
  /* 太长说明是整句话，不是在叫名字 —— 避免把
   * 「这个维斯康星的数据」当成唤醒。 */
  if (t.length > 12) return false;
  return WAKE_VARIANTS.some(re => re.test(t));
}

/* whisper 复核的冷却时间。
 * 差设备上乱码事件很密集（实测 3 秒内 3 次），
 * 不设冷却会把 CPU 打满，而且 whisper 并发只会互相拖慢。 */
const WHISPER_WAKE_COOLDOWN_MS = 3000;

/* 唤醒词置信度下限。
 *
 * ⚠ 实测结论：**这个阈值几乎没用，但仍然保留**。
 * 12 条干扰语料里 3 条误触发（25%），全是近音词：
 *   "加维斯特" → 贾维斯 (0.983)
 *   "家维斯"   → 贾维斯 (0.995)
 *   "假维斯"   → 贾维斯 (0.994)
 * 置信度全部 ≥0.983，靠阈值根本挡不住。
 *
 * 但 8 条正常语句（"我们今天要开会"/"数据库连接失败了"等）**零误触发**，
 * 说明日常对话是安全的，风险只在刻意构造的近音词。
 * 阈值定 0.90 用于挡掉真正模糊的音频（远场、噪声），不指望它挡近音词。
 * 真正的防御是 WAKE_COOLDOWN_MS + 唤醒后需要后续指令才动作。
 *
 * ══════ 2026-09 改造：这个常量不再直接当阈值用 ══════
 *
 * 用户的原话：**「语音交互不应该挑设备」**。
 *
 * 硬编码 0.90 在窄带设备上等于**永久锁死唤醒功能** ——
 * 实测 HUAWEI USB-C 耳机（4kHz 电话音质）上，
 * 系统识别器对「贾维斯」只能给出 0.002-0.107，永远够不到 0.90。
 *
 * 现在阈值由 mic_quality 按实测频谱决定：
 *   宽带（3kHz 能量 ≥20%）→ 0.85，系统识别器够准
 *   中等（≥5%）           → 0.45 + whisper 二次确认
 *   窄带（<5%）           → 0.10 + whisper 二次确认
 *                            此时系统识别器只当"可能有人在说话"的触发器
 *
 * 这个常量保留为**宽带设备的上限值**和向后兼容的导出。 */
const WAKE_MIN_CONFIDENCE = 0.90;

/* 唤醒冷却：同一个唤醒词在这个窗口内只生效一次。
 * 防止一句话里的重复音节造成连续触发。 */
const WAKE_COOLDOWN_MS = 2500;

/* ══════════ 连续对话窗口 ══════════
 *
 * 为什么需要：调研 eadmin2/jarvis_ai（157★）时发现它支持连续对话，
 * 而我们每说一句都要重新喊"贾维斯" —— 这是最影响实际体验的差距。
 *
 * 实现很轻：听写语法（DictationGrammar）**本来就一直加载着**，
 * 所以不用改 PowerShell，只在 JS 侧管理一个"窗口开着"的状态：
 *   窗口内 → speech 事件当作指令
 *   窗口外 → speech 事件丢弃（否则电视声、旁人说话都会被当命令）
 *
 * 30 秒是折中：
 *   太短（<15s）→ 追问一句还得再喊唤醒词，等于没做
 *   太长（>60s）→ 变成常开麦，房间里任何对话都可能被当指令
 * 每次成功交互都续期，所以真正的连续对话不会中途断掉。 */
const CONVO_WINDOW_MS = 30000;

/* 听写置信度下限。
 *
 * 比唤醒词低得多（0.90 → 0.45），理由：
 *   唤醒词是**闭集**（3 个词），高置信度是常态，可以要求严格
 *   自由听写是**开集**，正常一句话置信度经常只有 0.5-0.7
 * 实测「帮我看看代码」这类正常指令 conf ≈ 0.72。
 * 定 0.45 用于挡纯噪声（咳嗽、键盘声会识别成极低置信度的碎词）。 */
const SPEECH_MIN_CONFIDENCE = 0.45;

/* 听写最短字数 —— 挡掉"嗯""啊""哦"这类语气词和噪声碎片。
 * 它们不是指令，但 System.Speech 会识别成单字。 */
const SPEECH_MIN_CHARS = 2;

/* ══════════ VAD（静音判定） ══════════
 *
 * System.Speech 的三个静音超时参数，之前一个都没设。
 *
 * ⚠ **我最初的判断是错的，实测纠正过来的**：
 * 我以为默认值"对念文章合适、对说指令太迟钝"，于是想调快。
 * 实测打印默认值：
 *   EndSilenceTimeout          0.15 秒   ← 比我想设的 0.6 秒快 4 倍
 *   EndSilenceTimeoutAmbiguous 0.50 秒
 *   BabbleTimeout              0（不限制）
 *   InitialSilenceTimeout      30 秒
 *
 * 所以真正的问题**不是太慢，而是太快**：
 * 0.15 秒的静音就判定"讲完了"，中文句子里的自然停顿
 * （"帮我看一下……那个代码"、"贾维斯，嗯……查个股票"）会被切成两句，
 * 后半句变成窗口内的独立指令，模型收到残句。
 *
 * 调成 0.6 秒：容忍正常语速的思考停顿，又不会让人等太久。
 * Ambiguous 给 1.0 秒 —— 识别结果本身就模糊时，多等一会儿更可能等到完整句子。
 * BabbleTimeout 从"不限制"改成 3 秒：持续噪声（电视、空调）不该无限期占着识别器。 */
const VAD_END_SILENCE_SEC = 0.6;
const VAD_END_SILENCE_AMBIGUOUS_SEC = 1.0;
const VAD_BABBLE_SEC = 3.0;

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/** UTF-8 无 BOM 写文件 —— 中文脚本必须这样写，否则 PowerShell 读成乱码 */
function writeUtf8NoBom(file, text) {
  fs.writeFileSync(file, Buffer.from(text, 'utf8'));
}

/**
 * 跑一段 PowerShell 并返回 stdout。
 * 用 -File 而不是 -Command：中文参数经命令行传递会被 codepage 破坏，
 * 写成 UTF-8 文件再执行才可靠。
 */
function runPs(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const f = path.join(TMP_DIR, `ps_${crypto.randomBytes(6).toString('hex')}.ps1`);
    writeUtf8NoBom(f, script);
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('PowerShell 超时')); }, timeoutMs);
    ps.stdout.on('data', d => out += d.toString('utf8'));
    ps.stderr.on('data', d => err += d.toString('utf8'));
    ps.on('close', code => {
      clearTimeout(timer);
      fs.unlink(f, () => {});
      if (code !== 0 && !out) reject(new Error(err.trim() || `PowerShell 退出码 ${code}`));
      else resolve(out);
    });
    ps.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/* ─────────────────────────── TTS ─────────────────────────── */

/** 朗读文本的清洗：把 Markdown / 代码块去掉，避免把符号读出来 */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '，代码略，')   // 代码块不朗读
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // 链接只留文字
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 语音合成缓存：同一句话不重复合成 */
const ttsCache = new Map();
const TTS_CACHE_MAX = 40;

/**
 * 把文本合成为 WAV，返回 { file, bytes, ms }。
 * @param {string} text 要朗读的文本
 * @param {number} rate 语速 -10..10，0 为默认
 */
async function synthesize(text, rate = 0) {
  const clean = cleanForSpeech(text);
  if (!clean) return null;

  /* 太长的文本截断。
   *
   * 实测：410 字中文朗读 = 89 秒语音（3.9MB WAV）。
   * 助手回复不该让人听一分半，超过就提示看屏幕。
   * 120 字约 25 秒，是"听得完"的合理上限。 */
  const MAX_CHARS = 120;
  const spoken = clean.length > MAX_CHARS
    ? clean.slice(0, MAX_CHARS) + '……详细内容请看屏幕。'
    : clean;

  const key = `${rate}:${spoken}`;
  const hit = ttsCache.get(key);
  if (hit && fs.existsSync(hit.file)) return hit;

  const outFile = path.join(TMP_DIR, `tts_${crypto.randomBytes(8).toString('hex')}.wav`);
  // 文本写成单独文件，避免引号/换行在脚本里转义出错
  const txtFile = outFile.replace(/\.wav$/, '.txt');
  writeUtf8NoBom(txtFile, spoken);

  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('${TTS_VOICE}') } catch { }
$s.Rate = ${Math.max(-10, Math.min(10, rate | 0))}
$txt = [System.IO.File]::ReadAllText('${txtFile.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8)
$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}')
$s.Speak($txt)
$s.Dispose()
Write-Output 'OK'
`;
  const t0 = Date.now();
  await runPs(script, 30000);
  const ms = Date.now() - t0;
  fs.unlink(txtFile, () => {});

  if (!fs.existsSync(outFile)) throw new Error('TTS 未生成文件');
  const bytes = fs.statSync(outFile).size;
  const rec = { file: outFile, bytes, ms };

  // LRU：超量时删掉最老的缓存文件
  ttsCache.set(key, rec);
  if (ttsCache.size > TTS_CACHE_MAX) {
    const oldestKey = ttsCache.keys().next().value;
    const old = ttsCache.get(oldestKey);
    ttsCache.delete(oldestKey);
    if (old && old.file !== outFile) fs.unlink(old.file, () => {});
  }
  return rec;
}

/* ─────────────────────────── ASR ─────────────────────────── */

/* SRGS 唤醒词语法。
 * 必须显式 xml:lang="zh-CN" —— GrammarBuilder 走线程 culture 会加载失败。 */
function wakeGrammarXml() {
  const items = WAKE_WORDS.map(w => `      <item>${w}</item>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<grammar version="1.0" xml:lang="${ASR_CULTURE}" root="wake"
         xmlns="http://www.w3.org/2001/06/grammar">
  <rule id="wake">
    <one-of>
${items}
    </one-of>
  </rule>
</grammar>`;
}

/**
 * 常听进程：加载唤醒词语法 + 听写语法，持续监听麦克风。
 *
 * 输出协议（每行一条 JSON，便于 node 侧流式解析）：
 *   {"type":"wake","text":"贾维斯","conf":0.99}
 *   {"type":"speech","text":"帮我看看代码","conf":0.72}
 *   {"type":"error","msg":"..."}
 *
 * 之所以让 PowerShell 常驻而不是每次重启：
 * SpeechRecognitionEngine 初始化 + 语法编译约 300-600ms，
 * 每次唤醒都重启会明显迟滞。
 */
class Listener {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ps = null;
    this.buf = '';
    this.lastWakeAt = 0;
    this.running = false;
    /* 连续对话窗口的到期时间戳（0 = 窗口关闭，需要唤醒词）。
     * 这是"连续对话"的全部状态 —— 听写语法本来就常驻，
     * 所以不用碰 PowerShell，只在这里判断该不该采纳 speech 事件。 */
    this.convoUntil = 0;
    this.speaking = false;      // 贾维斯是否正在朗读（用于打断判定）
  }

  /** 对话窗口是否开着 */
  inConvo() { return Date.now() < this.convoUntil; }

  /** 续期对话窗口 —— 每次成功交互都调，让真正的连续对话不会中途断 */
  extendConvo() { this.convoUntil = Date.now() + CONVO_WINDOW_MS; }

  /** 关闭对话窗口（用户明确说"结束"或超时） */
  closeConvo() { this.convoUntil = 0; }

  /** 告知 Listener 当前是否在朗读 —— 决定 wake 事件算打断还是新一轮 */
  setSpeaking(on) { this.speaking = !!on; }

  /**
   * ══════════ whisper 唤醒复核（差设备的救命通道）══════════
   *
   * ══ 为什么需要 ══
   * 实测：HUAWEI USB-C 耳机上说三次「贾维斯」，
   * 系统识别器**一次都没匹配上唤醒词语法**，全部走 dictation 成乱码
   * （「我有肉不」「着人我是」「不着着老者我」conf≤0.016）。
   * 原代码在这里 return，于是差设备上唤醒功能完全不存在。
   *
   * ══ 三条必须的护栏 ══
   * 1. **节流**：whisper 一次要几秒 CPU，不能每句乱码都触发。
   * 2. **不能并发**：同时跑两个 whisper 会互相拖慢到不可用。
   * 3. **必须真有语音**：whisper 在纯静音上会**编出内容**（幻觉），
   *    实测见过凭空生成「谢谢观看」。所以 sawSpeech=false 直接丢。
   */
  async _tryWhisperWake(rawText, rawConf) {
    const now = Date.now();

    /* ══ 为什么每条退出路径都要上报事件 ══
     * 第一版这些 return 全是静默的，结果真机上 whisper 复核
     * 「没有命中也没有失败」—— 我只能靠猜来定位。
     * 这正是本项目反复踩的「看起来在工作但实际没连上」。
     * 现在每条路径都留痕，代价只是几个事件。 */

    /* 护栏 1+2：节流 + 互斥。
     * 差设备上乱码事件很密集，不设节流会把 CPU 打满。 */
    if (this._whisperBusy) {
      this.onEvent({ type: 'whisper_wake_skip', why: 'busy' });
      return;
    }
    if (now - (this._lastWhisperAt || 0) < WHISPER_WAKE_COOLDOWN_MS) {
      this.onEvent({
        type: 'whisper_wake_skip', why: 'cooldown',
        waitMs: WHISPER_WAKE_COOLDOWN_MS - (now - this._lastWhisperAt),
      });
      return;
    }

    /* ══ 长度过滤：实测修正过一次 ══
     *
     * 我最初写 `length > 10 return` 想省成本，结果实测发现
     * 真实的乱码往往**很长**（识别器把 2 秒噪声拉成一长串）：
     *   「是股数着一包雕琢的报表倒让着了我」16 字
     *   「当我路过着日报道窝窝肉」        11 字
     * 结果 whisper 复核一次都没被触发 —— 过滤条件把要救的场景挡死了。
     *
     * 教训：**过滤阈值必须来自实测样本，不能凭"应该差不多"来定。** */
    if (rawText.length < 2 || rawText.length > 25) {
      this.onEvent({ type: 'whisper_wake_skip', why: 'length', len: rawText.length });
      return;
    }

    this._whisperBusy = true;
    this._lastWhisperAt = now;
    try {
      /* ══════════ Phase 1：从环形缓冲取音频，不再现场录 ══════════
       *
       * ══ 为什么改 ══
       * 旧做法是"听到疑似唤醒词才启动录音"，实测证伪：
       * 每次启动有 1.6 秒固定开销（新起 PowerShell + 编译 C#），
       *   总耗时 2600ms  实际录音 990ms  启动开销 1600ms
       * 用户说完「贾维斯」→ 识别器识别(约1s) → 才开始录音
       * → 再等 1.6s 才收音 → 话早说完了。
       * 实测拿到的全是 no_speech peak≈30（静音）。
       *
       * ══ 现在 ══
       * 麦克风常驻开着，最近 6 秒音频躺在内存里。
       * **唤醒词在触发前就已经被录进缓冲了**，所以取得到。
       * 已实测验证：事后取回的峰值与 VAD 当时检测到的一致
       * （取回 946 vs 检测 455，取回更高因为 VAD 用平滑值）。
       *
       * 取 3 秒：唤醒词约 0.8s，加上识别器的处理延迟，
       * 3 秒足够覆盖，又不会让 whisper 因为太多静音变慢
       * （实测大量静音会让耗时从 4s 涨到 24s）。 */
      const R = this.ring;
      if (!R || !R.status().running) {
        this.onEvent({ type: 'whisper_wake_skip', why: 'ring_not_running' });
        return;
      }

      const wavPath = R.dumpRecent(3000);
      if (!wavPath) {
        /* 缓冲还没攒够 3 秒 —— 刚启动时会这样，不是错误 */
        this.onEvent({ type: 'whisper_wake_skip', why: 'ring_not_filled',
          filled: R.status().filledSeconds });
        return;
      }

      /* 护栏：缓冲里没有真实语音就绝不喂给 whisper。
       * whisper 在纯静音上会**编出内容**（幻觉），
       * 实测见过凭空生成「谢谢观看」。
       *
       * 注意用相对判据 —— 麦克风灵敏度会变，
       * 实测同一设备从 peak=18037 掉到 848（差 20 倍），
       * 写死绝对阈值会让功能在灵敏度变化后静默失效。 */
      const st = R.status();
      if (!st.speaking && st.peakSmooth < VOICE_FLOOR) {
        this.onEvent({ type: 'whisper_wake_skip', why: 'no_speech',
          peak: st.peakSmooth });
        try { require('fs').unlinkSync(wavPath); } catch { }
        return;
      }

      /* 顺手更新设备质量画像 —— 有真实样本就该学习，
       * 而不是永远停在 unknown 的保守策略上。 */
      try {
        const q = micQuality.analyze(wavPath);
        if (q.hasSignal && q.grade !== 'unknown') micQuality.recordProbe(q);
      } catch { /* 分级失败不影响唤醒判定 */ }

      const w = getWhisper();
      const tr = await w.transcribe(wavPath);
      try { require('fs').unlinkSync(wavPath); } catch { }
      const heard = String((tr && tr.text) || '').trim();
      if (!heard) {
        this.onEvent({ type: 'whisper_wake_skip', why: 'empty_transcript' });
        return;
      }

      if (matchesWakeWord(heard)) {
        /* 记录一次成功观测：系统识别器当时只给了 rawConf，
         * 而 whisper 确认这**确实**是唤醒词。
         * 这些样本会把阈值压到设备真的做得到的水平 ——
         * 实测这台设备上界只有 0.107，用 0.85 等于永久锁死。 */
        try { micQuality.recordWakeOutcome(rawConf, true); } catch { }
        /* 复用正常唤醒路径的全部规则（冷却、打断、开窗口），
         * 不要在这里重写一遍 —— 两条路径行为必须一致。 */
        this._handle({ type: 'wake', text: heard, conf: 1.0, via: 'whisper' });
        this.onEvent({ type: 'wake_via_whisper', heard, rawText, rawConf });
      } else {
        /* 没命中也是有价值的观测：说明这次系统识别器的低分是对的 */
        try { micQuality.recordWakeOutcome(rawConf, false); } catch { }
        /* 没命中也要说清听到了什么 —— 否则调不准变体表。 */
        this.onEvent({ type: 'whisper_wake_miss', heard, rawText });
      }
    } catch (e) {
      /* whisper 失败不该让语音功能崩掉 —— 静默降级。
       * 但记录下来，否则又变成"看起来在工作但实际没连上"。 */
      this.onEvent({
        type: 'whisper_wake_failed',
        msg: String((e && e.message) || e).slice(0, 200),
      });
    } finally {
      this._whisperBusy = false;
      try { getMicRec().cleanup(60 * 1000); } catch { }
    }
  }


  start() {
    if (this.running) return;

    /* ══ 先修麦克风音量，再启动识别器 ══
     *
     * 实测教训：用户报「喊了贾维斯不能唤醒」，查了三轮，
     * 真因是**麦克风输入音量 = 0%（-96dB 数字静音）**。
     * 一个数字解释了所有现象：waveIn 采到 peak=1、
     * SpeechRecognitionEngine 报 AudioState=Silence、
     * 而 WAV 直接喂识别器却有 conf=0.995（绕过了音量）。
     *
     * 音量是**运行时状态**，拔插耳机/驱动更新/别的应用独占后释放
     * 都可能把它打回 0，所以每次启动监听都要检查，不能只修一次。
     *
     * 故意不 await —— 修音量要跑一个 PowerShell（约 1-2 秒），
     * 不该阻塞识别器启动；识别器起来后音量就已经修好了。
     * 失败也不阻塞：系统识别器在低音量下仍可能勉强工作。 */
    micVolume.ensureAudible().then(r => {
      if (r && r.anyFixed) {
        const d = (r.devices || []).find(x => x.fixed);
        this.onEvent({
          type: 'mic_volume_fixed',
          msg: d ? `麦克风音量已从 ${d.before}% 自动调到 ${d.after}%` : '麦克风音量已自动调高',
        });
      } else if (r && r.stillTooLow) {
        /* 明确说"是什么问题"，而不是笼统说"语音有问题" ——
         * 「报错难懂」和「没有报错」一样糟。 */
        this.onEvent({
          type: 'error',
          msg: `麦克风音量过低且无法自动修正（${r.stillTooLow.join('、')}），`
            + `请在 设置→系统→声音→输入 里手动把输入音量调到 80% 以上`,
        });
      }
    }).catch(() => { /* 修不了就算了，不阻塞语音 */ });

    /* ══ 启动常驻环形缓冲（Phase 1）══
     *
     * 必须在识别器**之前**启动，理由很实际：
     * 识别器一识别出疑似唤醒词就要取音频，
     * 那时缓冲里必须已经有料。
     *
     * 两个进程同时开麦克风是安全的 —— 已实测验证：
     * waveIn(WAVE_MAPPER) 和 SAPI SetInputToDefaultAudioDevice
     * 可以共存，互不影响采集（都是共享模式，非独占）。 */
    try {
      this.ring = new ringBuf.RingBuffer(ev => {
        if (ev.type === 'error') {
          /* 环形缓冲挂了不该让语音功能整体崩掉 —— 降级到
           * "只有系统识别器"，但必须报出来，
           * 否则又变成"看起来在工作但实际没连上"。 */
          this.onEvent({ type: 'ring_error', msg: ev.msg });
        } else if (ev.type === 'level') {
          /* 音量流给 UI 画波形用。这是常驻缓冲的额外好处：
           * 以前没有常驻采集，界面上根本画不出实时音量。 */
          this.onEvent({ type: 'mic_level', peak: ev.peak, smooth: ev.smooth });
        }
      });
      this.ring.start();
    } catch (e) {
      this.onEvent({ type: 'ring_error', msg: '环形缓冲启动失败: ' + e.message });
      this.ring = null;
    }

    const gp = path.join(TMP_DIR, 'wake.grxml');
    writeUtf8NoBom(gp, wakeGrammarXml());

    /* 注意：下面的 PowerShell 脚本里**绝对不能写中文注释**。
     * 最小复现证实：同一段代码，加一行中文注释就让
     * `New-Object ...Grammar(path)` 返回 null（报 "值不能为 null，参数名: grammar"），
     * 删掉注释立刻正常。全角标点（：、）会破坏 PowerShell 的解析。
     * 所有说明都写在这里的 JS 注释中，生成的脚本保持纯 ASCII 注释或无注释。 */
    const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$cn = [System.Globalization.CultureInfo]'${ASR_CULTURE}'
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine $cn

# wake-word grammar (SRGS)
$wake = New-Object System.Speech.Recognition.Grammar('${gp.replace(/'/g, "''")}')
$r.LoadGrammar($wake)

# free-form dictation
$dict = New-Object System.Speech.Recognition.DictationGrammar
$r.LoadGrammar($dict)

$r.SetInputToDefaultAudioDevice()

# VAD timeouts - default EndSilenceTimeout is 0.15s which cuts natural pauses in Chinese
$r.EndSilenceTimeout = [TimeSpan]::FromSeconds(${VAD_END_SILENCE_SEC})
$r.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(${VAD_END_SILENCE_AMBIGUOUS_SEC})
$r.BabbleTimeout = [TimeSpan]::FromSeconds(${VAD_BABBLE_SEC})

Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -SourceIdentifier SR | Out-Null

$r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Write-Output '{"type":"ready"}'
[Console]::Out.Flush()

# CRITICAL - must use Wait-Event here, NOT Start-Sleep.
# Start-Sleep blocks the PowerShell message pump, and SpeechRecognitionEngine
# needs it to receive audio callbacks. Measured proof:
#   while(1){ Start-Sleep }  ->  AudioLevelUpdated events = 0   (no audio at all)
#   Wait-Event loop          ->  AudioLevelUpdated events = 94  (works)
# This single line is why voice never worked.
while ($true) {
  $ev = Wait-Event -SourceIdentifier SR -Timeout 3600
  if ($ev) {
    $res = $ev.SourceEventArgs.Result
    $rule = ''
    try { $rule = $res.Grammar.RuleName } catch { }
    $kind = if ($rule -eq 'wake') { 'wake' } else { 'speech' }
    $txt = $res.Text -replace '"','\\"'
    $obj = '{"type":"' + $kind + '","text":"' + $txt + '","conf":' +
           ([math]::Round($res.Confidence,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}'
    Write-Output $obj
    [Console]::Out.Flush()
    Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue
  }
}
`;
    const f = path.join(TMP_DIR, 'listen.ps1');
    writeUtf8NoBom(f, script);
    this.ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      { windowsHide: true });
    this.running = true;

    this.ps.stdout.on('data', d => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this._handle(ev);
      }
    });
    this.ps.stderr.on('data', d => {
      const m = d.toString('utf8').trim();
      if (m) this.onEvent({ type: 'error', msg: m.slice(0, 300) });
    });
    this.ps.on('close', () => {
      this.running = false;
      this.onEvent({ type: 'stopped' });
    });
  }

  /**
   * 事件分派 —— 连续对话与打断的判定都在这里。
   *
   * ══════ 三条规则 ══════
   *
   * 1. **打断优先**：正在朗读时听到唤醒词，先发 interrupt 让上层停播。
   *    不这样做的话，唤醒词会被当成新一轮对话，而喇叭还在响，
   *    麦克风又会收到自己的声音 → 自问自答。
   *
   * 2. **窗口内的 speech 才算指令**。窗口外丢弃 ——
   *    否则电视声、旁人说话、会议内容都会被当成命令发给模型。
   *    这既是隐私问题，也是**花钱**问题（每次误触发都是一次模型调用）。
   *
   * 3. **噪声要挡在进模型之前**：置信度 + 最短字数双重过滤。
   *    "嗯""啊"和键盘声都会被 System.Speech 识别成单字。
   */
  _handle(ev) {
    if (ev.type === 'wake') {
      /* ══ 自适应阈值，不再硬编码 ══
       *
       * 用户：「语音交互不应该挑设备」。
       * 硬编码 0.90 在窄带设备上永远够不到（实测只有 0.002-0.107），
       * 等于把功能锁死。现在阈值按实测设备质量取：
       *   宽带 0.85 / 中等 0.45 / 窄带 0.10 / 未探测 0.30
       *
       * 窄带下 0.10 极低，单看置信度几乎挡不住误触发 ——
       * 所以差设备必须配 whisper 二次确认。
       * 「降低阈值」和「二次确认」是一对，不能只做前者，
       * 否则电视声、旁人说话都会唤醒（既是隐私也是花钱问题）。 */
      const policy = micQuality.currentPolicy();
      if (ev.conf < policy.wakeConf) return;

      const now = Date.now();
      if (now - this.lastWakeAt < WAKE_COOLDOWN_MS) return;
      this.lastWakeAt = now;

      /* 规则 1：朗读中被唤醒 = 打断。
       * 先让上层停掉播放，再开新一轮对话窗口。 */
      if (this.speaking) {
        this.onEvent({ type: 'interrupt', reason: 'wake_while_speaking' });
      }
      this.extendConvo();
      this.onEvent({ type: 'wake', text: ev.text, conf: ev.conf, convo: true });
      return;
    }

    if (ev.type === 'speech') {
      const text = String(ev.text || '').trim();

      // 规则 3：噪声过滤（在进模型之前，误触发就是花钱）
      if (text.length < SPEECH_MIN_CHARS) return;
      if (ev.conf != null && ev.conf < SPEECH_MIN_CONFIDENCE) {
        /* ══ 差设备上的救命通道 ══
         *
         * 实测事故：在 HUAWEI USB-C 耳机上说三次「贾维斯」，
         * 系统识别器**一次都没匹配上唤醒词语法**，
         * 而是全部走 dictation 输出成乱码：
         *   「我有肉不」   conf=0.016
         *   「着人我是」   conf=0.002
         *   「不着着老者我」conf=0.002
         *
         * 原来的代码到这里就 return 了 —— 于是差设备上唤醒功能**完全不存在**。
         * 这正是用户说的「语音交互不应该挑设备」的核心症状：
         * 不是阈值调低就能解决，而是**唤醒词语法压根匹配不上**。
         *
         * 所以：窗口未开 + 低置信 + 长度像唤醒词时，
         * 录一段音交给 whisper 复核。whisper 对窄带音频鲁棒得多
         * （同一段音频它能抓到「维斯」，系统识别器给的是「会为贵」）。
         *
         * 只在**窗口外**做这件事 —— 窗口内已经在对话，不需要再确认唤醒。 */
        if (!this.inConvo() && micQuality.currentPolicy().needWhisperConfirm) {
          this._tryWhisperWake(text, ev.conf);
          return;
        }
        /* 低置信度不是完全丢弃 —— 上报一个 low_conf 事件，
         * 让界面能显示"没听清"，比完全没反应好。
         * 但**不会**发给模型。 */
        this.onEvent({ type: 'speech_unclear', text, conf: ev.conf });
        return;
      }

      /* 规则 2：窗口外的语音直接丢弃。
       * 这里不上报事件 —— 房间里的正常对话不该在界面上刷屏。 */
      if (!this.inConvo()) return;

      /* 用户明确结束对话。识别成本极低，
       * 但能避免"说完了还开着 30 秒窗口"带来的误触发。 */
      if (/^(结束|退出|没事了|不用了|好了谢谢)$/.test(text)) {
        this.closeConvo();
        this.onEvent({ type: 'convo_end', text });
        return;
      }

      /* 朗读中说话也算打断 —— 不只唤醒词能打断。
       * 这是 barge-in 的完整形态：随时说话就能截住它。 */
      if (this.speaking) {
        this.onEvent({ type: 'interrupt', reason: 'speech_while_speaking' });
      }

      this.extendConvo();     // 成功交互 → 续期，连续对话不中断
      this.onEvent({ type: 'speech', text, conf: ev.conf, convo: true });
      return;
    }

    this.onEvent(ev);
  }

  stop() {
    if (this.ps) { this.ps.kill(); this.ps = null; }
    /* 环形缓冲也要停 —— 它持有麦克风，不释放会让下次启动拿不到设备。
     * 顺手清掉临时 WAV，别把磁盘塞满。 */
    if (this.ring) {
      try { this.ring.stop(); } catch { }
      try { this.ring.cleanup(0); } catch { }
      this.ring = null;
    }
    this.running = false;
  }
}

/** 探测本机语音能力，用于 /api/status 与启动自检 */
async function probe() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = ($s.GetInstalledVoices() | Where-Object {$_.Enabled} |
  ForEach-Object { $_.VoiceInfo.Name }) -join '|'
$s.Dispose()
$recs = ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
  ForEach-Object { $_.Id }) -join '|'
Write-Output ('{"voices":"' + $voices + '","recognizers":"' + $recs + '"}')
`;
  try {
    const out = await runPs(script, 20000);
    const line = out.split('\n').find(l => l.trim().startsWith('{'));
    const j = JSON.parse(line);
    const voices = j.voices ? j.voices.split('|') : [];
    const recs = j.recognizers ? j.recognizers.split('|') : [];
    return {
      ok: voices.length > 0,
      tts: voices.includes(TTS_VOICE) ? TTS_VOICE : (voices[0] || null),
      ttsAll: voices,
      asr: recs[0] || null,
      asrAll: recs,
      wakeWords: WAKE_WORDS,
      /* ══ 把自适应策略暴露出来 ══
       *
       * 这一整轮排查最大的时间浪费，就是**看不见服务端进程内的真实状态**：
       * 我只能靠在别的进程里 require 同一个模块来猜，
       * 而那个进程的策略是 unknown、服务端的可能已经是 wideband。
       *
       * 阈值和 whisper 兜底开关是"唤醒能不能成"的决定性变量，
       * 必须能一眼看到，否则每次都要靠猜。 */
      policy: micQuality.currentPolicy(),
    };
  } catch (e) {
    return { ok: false, error: e.message, wakeWords: WAKE_WORDS };
  }
}

module.exports = {
  synthesize, cleanForSpeech, probe, Listener,
  WAKE_WORDS, WAKE_MIN_CONFIDENCE, TTS_VOICE,
  CONVO_WINDOW_MS, SPEECH_MIN_CONFIDENCE, SPEECH_MIN_CHARS,
  VAD_END_SILENCE_SEC, VAD_BABBLE_SEC,
  /* 导出给测试用 —— whisper 复核的匹配规则是差设备能否唤醒的关键，
   * 必须能被测试锁住（太宽会误唤醒，太窄等于 whisper 白接）。 */
  matchesWakeWord, WAKE_VARIANTS, WHISPER_WAKE_COOLDOWN_MS,
};
