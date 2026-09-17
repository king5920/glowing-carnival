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

/* ══════════ 模型档位选择（2026-09-09 本机实测） ══════════
 *
 * 曾经默认 small，注释里写"实时率约 0.3-0.5x，说 3 秒识别 1-1.5 秒"——
 * **那是推测，不是实测。** 真跑一遍：small 识别 4.8 秒音频要 4.9 秒，
 * 实时率 1.0x，短句 1.4 秒音频也要 3.2 秒。等 5 秒才出结果，不如打字。
 *
 * 三档实测对比（20 核 CPU / int8 / beam=1 / 各 5 次取中位数）：
 *
 *   档位   体积    短句1.4s  中句4.8s  长句5.9s   准确率
 *   tiny    75MB     0.31s     0.68s     0.68s   ✗ "假维斯"/"确然正常"/"四百零八"
 *   base   145MB     1.00s     1.15s     1.17s   ✓ 全对
 *   small  484MB     3.16s     5.00s     4.90s   ✓ 全对
 *
 * **base 是甜点：准确率和 small 打平，速度快 4.5 倍。**
 * tiny 便宜但听不懂专有名词（连 initial_prompt 都救不回来），不可用。
 *
 * ⚠ 别用 cpu_threads 调优：实测 4/8/16 线程无差异（5~6 秒），
 *   瓶颈不在并行度。也别指望关 temperature fallback ——
 *   logprob -0.13 很健康，本来就没触发 fallback。
 *
 * ⚠ 基准测试必须取中位数、多次采样：本机后台常驻浏览器/微信/管家，
 *   CPU 实时占用 30-40%，单次测量会在 2s~8s 之间乱跳，
 *   足以让你得出三个互相矛盾的错误结论（我全踩了一遍）。
 *   另：Win32_Processor.LoadPercentage 报 16% 是平均值假象，
 *   要用 Get-Counter '\Processor(_Total)\% Processor Time' 才准。
 *
 * 可用 JARVIS_WHISPER_MODEL 覆盖（tiny/base/small/medium/large-v3）。 */
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
 * ══ 2026-09-09 修正：只放股票词是个偏科的提示 ══
 *
 * 旧提示只列了行情术语，结果**操作类命令被带偏**。
 * 实测同一句"打开浏览器"（base 模型）：
 *   旧提示(纯股票)  → "打开流软器"    logprob -0.317  ✗
 *   新提示(+操作词) → "打开浏览器"    logprob -0.092  ✓
 *   无提示          → "打開流冷氣"    logprob -0.704  ✗✗
 *
 * 提示词是**先验分布**，不是词表：给了股票先验，模型就用股票的
 * 音素组合去猜所有词。所以必须覆盖真实使用的两类场景。
 *
 * ⚠ 别用 beam_size 救：实测 beam=3/5 结果与 beam=1 完全相同，
 *   只多花 100-250ms。提示词修好了就不需要加 beam。
 *
 * 不能放太长 —— prompt 占用 224 token 的上下文预算，
 * 塞满了会挤掉真正的音频上下文。当前约 90 字，还有余量。 */
const INITIAL_PROMPT = process.env.JARVIS_WHISPER_PROMPT
  || '贾维斯是我的AI助手。以下是对贾维斯说的话，可能是操作指令，'
   + '如打开浏览器、关闭窗口、截图、播放音乐、设置提醒、记一下、搜索、跑一下、查一下；'
   + '也可能是行情话题，如股票、沪深300、上证指数、大盘、板块、涨跌、'
   + '回测、选股、因子、持仓、资金流。';

const MODEL_SIZE = process.env.JARVIS_WHISPER_MODEL || 'base';

/* 各档模型体积（MB），用于给用户一个准确的下载预期。
 * 之前代码里写死"small=500MB，其它=1.5GB"，base 会被误报成 1.5GB。 */
const MODEL_MB = {
  tiny: 75, base: 145, small: 484, medium: 1530, 'large-v3': 3090,
};

/* ══════════ 本地模型目录（离线兜底） ══════════
 *
 * huggingface_hub 下载在某些环境下会失败但**不抛错**，
 * 只留下一个 0 字节的 model.bin，下次加载报
 * "File model.bin is incomplete" —— 又一个「假的可用」。
 * 实测两种失败：
 *   ① Xet CAS 后端 401（hf-mirror 不支持 Xet 协议，需 HF_HUB_DISABLE_XET=1）
 *   ② 沙箱/权限拦截文件落盘（SHFileOperationW 0x2）
 *
 * 所以支持一个本地目录：若 <LOCAL_MODEL_DIR>/<档位>/model.bin 存在且非空，
 * 直接把目录路径传给 WhisperModel，完全跳过 hub。
 * 手工准备（镜像直连可用，实测 200 OK）：
 *   curl -L -o model.bin https://hf-mirror.com/Systran/faster-whisper-base/resolve/main/model.bin
 *   同目录另需 config.json / tokenizer.json / vocabulary.txt */
const LOCAL_MODEL_DIR = process.env.JARVIS_WHISPER_MODEL_DIR
  || path.join(os.homedir(), '.cache', 'jarvis-whisper');

/** 找本地模型目录；没有或不完整就返回 null（让调用方走 hub）。 */
function localModelPath(size = MODEL_SIZE) {
  try {
    const dir = path.join(LOCAL_MODEL_DIR, size);
    const bin = path.join(dir, 'model.bin');
    /* 必须查大小 —— 0 字节残骸是下载失败的典型产物，
     * 只判断 existsSync 会当成"已就绪"然后在加载时炸。 */
    if (fs.statSync(bin).size < 1024 * 1024) return null;
    for (const f of ['config.json', 'tokenizer.json', 'vocabulary.txt']) {
      if (!fs.existsSync(path.join(dir, f))) return null;
    }
    return dir;
  } catch { return null; }
}

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
  /* 本机实测（2026-09-10）：PATH 里的 python/python3 全指向 qianfan 沙箱
   * 的隔离环境（无 faster-whisper），py 启动器损坏（指向不存在的 Accio 路径）。
   * 语音识别专用 venv（uv 托管，可重建）：C:/Users/99904/jarvis-whisper-venv
   * probe 只测"第一个能跑的 Python"，所以本机必须把 venv 放最前，
   * 否则会先命中沙箱 python 而误报"faster-whisper 未安装"。
   * 其它机器上该路径不存在时 spawn 失败会顺延到 python/python3，不影响可移植性。 */
  'C:/Users/99904/jarvis-whisper-venv/Scripts/python.exe',
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
 * 用行分隔而非长度前缀 —— 调试时能直接看懂。
 *
 * 多档位：_workers 按 size 各管一个常驻进程。
 *   base 是默认的快通道（~1.5s/句，常驻）；
 *   small 是"复核"通道（~6s/句，准但慢），按需启动，
 *   只在 base 结果可疑时才用，且不阻塞主交互。 */
const _workers = new Map();   // size -> worker 对象
const WORKER_IDLE_MS = 10 * 60 * 1000;   // 闲置 10 分钟就放掉（模型常驻内存）
let _worker = null;           // 指向当前 base worker（兼容旧引用/状态展示）
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

  /* 3) 模型是否已就绪。
   * 没就绪时**首次调用会下载**（base 约 145MB，small 约 484MB）——
   * 这必须提前告诉用户，不能让他在说完一句话后等 10 分钟不知道发生了什么。
   *
   * 两个来源：本地目录（离线兜底，优先）> HF hub 缓存。 */
  const local = localModelPath();
  if (local) {
    result.modelCached = true;
    result.modelPath = local;
    result.modelSource = '本地目录';
  } else {
    const hfHome = process.env.HF_HOME
      || path.join(os.homedir(), '.cache', 'huggingface');
    try {
      /* ⚠ 不能只看目录名存在。两个坑：
       *   ① includes('whisper-base') 会误命中 whisper-base.en，必须精确匹配
       *   ② 下载失败会留 0 字节 model.bin，目录在但模型是废的 ——
       *      报"已缓存"然后加载时炸，正是「假的可用」 */
      const hubDir = path.join(hfHome, 'hub');
      const want = `models--Systran--faster-whisper-${MODEL_SIZE}`;
      const hit = fs.readdirSync(hubDir, { withFileTypes: true })
        .find(d => d.isDirectory() && d.name === want);
      if (hit) {
        const snapRoot = path.join(hubDir, hit.name, 'snapshots');
        const ok = fs.readdirSync(snapRoot).some(s => {
          try {
            return fs.statSync(path.join(snapRoot, s, 'model.bin')).size > 1024 * 1024;
          } catch { return false; }
        });
        result.modelCached = ok;
        if (hit && !ok) result.modelBroken = true;
        result.modelSource = ok ? 'HF 缓存' : null;
      }
    } catch (_) { /* 目录不存在就是没缓存，不是错误 */ }
  }

  if (!result.modelCached) {
    const mb = MODEL_MB[MODEL_SIZE] || '未知大小';
    result.reason = result.modelBroken
      ? `${MODEL_SIZE} 模型缓存已损坏（model.bin 为空，下载中断）`
        + `，请删除 ~/.cache/huggingface/hub/models--Systran--faster-whisper-${MODEL_SIZE} 后重试`
      : `可用，但 ${MODEL_SIZE} 模型尚未下载（首次识别会下载约 ${mb}MB）`;
  }

  _probeCache = result; _probeAt = Date.now();
  return result;
}

/* ══════════ 常驻 worker 实现 ══════════ */

/** worker 端的 Python 脚本。模型加载一次，然后循环读 stdin。
 * modelRef：加载哪个模型（本地目录路径或档位名）。 */
function workerCode(modelRef) {
  return [
    'import sys, json, math',
    'from faster_whisper import WhisperModel',
    // 模型加载放在循环外 —— 这是整个优化的核心
    /* 有本地模型目录就传目录路径，完全跳过 hub 下载；
     * 否则传档位名（"base"），由 faster-whisper 自己去 hub 拉。 */
    `m = WhisperModel(${JSON.stringify(modelRef)}, device="cpu", compute_type=${JSON.stringify(COMPUTE_TYPE)})`,
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

/** 拿到一个 ready 的 worker（没有就启动）。失败返回 null 让调用方回退。
 * @param {string} pyExe python 可执行
 * @param {string} size  模型档位（base/small/...） */
async function getWorker(pyExe, size = MODEL_SIZE) {
  const existing = _workers.get(size);
  if (existing && existing.ready && existing.proc && !existing.proc.killed) {
    touchWorker(size);
    return existing;
  }
  if (existing && existing.starting) return existing.starting;   // 并发复用同一次启动

  const modelRef = localModelPath(size) || size;
  const startPromise = new Promise(resolve => {
    let proc;
    try {
      proc = spawn(pyExe, ['-u', '-c', workerCode(modelRef)], {
        windowsHide: true,
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: 'utf-8',
          HF_ENDPOINT: HF_ENDPOINT,
          /* 必须禁 Xet：hf-mirror 不支持 Xet CAS 协议，
           * 走 Xet 会拿到 401 Unauthorized 并留下 0 字节 model.bin。 */
          HF_HUB_DISABLE_XET: '1',
        }),
      });
    } catch (e) {
      _workers.delete(size);
      return resolve(null);
    }

    const w = { proc, size, ready: false, buf: '', pending: new Map(), seq: 0, starting: null };
    _workers.set(size, w);
    if (size === MODEL_SIZE) _worker = w;

    /* 启动超时给足：首次要下载模型（实测走镜像约 100 秒），
     * 之后加载模型约 13 秒（small 更久）。 */
    const timer = setTimeout(() => {
      if (!w.ready) {
        try { proc.kill(); } catch (_) {}
        _workers.delete(size);
        if (_worker === w) _worker = null;
        resolve(null);
      }
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
          touchWorker(size);
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
      _workers.delete(size);
      if (_worker === w) _worker = null;
      clearTimeout(timer);
      resolve(w.ready ? w : null);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      _workers.delete(size);
      if (_worker === w) _worker = null;
      resolve(null);
    });
  });

  const w0 = _workers.get(size);
  if (w0) w0.starting = startPromise;
  return startPromise;
}

/** 续期闲置计时器 —— 模型常驻内存，长期不用该放掉。
 * small 复核 worker 用更短的闲置时间（它大、又不常用）。 */
function touchWorker(size = MODEL_SIZE) {
  if (size !== MODEL_SIZE) {
    const w = _workers.get(size);
    if (w) {
      if (w.idleTimer) clearTimeout(w.idleTimer);
      w.idleTimer = setTimeout(() => stopWorker(size), 2 * 60 * 1000);
      if (w.idleTimer.unref) w.idleTimer.unref();
    }
    return;
  }
  if (_workerIdleTimer) clearTimeout(_workerIdleTimer);
  _workerIdleTimer = setTimeout(() => { stopWorker(MODEL_SIZE); }, WORKER_IDLE_MS);
  if (_workerIdleTimer.unref) _workerIdleTimer.unref();
}

/** 停掉常驻进程（默认停 base；可指定档位） */
function stopWorker(size = MODEL_SIZE) {
  if (size === MODEL_SIZE && _workerIdleTimer) {
    clearTimeout(_workerIdleTimer); _workerIdleTimer = null;
  }
  const w = _workers.get(size);
  if (!w) return;
  _workers.delete(size);
  if (_worker === w) _worker = null;
  if (w.idleTimer) clearTimeout(w.idleTimer);
  if (!w.proc) return;
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

  const size = opts.model || MODEL_SIZE;
  const w = await getWorker(p.python, size);
  if (!w || !w.ready) {
    return {
      ok: false,
      reason: p.modelCached
        ? 'whisper 进程启动失败'
        : `whisper 进程启动失败（首次需从 ${HF_ENDPOINT} 下载约 ${MODEL_MB[size] || '?'}MB 模型）`,
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
    } else if (/model\.bin is incomplete|failed to read a value of size/i.test(raw)) {
      /* 实测：下载中断留下 0 字节 model.bin，之后每次加载都报这个。
       * 关键是必须告诉用户「删掉重下」，否则他会以为是模型不兼容。 */
      reason = `${MODEL_SIZE} 模型文件损坏（下载中断留下空文件）。`
        + `请删除 ~/.cache/huggingface/hub/models--Systran--faster-whisper-${MODEL_SIZE} 后重试，`
        + '或手工下载到 ~/.cache/jarvis-whisper/' + MODEL_SIZE + '/。';
    } else if (/xethub|CAS Client Error|reconstructions/i.test(raw)) {
      reason = 'HuggingFace Xet 传输协议失败（镜像站不支持）。'
        + '已默认设 HF_HUB_DISABLE_XET=1，若仍失败请手工下载模型到 '
        + '~/.cache/jarvis-whisper/' + MODEL_SIZE + '/。';
    } else if (/SHFileOperationW|Errno 13|PermissionError|Access is denied/i.test(raw)) {
      reason = '模型缓存写入被拒（权限或沙箱限制）。'
        + '可手工下载模型到 ~/.cache/jarvis-whisper/' + MODEL_SIZE + '/ 绕过。';
    } else if (/No space left|Errno 28/i.test(raw)) {
      reason = `磁盘空间不足，${MODEL_SIZE} 模型需要约 ${MODEL_MB[MODEL_SIZE] || '?'}MB。`;
    } else if (/ctranslate2|DLL load failed|ImportError/i.test(raw)) {
      reason = 'ctranslate2 加载失败，Windows 上多为缺 Microsoft Visual C++ 运行库。';
    } else if (/转写超时/.test(raw)) {
      reason = '转写超时。CPU 负载过高或音频过长。';
    } else {
      reason = raw.slice(0, 200);
    }
    return { ok: false, reason, rawError: raw.slice(0, 600), fallback: 'System.Speech' };
  }

  const cleaned = cleanTranscript(msg.text || '');
  return {
    ok: true,
    text: cleaned.text,
    raw: cleaned.changed ? (msg.text || '') : undefined,
    conf: msg.conf,
    lang: msg.lang,
    langProb: msg.langProb,
    engine: `faster-whisper:${MODEL_SIZE}`,
  };
}

/* ══════════ 转写结果清洗（2026-09-09 实测必需） ══════════
 *
 * 短音频末尾 whisper 会稳定吐幻觉 token。**不是偶发，是 100% 复现**：
 *   "截图"     → "截图Ｇ跌"      conf 0.641（4/4 次完全一致）
 *   "播放音乐" → "播放音乐；。"  conf 0.682（3/3 次完全一致）
 *   "搜索一下今天的新闻" → 尾部一个 U+FFFD 替换字符
 *
 * 成因：解码器在音频结束后仍要产 token，短音频没有足够上下文
 * 让它稳定输出 <|endoftext|>，于是抓一个高频字凑数。
 * 顺带一个可用信号：**带幻觉尾巴的句子 conf 明显偏低**
 * （0.64/0.68 vs 正常 0.89~0.95）。
 *
 * ⚠ 清洗必须保守。宁可漏掉一个垃圾字符，也不能吃掉真实内容 ——
 *   识别结果会直接进指令解析，"关闭窗口"被削成"关闭"是更糟的错。
 * 所以只删三类**明确**无意义的尾部字符，不做同音词纠正、不动句子中部。 */
function cleanTranscript(text) {
  const before = text;
  let t = text;

  /* 1) U+FFFD 替换字符：解码失败的产物，任何位置都无意义 */
  t = t.replace(/\uFFFD/g, '');

  /* 2) 尾部标点堆叠："；。" "，。" "。。" —— 只保留最后一个句号 */
  t = t.replace(/[，,、；;：:。.!！?？\s]{2,}$/u, '。');

  /* 2b) 尾部单个"非终止"标点：短音频常吐 "截图；" "查一下上证指数：" ——
   * 分号/冒号/逗号出现在句尾在中文里没有意义，一律换成句号。
   * ⚠ 不动 。！？ —— 那些是合法句末标点，删了会丢失语气信息
   *   （疑问句进指令解析时"？"是有用的信号）。 */
  t = t.replace(/[，,、；;：:]$/u, '。');

  /* 3) 尾部孤立的全角/半角单字母 + 单字组合，如 "Ｇ跌"。
   * 严格限定：必须紧跟在中文之后、且长度 ≤2、且含全角字母 ——
   * 三个条件同时满足才删，避免误伤"看一下A股"这类真实内容。 */
  t = t.replace(/(?<=[\u4e00-\u9fa5])[Ａ-Ｚａ-ｚ][\u4e00-\u9fa5]?[。.]?$/u, '');

  /* 4) 收尾：去空白，若清完只剩标点则视为空 */
  t = t.trim();
  if (/^[，,、；;：:。.!！?？\s]*$/u.test(t)) t = '';

  return { text: t, changed: t !== before };
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
    modelSource: p.modelSource || null,
    note: p.available
      ? (p.modelCached
        ? `正在使用 faster-whisper:${p.modelSize}（${p.modelSource || '已就绪'}，`
          + '识别准确率高于系统语音)'
        : '已安装但模型未下载，首次识别会先下载模型')
      : ' 使用 Windows 系统语音（零依赖，准确率略低）。安装 faster-whisper 可提升准确率，'
        + `但需要约 ${MODEL_MB[MODEL_SIZE] || '?'}MB 模型文件 —— 贾维斯不会替你安装。`,
  };
}

/** 清缓存 —— 用户装完后不用重启服务 */
function resetProbe() { _probeCache = null; _probeAt = 0; }

/** 后台预热某档模型（不 await、不阻塞）。
 * 给"复核专用的 small"用：它冷启动加载要约 20-30 秒，等真要复核时再加载
 * 用户会干等；监听开始后悄悄拉起来，第一次低置信指令命中时往往已是热的。
 * 任何失败都静默——预热只是优化，不是功能。 */
async function prewarm(size = 'small') {
  try {
    const p = await probe();
    if (!p.available) return false;
    const w = await getWorker(p.python, size);
    return !!(w && w.ready);
  } catch (_) { return false; }
}

module.exports = {
  probe, transcribe, status, resetProbe, stopWorker, localModelPath, prewarm,
  cleanTranscript,
  MODEL_SIZE, MODEL_MB, COMPUTE_TYPE, TMP_DIR, HF_ENDPOINT, INITIAL_PROMPT,
  LOCAL_MODEL_DIR, WORKER_IDLE_MS,
};
