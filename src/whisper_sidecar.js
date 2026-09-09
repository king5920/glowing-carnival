'use strict';
/**
 * ══════════════ faster-whisper 可选旁路 ══════════════
 *
 * 调研 eadmin2/jarvis_ai（157★）后确认：我们唯一剩下的真差距是
 * **STT 识别准确率**。Windows System.Speech 对中文自由听写的准确率
 * 明显不如 faster-whisper。
 *
 * ══════ 三条铁律 ══════
 *
 * 1. **绝不自动安装。**
 *    faster-whisper 会拉 ctranslate2 + av + 模型文件（small 约 500MB，
 *    medium 约 1.5GB）。在用户没同意的情况下往他机器上装 1GB 东西、
 *    占满 C 盘、可能还要编译 —— 这是越界。
 *    只检测、只给出**用户自己复制粘贴**的安装命令。
 *
 * 2. **不可用就静默回退 System.Speech。**
 *    旁路缺失不是错误。贾维斯的核心承诺是"零额外依赖也能用"，
 *    这个模块只是让有条件的用户体验更好。
 *
 * 3. **可用性判断必须真的跑一次导入。**
 *    只查 `importlib.find_spec` 不够 —— ctranslate2 在缺 DLL 时
 *    find_spec 能找到但 import 会崩（Windows 上很常见，缺 MSVC 运行库）。
 *    所以探测时真的 import 一次。这和「假备用源比没有备用源更危险」同一原则：
 *    **报告"可用"却用不了，比报告"不可用"更糟。**
 *
 * ══════ 为什么不用官方 openai-whisper ══════
 * 它依赖 PyTorch（~2.5GB）。faster-whisper 用 CTranslate2，
 * CPU 上快 4 倍、体积小得多，中文准确率相同。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 模型大小选择。
 *
 * small 是给纯 CPU 机器的甜点：约 500MB，中文可用，实时率约 0.3-0.5x
 * （说 3 秒的话，识别约 1-1.5 秒）。
 * medium/large 准确率更高但 CPU 上太慢，会让语音交互失去意义 ——
 * 等 5 秒才出结果不如打字。
 * 可用环境变量覆盖，但默认保守。 */
/* ══════════ 领域提示词（实测效果显著） ══════════
 *
 * whisper 不认识"贾维斯"这个专有名词。实测：
 *   无提示   → "假为师帮我看一下今天的大盘情况"  conf 0.697
 *   加提示   → "贾维斯帮我看一下今天的大盘情况"  conf 0.860
 *
 * 不只修正了名字，**整句置信度从 0.70 提到 0.86**。
 * 原因：initial_prompt 会作为上文送进解码器，
 * 让模型偏向这个领域的词汇分布。
 *
 * 提示词里放了唤醒词 + 高频股票术语，因为这台机器上
 * 贾维斯主要用于量化和行情场景。
 * 不能放太长 —— prompt 占用 224 token 的上下文预算，
 * 塞满了会挤掉真正的音频上下文。 */
const INITIAL_PROMPT = process.env.JARVIS_WHISPER_PROMPT
  || '贾维斯是我的AI助手。以下是对贾维斯说的话，内容多为股票、大盘、指数、'
   + '板块、涨跌、回测、选股、因子、持仓、资金流等话题。';

const MODEL_SIZE = process.env.JARVIS_WHISPER_MODEL || 'small';

/* ══════════ HuggingFace 镜像（国内必需） ══════════
 *
 * 实测：huggingface.co 和 cdn-lfs.huggingface.co **均连接超时**，
 * 而 hf-mirror.com 可达（160.16.86.14）。
 * 首次转写会卡在下载模型然后失败 —— 报的是一大段 httpx traceback，
 * 用户根本看不出是"墙"的问题。
 *
 * 所以默认走镜像。这不是偷偷改行为 ——
 * 官方源不通的情况下，不设镜像等于功能不可用。
 * 用户想用官方源可以设 JARVIS_HF_ENDPOINT=https://huggingface.co。 */
const HF_ENDPOINT = process.env.JARVIS_HF_ENDPOINT
  || process.env.HF_ENDPOINT
  || 'https://hf-mirror.com';

/* CPU 上必须用 int8 量化，否则 small 模型也慢到不可用。
 * 实测差异约 2-3 倍。准确率损失在中文口语上几乎感知不到。 */
const COMPUTE_TYPE = process.env.JARVIS_WHISPER_COMPUTE || 'int8';

const PY_CANDIDATES = [
  process.env.JARVIS_PYTHON,
  'python',
  'python3',
  /* ⚠ 不放 'py'：实测本机 py 启动器坏了，
   * 指向一个不存在的 Accio 路径（Unable to create process）。
   * 依赖它会得到"看起来有 Python 但跑不了"的假阳性。 */
].filter(Boolean);

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-whisper');

/** 探测结果缓存 —— 每次开麦都跑一遍 Python 启动太慢（约 700ms） */
let _probeCache = null;
let _probeAt = 0;
const PROBE_TTL_MS = 5 * 60 * 1000;

/* ══════════ 常驻 Python 进程（性能的关键） ══════════
 *
 * 实测耗时拆解（6 秒音频、small/int8、纯 CPU）：
 *   import faster_whisper    1.2 秒
 *   加载 small 模型         13.1 秒   ← 70% 的时间花在这
 *   实际转写                 4.4 秒
 *   ──────────────────────────────
 *   总计                    18.7 秒
 *
 * **每次都重新加载模型是致命的** —— 说一句话等 19 秒不如打字，
 * 语音交互的全部价值就是快。
 *
 * 所以让 Python 常驻，模型只加载一次，之后每次转写只花 4-5 秒。
 * 这和 voice.js 让 PowerShell 常驻同理
 * （那里是因为 SpeechRecognitionEngine 初始化要 300-600ms）。
 *
 * 协议：stdin 送一行 JSON 请求，stdout 回一行 JSON 结果。
 * 用行分隔而非长度前缀 —— 调试时能直接看懂。 */
let _worker = null;
const WORKER_IDLE_MS = 10 * 60 * 1000;   // 闲置 10 分钟就放掉（模型占约 500MB 内存）
let _workerIdleTimer = null;

function runPy(pyExe, code, timeoutMs = 20000) {
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    let p;
    try {
      p = spawn(pyExe, ['-c', code], {
        windowsHide: true,
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: 'utf-8',
          // 别让 HuggingFace 在探测阶段偷偷下载模型
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        }),
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }

    const timer = setTimeout(() => {
      if (!done) { done = true; try { p.kill(); } catch (_) {} resolve({ ok: false, error: '探测超时' }); }
    }, timeoutMs);

    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    p.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

/**
 * 探测 faster-whisper 是否真的可用。
 *
 * 关键：**真的 import 一次**，不只查 find_spec。
 * ctranslate2 在 Windows 上缺 MSVC 运行库时 find_spec 找得到但 import 崩。
 * 报"可用"却用不了比报"不可用"更糟。
 */
async function probe(force = false) {
  if (!force && _probeCache && Date.now() - _probeAt < PROBE_TTL_MS) {
    return _probeCache;
  }

  const result = {
    available: false,
    python: null,
    pythonVersion: null,
    reason: null,
    modelSize: MODEL_SIZE,
    computeType: COMPUTE_TYPE,
    modelCached: false,
    installHint: null,
  };

  // 1) 找一个能跑的 Python
  let pyExe = null, pyVer = null;
  for (const cand of PY_CANDIDATES) {
    const r = await runPy(cand, 'import sys; print(sys.version.split()[0])', 8000);
    if (r.ok && r.stdout) { pyExe = cand; pyVer = r.stdout; break; }
  }
  if (!pyExe) {
    result.reason = '未找到可用的 Python（faster-whisper 需要 Python 3.9+）';
    result.installHint = '安装 Python 3.12 后再执行下面的 pip 命令';
    _probeCache = result; _probeAt = Date.now();
    return result;
  }
  result.python = pyExe;
  result.pythonVersion = pyVer;

  // 2) 真的 import faster_whisper（不只 find_spec）
  const impCode = [
    'import sys, json',
    'info = {}',
    'try:',
    '    from faster_whisper import WhisperModel',
    '    info["import"] = "ok"',
    '    import faster_whisper as fw',
    '    info["version"] = getattr(fw, "__version__", "unknown")',
    'except Exception as e:',
    '    info["import"] = "fail"',
    '    info["err"] = type(e).__name__ + ": " + str(e)[:200]',
    'print(json.dumps(info))',
  ].join('\n');

  const r = await runPy(pyExe, impCode, 25000);
  if (!r.ok) {
    result.reason = 'Python 执行失败: ' + ((r.stderr || r.error || '').slice(0, 200));
    _probeCache = result; _probeAt = Date.now();
    return result;
  }

  let info = {};
  try {
    const line = (r.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).pop();
    info = JSON.parse(line || '{}');
  } catch (_) {
    result.reason = '探测输出无法解析';
    _probeCache = result; _probeAt = Date.now();
    return result;
  }

  if (info.import !== 'ok') {
    /* 区分"没装"和"装了但坏了" —— 给出的建议完全不同。
     * ModuleNotFoundError → pip install
     * ImportError/OSError  → 大概率缺 MSVC 运行库或 DLL 损坏 */
    const err = info.err || '';
    if (/ModuleNotFoundError/.test(err)) {
      result.reason = 'faster-whisper 未安装';
      result.installHint = `${pyExe} -m pip install faster-whisper`;
    } else {
      result.reason = 'faster-whisper 已安装但导入失败: ' + err.slice(0, 160);
      result.installHint = 'Windows 上多为缺 Microsoft Visual C++ 运行库，'
        + '装「Microsoft Visual C++ Redistributable」后重试；'
        + `或重装：${pyExe} -m pip install --force-reinstall faster-whisper`;
    }
    _probeCache = result; _probeAt = Date.now();
    return result;
  }

  result.available = true;
  result.version = info.version || null;

  /* 3) 模型是否已缓存。
   * 没缓存时**首次调用会下载 500MB** —— 这必须提前告诉用户，
   * 不能让他在说完一句话后等 10 分钟不知道发生了什么。 */
  const hfHome = process.env.HF_HOME
    || path.join(os.homedir(), '.cache', 'huggingface');
  try {
    if (fs.existsSync(hfHome)) {
      const hit = fs.readdirSync(path.join(hfHome, 'hub'), { withFileTypes: true })
        .some(d => d.isDirectory() && d.name.includes(`whisper-${MODEL_SIZE}`));
      result.modelCached = hit;
    }
  } catch (_) { /* 目录不存在就是没缓存，不是错误 */ }

  if (!result.modelCached) {
    result.reason = `可用，但 ${MODEL_SIZE} 模型尚未下载`
      + `（首次识别会下载约 ${MODEL_SIZE === 'small' ? '500MB' : '1.5GB'}）`;
  }

  _probeCache = result; _probeAt = Date.now();
  return result;
}

/* ══════════ 常驻 worker 实现 ══════════ */

/** worker 端的 Python 脚本。模型加载一次，然后循环读 stdin。 */
function workerCode() {
  return [
    'import sys, json, math',
    'from faster_whisper import WhisperModel',
    // 模型加载放在循环外 —— 这是整个优化的核心
    `m = WhisperModel(${JSON.stringify(MODEL_SIZE)}, device="cpu", compute_type=${JSON.stringify(COMPUTE_TYPE)})`,
    'sys.stdout.write(json.dumps({"type":"ready"}) + "\\n"); sys.stdout.flush()',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line: continue',
    '    try:',
    '        req = json.loads(line)',
    '    except Exception as e:',
    '        sys.stdout.write(json.dumps({"type":"error","id":None,"err":"bad json"}) + "\\n")',
    '        sys.stdout.flush(); continue',
    '    rid = req.get("id")',
    '    if req.get("cmd") == "quit": break',
    '    try:',
    '        segs, info = m.transcribe(req["wav"], language=req.get("lang","zh"),',
    '            beam_size=req.get("beam", 1),',
    '            initial_prompt=req.get("prompt"),',
    // vad_filter is caller-controlled: Silero VAD drops short utterances
    // surrounded by silence, which silently returns empty text for wake words.
    '            vad_filter=bool(req.get("vad", True)),',
    '            vad_parameters=dict(min_silence_duration_ms=400))',
    '        parts = []; probs = []',
    '        for s in segs:',
    '            parts.append(s.text)',
    '            if getattr(s, "avg_logprob", None) is not None: probs.append(s.avg_logprob)',
    '        conf = round(math.exp(sum(probs)/len(probs)), 3) if probs else None',
    '        out = {"type":"result","id":rid,"text":"".join(parts).strip(),"conf":conf,',
    '               "lang":info.language,"langProb":round(info.language_probability,3)}',
    '    except Exception as e:',
    '        out = {"type":"error","id":rid,"err":type(e).__name__+": "+str(e)[:300]}',
    '    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\\n"); sys.stdout.flush()',
  ].join('\n');
}

/** 拿到一个 ready 的 worker（没有就启动）。失败返回 null 让调用方回退。 */
async function getWorker(pyExe) {
  if (_worker && _worker.ready && _worker.proc && !_worker.proc.killed) {
    touchWorker();
    return _worker;
  }
  if (_worker && _worker.starting) return _worker.starting;   // 并发调用复用同一次启动

  const startPromise = new Promise(resolve => {
    let proc;
    try {
      proc = spawn(pyExe, ['-u', '-c', workerCode()], {
        windowsHide: true,
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: 'utf-8',
          HF_ENDPOINT: HF_ENDPOINT,
        }),
      });
    } catch (e) {
      _worker = null;
      return resolve(null);
    }

    const w = { proc, ready: false, buf: '', pending: new Map(), seq: 0, starting: null };
    _worker = w;

    /* 启动超时给足：首次要下载模型（实测走镜像约 100 秒），
     * 之后加载模型约 13 秒。 */
    const timer = setTimeout(() => {
      if (!w.ready) { try { proc.kill(); } catch (_) {} _worker = null; resolve(null); }
    }, 600000);

    proc.stdout.on('data', d => {
      w.buf += d.toString('utf8');
      let i;
      while ((i = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, i).trim();
        w.buf = w.buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }

        if (msg.type === 'ready') {
          w.ready = true; w.starting = null;
          clearTimeout(timer);
          touchWorker();
          resolve(w);
          continue;
        }
        // 派发给对应的等待者
        const cb = w.pending.get(msg.id);
        if (cb) { w.pending.delete(msg.id); cb(msg); }
      }
    });

    proc.stderr.on('data', () => { /* 进度条等噪声，丢掉 */ });

    proc.on('close', () => {
      w.ready = false;
      // 未完成的请求全部失败，别让调用方永久挂着
      w.pending.forEach(cb => cb({ type: 'error', err: 'worker 退出' }));
      w.pending.clear();
      if (_worker === w) _worker = null;
      clearTimeout(timer);
      resolve(w.ready ? w : null);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      if (_worker === w) _worker = null;
      resolve(null);
    });
  });

  if (_worker) _worker.starting = startPromise;
  return startPromise;
}

/** 续期闲置计时器 —— 模型占约 500MB 内存，长期不用该放掉 */
function touchWorker() {
  if (_workerIdleTimer) clearTimeout(_workerIdleTimer);
  _workerIdleTimer = setTimeout(() => { stopWorker(); }, WORKER_IDLE_MS);
  // 别让这个定时器阻止 node 退出
  if (_workerIdleTimer.unref) _workerIdleTimer.unref();
}

/** 停掉常驻进程 */
function stopWorker() {
  if (_workerIdleTimer) { clearTimeout(_workerIdleTimer); _workerIdleTimer = null; }
  const w = _worker;
  _worker = null;
  if (!w || !w.proc) return;
  try { w.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (_) {}
  setTimeout(() => { try { w.proc.kill(); } catch (_) {} }, 1500).unref?.();
}

/**
 * 转写一个 WAV 文件。
 *
 * 只在 probe().available 为真时调用。
 * 失败一律返回 { ok:false }，由上层回退 System.Speech ——
 * 旁路失败不该让整个语音功能挂掉。
 */
async function transcribe(wavPath, opts = {}) {
  const p = await probe();
  if (!p.available) {
    return { ok: false, reason: p.reason, fallback: 'System.Speech' };
  }
  if (!fs.existsSync(wavPath)) {
    return { ok: false, reason: '音频文件不存在: ' + wavPath };
  }

  const w = await getWorker(p.python);
  if (!w || !w.ready) {
    return {
      ok: false,
      reason: p.modelCached
        ? 'whisper 进程启动失败'
        : `whisper 进程启动失败（首次需从 ${HF_ENDPOINT} 下载约 500MB 模型）`,
      fallback: 'System.Speech',
    };
  }

  const id = ++w.seq;
  const req = {
    id,
    wav: wavPath,
    lang: opts.lang || 'zh',
    beam: Number(opts.beamSize) || 1,      // CPU 上 beam=1 明显更快
    prompt: opts.prompt || INITIAL_PROMPT,
    /* ══ 为什么要能关掉 VAD ══
     *
     * 侧车原来无条件 vad_filter=True。实测发现这会让**唤醒词**
     * 转录**返回空字符串**：
     *   peak=12192 的清晰语音 → 「」
     *   peak= 3723            → 「」
     *   peak=  990            → 「」
     *
     * 原因：Silero VAD 会把"前后都是静音的短促发音"整段丢掉。
     * 「贾维斯」只有 0.8 秒，放在 2.5 秒片段里正好被判成噪声。
     *
     * 而且失败方式极其隐蔽 —— 不报错，只是返回空，
     * 于是我一路误判成"whisper 识别不出唤醒词，得换引擎"。
     *
     * 这正是项目里那条铁律的又一次印证：
     * **不要在成熟模型的输入端做想当然的信号处理**
     * （上一次是 pre-emphasis，同样让识别变差）。
     *
     * 唤醒词场景传 vad:false，长句听写仍可保留 VAD 去掉静音。 */
    vad: opts.vad === undefined ? true : !!opts.vad,
  };

  /* 模型已常驻，单次转写只需 4-5 秒（6 秒音频实测 4.4 秒）。
   * 给 90 秒余量应对长句和 CPU 抢占。 */
  const msg = await new Promise(resolve => {
    const timer = setTimeout(() => {
      w.pending.delete(id);
      resolve({ type: 'error', err: '转写超时' });
    }, 90000);
    w.pending.set(id, m => { clearTimeout(timer); resolve(m); });
    try { w.proc.stdin.write(JSON.stringify(req) + '\n'); }
    catch (e) {
      clearTimeout(timer); w.pending.delete(id);
      resolve({ type: 'error', err: '写入 worker 失败: ' + e.message });
    }
  });

  touchWorker();

  if (msg.type !== 'result') {
    const raw = String(msg.err || '');
    /* ══ 把 Python 报错翻译成人能看懂的原因 ══
     * 实测首次失败时是 40 行 httpx traceback，
     * 用户完全看不出是"墙"的问题。
     * 「报错难懂」和「没有报错」一样糟。 */
    let reason;
    if (/ConnectTimeout|ConnectionError|Max retries|timed out|NewConnectionError/i.test(raw)) {
      reason = `下载模型失败：连不上 ${HF_ENDPOINT}。`
        + '国内访问 huggingface.co 通常超时 —— '
        + '可设 JARVIS_HF_ENDPOINT 换镜像，或继续用系统语音。';
    } else if (/No space left|Errno 28/i.test(raw)) {
      reason = '磁盘空间不足，模型需要约 500MB。';
    } else if (/ctranslate2|DLL load failed|ImportError/i.test(raw)) {
      reason = 'ctranslate2 加载失败，Windows 上多为缺 Microsoft Visual C++ 运行库。';
    } else if (/转写超时/.test(raw)) {
      reason = '转写超时。CPU 负载过高或音频过长。';
    } else {
      reason = raw.slice(0, 200);
    }
    return { ok: false, reason, rawError: raw.slice(0, 600), fallback: 'System.Speech' };
  }

  return {
    ok: true,
    text: msg.text || '',
    conf: msg.conf,
    lang: msg.lang,
    langProb: msg.langProb,
    engine: `faster-whisper:${MODEL_SIZE}`,
  };
}

/**
 * 给用户看的状态摘要 —— 用于 /api/status 和界面提示。
 *
 * 关键：**不可用时也要说清楚为什么、怎么装**，
 * 但绝不代替用户执行安装。
 */
async function status() {
  const p = await probe();
  return {
    engine: p.available ? `faster-whisper:${p.modelSize}` : 'System.Speech',
    whisperAvailable: p.available,
    modelCached: p.modelCached,
    python: p.python,
    pythonVersion: p.pythonVersion,
    reason: p.reason,
    /* 安装命令给出来让用户自己决定 —— 这是"可选旁路"的含义。
     * 自动装 1GB 依赖是越界。 */
    installHint: p.installHint,
    note: p.available
      ? (p.modelCached ? '正在使用 faster-whisper（识别准确率高于系统语音）'
        : '已安装但模型未下载，首次识别会先下载模型')
      : ' 使用 Windows 系统语音（零依赖，准确率略低）。安装 faster-whisper 可提升准确率，'
        + '但需要约 500MB 模型文件 —— 贾维斯不会替你安装。',
  };
}

/** 清缓存 —— 用户装完后不用重启服务 */
function resetProbe() { _probeCache = null; _probeAt = 0; }

module.exports = {
  probe, transcribe, status, resetProbe, stopWorker,
  MODEL_SIZE, COMPUTE_TYPE, TMP_DIR, HF_ENDPOINT, INITIAL_PROMPT,
  WORKER_IDLE_MS,
};
