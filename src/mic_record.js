'use strict';
/**
 * ══════════════ 麦克风录音（waveIn） ══════════════
 *
 * ══ 为什么必须自己录，不能用 MCI ══
 *
 * 实测踩过的大坑：**MCI 在这台机器上返回假数据。**
 *
 * 同一时刻、同一个麦克风：
 *   MCI (`mciSendString record`)  → peak=32641（满幅，看起来信号很强）
 *   waveIn (`waveInOpen/Start`)   → peak=1（真实的静音）
 *
 * 我基于 MCI 的读数推了三轮结论，得出过两个**完全错误**的判断：
 *   ① "麦克风输出 100% 削波的垃圾数据"
 *   ② "华为音频特效 APO 吞掉了音频"
 * 换成 waveIn 一次就露馅了。
 *
 * **教训：交叉验证要在第一步做，不是第五步。**
 * 这和「上证指数拿到平安银行数据」同类 —— 没验证数据源本身可信。
 *
 * 所以这个模块只用 waveIn，并且把这条经验写在最显眼的地方。
 *
 * ══ 为什么需要录音这一步 ══
 *
 * 用户：**「语音交互不应该挑设备」**。
 *
 * 原架构唯一的识别路径是 Windows System.Speech，
 * 它在窄带设备上给出「会为贵」conf=0.002 —— 完全不可用。
 * 而 whisper 对同一段音频能抓到「维斯」，明显更强，
 * 却因为拿不到原始音频而只能待在 /api/voice/stt 旁路里。
 *
 * 录音模块补的就是这一环：把麦克风音频落成 WAV，
 * whisper 才能接进实时链路，设备差就不再等于功能没有。
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');

/* whisper 要 16kHz 单声道 —— 它内部就是按这个重采样的，
 * 直接录成目标格式省一次转换。 */
const RATE = 16000;

/* 单次录音上限。指令一般 2-6 秒，给 10 秒足够；
 * 太长会让 whisper 变慢（实测大量静音会让耗时从 4s 涨到 24s）。 */
const MAX_MS = 10000;

/* ══ C# 源码 ══
 *
 * ⚠ 两条硬规则，都是实测踩出来的：
 *
 * 1. **必须纯 ASCII**。中文在 `powershell.exe -File` 下编码损坏，
 *    引号被吞导致语法错误（见过 `宄板€?` 这种乱码）。
 *
 * 2. **不能用裸 `<` 做比较**。PowerShell here-string 会把 `s < n`
 *    当成重定向，报 "类、结构或接口成员声明中的标记for无效"。
 *    循环条件统一写成 `i != n`。
 *
 * 说明都写在这个 JS 文件的注释里，不写进 C#。
 */
const CS_SOURCE = `
using System; using System.Runtime.InteropServices;
public class JarvisRec {
  [StructLayout(LayoutKind.Sequential)]
  public struct WF { public ushort tag, ch; public uint rate, bps; public ushort align, bits, cb; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WH { public IntPtr data; public uint len, rec; public IntPtr user; public uint flags, loops; public IntPtr next, res; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct WIC {
    public ushort mid, pid; public uint ver;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
    public uint formats; public ushort ch, res;
  }
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WF f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Ansi)] static extern int waveInGetDevCapsA(IntPtr id, ref WIC c, int size);

  public static int Devs() { return waveInGetNumDevs(); }

  // Enumerate input devices: "idx|name" per line.
  // Device names come back as ANSI (GBK on zh-CN), so JS side must decode.
  public static string List() {
    int n = waveInGetNumDevs();
    string s = "count=" + n;
    for (int i = 0; i != n; i++) {
      var c = new WIC();
      waveInGetDevCapsA((IntPtr)i, ref c, Marshal.SizeOf(typeof(WIC)));
      s = s + "\\n" + i + "|" + c.name;
    }
    return s;
  }

  // Short signal probe on one device. Used to pick the healthiest input.
  // Returns "peak=N clip=N zero=N rms=N" or "ERR open=code".
  public static string Probe(int dev, int rate, int ms) {
    var f = new WF();
    f.tag = 1; f.ch = 1; f.rate = (uint)rate; f.bits = 16;
    f.align = 2; f.bps = (uint)(rate * 2); f.cb = 0;
    IntPtr h;
    int r = waveInOpen(out h, (uint)dev, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (r != 0) return "ERR open=" + r;
    int bytes = rate * 2 * ms / 1000;
    IntPtr buf = Marshal.AllocHGlobal(bytes);
    for (int i = 0; i != bytes; i++) Marshal.WriteByte(buf, i, 0);
    var hdr = new WH(); hdr.data = buf; hdr.len = (uint)bytes;
    int hs = Marshal.SizeOf(typeof(WH));
    waveInPrepareHeader(h, ref hdr, hs);
    waveInAddBuffer(h, ref hdr, hs);
    waveInStart(h);
    System.Threading.Thread.Sleep(ms + 150);
    waveInStop(h);
    int peak = 0; int clip = 0; int zero = 0; double sumSq = 0; int n = 0;
    for (int i = 0; bytes - i >= 2; i += 2) {
      short v = (short)(Marshal.ReadByte(buf, i) | (Marshal.ReadByte(buf, i + 1) * 256));
      int a = v; if (a < 0) a = -a;
      if (a > peak) peak = a;
      if (a >= 32000) clip++;
      if (v == 0) zero++;
      sumSq += (double)v * v; n++;
    }
    waveInClose(h);
    Marshal.FreeHGlobal(buf);
    int rms = 0; if (n > 0) rms = (int)Math.Sqrt(sumSq / n);
    int clipPct = 0; int zeroPct = 0;
    if (n > 0) { clipPct = clip * 100 / n; zeroPct = zero * 100 / n; }
    return "peak=" + peak + " clip=" + clipPct + " zero=" + zeroPct + " rms=" + rms;
  }

  // Record ms milliseconds with early stop on trailing silence (simple VAD).
  // dev: waveIn device index, or -1 for WAVE_MAPPER (Windows default).
  // Returns "peak=N ms=N stopped=reason speech=0|1"
  public static string Rec(int dev, int rate, int maxMs, string outPath, int silenceMs, int startThresh) {
    if (waveInGetNumDevs() == 0) return "ERR no-input-device";
    var f = new WF();
    f.tag = 1; f.ch = 1; f.rate = (uint)rate; f.bits = 16;
    f.align = 2; f.bps = (uint)(rate * 2); f.cb = 0;
    IntPtr h;
    // dev -1 maps to WAVE_MAPPER (0xFFFFFFFF): let Windows pick the default.
    uint devId = 0xFFFFFFFF;
    if (dev >= 0) devId = (uint)dev;
    int r = waveInOpen(out h, devId, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (r != 0) return "ERR open=" + r;
    int bytes = rate * 2 * maxMs / 1000;
    IntPtr buf = Marshal.AllocHGlobal(bytes);
    for (int i = 0; i != bytes; i++) Marshal.WriteByte(buf, i, 0);
    var hdr = new WH(); hdr.data = buf; hdr.len = (uint)bytes;
    int hs = Marshal.SizeOf(typeof(WH));
    waveInPrepareHeader(h, ref hdr, hs);
    waveInAddBuffer(h, ref hdr, hs);
    waveInStart(h);

    int chunkMs = 30;
    int chunkBytes = rate * 2 * chunkMs / 1000;
    int elapsed = 0, quietRun = 0, globalPeak = 0, runningPeak = 0;
    bool sawSpeech = false;
    string why = "maxlen";
    // Require ~1s of accumulated speech before silence may stop us.
    // A single pop or cough must not count as a whole utterance.
    int speechMs = 0;

    // NOTE on loop style: this file's C# must avoid a bare less-than sign in
    // for/while headers, because PowerShell here-strings parse it as
    // redirection. But inequality is NOT a safe substitute for a bounds check:
    // "elapsed not-equal maxMs" silently never matched when maxMs was not a
    // multiple of chunkMs (e.g. 2000 with chunk 30), so the loop ran past the
    // buffer and Marshal.ReadByte threw AccessViolationException.
    // Correct approach: compare with a subtraction needing only greater-than.
    while (maxMs - elapsed >= chunkMs) {
      System.Threading.Thread.Sleep(chunkMs);
      elapsed += chunkMs;
      int from = (elapsed - chunkMs) * rate * 2 / 1000;
      int to = from + chunkBytes;
      if (to > bytes) to = bytes;
      int peak = 0;
      // Same rule here: use subtraction so no bare less-than is needed, and
      // require 2 whole bytes to remain before reading a 16-bit sample.
      for (int i = from; to - i >= 2; i += 2) {
        short v = (short)(Marshal.ReadByte(buf, i) | (Marshal.ReadByte(buf, i + 1) * 256));
        int a = v; if (a < 0) a = -a;
        if (a > peak) peak = a;
      }
      if (peak > globalPeak) globalPeak = peak;

      // Moving peak with decay, so one spiky frame cannot trip the VAD.
      if (peak > runningPeak) runningPeak = peak;
      else runningPeak = (int)(runningPeak * 0.85f);

      bool hasVoice = runningPeak >= startThresh;
      if (hasVoice) {
        sawSpeech = true;
        quietRun = 0;
        speechMs += chunkMs;
      } else if (sawSpeech) {
        quietRun += chunkMs;
        if (speechMs >= 1000 && quietRun >= silenceMs) { why = "silence"; break; }
      }
    }

    waveInStop(h);
    int used = elapsed * rate * 2 / 1000;
    if (used > bytes) used = bytes;
    var data = new byte[used];
    Marshal.Copy(buf, data, 0, used);
    waveInClose(h);
    Marshal.FreeHGlobal(buf);

    using (var fsOut = new System.IO.FileStream(outPath, System.IO.FileMode.Create)) {
      var bw = new System.IO.BinaryWriter(fsOut);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
      bw.Write(36 + used);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
      bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
      bw.Write(16); bw.Write((short)1); bw.Write((short)1);
      bw.Write(rate); bw.Write(rate * 2); bw.Write((short)2); bw.Write((short)16);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
      bw.Write(used); bw.Write(data);
    }
    return "peak=" + globalPeak + " ms=" + elapsed + " stopped=" + why + " speech=" + (sawSpeech ? 1 : 0);
  }
}
`;

function writeUtf8NoBom(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(s, 'utf8'));
}

let _csWritten = false;
function ensureCs() {
  const csPath = path.join(TMP_DIR, 'jarvisrec.cs');
  if (!_csWritten || !fs.existsSync(csPath)) {
    writeUtf8NoBom(csPath, CS_SOURCE);
    _csWritten = true;
  }
  return csPath;
}

/* ══════════════ 设备选择层 ══════════════
 *
 * ══ 为什么需要它 ══
 *
 * 原来 waveInOpen 写死 WAVE_MAPPER(0xFFFFFFFF)，意思是"让 Windows 挑默认设备"。
 * 听起来很符合「不挑设备」原则，实际后果相反：
 *
 *   本机有两个输入设备，实测 rms 差 50 倍
 *     索引 0  HUAWEI USB-C HEADSET   rms=15   窄带，3kHz 以上几乎无信号
 *     索引 1  本机麦克风（英特尔）    rms=776  宽带
 *
 * Windows 默认挑的不一定是能用的那个，而代码连"换一个试试"的能力都没有。
 * 用户插拔耳机、系统改默认设备，语音功能就时好时坏，且无从诊断。
 *
 * ══ 设计原则：自动选优，可以覆盖，但不写死 ══
 *
 * 1. 默认 `device: 'auto'` —— 实测每个设备的信噪比，挑最好的
 * 2. 可传 `device: <索引>` 显式指定（诊断时用）
 * 3. 可传 `device: 'default'` 回到 WAVE_MAPPER 行为
 * 4. 结果缓存 —— 探测要真实录音，不能每次录音前都跑一遍
 *
 * ══ 一个必须记住的坑 ══
 *
 * **MCI 会撒谎。** 用 mciSendString 探测时，被 APO 处理的设备返回
 * peak=32641（满幅）；换 waveIn 探测同一设备，返回真实底噪。
 * 曾据 MCI 数据推出「华为 APO 吞掉音频」的错误结论。
 * → 所有探测一律走 waveIn，本文件不引入任何 MCI 调用。
 */

/* 设备名是 ANSI（简中系统为 GBK），Node 原生 TextDecoder 就能解，
 * 不需要 iconv-lite —— 守住零依赖约束。 */
function decodeAnsi(buf) {
  try {
    return new TextDecoder('gbk').decode(buf).replace(/\0+$/, '');
  } catch {
    return buf.toString('latin1').replace(/\0+$/, '');
  }
}

function runPsSync(body, timeoutMs = 30000) {
  const csPath = ensureCs();
  const scriptPath = path.join(TMP_DIR, 'devq.ps1');
  writeUtf8NoBom(scriptPath, `Add-Type -Path '${csPath.replace(/'/g, "''")}'\n${body}\n`);
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { timeout: timeoutMs, windowsHide: true });
  /* 不指定 encoding，拿 Buffer 自己解 —— 设备名里的中文是 GBK，
   * 让 Node 按 utf8 解会得到乱码。 */
  return {
    ok: r.status === 0,
    stdout: r.stdout ? decodeAnsi(r.stdout) : '',
    stderr: r.stderr ? decodeAnsi(r.stderr) : '',
  };
}

/** 列出所有 waveIn 输入设备 → [{ index, name }] */
function listDevices() {
  const r = runPsSync('Write-Output ([JarvisRec]::List())', 15000);
  if (!r.ok && !r.stdout) return { ok: false, error: r.stderr.slice(0, 200) || '枚举失败', devices: [] };
  const devices = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\d+)\|(.*)$/.exec(line.trim());
    if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
  }
  return { ok: true, devices };
}

/** 实测一个设备的信号质量（录 ms 毫秒，默认 600ms 够判断） */
function probeDevice(index, ms = 600) {
  const r = runPsSync(`Write-Output ([JarvisRec]::Probe(${index}, ${RATE}, ${ms}))`, 20000);
  const m = /peak=(-?\d+) clip=(\d+) zero=(\d+) rms=(\d+)/.exec(r.stdout);
  if (!m) {
    const err = /ERR (.+)/.exec(r.stdout);
    return { ok: false, index, error: err ? err[1] : (r.stderr.slice(0, 120) || '无输出') };
  }
  const peak = Number(m[1]), clip = Number(m[2]), zero = Number(m[3]), rms = Number(m[4]);

  /* 健康判定。三种坏情况要分开报，因为修法完全不同：
   *   dead  设备打不开或采不到 → 检查是否被独占/未插入
   *   clip  满幅削波          → 增益过高或特效链异常
   *   quiet 有信号但极弱      → 输入音量过低，可用但需降低判定门槛 */
  let health;
  if (peak <= 2) health = 'dead';
  else if (clip >= 50) health = 'clip';
  else if (rms < 3) health = 'quiet';
  else health = 'ok';

  return { ok: true, index, peak, clipPct: clip, zeroPct: zero, rms, health };
}

/* 选优结果缓存。探测要真实录音（每设备 600ms），
 * 不能每次 record() 前都重跑一遍。 */
let _bestCache = null;
let _bestCacheAt = 0;
const BEST_TTL_MS = 5 * 60 * 1000;

/**
 * 挑一个能用的输入设备。
 *
 * 排序依据 rms（信号强度）而不是 peak —— peak 会被单个爆音带偏，
 * rms 反映整体信噪水平。实测本机板载麦 rms=776 vs USB 耳机 rms=15，
 * 差距一目了然。
 *
 * @param force 忽略缓存重新探测（用户插拔设备后应传 true）
 */
function pickBestDevice(force = false) {
  if (!force && _bestCache && Date.now() - _bestCacheAt < BEST_TTL_MS) {
    return { ..._bestCache, cached: true };
  }

  const list = listDevices();
  if (!list.ok || list.devices.length === 0) {
    const res = { ok: false, error: list.error || '没有输入设备', index: -1, candidates: [] };
    _bestCache = res; _bestCacheAt = Date.now();
    return res;
  }

  const candidates = list.devices.map((d) => ({ ...d, ...probeDevice(d.index) }));
  const usable = candidates.filter((c) => c.ok && c.health !== 'dead' && c.health !== 'clip');
  usable.sort((a, b) => b.rms - a.rms);

  const res = usable.length > 0
    ? { ok: true, index: usable[0].index, name: usable[0].name,
        rms: usable[0].rms, peak: usable[0].peak, health: usable[0].health, candidates }
    : { ok: false, error: '所有输入设备都不可用', index: -1, candidates };

  _bestCache = res;
  _bestCacheAt = Date.now();
  return res;
}

function resetDeviceCache() { _bestCache = null; _bestCacheAt = 0; }

/** 把 opts.device 解析成 C# 要的设备索引（-1 表示 WAVE_MAPPER） */
function resolveDevice(device) {
  if (device === 'default') return { index: -1, how: 'WAVE_MAPPER' };
  if (typeof device === 'number' && device >= 0) return { index: device, how: '显式指定' };
  if (device === undefined || device === 'auto') {
    const best = pickBestDevice();
    /* 选不出来时退回 WAVE_MAPPER，而不是直接失败 ——
     * Windows 默认设备也许恰好可用，让它有机会试一次。 */
    return best.ok
      ? { index: best.index, how: '自动选优', name: best.name, rms: best.rms }
      : { index: -1, how: 'WAVE_MAPPER（选优失败，退回默认）', warn: best.error };
  }
  return { index: -1, how: 'WAVE_MAPPER（device 参数无法识别）' };
}

/* ══════════ 语音起始阈值自适应（2026-09-09 实测必需） ══════════
 *
 * 阈值原本写死 500。问题：**不同麦克风的信号量级差一个数量级。**
 * 本机实测底噪 rms：
 *   设备 0 华为 USB-C 耳机  rms 7~15   说话峰值约 200~600
 *   设备 1 本机数字麦克风   rms 2~776  说话峰值可上千
 * 写死 500 在 USB 耳机上就是"说了话也判定为静音"——
 * 实测 peak 186/429 全被判成 sawSpeech=false。
 *
 * 更糟的是这个失败**长得像麦克风坏了**：录音成功、有 peak 值、
 * 但 sawSpeech=false，调用方直接丢弃。排查会跑到驱动/APO 上去
 * （Phase 18 就是这么误判的）。
 *
 * 改成按底噪自适应：阈值 = clamp(底噪 rms × 8, 60, 1200)。
 *   · 乘 8 —— 实测说话峰值/底噪 rms 通常 >20 倍，8 倍留足余量又不误触发
 *   · 下限 60 —— 防止极静环境（rms≈2）把阈值压到 16，风扇声都能触发
 *   · 上限 1200 —— **探测期间如果正好有人说话，"底噪"会被严重高估**。
 *     实测探测到 rms=776（我在说话），×8 得 6208，比说话峰值还高，
 *     结果是永远判定静音。上限把这种自伤挡住。
 * 调用方仍可用 opts.threshold 显式覆盖。 */
const THRESH_NOISE_MULT = 8;
const THRESH_FLOOR = 60;
const THRESH_CEIL = 1200;

/** 由设备底噪推一个合理阈值；拿不到底噪就退回保守值。 */
function autoThreshold(dev) {
  const rms = dev && typeof dev.rms === 'number' ? dev.rms : null;
  if (rms == null) return 200;   /* 未探测（如 default/显式设备号）时的折中值 */
  const v = Math.round(rms * THRESH_NOISE_MULT);
  return Math.min(Math.max(v, THRESH_FLOOR), THRESH_CEIL);
}

/**
 * 录一段音频到 WAV。
 *
 * @param opts.maxMs      最长录多久（默认 6s，上限 MAX_MS）
 * @param opts.silenceMs  说完后静音多久就提前停（默认 800ms）
 * @param opts.threshold  判定"有人在说话"的振幅门槛。
 *                        **默认按设备底噪自适应**（见 autoThreshold），
 *                        不再写死 —— 写死会让低增益麦克风永远判定为静音。
 * @param opts.outPath    输出路径（默认临时目录）
 * @param opts.device     'auto'（默认，实测选最好的）| 'default'（Windows 默认设备）| 索引数字
 *
 * @returns { ok, path, peak, ms, stopped, sawSpeech, device, threshold, error }
 *
 * ⚠ 返回的 `sawSpeech=false` 意味着**整段都低于阈值**。
 * 调用方必须检查它 —— 把静音丢给 whisper 会得到幻觉文本
 * （实测 whisper 在纯静音上会编出"谢谢观看"之类的内容）。
 * 但也要留意：sawSpeech=false + peak 不低 ⇒ 阈值设高了，不是麦克风坏了。
 */
function record(opts = {}) {
  const maxMs = Math.min(Math.max(Number(opts.maxMs) || 6000, 500), MAX_MS);
  const silenceMs = Math.max(Number(opts.silenceMs) || 800, 200);
  const outPath = opts.outPath || path.join(TMP_DIR, 'cap_' + Date.now() + '.wav');
  /* 必须先解析设备 —— 阈值要用它的底噪 rms 推算 */
  const dev = resolveDevice(opts.device);
  const threshold = opts.threshold != null
    ? Math.max(Number(opts.threshold) || 1, 1)
    : autoThreshold(dev);

  return new Promise(resolve => {
    let csPath;
    try {
      csPath = ensureCs();
      writeUtf8NoBom(path.join(TMP_DIR, 'rec.ps1'),
        `Add-Type -Path '${csPath}'\n` +
        `Write-Output ([JarvisRec]::Rec(${dev.index}, ${RATE}, ${maxMs}, '${outPath.replace(/'/g, "''")}', ${silenceMs}, ${threshold}))\n`);
    } catch (e) {
      return resolve({ ok: false, error: '写临时脚本失败: ' + e.message });
    }

    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
       '-File', path.join(TMP_DIR, 'rec.ps1')],
      { windowsHide: true });

    let out = '', err = '';
    ps.stdout.on('data', d => { out += d.toString('utf8'); });
    ps.stderr.on('data', d => { err += d.toString('utf8'); });

    /* 超时留足余量：录音本身 maxMs，加上 PowerShell 启动
     * 和 Add-Type 编译（首次约 1-2 秒）。 */
    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, maxMs + 15000);

    ps.on('close', () => {
      clearTimeout(timer);
      const m = /peak=(\d+) ms=(\d+) stopped=(\w+) speech=(\d)/.exec(out);
      if (!m) {
        const errLine = /^ERR (.+)$/m.exec(out);
        return resolve({
          ok: false,
          error: errLine ? errLine[1]
               : ('录音无输出' + (err ? '；' + err.trim().slice(0, 150) : '')),
        });
      }
      resolve({
        ok: true,
        path: outPath,
        peak: Number(m[1]),
        ms: Number(m[2]),
        stopped: m[3],
        sawSpeech: m[4] === '1',
        device: dev,
        threshold,
      });
    });

    ps.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'spawn 失败: ' + e.message });
    });
  });
}

/** 清掉旧的临时录音，别把用户磁盘塞满 */
function cleanup(olderThanMs = 5 * 60 * 1000) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (!/^cap_\d+\.wav$/.test(f)) continue;
      const p = path.join(TMP_DIR, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) {
          fs.unlinkSync(p); removed++;
        }
      } catch { }
    }
  } catch { }
  return removed;
}

module.exports = {
  record, cleanup, autoThreshold,
  listDevices, probeDevice, pickBestDevice, resetDeviceCache, resolveDevice,
  CS_SOURCE, RATE, MAX_MS, TMP_DIR,
};
