'use strict';
/**
 * ══════════════ 常驻音频环形缓冲 ══════════════
 *
 * ══ 为什么必须这样做（Phase 1 的全部理由）══
 *
 * 上一版用「反应式录音」：听到疑似唤醒词才启动录音进程。
 * 实测证伪 —— 每次启动有 **1.6 秒固定开销**（新起 PowerShell + 编译 C#）：
 *
 *   总耗时 2600ms   实际录音 990ms   启动开销 1600ms
 *
 * 后果：用户说完「贾维斯」→ 系统识别器识别(约1s) → 才开始录音
 * → 再等 1.6s 才真正收音 → **话早说完了**。
 * 实测 whisper 复核拿到的全是 `no_speech peak≈30`（静音）。
 *
 * 所以正确做法是业内标准的**环形缓冲**：
 * 麦克风一直开着，最近 N 秒音频常驻内存。
 * 一旦需要（唤醒词疑似命中），**把已经过去的音频取出来** ——
 * 包含唤醒词本身，因为它在触发前就已经被录进缓冲了。
 *
 * ══ 采集方式：waveIn 轮询，不用回调 ══
 *
 * 两条实测得来的硬约束：
 *
 * 1. **绝不能用 MCI**。同一时刻同一麦克风：
 *      MCI    → peak=32641（满幅假数据）
 *      waveIn → peak=1（真实静音）
 *    我曾基于 MCI 的假读数推了三轮错误结论。
 *
 * 2. **不能依赖 waveIn 回调**。C# 回调需要消息泵，
 *    而 PowerShell 里 `Start-Sleep` 会阻塞消息泵
 *    （这正是最早唤醒词完全不触发的根因：0 个音频事件）。
 *    所以改用**轮询 WHDR_DONE 标志位**，不注册回调。
 *    已实测：3 秒稳定收到 30 块 × 3200 字节，速率准确。
 *
 * ══ 传输协议 ══
 *
 * 子进程 stdout 纯文本行（二进制走 base64，避开管道编码问题）：
 *   `START numdevs=N`      启动
 *   `OPEN rc=0`            设备打开结果
 *   `STARTED`              开始采集
 *   `C <base64>`           一块音频（16-bit 单声道 16kHz）
 *   `CRASH: ...`           异常
 *
 * stdin 收到任意一行即退出（优雅关闭）。
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');

/* ══════════════ 为什么必须编译成独立 exe ══════════════
 *
 * ══ 实测对照（同一段 waveIn 代码，一字未改，只换宿主）══
 *
 *   PowerShell 宿主 (Add-Type 动态编译)   peak=  129   ✗ 静音
 *   独立 exe        (csc 预编译)          peak=15261   ✓ 正常
 *
 * 差 118 倍。
 *
 * ══ 为什么会这样 ══
 * 这台机器的采集链上挂着华为的 APO（音频处理对象）：
 *   HIVAAP  HiVA 语音助手
 *   HWVEAP  语音增强
 *   HAINAP  AI 降噪
 * 两个物理麦克风（USB 耳机 + Intel 内置）都挂着同一套，
 * 这就是为什么换耳机毫无变化。
 *
 * 它们按**宿主进程**做策略：对 powershell.exe 这种脚本宿主
 * 输出静音，对正常应用放行。
 *
 * ══ 这个坑有多深（诊断记录，避免重犯）══
 * API 全部返回成功：waveInOpen rc=0、格式协商通过、
 * 缓冲正常回收、Windows 隐私记录里还写着"PowerShell 刚用过麦克风"。
 * 原始字节结构也完全正确（16-bit 小端），
 * **只是内容是无信号底噪**（-8 -16 -12 -7...）。
 *
 * 正因为"看起来全对"，我先后误判成：
 *   音量问题 / waveIn 与 SAPI 互斥 / 采样率不对 /
 *   whisper 识别不行 / 麦克风权限 / 硬件坏了
 * 全都不是。用户用 Windows 录音机录出饱满波形，
 * 才证明音频路径本身没问题，问题在宿主。
 *
 * ══ 规则 ══
 * 采集**只能**走预编译 exe。绝不要为了省事改回 powershell -Command，
 * 那等于把功能静默废掉，而且极难查。 */

/** 采样率。whisper 内部就按 16kHz 重采样，直接录成目标格式省一次转换。 */
const RATE = 16000;

/** 每块时长。100ms 是实测过的稳定值：
 *  太小（<50ms）轮询开销占比高；太大（>200ms）VAD 反应迟钝。 */
const CHUNK_MS = 100;

/** 环形缓冲保留多久。
 *
 *  唤醒词「贾维斯」约 0.8 秒，加上前后余量和识别延迟，
 *  6 秒足够覆盖「说完唤醒词 + 系统识别器识别完 + 我们来取」的全过程。
 *  内存开销：6s × 16000 × 2 字节 = 192KB，可以忽略。 */
const RING_SECONDS = 6;

const RING_BYTES = RING_SECONDS * RATE * 2;

/** 判定"有人在说话"的振幅门槛（16-bit 满幅 32767）。
 *  实测：静音底噪 peak≈1-30，正常说话 peak 数千到两万。 */
const VOICE_THRESHOLD = 400;

/* ══ C# 源码 ══
 *
 * ⚠ 三条硬规则，全是实测踩出来的：
 *
 * 1. **必须纯 ASCII**。中文在 `powershell.exe -File` 下编码损坏，
 *    引号被吞导致语法错误（见过 `宄板€?` 这种乱码）。
 *    所有说明写在本 JS 文件的注释里。
 *
 * 2. **for/while 头部不能用裸 `<`**。PowerShell here-string 把它当重定向，
 *    报「类、结构或接口成员声明中的标记for无效」。
 *
 * 3. **`!=` 不是边界检查的安全替代**。曾把 `elapsed < maxMs` 改成
 *    `elapsed != maxMs`，在 maxMs 不是步长整数倍时永不匹配，
 *    冲出缓冲区触发 AccessViolationException。
 *    正确做法：用减法比较，只需要 `>=`。
 *
 * 4. **自己写 UTF-8 字节到 stdout**。PowerShell 的编码转换层会
 *    吞掉/改写输出；直接 OpenStandardOutput 绕开它。
 */
const CS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

public class JarvisRingMic {
  [StructLayout(LayoutKind.Sequential)]
  public struct WF { public ushort tag, ch; public uint rate, bps; public ushort align, bits, cb; }

  [StructLayout(LayoutKind.Sequential)]
  public struct WH {
    public IntPtr data;
    public uint len, rec;
    public IntPtr user;
    public uint flags, loops;
    public IntPtr next, res;
  }

  [DllImport("winmm.dll")]
  static extern int waveInOpen(out IntPtr h, uint dev, ref WF f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")]
  static extern int waveInPrepareHeader(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")]
  static extern int waveInAddBuffer(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")]
  static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")]
  static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")]
  static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")]
  static extern int waveInUnprepareHeader(IntPtr h, ref WH hd, int size);
  [DllImport("winmm.dll")]
  static extern int waveInClose(IntPtr h);
  [DllImport("winmm.dll")]
  static extern int waveInGetNumDevs();

  static volatile bool running = true;
  static System.IO.Stream stdout;

  // Write UTF-8 bytes straight to stdout: the PowerShell encoding layer
  // otherwise mangles or swallows output.
  static void Emit(string s) {
    var bytes = Encoding.UTF8.GetBytes(s + "\\n");
    stdout.Write(bytes, 0, bytes.Length);
    stdout.Flush();
  }

  public static void Main() {
    stdout = Console.OpenStandardOutput();
    try {
      int ndev = waveInGetNumDevs();
      Emit("START numdevs=" + ndev);
      if (ndev == 0) { Emit("CRASH: no-input-device"); return; }

      int rate = ${RATE};
      int chunkMs = ${CHUNK_MS};
      int chunkBytes = rate * 2 * chunkMs / 1000;
      int nBuf = 4;

      var f = new WF();
      f.tag = 1; f.ch = 1; f.rate = (uint)rate;
      f.bits = 16; f.align = 2; f.bps = (uint)(rate * 2); f.cb = 0;

      IntPtr h;
      // 0xFFFFFFFF = WAVE_MAPPER: let Windows pick the current default input,
      // so swapping headsets does not need a restart.
      int rc = waveInOpen(out h, 0xFFFFFFFF, ref f, IntPtr.Zero, IntPtr.Zero, 0);
      Emit("OPEN rc=" + rc);
      if (rc != 0) return;

      var bufs = new byte[nBuf][];
      var hdrs = new WH[nBuf];
      var pins = new GCHandle[nBuf];
      int hs = Marshal.SizeOf(typeof(WH));

      for (int i = 0; i != nBuf; i++) {
        bufs[i] = new byte[chunkBytes];
        pins[i] = GCHandle.Alloc(bufs[i], GCHandleType.Pinned);
        hdrs[i] = new WH();
        hdrs[i].data = pins[i].AddrOfPinnedObject();
        hdrs[i].len = (uint)chunkBytes;
        waveInPrepareHeader(h, ref hdrs[i], hs);
        waveInAddBuffer(h, ref hdrs[i], hs);
      }

      // Shutdown watcher: any stdin line (or EOF) stops us cleanly.
      var t = new Thread(delegate() {
        try { Console.In.ReadLine(); } catch { }
        running = false;
      });
      t.IsBackground = true;
      t.Start();

      waveInStart(h);
      Emit("STARTED");

      // Poll WHDR_DONE instead of registering a callback: a waveIn callback
      // needs a message pump, and PowerShell's Start-Sleep blocks the pump
      // (that was the original bug where zero audio events ever arrived).
      while (running) {
        Thread.Sleep(chunkMs / 2);
        for (int i = 0; i != nBuf; i++) {
          if ((hdrs[i].flags & 1u) == 0) continue;   // WHDR_DONE
          int rec = (int)hdrs[i].rec;
          if (rec > 0) {
            if (rec > chunkBytes) rec = chunkBytes;
            Emit("C " + Convert.ToBase64String(bufs[i], 0, rec));
          }
          hdrs[i].flags &= ~1u;
          hdrs[i].rec = 0;
          waveInAddBuffer(h, ref hdrs[i], hs);
        }
      }

      waveInStop(h);
      waveInReset(h);
      for (int i = 0; i != nBuf; i++) {
        waveInUnprepareHeader(h, ref hdrs[i], hs);
        pins[i].Free();
      }
      waveInClose(h);
      Emit("STOPPED");
    } catch (Exception e) {
      try { Emit("CRASH: " + e.GetType().Name + " " + e.Message); } catch { }
    }
  }
}
`;

function writeUtf8NoBom(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(s, 'utf8'));
}

/* ══ csc.exe —— .NET Framework 4.x 系统自带，无需安装 ══ */
let _cscPath;
function cscPath() {
  if (_cscPath !== undefined) return _cscPath;
  _cscPath = null;
  for (const c of [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ]) {
    if (fs.existsSync(c)) { _cscPath = c; break; }
  }
  return _cscPath;
}

/**
 * 编译 ringmic.cs → ringmic.exe，返回 exe 路径。
 *
 * 为什么非要预编译成 exe：见文件顶部长注释。
 * 一句话——PowerShell 宿主拿到的是静音（peak=129），
 * 独立 exe 才有真实音频（peak=15261）。
 *
 * 只编一次；exe 存在就直接复用（编译约 0.5 秒）。
 * @returns {{exe:string}|{error:string}}
 */
function ensureExe() {
  const exePath = path.join(TMP_DIR, 'ringmic.exe');
  const csPath = path.join(TMP_DIR, 'ringmic.cs');

  /* 已有 exe 且比源码新，直接用 */
  try {
    if (fs.existsSync(exePath) && fs.existsSync(csPath)
      && fs.readFileSync(csPath, 'utf8') === CS_SOURCE) {
      return { exe: exePath };
    }
  } catch { /* 读不到就重新编 */ }

  const csc = cscPath();
  if (!csc) {
    return { error: '找不到 csc.exe（需要 .NET Framework 4.x，Windows 通常自带）' };
  }
  try {
    writeUtf8NoBom(csPath, CS_SOURCE);
  } catch (e) {
    return { error: '写入 C# 源码失败: ' + e.message };
  }
  const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe',
    '/out:' + exePath, csPath], { encoding: 'utf8', windowsHide: true });
  if (r.error) return { error: '调用编译器失败: ' + r.error.message };
  if (r.status !== 0 || !fs.existsSync(exePath)) {
    const msg = String(r.stdout || r.stderr || '').split(/\r?\n/)
      .filter(Boolean).slice(0, 2).join(' | ');
    return { error: '编译采集程序失败: ' + msg.slice(0, 240) };
  }
  return { exe: exePath };
}

/**
 * 常驻环形缓冲。
 *
 * 事件：
 *   'ready'                     采集已启动
 *   'speaking'  {peak}          检测到开始说话
 *   'silence'   {speechMs}      说话结束（附本次语音时长）
 *   'level'     {peak}          每块的音量（UI 画波形用）
 *   'error'     {msg}           子进程异常
 */
class RingBuffer {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => { });
    this.ps = null;
    this.buf = Buffer.alloc(RING_BYTES);
    this.writePos = 0;      // 下一次写入的位置
    this.filled = 0;        // 已写入的总字节（上限 RING_BYTES）
    this.running = false;
    this.lineBuf = '';
    /* VAD 状态 */
    this.peakSmooth = 0;
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalChunks = 0;
    this.lastChunkAt = 0;
  }

  start() {
    if (this.running) return;

    /* ══ 必须直接 spawn exe，不能经过 powershell ══
     *
     * 实测：同一段 waveIn 代码，PowerShell 宿主 peak=129（静音），
     * 独立 exe peak=15261（正常）。差 118 倍。
     * 华为 APO 按宿主进程做策略，对脚本宿主输出静音。
     * 详见文件顶部注释。 */
    const built = ensureExe();
    if (built.error) {
      /* 编译失败必须明确报出来 —— 静默降级会让语音功能
       * "看起来在工作但实际没连上"，那是本项目最难查的一类问题。 */
      this.onEvent({ type: 'error', msg: built.error });
      return;
    }

    this.ps = spawn(built.exe, [], { windowsHide: true });
    this.running = true;

    this.ps.stdout.on('data', d => this._onData(d));
    this.ps.stderr.on('data', d => {
      const m = d.toString('utf8').trim();
      if (m) this.onEvent({ type: 'error', msg: m.slice(0, 300) });
    });
    this.ps.on('close', () => {
      this.running = false;
      this.onEvent({ type: 'closed' });
    });
    this.ps.on('error', e => {
      this.running = false;
      this.onEvent({ type: 'error', msg: 'spawn 失败: ' + e.message });
    });
  }

  stop() {
    this.running = false;
    if (!this.ps) return;
    /* 先请子进程自己退出（它会 waveInClose 释放麦克风），
     * 再兜底 kill —— 不释放会让下一次启动拿不到设备。 */
    try { this.ps.stdin.write('quit\n'); } catch { }
    const p = this.ps;
    this.ps = null;
    setTimeout(() => { try { p.kill(); } catch { } }, 600);
  }

  _onData(d) {
    this.lineBuf += d.toString('utf8');
    let i;
    while ((i = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, i).trim();
      this.lineBuf = this.lineBuf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('C ')) this._onChunk(line.slice(2));
      else if (line === 'STARTED') this.onEvent({ type: 'ready' });
      else if (line.startsWith('CRASH:')) this.onEvent({ type: 'error', msg: line });
      /* START/OPEN/STOPPED 是诊断信息，不往上报，避免刷屏 */
    }
  }

  _onChunk(b64) {
    let raw;
    try { raw = Buffer.from(b64, 'base64'); } catch { return; }
    if (!raw.length) return;

    this.totalChunks++;
    this.lastChunkAt = Date.now();

    /* 写入环形缓冲（可能跨越尾部，分两段写） */
    const n = raw.length;
    if (n >= RING_BYTES) {
      raw.copy(this.buf, 0, n - RING_BYTES);
      this.writePos = 0;
      this.filled = RING_BYTES;
    } else {
      const tail = RING_BYTES - this.writePos;
      if (n <= tail) {
        raw.copy(this.buf, this.writePos);
      } else {
        raw.copy(this.buf, this.writePos, 0, tail);
        raw.copy(this.buf, 0, tail);
      }
      this.writePos = (this.writePos + n) % RING_BYTES;
      this.filled = Math.min(this.filled + n, RING_BYTES);
    }

    /* ══ VAD ══ */
    let peak = 0;
    for (let k = 0; k + 1 < n; k += 2) {
      const v = Math.abs(raw.readInt16LE(k));
      if (v > peak) peak = v;
    }
    /* 滑动峰值（指数衰减）—— 防单帧爆音把 VAD 掀翻 */
    this.peakSmooth = peak > this.peakSmooth
      ? peak
      : Math.round(this.peakSmooth * 0.8);

    this.onEvent({ type: 'level', peak, smooth: this.peakSmooth });

    const voiced = this.peakSmooth > VOICE_THRESHOLD;
    if (voiced) {
      this.speechMs += CHUNK_MS;
      this.silenceMs = 0;
      if (!this.speaking) {
        this.speaking = true;
        this.onEvent({ type: 'speaking', peak: this.peakSmooth });
      }
    } else {
      this.silenceMs += CHUNK_MS;
      if (this.speaking && this.silenceMs >= 500) {
        this.speaking = false;
        const ms = this.speechMs;
        this.speechMs = 0;
        this.onEvent({ type: 'silence', speechMs: ms });
      }
    }
  }

  /**
   * 取最近 ms 毫秒的音频，返回完整 WAV Buffer。
   *
   * **这是整个 Phase 1 的意义所在**：唤醒词的音频在触发前
   * 就已经躺在缓冲里了，所以取得到 —— 而反应式录音永远取不到。
   *
   * @returns {Buffer|null} WAV 数据；缓冲里没够料时返回 null
   */
  readRecent(ms) {
    const want = Math.min(
      Math.max(Math.floor(ms / 1000 * RATE) * 2, 2),
      RING_BYTES);
    if (this.filled < want) return null;

    const pcm = Buffer.alloc(want);
    /* 从 writePos 往回数 want 字节；可能跨尾部 */
    const start = (this.writePos - want + RING_BYTES) % RING_BYTES;
    if (start + want <= RING_BYTES) {
      this.buf.copy(pcm, 0, start, start + want);
    } else {
      const first = RING_BYTES - start;
      this.buf.copy(pcm, 0, start, RING_BYTES);
      this.buf.copy(pcm, first, 0, want - first);
    }
    return wrapWav(pcm, RATE);
  }

  /** 把最近 ms 毫秒写成 WAV 文件，返回路径（whisper 要文件输入） */
  dumpRecent(ms, outPath) {
    const wav = this.readRecent(ms);
    if (!wav) return null;
    const p = outPath || path.join(TMP_DIR, 'ring_' + Date.now() + '.wav');
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, wav);
      return p;
    } catch { return null; }
  }

  /** 诊断状态 —— 面板和自检用 */
  status() {
    return {
      running: this.running,
      ringSeconds: RING_SECONDS,
      filledSeconds: +(this.filled / 2 / RATE).toFixed(2),
      speaking: this.speaking,
      peakSmooth: this.peakSmooth,
      totalChunks: this.totalChunks,
      /* 超过 2 秒没收到块就是卡住了 —— 明确报出来，
       * 不然又变成"看起来在工作但实际没连上"。 */
      stalled: this.running && this.lastChunkAt > 0
        && Date.now() - this.lastChunkAt > 2000,
    };
  }

  /** 清掉旧的 dump 文件，别把磁盘塞满 */
  cleanup(olderThanMs = 5 * 60 * 1000) {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(TMP_DIR)) {
        if (!/^ring_\d+\.wav$/.test(f)) continue;
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
}

/** PCM 加 44 字节 WAV 头 */
function wrapWav(pcm, rate) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);          // PCM
  hdr.writeUInt16LE(1, 22);          // mono
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28);   // byte rate
  hdr.writeUInt16LE(2, 32);          // block align
  hdr.writeUInt16LE(16, 34);         // bits
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

module.exports = {
  RingBuffer, wrapWav, CS_SOURCE,
  RATE, CHUNK_MS, RING_SECONDS, RING_BYTES, VOICE_THRESHOLD, TMP_DIR,
};
