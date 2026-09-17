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

/* 动态领域提示词供给器（由 server 注入，读 db 里用户实际查过的股票名）。
 *
 * 为什么不直接 require db：voice.js 要能在不连数据库的测试里独立跑，
 * 而且每次唤醒都查库也浪费。server 启动时 setWhisperPromptProvider 注入，
 * 这里调用时做 60 秒缓存 + try/catch，任何异常都退回静态提示，
 * 绝不让"想把股票名喂准一点"反过来导致唤醒失败。 */
let _promptProvider = null;
let _promptCache = { at: 0, text: null, vocab: [] };
const PROMPT_CACHE_MS = 60000;
/* 供给器返回一个专名数组（股票/板块/龙头）；提示词拼接和"是否像没匹配上的
 * 股票名"判断都用它。 */
function setWhisperPromptProvider(fn) {
  _promptProvider = typeof fn === 'function' ? fn : null;
  // 换供给器（测试里也常换）必须立刻让旧词表缓存失效，否则 60 秒内
  // 仍按上一份词表判断"名字有没有命中"，触发条件会算错。
  _promptCache = { at: 0, text: null, vocab: [] };
}
function _getVocab() {
  const now = Date.now();
  if (_promptCache.text && now - _promptCache.at < PROMPT_CACHE_MS) return _promptCache;
  let vocab = [];
  try {
    const v = _promptProvider ? _promptProvider() : [];
    vocab = Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [];
  } catch (_) { vocab = []; }
  const base = require('./whisper_sidecar').INITIAL_PROMPT;
  const text = vocab.length ? (base + '最近可能提到的股票：' + vocab.join('、') + '。') : base;
  _promptCache = { at: now, text, vocab };
  return _promptCache;
}
function buildWhisperPrompt() {
  if (!_promptProvider) return undefined;   // undefined → sidecar 用自带静态提示
  return _getVocab().text;
}

/* 判断一次 base 转写是否"值得用 small 复核"。
 *
 * 实测：置信度对"专名错"不敏感——"认则科技"(应为润泽科技) 仍有 0.81，
 * 单纯卡 conf 阈值会漏掉真正要纠正的股票名。所以两条触发，取其一：
 *   ① 置信度低（含糊/口音/噪声）；
 *   ② 句子明显在点股票（出现"这只股/股票/板块/代码"等），但话里的名字
 *      一个都没命中已知词表 —— 很可能是专名被识别成了近音字，值得精识别。
 * 触发②要求词表非空，否则冷启动时任何句子都会被判"没命中"而白白复核。 */
const STOCK_INTENT_RE = /(股票|这只股|这只票|个股|板块|龙头|代码|股价|仓位|买入|卖出|涨停|跌停)/;
/* 判断 whisper 兜底出来的一句"没带唤醒词"的话，像不像真指令。
 * 覆盖炒股与常用操作，宁可稍宽——它只在 SRGS 唤醒已触发的前提下使用。 */
const COMMAND_INTENT_RE = new RegExp([
  '股票|这只股|这只票|个股|板块|龙头|代码|股价|仓位|买入|卖出|涨停|跌停|大盘|行情|资金|主力|北向|均线|持仓|回测|选股|基金|指数',
  '看一下|帮我|给我|查一下|查下|看看|打开|关闭|截图|播放|提醒|记一下|搜索|搜一下|跑一下|多少|怎么样|什么价|能不能|要不要',
].join('|'));
function shouldVerify(heard, conf) {
  if (!VERIFY_MODEL) return false;
  if (conf != null && conf < VERIFY_BASE_CONF) return true;
  if (STOCK_INTENT_RE.test(heard)) {
    const { vocab } = _getVocab();
    if (vocab.length && !vocab.some(name => name && heard.includes(name))) return true;
  }
  return false;
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

/* ── TTS 双引擎（Phase 25）──
 *
 * SAPI 的中文语音只有 Huihui 一个（2010 年代的拼接音，机械感来源），
 * 用户要求"多几种女声"。edge-tts（微软 Edge 在线朗读）提供 8 个
 * 实测可用的中文女声、神经音质，且零新增依赖（手写 WS，见 tts_edge.js）。
 *
 * 引擎策略：
 *   edge-tts 为主（默认晓晓，可切换），SAPI Huihui 兜底
 *   —— 断网 / token 失效 / 服务端异常都会自动降级，不打断朗读。
 */
const ttsEdge = require('./tts_edge');

/** 当前生效音色（edge-tts 体系；SAPI 兜底固定 Huihui）。 */
let currentVoice = ttsEdge.DEFAULT_VOICE;

/** 切换当前音色。input 支持音色 id / 中文名 / 拼音昵称。 */
function setTtsVoice(input) {
  const id = ttsEdge.normalizeVoice(input);
  if (!id) return { ok: false, error: `未知音色：${input}`, voices: ttsEdge.VOICES };
  currentVoice = id;
  const meta = ttsEdge.VOICES.find(v => v.id === id);
  return { ok: true, voice: id, name: meta && meta.name, region: meta && meta.region };
}

/** 当前音色状态（含兜底信息，供 probe / 工具查询）。 */
function getTtsVoice() {
  const meta = ttsEdge.VOICES.find(v => v.id === currentVoice);
  return {
    engine: 'edge-tts', voice: currentVoice,
    name: meta && meta.name, region: meta && meta.region,
    fallback: { engine: 'sapi', voice: TTS_VOICE },
  };
}

/** 全部可选音色（给工具注册 / UI 用）。 */
function listTtsVoices() {
  return ttsEdge.VOICES;
}

/** 语速数字(-10..10) → edge-tts 的百分比字符串（"+10%" / "-20%"）。 */
function rateToPct(rate) {
  const n = Math.max(-10, Math.min(10, rate | 0));
  if (n === 0) return '+0%';
  return `${n > 0 ? '+' : ''}${n * 10}%`;
}

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
   * 「这个维斯康星的数据」当成唤醒。
   * 但句首就是强唤醒词的"贾维斯，帮我看XX"一口气说法不算，
   * 那由 parseWakeCommand 单独识别并拆出指令。 */
  if (t.length > 12) return LEAD_WAKE_RE.test(t);
  return WAKE_VARIANTS.some(re => re.test(t));
}

/* 句首强唤醒：只认"贾/加/家/嘉 + 维斯/维"这类清晰的叫名，
 * 必须出现在开头（前面最多容忍语气词"喂/哎/嘿"）。
 * 故意不收裸"维斯"——那是"威斯康星/维斯坦"等词的中段，
 * 只有开头完整的"X维斯"才是在叫助手。 */
const LEAD_WAKE_RE = /^(?:喂|哎|嘿|欸)?(?:贾维斯|加维斯|家维斯|嘉维斯|贾维|加维|家维)/;

/**
 * 解析"唤醒词 + 指令"一口气说的句子，例如
 *   「贾维斯帮我看一下新安股份这只股票」
 *   「嘿贾维斯 今天大盘怎么样」
 * 命中句首强唤醒时返回 { command }，command 是剥掉唤醒词后的指令
 * （可能为空字符串，表示只是叫了一声）；否则返回 null。
 *
 * 这解决了一个真实漏唤醒：matchesWakeWord 的长度护栏(12字)把这种
 * 最自然的连贯说法整句判成"不是唤醒"，于是既没开窗、指令也丢了。
 */
function parseWakeCommand(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const compact = t.replace(/[\s，。、！？,.!?]/g, '');
  const m = compact.match(LEAD_WAKE_RE);
  if (!m) return null;
  // 去掉句首语气词 + 唤醒词，剩下的才是指令
  let rest = compact.slice(m[0].length);
  rest = rest.replace(/^(帮我|给我|那个|就是|哎|啊|嗯)+/, '');
  return { command: rest.trim() };
}

/* whisper 复核的冷却时间。
 * 差设备上乱码事件很密集（实测 3 秒内 3 次），
 * 不设冷却会把 CPU 打满，而且 whisper 并发只会互相拖慢。 */
const WHISPER_WAKE_COOLDOWN_MS = 3000;

/* 指令低置信时用更大的模型复核（智能档位切换）。
 *
 * 实测标准发音 10 句炒股口语：base 字准 92% / 1.5s，small 98% / 6.4s。
 * 为了不把每句话都拖慢 5 秒，只有 base 置信度低于此值才升级 small 复核。
 * 设环境变量 JARVIS_WHISPER_VERIFY_MODEL='' 可关闭（无大模型/纯求快时）。
 * 0.72：base 对清晰正确句子通常给 0.8+，明显含糊或专名错读会掉到 0.6 档。 */
const VERIFY_MODEL = process.env.JARVIS_WHISPER_VERIFY_MODEL != null
  ? process.env.JARVIS_WHISPER_VERIFY_MODEL.trim()
  : 'small';
const VERIFY_BASE_CONF = Number(process.env.JARVIS_WHISPER_VERIFY_CONF) || 0.72;

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
 * 15 秒（2026-09-13 从 30 秒下调，用户实测选择）：
 *   追问一句足够；更重要的是修"朗读时倒计时空跑"——
 *   现在窗口在朗读结束时才重新计时（见 setSpeaking），
 *   15 秒是"念完之后"真正能用来接话的时间，不是和朗读重叠的虚账。
 *   太长会变成常开麦，房间里任何对话都可能被当命令。
 * 每次成功交互都续期，所以真正的连续对话不会中途断掉。 */
const CONVO_WINDOW_MS = 15000;

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

/** 语音合成缓存：同一句话（含音色）不重复合成 */
const ttsCache = new Map();
const TTS_CACHE_MAX = 40;

/** 写缓存并做 LRU 淘汰（删最老的文件）。 */
function cachePut(key, rec) {
  ttsCache.set(key, rec);
  if (ttsCache.size > TTS_CACHE_MAX) {
    const oldestKey = ttsCache.keys().next().value;
    const old = ttsCache.get(oldestKey);
    ttsCache.delete(oldestKey);
    if (old && old.file !== rec.file) fs.unlink(old.file, () => {});
  }
  return rec;
}

/** SAPI 兜底引擎：PowerShell 调 System.Speech，输出 wav。 */
async function sapiSynthesize(rate, spoken, key) {
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
  try {
    await runPs(script, 30000);
  } finally {
    fs.unlink(txtFile, () => {});
  }

  if (!fs.existsSync(outFile)) throw new Error('TTS 未生成文件');
  const rec = {
    file: outFile,
    bytes: fs.statSync(outFile).size,
    ms: Date.now() - t0,
    engine: 'sapi',
    mime: 'audio/wav',
  };
  return cachePut(key, rec);
}

/**
 * 把文本合成为音频，返回 { file, bytes, ms, engine, mime }。
 * @param {string} text 要朗读的文本
 * @param {number} rate 语速 -10..10，0 为默认
 * @param {string} [voice] 指定音色（id/中文名/昵称）；缺省用当前音色 currentVoice
 */
async function synthesize(text, rate = 0, voice = null) {
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

  const vId = ttsEdge.normalizeVoice(voice) || currentVoice;
  const key = `${rate}:${vId}:${spoken}`;
  const hit = ttsCache.get(key);
  if (hit && fs.existsSync(hit.file)) return hit;

  /* 主引擎：edge-tts 神经语音（断网/异常自动降级 SAPI） */
  try {
    const t0 = Date.now();
    const buf = await ttsEdge.synthesize(spoken, {
      voice: vId,
      ratePct: rateToPct(rate),
      timeoutMs: 25000,
    });
    const outFile = path.join(TMP_DIR, `tts_${crypto.randomBytes(8).toString('hex')}.mp3`);
    fs.writeFileSync(outFile, buf.buffer);
    const rec = {
      file: outFile,
      bytes: buf.bytes,
      ms: Date.now() - t0,
      engine: 'edge-tts',
      mime: 'audio/mpeg',
    };
    return cachePut(key, rec);
  } catch (e) {
    console.warn(`[voice] edge-tts 合成失败，降级 SAPI(${TTS_VOICE})：${e.message}`);
    return sapiSynthesize(rate, spoken, key);
  }
}

/**
 * 流式语音合成：edge-tts 音频帧一到就通过 onAudio 吐出。
 *
 * 与 synthesize（整段缓冲 + 落盘 + 缓存）不同：
 *   · 不写临时文件、不进缓存 —— 流式的价值就是"早出声"，
 *     落盘再读反而把省下的延迟又加回来；
 *   · 走同一套 cleanForSpeech / 120 字截断，保证两种模式说的内容一致；
 *   · edge-tts 失败由调用方决定如何降级（端点会退回整段 SAPI），
 *     这里不自己吞错 —— 吞了调用方会以为流正常结束，浏览器干等。
 *
 * @returns {Promise<{bytes:number, engine:string, mime:string}>}
 */
async function synthesizeStream(text, rate = 0, voice = null, onAudio) {
  const clean = cleanForSpeech(text);
  if (!clean) return null;
  const MAX_CHARS = 120;
  const spoken = clean.length > MAX_CHARS
    ? clean.slice(0, MAX_CHARS) + '……详细内容请看屏幕。'
    : clean;
  const vId = ttsEdge.normalizeVoice(voice) || currentVoice;
  const r = await ttsEdge.synthesizeStream(spoken, {
    voice: vId,
    ratePct: rateToPct(rate),
    timeoutMs: 25000,
  }, onAudio);
  return { ...r, mime: 'audio/mpeg' };
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

    /* 能量起音打断（比等识别完整句早 ~0.6-1s）的状态。
     * speakingStartedAt：本次朗读开始时间，用来跳过刚出声那段
     *   （此时喇叭回声正猛，最容易自触发）。
     * onsetInterruptAt：上一次能量打断的节流时间戳。 */
    this.speakingStartedAt = 0;
    this.onsetInterruptAt = 0;
  }

  /** 对话窗口是否开着 */
  inConvo() { return Date.now() < this.convoUntil; }

  /** 续期对话窗口 —— 每次成功交互都调，让真正的连续对话不会中途断 */
  extendConvo() { this.convoUntil = Date.now() + CONVO_WINDOW_MS; }

  /** 关闭对话窗口（用户明确说"结束"或超时） */
  closeConvo() { this.convoUntil = 0; }

  /**
   * 告知 Listener 当前是否在朗读。
   *
   * 关键修复（2026-09-13）：朗读**结束**时重新开窗。
   * 之前窗口在"识别到用户说话"时就开始计时，于是贾维斯朗读的那段时间
   * （长回复能念 20+ 秒）把窗口白白耗掉，等它念完用户能接话时，
   * 30 秒只剩几秒 —— 截图里的"7 秒"就是这么来的。
   *
   * 正确语义：窗口代表"用户念完之后可以免唤醒接话的时间"，
   * 所以必须在 TTS 结束那一刻才开始走表。
   *
   * 只在"刚才确实在朗读"时续期：setSpeaking(false) 在很多路径都会调
   * （error/空音频/打断），无脑续期会让一句没出声的失败也开窗。 */
  setSpeaking(on) {
    const was = this.speaking;
    this.speaking = !!on;
    if (on) this.speakingStartedAt = Date.now();
    if (was && !on) this.convoUntil = Date.now() + CONVO_WINDOW_MS;
  }

  /**
   * 能量起音 → 朗读中即时打断。
   *
   * 为什么需要它：原来的打断要等 System.Speech 识别完整句，
   * 而识别器要先听到 0.6-1 秒的句尾静音才出结果，所以"立刻打断"做不到。
   * 环形缓冲在音量越过 400 的那一刻就回调（约 100-300ms），快得多。
   *
   * 三道防自触发（喇叭回声会让麦收到自己的声音）：
   *   1. 只在确实正在朗读时才可能打断；
   *   2. 朗读刚出声的 ECHO_SETTLE_MS 内忽略 —— 那是回声建立期，
   *      真人插话几乎不会精确卡在这 0.4 秒里；
   *   3. 节流：一次打断后 ONSET_COOLDOWN_MS 内不再触发，
   *      避免同一段人声/回声反复打断。
   * 真正"这句话是什么"仍交给随后的识别结果（wake/speech）处理，
   * 这里只负责"马上闭嘴"，不负责理解。
   */
  _handleSpeechOnset(/*peak*/) {
    if (!this.speaking) return;
    const now = Date.now();
    const ECHO_SETTLE_MS = 400;
    const ONSET_COOLDOWN_MS = 1500;
    if (now - this.speakingStartedAt < ECHO_SETTLE_MS) return;
    if (now - this.onsetInterruptAt < ONSET_COOLDOWN_MS) return;
    this.onsetInterruptAt = now;
    this.onEvent({ type: 'interrupt', reason: 'speech_onset' });
  }

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
    const heard = await this._whisperFromRing(rawText, 'wake');
    if (heard == null) return;   // 跳过/失败路径已在 helper 内上报

    /* 优先处理"贾维斯，帮我看XX"这种唤醒词+指令一口气说的句子。
     * 不这样的话，matchesWakeWord 的长度护栏会把整句判成非唤醒，
     * 用户最自然的说法反而既唤不醒也丢了指令。 */
    const pc = parseWakeCommand(heard);
    if (pc) {
      try { micQuality.recordWakeOutcome(rawConf, true); } catch { }
      // 先开窗
      this._handle({ type: 'wake', text: '贾维斯', conf: 1.0, via: 'whisper_lead' });
      this.onEvent({ type: 'wake_via_whisper', heard, rawText, rawConf, lead: true });
      // 剥出的指令若足够长，紧接着当指令下发，省得用户再重复一遍
      const cmd = pc.command;
      if (cmd && cmd.length >= 2) {
        this.onEvent({ type: 'speech_via_whisper', heard: cmd, rawText: heard, rawConf, lead: true });
        this._handle({ type: 'speech', text: cmd, conf: 1.0, convo: true, via: 'whisper_lead' });
      }
      return;
    }

    if (matchesWakeWord(heard)) {
      try { micQuality.recordWakeOutcome(rawConf, true); } catch { }
      this._handle({ type: 'wake', text: heard, conf: 1.0, via: 'whisper' });
      this.onEvent({ type: 'wake_via_whisper', heard, rawText, rawConf });
    } else if (this._looksLikeCommand(heard)) {
      /* SRGS 唤醒语法已经撞过一次（本函数就是被它低置信触发的），
       * 只是 whisper 没把"贾维斯"转出来、却转出了一句完整指令 ——
       * 实测案例：用户说"贾维斯帮我看新安股份"，whisper 给
       * "下星安股份指支股票"，里面没有"维斯"。
       *
       * 旧逻辑到这里就判 wake_miss 丢掉，既没开窗指令也没了。
       * 既然有 SRGS 唤醒信号在先、whisper 又给了像样的指令，
       * 就信任这是"唤醒+一口气指令"，开窗并下发。
       * _looksLikeCommand 足够保守，避免把电视声当唤醒。 */
      try { micQuality.recordWakeOutcome(rawConf, true); } catch { }
      this._handle({ type: 'wake', text: '贾维斯', conf: 1.0, via: 'whisper_cmd_recover' });
      this.onEvent({ type: 'wake_via_whisper', heard, rawText, rawConf, recovered: true });
      this.onEvent({ type: 'speech_via_whisper', heard, rawText, rawConf, recovered: true });
      this._handle({ type: 'speech', text: heard, conf: 1.0, convo: true, via: 'whisper_cmd_recover' });
    } else {
      try { micQuality.recordWakeOutcome(rawConf, false); } catch { }
      this.onEvent({ type: 'whisper_wake_miss', heard, rawText });
    }
  }

  /**
   * whisper 没听到唤醒词，但给了一段文本 —— 判断它像不像"指令"。
   *
   * 用在"SRGS 唤醒语法已低置信触发、whisper 兜底"的场景：
   * 有唤醒在先的信号，这里宁可宽松一点救回连贯说法，
   * 但仍要过滤明显的乱码/噪声：
   *   · 长度 4~25（太短可能是噪声，超长不像一句话指令）；
   *   · 命中常见的操作/行情意图词，或句中出现已知专名词表里的名字。
   */
  _looksLikeCommand(text) {
    const t = String(text || '').replace(/[\s，。、！？,.!?]/g, '');
    if (t.length < 4 || t.length > 25) return false;
    if (COMMAND_INTENT_RE.test(t)) return true;
    const { vocab } = (typeof _getVocab === 'function') ? _getVocab() : { vocab: [] };
    return vocab.some(name => name && t.includes(name));
  }

  /**
   * ══════════ whisper 指令复核（对话窗口内的救命通道）══════════
   *
   * ══ 这是 2026-09-11 修的真 bug ══
   * 用户在网页点麦克风，能被唤醒（唤醒词走 _tryWhisperWake 救活了），
   * 但接着说指令时界面永远显示「没听清」。根因：
   *   窄带麦上 System.Speech 对自由听写也只给 conf 0.0x-0.3，
   *   而 _handle 里 whisper 兜底**只在窗口外**触发（`!inConvo()`）；
   *   一旦进了对话窗口，低置信指令直接 speech_unclear，从不问 whisper。
   * 于是"能叫醒、不能下命令"。
   *
   * 修法：窗口内低置信时同样从环形缓冲取音交给 whisper，
   * 识别出像样的句子就当指令下发（conf 记 1.0，标记 via:whisper）。
   * 噪声防护沿用同一套：忙/冷却互斥、长度区间、峰值地板、
   * 且必须仍在对话窗口内（防止窗口早关后补一句电视声进来）。
   */
  async _tryWhisperCommand(rawText, rawConf) {
    const wasInConvo = this.inConvo();
    const heard = await this._whisperFromRing(rawText, 'command');
    if (heard == null) return;

    /* 复核耗时约 0.5-1s，期间窗口可能刚好到期 —— 以发起时在窗口内为准，
     * 但内容若像唤醒词则交回唤醒逻辑，不在这里硬当指令。 */
    if (matchesWakeWord(heard)) {
      this._handle({ type: 'wake', text: heard, conf: 1.0, via: 'whisper_cmd' });
      this.onEvent({ type: 'wake_via_whisper', heard, rawText, rawConf });
      return;
    }
    if (!wasInConvo) {
      this.onEvent({ type: 'whisper_cmd_skip', why: 'convo_closed', heard });
      return;
    }
    this.onEvent({ type: 'speech_via_whisper', heard, rawText, rawConf });
    /* 走统一处理：会做结束词/打断/续期并发 speech 事件给模型 */
    this._handle({ type: 'speech', text: heard, conf: 1.0, convo: true, via: 'whisper' });
  }

  /**
   * 从环形缓冲取最近音频跑 whisper，返回识别文本；
   * 各种跳过/失败返回 null 并已上报对应事件。wake/command 共用。
   */
  async _whisperFromRing(rawText, kind) {
    const now = Date.now();
    const skipEvt = 'whisper_' + kind + '_skip';
    const failEvt = 'whisper_' + kind + '_failed';

    if (this._whisperBusy) { this.onEvent({ type: skipEvt, why: 'busy' }); return null; }
    if (now - (this._lastWhisperAt || 0) < WHISPER_WAKE_COOLDOWN_MS) {
      this.onEvent({ type: skipEvt, why: 'cooldown',
        waitMs: WHISPER_WAKE_COOLDOWN_MS - (now - this._lastWhisperAt) });
      return null;
    }
    /* 长度过滤区间沿用唤醒复核的实测结论：真实乱码可能很长（见下）。 */
    if (rawText.length < 2 || rawText.length > 25) {
      this.onEvent({ type: skipEvt, why: 'length', len: rawText.length });
      return null;
    }

    this._whisperBusy = true;
    this._lastWhisperAt = now;
    let wavPath = null;
    try {
      const R = this.ring;
      if (!R || !R.status().running) { this.onEvent({ type: skipEvt, why: 'ring_not_running' }); return null; }
      wavPath = R.dumpRecent(3000);
      if (!wavPath) {
        this.onEvent({ type: skipEvt, why: 'ring_not_filled', filled: R.status().filledSeconds });
        return null;
      }
      const st = R.status();
      if (!st.speaking && st.peakSmooth < VOICE_FLOOR) {
        this.onEvent({ type: skipEvt, why: 'no_speech', peak: st.peakSmooth });
        return null;
      }
      try {
        const q = micQuality.analyze(wavPath);
        if (q.hasSignal && q.grade !== 'unknown') micQuality.recordProbe(q);
      } catch { }

      const tr = await getWhisper().transcribe(wavPath, { vad: false, prompt: buildWhisperPrompt() });
      if (!tr || !tr.ok) { this.onEvent({ type: failEvt, reason: tr && tr.reason }); return null; }
      let heard = String(tr.text || '').trim();
      if (!heard) { this.onEvent({ type: skipEvt, why: 'empty_transcript' }); return null; }

      /* 策略：默认走快的 base；当结果可疑时才用 small 对同一段音频复核。
       *   · 指令轮：低置信，或像在点股票却没一个名字命中词表；
       *   · 唤醒轮：whisper 没听到唤醒词、却转出一句像指令的整句
       *     （"贾维斯帮我看新安股份"被转成"下星安股份指支股票"）——
       *     这种要拿去救回连贯说法，专名又错了，值得 small 精识别。
       * 单纯叫名字的唤醒不复核，没必要为开窗等约 6 秒。
       *
       * 代价透明：复核期间前端显示"正在仔细辨认…"；
       * 失败/超时一律沿用 base 结果，绝不为追求准确率把交互卡死。 */
      const wakeCommandLike = kind === 'wake' && !matchesWakeWord(heard)
        && this._looksLikeCommand(heard);
      if (((kind === 'command' && shouldVerify(heard, tr.conf)) || wakeCommandLike)) {
        try {
          this.onEvent({ type: 'whisper_verifying', base: heard, baseConf: tr.conf });
          const tV = Date.now();
          const tr2 = await getWhisper().transcribe(wavPath, {
            vad: false, model: VERIFY_MODEL, prompt: buildWhisperPrompt(),
          });
          if (tr2 && tr2.ok && String(tr2.text || '').trim()) {
            heard = String(tr2.text).trim();
            this.onEvent({ type: 'whisper_verified', heard, model: VERIFY_MODEL,
              baseConf: tr.conf, ms: Date.now() - tV });
          }
        } catch (_) { /* 复核失败就用 base 结果 */ }
      }

      return heard;
    } catch (e) {
      this.onEvent({ type: failEvt, msg: String((e && e.message) || e).slice(0, 200) });
      return null;
    } finally {
      this._whisperBusy = false;
      if (wavPath) { try { require('fs').unlinkSync(wavPath); } catch { } }
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
        } else if (ev.type === 'speaking') {
          /* 能量起音：只要有人开口（smooth 越过 400）就触发。
           * 比"识别完整句"早 ~0.6-1 秒 —— 朗读中用它做即时打断，
           * 不用等 EndSilence 走完。是否真打断由 _handleSpeechOnset 把关。 */
          this._handleSpeechOnset(ev.peak);
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
      if (ev.conf < policy.wakeConf) {
        /* ══ 低置信的"唤醒语法命中"也要走 whisper 复核 ══
         *
         * 2026-09-13 修的漏唤醒 bug：
         * System.Speech 对同一句话只会给**一个**结果 —— 要么命中 SRGS
         * 唤醒语法(type=wake)，要么走听写(type=speech)，不会两个都给。
         * 窄带麦上唤醒语法偶尔会"撞上"，但 conf 只有 0.0x（够不到
         * wakeConf 0.10）。原代码在这里直接 return，而同一句话又不会
         * 再产生 speech 事件 —— 于是 whisper 救命通道（在 speech 分支里）
         * **永远没机会跑**，表现为"喊了没反应"。
         *
         * 现在：低置信 wake 命中，和低置信 speech 一样送 whisper 复核。
         * 只在窗口外做（窗口内不需要再确认唤醒），并复用同一套节流，
         * 不会因为"语法撞上"就额外放大误唤醒。 */
        if (!this.inConvo() && policy.needWhisperConfirm) {
          this._tryWhisperWake(ev.text || '贾维斯', ev.conf);
        }
        return;
      }

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
         * 只在**窗口外**做这件事 —— 窗口内已经在对话，不需要再确认唤醒。
         *
         * ══ 2026-09-11：窗口内也要救（修"能唤醒却下不了指令"）══
         * 窄带麦上唤醒被 whisper 救活后，接着说的指令在窗口内同样只有
         * conf 0.0x，原来直接 speech_unclear，界面就一直「没听清」。
         * 现在窗口内走 _tryWhisperCommand，把 whisper 识别句当指令下发。 */
        if (micQuality.currentPolicy().needWhisperConfirm) {
          if (this.inConvo()) {
            /* 复核要 0.5-1s，先让界面显示"在辨认"而非干等 */
            this.onEvent({ type: 'whisper_rescuing', phase: 'command' });
            this._tryWhisperCommand(text, ev.conf);
          } else {
            this._tryWhisperWake(text, ev.conf);
          }
          return;
        }
        /* 低置信度不是完全丢弃 —— 上报一个 low_conf 事件，
         * 让界面能显示"没听清"，比完全没反应好。
         * 但**不会**发给模型。 */
        this.onEvent({ type: 'speech_unclear', text, conf: ev.conf });
        return;
      }

      /* 规则 2：窗口外的语音直接丢弃。
       * 这里不上报事件 —— 房间里的正常对话不该在界面上刷屏。
       *
       * ══ 新增 fallback：dictation 中也可能包含唤醒词 ══
       * 实测这台设备上 System.Speech 的唤醒词语法几乎匹配不上
       * （conf 0.002-0.107），但 dictation 模式能抓到内容。
       * 如果文本里包含唤醒词，不要静默丢弃 —— 当作 wake 处理。 */
      if (!this.inConvo()) {
        if (matchesWakeWord(text)) {
          this.onEvent({ type: 'wake', text, conf: ev.conf || 0.5, convo: true, via: 'dictation_fallback' });
          return;
        }
        return;
      }

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

  /**
   * 停止监听。返回 Promise —— 环形缓冲的子进程确实退出后才 resolve。
   *
   * 为什么要 await（2026-09-09 实测）：ring.stop() 内部是异步的，
   * 老代码同步调完就立刻 cleanup(0) 删临时文件，
   * 此时子进程还活着、还可能在写；更糟的是主进程若紧接着退出，
   * 子进程变孤儿并锁住 ringmic.exe，下次重编译直接失败（CS0016）。
   * 清理必须排在子进程确实死掉之后。
   */
  async stop() {
    if (this.ps) { this.ps.kill(); this.ps = null; }
    /* 环形缓冲也要停 —— 它持有麦克风，不释放会让下次启动拿不到设备。 */
    if (this.ring) {
      const r = this.ring;
      this.ring = null;
      try { await r.stop(); } catch { }
      /* 顺手清掉临时 WAV，别把磁盘塞满。必须在子进程退出后做。 */
      try { r.cleanup(0); } catch { }
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
  synthesize, synthesizeStream, cleanForSpeech, probe, Listener,
  WAKE_WORDS, WAKE_MIN_CONFIDENCE, TTS_VOICE,
  CONVO_WINDOW_MS, SPEECH_MIN_CONFIDENCE, SPEECH_MIN_CHARS,
  VAD_END_SILENCE_SEC, VAD_BABBLE_SEC,
  /* 导出给测试用 —— whisper 复核的匹配规则是差设备能否唤醒的关键，
   * 必须能被测试锁住（太宽会误唤醒，太窄等于 whisper 白接）。 */
  matchesWakeWord, WAKE_VARIANTS, WHISPER_WAKE_COOLDOWN_MS,
  /* "贾维斯，帮我看XX"一口气说法的解析（唤醒+指令连说） */
  parseWakeCommand, LEAD_WAKE_RE,
  /* TTS 双引擎：音色切换状态与列表（供 set_tts_voice 工具 / probe 使用） */
  setTtsVoice, getTtsVoice, listTtsVoices, rateToPct,
  /* 动态 whisper 领域提示词（注入用户实际查过的股票名，提高专名识别） */
  setWhisperPromptProvider,
  /* 复核判定（测试锁阈值与"点股票却没命中词表"两条触发） */
  shouldVerify, VERIFY_MODEL, VERIFY_BASE_CONF,
};
