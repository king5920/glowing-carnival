'use strict';
/**
 * ══════════════ 麦克风音量自愈 ══════════════
 *
 * ══ 为什么需要这个（惨痛的实测经历）══
 *
 * 用户报「喊了贾维斯不能唤醒」，我查了整整三轮，
 * 期间得出过两个**错误结论**：
 *
 *   ① "麦克风输出 100% 削波的垃圾数据"
 *      → 错。是 MCI API 在这台机器上返回假数据。
 *        同一时刻 MCI 报 peak=32641，waveIn 报 peak=1。
 *
 *   ② "华为音频特效 APO 吞掉了音频"
 *      → 错。USB 耳机根本没挂 APO，却是同样结果。
 *
 * 真正的原因简单到离谱：
 *
 *     麦克风输入音量 = 0%（-96 dB，数字静音下限）
 *
 * 一个数字解释了所有现象：
 *   - waveIn 采到 peak=1（几乎纯零）
 *   - SpeechRecognitionEngine 报 AudioState=Silence（它判断正确）
 *   - 把 WAV 直接喂识别器却有 conf=0.995（因为绕过了音量）
 *
 * 用 Core Audio API 设到 100% 后，立刻采到真实语音波形：
 *   seg0 peak=29 | seg1 peak=104 | seg2 peak=308 |
 *   seg3 peak=13381 avg=1440 ← 说话了！| seg4 peak=5513
 *
 * ══ 教训 ══
 * **交叉验证要在第一步做，不是第五步。**
 * 我拿着 MCI 一个工具的读数推了三轮结论，
 * 换一个 API 一次就露馅了。
 * 这和「上证指数拿到平安银行数据」是同一类错误 ——
 * 没验证数据源本身是否可信。
 *
 * ══ 为什么不能只靠用户手动调 ══
 * 音量是**运行时状态**，会被这些操作重置：
 *   - 拔插耳机（切换默认设备）
 *   - 驱动更新 / 系统更新
 *   - 某些应用独占麦克风后释放
 *   - 华为电脑管家的"智慧"调节
 * 所以每次开始监听前都要检查并修正，不能只修一次。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');

/* 目标音量。不用 100% 是因为部分设备在满刻度会引入底噪；
 * 90% 实测已经足够（peak 从 8105 升到 23166）。 */
const TARGET_SCALAR = 0.90;

/* 低于这个值就认为"被静音了"，需要修正。
 * 实测坏掉时是 0.00-0.01，正常说话需要 0.5 以上。 */
const MIN_ACCEPTABLE = 0.30;

/* ══ 为什么还需要第二个、更高的门槛 ══
 *
 * 实测事故：默认采集设备停在 **62%（+2.6dB）**，
 * 高于 MIN_ACCEPTABLE(30%) 所以旧逻辑判定"没问题、不用修"，
 * 但实际采到的语音峰值只有 571（正常应是一两万），
 * A/B/A 三段测试里有声块 2/75 —— 等于采不到人声。
 *
 * 更糟的是：ensureAudible() 在完全没改动音量的情况下
 * 仍然回报"已修"，属于**假修复** ——
 * 本项目早就立过规矩：假修复比不修更危险，
 * 因为它让人以为问题已经解决，从此往错的方向查。
 *
 * 所以拆成两个门槛，各管一件事：
 *   MIN_ACCEPTABLE (30%)  —— "被静音了"，属于故障
 *   MIN_HEALTHY    (85%)  —— "偏低"，能用但采不好，也该顺手抬上去
 *
 * 抬到 90% 没有副作用：这是**采集增益**，不是播放音量，
 * 调高只影响我们自己录到的电平。 */
const MIN_HEALTHY = 0.85;

let _lastFix = 0;
const FIX_COOLDOWN_MS = 30 * 1000;   // 别把这事变成注册表轰炸

function writeUtf8NoBom(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(s, 'utf8'));
}

/* ══ C# 源码：Core Audio IAudioEndpointVolume ══
 *
 * ⚠ 这段 C# 必须是纯 ASCII —— 实测中文会在
 * `powershell.exe -File` 下编码损坏（引号被吞导致语法错误）。
 * 说明写在这个 JS 文件的注释里，不写进 C#。
 *
 * ⚠ 也不能用 `s < n` 这种写法：PowerShell here-string 会把
 * `<` 当重定向。循环条件统一写成 `i != n`。
 */
const CS_SOURCE = `
using System; using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumCo { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEnum {
  int EnumAudioEndpoints(int dataFlow, int mask, out IColl col);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IDev dev);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IColl { int GetCount(out uint c); int Item(uint i, out IDev d); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDev {
  int Activate(ref Guid iid, int cls, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  int OpenPropertyStore(int access, out IPropStore ps);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropStore { int GetCount(out int c); int GetAt(int i, out PKEY k); int GetValue(ref PKEY k, out PROPV v); }
[StructLayout(LayoutKind.Sequential)] struct PKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct PROPV { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IVol {
  int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float db, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float lvl, ref Guid ctx);
  int GetMasterVolumeLevel(out float db);
  int GetMasterVolumeLevelScalar(out float lvl);
  int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float lvl, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float db);
  int GetChannelVolumeLevelScalar(uint ch, out float lvl);
  int SetMute(int mute, ref Guid ctx);
  int GetMute(out int mute);
}
public class MicFix {
  // dataFlow: 0=render(playback) 1=capture(recording); mask 1=DEVICE_STATE_ACTIVE
  //
  // Device names are Chinese. Setting [Console]::OutputEncoding in PowerShell
  // only affects the console, NOT a redirected pipe, so names came back as "?".
  // Fix: write raw UTF-8 bytes to stdout from C#, bypassing the PS encoding layer.
  public static void Emit(string s) {
    var bytes = System.Text.Encoding.UTF8.GetBytes(s);
    var so = Console.OpenStandardOutput();
    so.Write(bytes, 0, bytes.Length);
    so.Flush();
  }
  public static string Run(float target, float minOk, int applyFix) {
    var sb = new System.Text.StringBuilder();
    IEnum e;
    try { e = (IEnum)new EnumCo(); }
    catch (Exception ex) { return "ERR enumerator: " + ex.Message; }
    IColl col;
    if (e.EnumAudioEndpoints(1, 1, out col) != 0) return "ERR EnumAudioEndpoints";
    uint n; col.GetCount(out n);
    sb.Append("devices=" + n + "\\n");
    for (uint i = 0; i != n; i++) {
      IDev d;
      if (col.Item(i, out d) != 0) continue;
      string id = ""; d.GetId(out id);
      string name = "?";
      try {
        IPropStore ps;
        if (d.OpenPropertyStore(0, out ps) == 0) {
          var k = new PKEY();
          k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 2;
          PROPV pv;
          if (ps.GetValue(ref k, out pv) == 0 && pv.p != IntPtr.Zero)
            name = Marshal.PtrToStringUni(pv.p);
        }
      } catch { }
      var iid = typeof(IVol).GUID;
      object o;
      // 23 = CLSCTX_ALL
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) {
        sb.Append("dev" + i + " activate-failed name=" + name + "\\n");
        continue;
      }
      var v = (IVol)o;
      float before; int muteBefore;
      v.GetMasterVolumeLevelScalar(out before);
      v.GetMute(out muteBefore);
      float after = before; int muteAfter = muteBefore; int rc = 0;
      if (applyFix != 0 && (before < minOk || muteBefore != 0)) {
        var ctx = Guid.Empty;
        rc = v.SetMasterVolumeLevelScalar(target, ref ctx);
        v.SetMute(0, ref ctx);
        v.GetMasterVolumeLevelScalar(out after);
        v.GetMute(out muteAfter);
      }
      sb.Append("dev" + i
        + " name=" + name
        + " before=" + Math.Round(before * 100)
        + " after=" + Math.Round(after * 100)
        + " muteBefore=" + muteBefore
        + " muteAfter=" + muteAfter
        + " rc=" + rc
        + "\\n");
    }
    return sb.ToString();
  }
}
`;

/**
 * 检查（可选修正）所有活动录音设备的音量。
 *
 * @param opts.apply  true=真的改音量，false=只读检查
 * @returns { ok, devices: [{index, name, before, after, muted, fixed}], raw }
 */
function checkAndFix(opts = {}) {
  const apply = opts.apply !== false;
  return new Promise(resolve => {
    const csPath = path.join(TMP_DIR, 'micfix.cs');
    const ps1Path = path.join(TMP_DIR, 'micfix.ps1');
    try {
      writeUtf8NoBom(csPath, CS_SOURCE);
      writeUtf8NoBom(ps1Path,
        `Add-Type -Path '${csPath}'\n` +
        /* 用 Emit 而不是 Write-Output：C# 直接写 UTF-8 字节到 stdout，
         * 绕开 PowerShell 的编码转换（否则中文设备名变问号）。 */
        /* 传 MIN_HEALTHY(85%) 而不是 MIN_ACCEPTABLE(30%)：
         * 实测 62% 的设备高于 30% 所以旧逻辑不修，
         * 但实际采到的语音峰值只有 571，等于采不到人声。
         * 采集增益调高没有副作用，该修就修。 */
        `[MicFix]::Emit([MicFix]::Run(${TARGET_SCALAR}, ${MIN_HEALTHY}, ${apply ? 1 : 0}))\n`);
    } catch (e) {
      return resolve({ ok: false, error: '写临时脚本失败: ' + e.message, devices: [] });
    }

    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path],
      { windowsHide: true });

    let out = '', err = '';
    ps.stdout.on('data', d => { out += d.toString('utf8'); });
    ps.stderr.on('data', d => { err += d.toString('utf8'); });

    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, 20000);

    ps.on('close', () => {
      clearTimeout(timer);
      if (/^ERR /m.test(out)) {
        return resolve({ ok: false, error: out.trim().slice(0, 200), devices: [], raw: out });
      }
      const devices = [];
      for (const line of out.split(/\r?\n/)) {
        const m = /^dev(\d+) name=(.*?) before=(-?\d+) after=(-?\d+) muteBefore=(\d+) muteAfter=(\d+) rc=(-?\d+)/.exec(line);
        if (!m) continue;
        const before = Number(m[3]), after = Number(m[4]);
        devices.push({
          index: Number(m[1]),
          name: m[2] || null,
          before, after,
          mutedBefore: m[5] === '1',
          mutedAfter: m[6] === '1',
          /* 真的改动了才算 fixed —— 报告"修好了"但其实没动
           * 比报告失败更有害（和假备用源同一个道理）。 */
          fixed: apply && after > before,
          rc: Number(m[7]),
        });
      }
      if (!devices.length) {
        return resolve({
          ok: false,
          error: '没解析到任何录音设备' + (err ? '；stderr: ' + err.trim().slice(0, 150) : ''),
          devices: [], raw: out,
        });
      }
      const tooLow = devices.filter(d => d.after < MIN_ACCEPTABLE * 100);
      const suboptimal = devices.filter(d => d.after >= MIN_ACCEPTABLE * 100 && d.after < MIN_HEALTHY * 100);
      resolve({
        ok: true,
        devices,
        anyFixed: devices.some(d => d.fixed),
        stillTooLow: tooLow.length ? tooLow.map(d => d.name || ('dev' + d.index)) : null,
        suboptimal: suboptimal.length ? suboptimal.map(d => d.name || ('dev' + d.index)) : null,
        raw: out,
      });
    });

    ps.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'spawn 失败: ' + e.message, devices: [] });
    });
  });
}

/**
 * 开始监听前调用：带冷却的自动修正。
 * 静默失败 —— 修不了也不该阻塞语音启动（系统识别器仍可能工作）。
 */
async function ensureAudible() {
  if (Date.now() - _lastFix < FIX_COOLDOWN_MS) {
    return { ok: true, skipped: 'cooldown' };
  }
  _lastFix = Date.now();
  try {
    return await checkAndFix({ apply: true });
  } catch (e) {
    return { ok: false, error: e.message, devices: [] };
  }
}

/**
 * 给面板/诊断用的只读状态
 *
 * ⚠ 已知限制：设备名目前拿不到（显示为 null）。
 * 试过两种修法都没成功：
 *   1. PowerShell 侧设 [Console]::OutputEncoding=UTF8
 *      → 只影响控制台，不影响重定向的管道
 *   2. C# 侧直接写 UTF-8 字节到 stdout（Emit）
 *      → 还是问号，说明名字在 C# 拿到时**就已经是问号**，
 *        问题在 IPropertyStore/PROPVARIANT 的读取上
 *        （我的 PROPVARIANT 结构没按 vt 类型分支处理）
 *
 * 判断：设备名只用于显示，音量数字才是功能所需，
 * 而音量读写完全正常。不值得为显示名再花时间 ——
 * 用「默认麦克风」+ 索引兜底，把限制写在这里。
 */
async function status() {
  const r = await checkAndFix({ apply: false });
  if (!r.ok) return { ok: false, error: r.error };
  const worst = r.devices.reduce((a, b) => (a && a.before <= b.before ? a : b), null);
  return {
    ok: true,
    devices: r.devices.map(d => ({ name: d.name, volume: d.before, muted: d.mutedBefore })),
    /* 明确告诉用户"静音了"而不是笼统说"语音有问题" ——
     * 「报错难懂」和「没有报错」一样糟。 */
    problem: worst && worst.before < MIN_ACCEPTABLE * 100
      ? `麦克风输入音量只有 ${worst.before}%（${worst.name || '默认设备'}），低于 ${MIN_ACCEPTABLE * 100}% 基本采不到语音`
      : null,
  };
}

module.exports = {
  checkAndFix, ensureAudible, status,
  TARGET_SCALAR, MIN_ACCEPTABLE, MIN_HEALTHY, FIX_COOLDOWN_MS, CS_SOURCE,
};
