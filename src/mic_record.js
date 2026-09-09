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

const { spawn } = require('child_process');
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
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WF f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();

  public static int Devs() { return waveInGetNumDevs(); }

  // Record with early stop on trailing silence (simple VAD).
  // Returns "peak=N ms=N stopped=reason"
  public static string Rec(int rate, int maxMs, string outPath, int silenceMs, int startThresh) {
    if (waveInGetNumDevs() == 0) return "ERR no-input-device";
    var f = new WF();
    f.tag = 1; f.ch = 1; f.rate = (uint)rate; f.bits = 16;
    f.align = 2; f.bps = (uint)(rate * 2); f.cb = 0;
    IntPtr h;
    // WAVE_MAPPER = -1 : let Windows pick the current default input
    int r = waveInOpen(out h, 0xFFFFFFFF, ref f, IntPtr.Zero, IntPtr.Zero, 0);
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

/**
 * 录一段音频到 WAV。
 *
 * @param opts.maxMs      最长录多久（默认 10s，上限 MAX_MS）
 * @param opts.silenceMs  说完后静音多久就提前停（默认 800ms）
 * @param opts.threshold  判定"有人在说话"的振幅门槛（默认 500）
 * @param opts.outPath    输出路径（默认临时目录）
 *
 * @returns { ok, path, peak, ms, stopped, sawSpeech, error }
 *
 * ⚠ 返回的 `sawSpeech=false` 意味着**整段都是静音**。
 * 调用方必须检查它 —— 把静音丢给 whisper 会得到幻觉文本
 * （实测 whisper 在纯静音上会编出"谢谢观看"之类的内容）。
 */
function record(opts = {}) {
  const maxMs = Math.min(Math.max(Number(opts.maxMs) || 6000, 500), MAX_MS);
  const silenceMs = Math.max(Number(opts.silenceMs) || 800, 200);
  const threshold = Math.max(Number(opts.threshold) || 500, 1);
  const outPath = opts.outPath || path.join(TMP_DIR, 'cap_' + Date.now() + '.wav');

  return new Promise(resolve => {
    let csPath;
    try {
      csPath = ensureCs();
      writeUtf8NoBom(path.join(TMP_DIR, 'rec.ps1'),
        `Add-Type -Path '${csPath}'\n` +
        `Write-Output ([JarvisRec]::Rec(${RATE}, ${maxMs}, '${outPath.replace(/'/g, "''")}', ${silenceMs}, ${threshold}))\n`);
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

module.exports = { record, cleanup, CS_SOURCE, RATE, MAX_MS, TMP_DIR };
