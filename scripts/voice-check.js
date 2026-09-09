'use strict';
/**
 * 真人语音端到端验收（需要人配合说话）
 *
 * 为什么单独一个脚本、不放进测试套件：
 * 测试套件必须能无人值守跑（CI / 每次提交），
 * 而这个脚本的**核心价值恰恰在于有人**——
 * TTS 合成语音是"理想输入"，真人说话才有口音、环境噪声、
 * 距离变化、气口停顿。前者全对不代表后者能用。
 *
 * 用法：
 *   node scripts/voice-check.js            自动选设备
 *   node scripts/voice-check.js 1          指定设备 1
 *   node scripts/voice-check.js default    用系统默认输入
 */

const path = require('path');
const fs = require('fs');
const rec = require(path.join(__dirname, '..', 'src', 'mic_record.js'));
const whisper = require(path.join(__dirname, '..', 'src', 'whisper_sidecar.js'));

const ROUNDS = [
  '打开浏览器',
  '贾维斯，现在几点了',
  '帮我看一下今天的大盘情况',
];

/* ══ 为什么必须看 rms dBFS，而不只看 peak（2026-09-09 实测）══
 *
 * 一次排查里，麦克风采到的音频 peak=2924、VAD 也报「检测到语音」，
 * 但 whisper 稳定返回空字符串。当时连查了三个方向都错：
 *   × 以为音量太小 → 数字增益放大 20 倍，依然是空
 *   × 以为 VAD 吞掉了 → vad:false，依然是空
 *   × 以为模型坏了 → 同一模型识别 TTS 文件完全正常（conf 0.93）
 *
 * 真因在电平的**统计量**上，peak 完全看不出来：
 *   TTS 直录文件   rms=2301  → -23 dBFS  ✓ 识别正常
 *   麦克风采集     rms=  51  → -56 dBFS  ✗ 返回空
 * 差 33 dB。peak 只反映瞬时最大值（一次咳嗽就能拉高），
 * rms 才反映整段的有效能量 —— 这才是识别模型实际"听到"的东西。
 *
 * 而数字增益救不回来的原因是第一性的：
 * **放大同时放大信号和噪声，信噪比一点没变，增益不创造信息。**
 *
 * 所以这里必须把 rms dBFS 打出来并给出分档判断。 */
const DBFS_GOOD = -30;   // 优于此值：识别端能正常工作
const DBFS_WEAK = -45;   // 介于两者：偏弱，勉强可用
/* 低于 DBFS_WEAK：基本必然返回空，别再去查模型和 VAD */

/** 读 16bit 单声道 WAV，算 peak / rms / dBFS */
function wavLevel(p) {
  try {
    const b = fs.readFileSync(p);
    let peak = 0, sum = 0, n = 0;
    for (let i = 44; i + 1 < b.length; i += 2) {
      const a = Math.abs(b.readInt16LE(i));
      if (a > peak) peak = a;
      sum += a * a; n++;
    }
    if (!n) return null;
    const rms = Math.sqrt(sum / n);
    return {
      peak,
      rms: Math.round(rms),
      dbfs: rms > 0 ? Number((20 * Math.log10(rms / 32767)).toFixed(1)) : -99,
      seconds: Number((n / rec.RATE).toFixed(2)),
    };
  } catch { return null; }
}

/** 把 dBFS 翻译成人能直接行动的结论 */
function levelVerdict(dbfs) {
  if (dbfs >= DBFS_GOOD) return { grade: 'ok', text: '电平正常' };
  if (dbfs >= DBFS_WEAK) return { grade: 'weak', text: '电平偏弱（识别可能不稳）' };
  return {
    grade: 'bad',
    text: '电平过低（低于 ' + DBFS_WEAK + ' dBFS，识别几乎必然返回空）',
  };
}

function arg() {
  const a = process.argv[2];
  if (!a) return 'auto';
  if (a === 'auto' || a === 'default') return a;
  const n = Number(a);
  return Number.isInteger(n) ? n : 'auto';
}

async function main() {
  console.log('\n═══════ 真人语音验收 ═══════\n');

  /* 1) 先把识别端状态摊开。不可用就没必要让用户白说三句话。 */
  const st = await whisper.status();
  console.log('识别引擎 :', st.engine);
  console.log('模型来源 :', st.modelSource || '(未就绪)');
  if (!st.whisperAvailable || !st.modelCached) {
    console.log('\n✗ 识别端未就绪：' + (st.reason || '未知原因'));
    if (st.installHint) console.log('  安装提示：' + st.installHint);
    process.exit(1);
  }

  /* 2) 设备探测结果也要摊开 —— 用户得知道在录哪个麦克风。
   * 只报"录音成功"而不说是哪个设备，出问题时无法定位。 */
  const want = arg();
  const dev = rec.resolveDevice(want);
  console.log('输入设备 :', dev.name || ('#' + dev.index), '（' + dev.how + '）');
  if (typeof dev.rms === 'number') console.log('底噪 rms :', dev.rms);
  /* 把阈值显式打出来。sawSpeech=false 时用户必须能判断
   * 是"真没说话"还是"阈值设太高" —— 少这一行就得靠猜。 */
  console.log('语音阈值 :', rec.autoThreshold(dev), '（按底噪自适应）');
  console.log('');

  const results = [];
  for (let i = 0; i < ROUNDS.length; i++) {
    const target = ROUNDS[i];
    console.log('── 第 ' + (i + 1) + '/' + ROUNDS.length + ' 句 ──');
    console.log('  请说：「' + target + '」');
    console.log('  （听到提示后开始，说完停顿一下会自动截断）');

    const r = await rec.record({ device: want, maxMs: 8000, silenceMs: 1200 });
    if (!r.ok) {
      console.log('  ✗ 录音失败：' + r.error + '\n');
      results.push({ target, err: r.error });
      continue;
    }
    /* peak 和 sawSpeech 一起报。只报"录到了"没用 ——
     * 静默 5 秒也会"录到"一个全是底噪的文件。 */
    console.log('  录音：peak=' + r.peak + ' 时长=' + r.ms + 'ms'
      + ' 检测到语音=' + (r.sawSpeech ? '是' : '否')
      + ' 截断原因=' + r.stopped);

    /* 电平体检。这一行是「识别返回空」时唯一能直接定位的证据 ——
     * peak 高但 rms 低是最常见的假信号，不打出来就会去误查模型。 */
    const lv = wavLevel(r.path);
    if (lv) {
      const v = levelVerdict(lv.dbfs);
      console.log('  电平：rms=' + lv.rms + ' (' + lv.dbfs + ' dBFS) '
        + (v.grade === 'ok' ? '✓ ' : '⚠ ') + v.text);
      if (v.grade === 'bad') {
        console.log('    → 这是采集端增益问题，不是模型问题。数字放大无效（信噪比不变）。');
        console.log('    → 请到「声音设置 → 输入 → ' + (dev.name || ('设备#' + dev.index))
          + '」把输入音量调高，或把麦克风移近嘴边 5-10cm。');
      }
    }

    if (!r.sawSpeech) {
      /* 关键诊断：peak 明显高于阈值却判静音，说明是阈值/时序问题；
       * peak 也很低才是真的没录到声音。分开说，否则用户会去查驱动。 */
      const hint = r.peak > r.threshold
        ? '（peak ' + r.peak + ' > 阈值 ' + r.threshold
          + '，说话可能太短促，试着说慢一点、长一点）'
        : '（peak ' + r.peak + ' 低于阈值 ' + r.threshold
          + '，请提高麦克风音量或靠近说话）';
      console.log('  ⚠ 未检测到语音 ' + hint + '\n');
      results.push({ target, text: '', noSpeech: true });
      continue;
    }

    const t0 = Date.now();
    const tr = await whisper.transcribe(r.path);
    const ms = Date.now() - t0;
    if (!tr.ok) {
      console.log('  ✗ 识别失败：' + tr.reason + '\n');
      results.push({ target, err: tr.reason });
      continue;
    }
    console.log('  识别：「' + (tr.text || '(空)') + '」'
      + '  conf=' + tr.conf + '  耗时=' + ms + 'ms');
    if (tr.raw) console.log('  清洗前：「' + tr.raw + '」');

    /* 「识别为空」必须给出方向，否则用户（和我）会去乱查模型/VAD。
     * 实测排查路径：先看电平，电平够了再怀疑其它。 */
    if (!tr.text) {
      if (lv && lv.dbfs < DBFS_WEAK) {
        console.log('  → 空结果的原因已定位：电平 ' + lv.dbfs
          + ' dBFS 太低。先解决麦克风增益，别去查模型。');
      } else {
        console.log('  → 电平正常却为空，可能是发音过短被 VAD 整段丢弃。'
          + '短唤醒词场景应传 vad:false。');
      }
    }
    console.log('');
    results.push({ target, text: tr.text, conf: tr.conf, ms, dbfs: lv && lv.dbfs });
  }

  /* 3) 汇总。判定交给人 —— 机器不该替人判断"这算不算听对了"，
   * 因为同义、语序、数字写法都可能"不完全一样但完全正确"。 */
  console.log('═══════ 汇总 ═══════\n');
  for (const r of results) {
    const got = r.err ? ('错误：' + r.err) : ('「' + (r.text || '(空)') + '」');
    console.log('  说「' + r.target + '」→ ' + got
      + (r.conf != null ? '  conf=' + r.conf : '')
      + (r.dbfs != null ? '  ' + r.dbfs + 'dBFS' : ''));
  }
  const ok = results.filter(r => r.text && !r.noSpeech);
  const ms = ok.map(r => r.ms).sort((a, b) => a - b);
  console.log('\n  有效识别 ' + ok.length + '/' + ROUNDS.length
    + (ms.length ? '  延迟中位 ' + ms[Math.floor(ms.length / 2)] + 'ms' : ''));

  /* 电平问题优先说 —— 它会同时压垮所有句子，
   * 在它没解决前调提示词、换模型都是白费。 */
  const dbs = results.map(r => r.dbfs).filter(v => typeof v === 'number');
  if (dbs.length) {
    const worst = Math.max(...dbs);   // 取最好的一次来判断上限
    if (worst < DBFS_WEAK) {
      console.log('\n  ⚠ 首要问题：所有录音电平都低于 ' + DBFS_WEAK + ' dBFS'
        + '（最好一次 ' + worst + '）。');
      console.log('    这是采集增益不足，先解决它 —— 在此之前换模型/调提示词都无效。');
      console.log('    做法：声音设置 → 输入 → 提高输入音量；或换设备：'
        + 'node scripts/voice-check.js <设备号>');
    }
  }

  console.log('\n  请自行判断内容是否正确。若某句一直错，可试：');
  console.log('    · 把该词加进 JARVIS_WHISPER_PROMPT（提示词=先验分布，实测有效）');
  console.log('    · 换设备：node scripts/voice-check.js <设备号>');
  console.log('    · 升档位：JARVIS_WHISPER_MODEL=small（慢 4.5 倍，准确率提升有限）\n');

  rec.cleanup(0);
  whisper.stopWorker();
}

main().catch(e => {
  console.error('\n✗ 崩溃：' + (e && e.stack || e));
  process.exit(1);
});
