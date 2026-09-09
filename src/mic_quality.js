'use strict';
/**
 * ══════════════ 麦克风质量自检 + 自适应阈值 ══════════════
 *
 * ══ 为什么需要这个 ══
 *
 * 用户的原话：**「语音交互不应该挑设备」**。
 *
 * 这句话点出了架构缺陷。原来的代码里有三个硬编码的设备假设：
 *
 *   ① WAKE_MIN_CONFIDENCE = 0.90
 *      → 窄带设备上系统识别器只给 0.002-0.107，等于**永久锁死唤醒**
 *   ② 系统 System.Speech 是唯一识别路径
 *      → 窄带下给出「会为贵」conf=0.002，完全不可用
 *   ③ whisper 装好了却只在旁路
 *      → 明明能从同一段音频抓出「维斯」，却用不上
 *
 * 任何一个假设不满足，整个语音功能就归零 —— 这就是"挑设备"。
 *
 * ══ 实测数据（HUAWEI USB-C 耳机，窄带）══
 *
 * 频谱：500Hz=100%  1000Hz=13%  2000Hz=16%  3000Hz=1%  4000Hz=0%
 *   → 3000Hz 以上几乎为零，而「贾」是塞擦音，辨识信息就在 2-4kHz
 *   → 所以两个引擎都只抓到「维斯」，漏掉「贾」
 *
 * 同一段音频：
 *   whisper      「为了维斯」        ← 抓到了
 *   系统识别器   「会为贵」conf=0.002 ← 完全没有
 *
 * ══ 我试过但失败的方案（记录下来免得再犯）══
 *
 * **预加重补偿**（y[n] = x[n] - 0.95*x[n-1]）：
 *   频谱确实改善了：2000Hz 从 16% 提升到 62%（4 倍）
 *   但 whisper 识别**变差**：「为了维斯」→「way way way」
 *
 * 原因：预加重是 MFCC 特征提取的前处理，
 * 而 whisper 内部已经做了自己的前处理（log-Mel），
 * 在外面再加一层反而破坏了它期望的输入分布。
 *
 * **教训：不要在成熟模型的输入端做"想当然"的信号处理。**
 * 4000Hz 以上本来就没信号，放大也放大不出来 ——
 * 带宽是物理限制，软件补不回来。
 *
 * ══ 正确做法 ══
 * 不改音频，改**判定策略**：设备差就降低单次判定的权重，
 * 用第二个引擎交叉确认。质量由实测决定，不写死。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');

/* ══ 设备等级 ══
 *
 * 用 3000Hz 处的相对能量分级 —— 这个频点是关键，
 * 因为汉语塞擦音（j/q/x/zh/ch/sh）的辨识信息主要在 2-4kHz。
 * 实测窄带 USB 耳机在这里是 1%，正常宽带麦克风应有 20% 以上。 */
const GRADES = {
  /* 宽带：高频完整。
   *
   * ⚠ **注意这里的 needWhisperConfirm 是 true，不是 false** ⚠
   *
   * ══ 血的教训：修好音量反而让唤醒彻底失效 ══
   *
   * 原来这里写 needWhisperConfirm:false，理由是"宽带设备系统识别器够准"。
   * 实测把它证伪了，而且代价很大：
   *
   *   1. 麦克风音量从 62% 修到 90%，音频质量真的变好了
   *   2. 频谱分级于是从 unknown 升级成 wideband
   *   3. wideband 关掉了 whisper 兜底，并把阈值抬到 0.85
   *   4. 但这台设备的系统识别器对「贾维斯」只给 conf ≤ 0.043
   *   5. 结果：**修好音量之后，唤醒从"偶尔能成"变成"永远不可能"**
   *
   * 根本错误在于我把两件独立的事当成了因果：
   *   「频谱好」 ≠ 「系统识别器认得出唤醒词」
   * 频谱说明的是**音频通路**质量；
   * 识别率取决于声学模型、口音、发音、语言包 —— 跟频谱没有必然关系。
   *
   * 所以宽带设备也必须保留 whisper 兜底。
   * 代价是每次疑似唤醒多花几秒 CPU；
   * 收益是**功能不会因为"变好"而失效**。这个交换绝对值得。
   *
   * 真正该决定"能不能关兜底"的，是**实测的系统识别器命中率**，
   * 而不是频谱等级 —— 见 recordWakeOutcome()。 */
  wideband: {
    label: '宽带',
    wakeConf: 0.85,           // 系统识别器若真能给高分，这条路更快
    needWhisperConfirm: true, // 但绝不因此关掉兜底
    note: null,
  },
  /* 中等：高频衰减但还有，系统识别器勉强可用，whisper 兜底 */
  medium: {
    label: '中频段衰减',
    wakeConf: 0.45,
    needWhisperConfirm: true,
    note: '高频有衰减，唤醒词会用 whisper 二次确认',
  },
  /* 窄带：高频基本没有（电话音质），系统识别器不可信，
   * 只把它当"可能有人在说话"的触发器，判定全交给 whisper */
  narrowband: {
    label: '窄带（约4kHz，电话音质）',
    wakeConf: 0.10,           // 极低 —— 只用来触发，不用来判定
    needWhisperConfirm: true,
    note: '设备高频缺失，已启用 whisper 兜底；说慢一点识别更准',
  },
  /* 探测失败时的保守默认：假设最差，保证能用。
   * "宁可慢，不可用不了" —— 和「假备用源比没有备用源更危险」同理，
   * 假设设备好而实际差，会导致功能静默失效。 */
  unknown: {
    label: '未探测',
    wakeConf: 0.30,
    needWhisperConfirm: true,
    note: '尚未探测麦克风质量，暂按较宽松策略工作',
  },
};

/* ══════════ 实测唤醒命中率（比频谱更可信的依据）══════════
 *
 * ══ 为什么需要这个 ══
 * 频谱等级只能说明**音频通路**好不好，说明不了
 * **系统识别器认不认得出唤醒词** —— 这两件事没有必然关系。
 *
 * 实测反例：这台设备频谱是 wideband（3kHz 能量 26%），
 * 但系统识别器对「贾维斯」给出的置信度是 0.002 ~ 0.107，
 * 一次都没超过 0.15。用 0.85 当阈值等于永久锁死。
 *
 * 所以真正该决定阈值的是**实测分布**：
 * 记录系统识别器每次给唤醒词打了多少分，
 * 用观测到的上界来判断"这个阈值现实吗"。
 *
 * 这也是「语音交互不应该挑设备」的正确落地方式 ——
 * 不假设设备行为，而是测量它。 */
const _wakeObs = {
  /* 系统识别器在**疑似唤醒**场合给出的置信度样本 */
  confs: [],
  /* whisper 复核确认"确实说了唤醒词"的次数 */
  confirmed: 0,
  /* 其中系统识别器自己也够格的次数 */
  sapiWouldHave: 0,
};

const WAKE_OBS_MAX = 40;

/**
 * 记录一次唤醒观测。
 *
 * @param {number} conf     系统识别器给的置信度
 * @param {boolean} wasReal whisper 是否确认这真的是唤醒词
 */
function recordWakeOutcome(conf, wasReal) {
  if (typeof conf === 'number' && conf >= 0) {
    _wakeObs.confs.push(conf);
    if (_wakeObs.confs.length > WAKE_OBS_MAX) _wakeObs.confs.shift();
  }
  if (wasReal) {
    _wakeObs.confirmed++;
    if (typeof conf === 'number' && conf >= 0.5) _wakeObs.sapiWouldHave++;
  }
}

/**
 * 实测能达到的置信度上界。
 * 用它把"理论阈值"压到"这台设备真的做得到"的水平。
 */
function observedCeiling() {
  if (_wakeObs.confs.length < 3) return null;
  return Math.max(..._wakeObs.confs);
}

function wakeObservations() {
  return {
    samples: _wakeObs.confs.length,
    ceiling: observedCeiling(),
    confirmed: _wakeObs.confirmed,
    sapiWouldHave: _wakeObs.sapiWouldHave,
  };
}

function resetWakeOutcomes() {
  _wakeObs.confs = [];
  _wakeObs.confirmed = 0;
  _wakeObs.sapiWouldHave = 0;
}

/* Goertzel 算法算单频点能量 —— 比完整 FFT 轻得多，
 * 我们只需要几个特定频点，不需要整个频谱。 */
function bandEnergy(samples, rate, f0) {
  if (f0 >= rate / 2) return 0;
  const w = 2 * Math.PI * f0 / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i] + c * s1 - s2;
    s2 = s1; s1 = t;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - c * s1 * s2)) / samples.length;
}

/** 读 16-bit 单声道 WAV */
function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.length < 45) throw new Error('WAV 太短');
  const rate = b.readUInt32LE(24);
  const n = (b.length - 44) >> 1;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { rate, samples: s };
}

/**
 * 分析一段录音，判定设备等级。
 *
 * @returns { grade, gradeInfo, spectrum, peak, hasSignal }
 */
function analyze(wavPath) {
  const { rate, samples } = readWav(wavPath);

  let peak = 0;
  for (const v of samples) { const a = Math.abs(v); if (a > peak) peak = a; }

  /* 没信号就没法判质量 —— 必须区分"设备差"和"没说话"。
   * 把静音误判成"设备差"会永久降低阈值，增加误触发。 */
  if (peak < 0.01) {
    return {
      grade: 'unknown', gradeInfo: GRADES.unknown,
      peak, hasSignal: false,
      why: '录音里没有有效信号（峰值 ' + peak.toFixed(4) + '），无法判定设备质量',
    };
  }

  /* ⚠ 太短的样本不能用来分级 —— 实测踩过这个坑：
   * VAD 提前停止只录到 1 秒的样本，被判成 wideband（3kHz=100%），
   * 而同一个设备用完整样本判出来是 narrowband（3kHz=1%）。
   * 原因是短样本里一个高频冲击（爆音、咔嗒声）就能主导整个频谱。
   *
   * **分级错了比不分级更危险**：把窄带设备误判成宽带，
   * 会启用高阈值 0.85 并关掉 whisper 兜底 → 功能直接归零。
   * 所以宁可返回 unknown（保守策略），也不要基于烂样本下结论。 */
  const durSec = samples.length / rate;
  if (durSec < 1.2) {
    return {
      grade: 'unknown', gradeInfo: GRADES.unknown,
      peak, hasSignal: true, durationSec: +durSec.toFixed(1),
      why: `样本只有 ${durSec.toFixed(1)}s，太短不足以判定频谱（需 ≥1.2s）`
         + '；短样本里一次爆音就能把频谱带偏',
    };
  }

  const freqs = [500, 1000, 2000, 3000, 4000];
  const energies = {};
  for (const f of freqs) {
    if (f < rate / 2) energies[f] = bandEnergy(samples, rate, f);
  }
  const maxE = Math.max(...Object.values(energies));
  const rel = {};
  for (const [f, e] of Object.entries(energies)) {
    rel[f] = maxE > 0 ? e / maxE : 0;
  }

  /* 3000Hz 相对能量是分级依据。
   * 实测：窄带 USB 耳机 = 0.01，正常宽带麦克风应 > 0.20 */
  const hf = rel[3000] != null ? rel[3000] : 0;
  const mid = rel[2000] != null ? rel[2000] : 0;

  let grade;
  if (hf >= 0.20) grade = 'wideband';
  else if (hf >= 0.05 || mid >= 0.40) grade = 'medium';
  else grade = 'narrowband';

  return {
    grade, gradeInfo: GRADES[grade],
    peak, hasSignal: true,
    spectrum: Object.fromEntries(
      Object.entries(rel).map(([f, v]) => [f, Math.round(v * 100)])),
    hf3k: Math.round(hf * 100),
    sampleRate: rate,
    durationSec: +(samples.length / rate).toFixed(1),
  };
}

/* 探测结果缓存 —— 设备不常换，但换了要能发现。
 * 缓存 key 用设备数量+默认设备 id 的简单指纹。 */
let _cached = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 当前生效的策略（没探测过就返回保守默认） */
function currentPolicy() {
  const base = (_cached && Date.now() - _cachedAt < CACHE_TTL_MS)
    ? {
      ...(_cached.gradeInfo), grade: _cached.grade, measured: true,
      spectrum: _cached.spectrum, hf3k: _cached.hf3k,
    }
    : { ...GRADES.unknown, grade: 'unknown', measured: false };

  /* ══ 用实测上界压住理论阈值 ══
   *
   * 实测事故：频谱判成 wideband → 阈值 0.85，
   * 但这台设备的系统识别器对「贾维斯」最高只给 0.107。
   * 阈值高于设备能力上限 = 唤醒永久失效，
   * 而且**表面上一切正常**（没有报错，只是永远不响应）。
   *
   * 所以只要观测到足够样本，就把阈值压到实测上界的 70%：
   * 既保留一定判别力，又保证"设备真的做得到"。 */
  const ceiling = observedCeiling();
  if (ceiling != null && base.wakeConf > ceiling * 0.7) {
    const adjusted = Math.max(ceiling * 0.7, 0.05);
    return {
      ...base,
      wakeConf: +adjusted.toFixed(3),
      /* 压过阈值就必须开兜底 —— 低阈值单独上阵会大量误触发 */
      needWhisperConfirm: true,
      wakeConfCappedFrom: base.wakeConf,
      observedCeiling: +ceiling.toFixed(3),
    };
  }
  return base;
}

/** 记录一次探测结果 */
function recordProbe(result) {
  if (result && result.hasSignal) {
    _cached = result;
    _cachedAt = Date.now();
  }
  return currentPolicy();
}

/** 手动作废缓存（拔插设备后调用） */
function resetProbe() { _cached = null; _cachedAt = 0; }

/**
 * 给面板看的诚实描述 —— 不假装一切正常。
 *
 * 「报错难懂」和「没有报错」一样糟；
 * 「假装设备很好」比「说清楚设备有限制」更有害 ——
 * 用户会以为是贾维斯坏了，而不是设备的物理限制。
 */
function describe() {
  const p = currentPolicy();
  const out = {
    grade: p.grade,
    label: p.label,
    measured: p.measured,
    whisperFallback: p.needWhisperConfirm,
    wakeConfidence: p.wakeConf,
    note: p.note,
  };
  if (p.spectrum) out.spectrum = p.spectrum;
  if (p.hf3k != null) out.highFreq3kPercent = p.hf3k;
  return out;
}

module.exports = {
  analyze, currentPolicy, recordProbe, resetProbe, describe,
  GRADES, bandEnergy, readWav, TMP_DIR, CACHE_TTL_MS,
  /* 实测唤醒命中率 —— 比频谱更可信的阈值依据 */
  recordWakeOutcome, observedCeiling, wakeObservations, resetWakeOutcomes,
};
