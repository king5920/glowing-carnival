'use strict';
/**
 * 一键设备体检（语音"不挑设备"的验收台）
 *
 * ══════ 用户 2026-09-10 决定重启语音 ══════
 * 触发方式最终要"唤醒词 + 按钮"，但在默认常驻监听之前，先用体检回答
 * 最关键的问题：**我这台机器、我的麦，到底行不行？哪个麦行？**
 *
 * 单张 3/3 截图不算数（固定麦、安静、短句、标准普通话 = N=1 理想样本，
 * 正是项目反复警惕的"单次观测下结论"）。体检逐个输入设备：
 *   1) 真实录一段用户说的话（不是静默探测）
 *   2) 信号健康：rms/削波/是否检测到语音
 *   3) 带宽分级：mic_quality.analyze（hf3k，塞擦音信息）
 *   4) 双引擎识别：faster-whisper:base + System.Speech 跑同一段 WAV
 *   5) 延迟：whisper 转写耗时
 *
 * 产出是【证据报告】，不做任何自动启用、不改常驻监听状态。
 * 坏了/没说话/引擎缺失都明说，不把"没采到声音"说成"设备差"。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const mr = require('./mic_record');
const mq = require('./mic_quality');
const whisper = require('./whisper_sidecar');

const TMP_DIR = path.join(os.tmpdir(), 'jarvis-voice');

/* 体检引导句。覆盖：唤醒词、塞擦音密集字（贾/几/今）、日常指令。 */
const DEFAULT_PROMPTS = [
  '贾维斯，现在几点了',
  '帮我看一下今天的大盘情况',
  '打开浏览器',
];

/**
 * 用 System.Speech 识别一个 WAV 文件（听写语法）。
 *
 * 复用 voice.js 的踩坑结论：
 *   - 显式 zh-CN culture，否则语法语言不匹配
 *   - 脚本 UTF-8 无 BOM、不含中文注释（全角标点会破坏 PowerShell 解析）
 *   - SetInputToWaveFile 直接吃文件，不需要重采样到 8kHz
 * 返回 {ok,text,confidence,error}
 */
function recognizeWavSystem(wavPath, { timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    const script =
      "$ErrorActionPreference='Stop'\n" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" +
      "Add-Type -AssemblyName System.Speech\n" +
      "$cn=[System.Globalization.CultureInfo]'zh-CN'\n" +
      "$r=New-Object System.Speech.Recognition.SpeechRecognitionEngine $cn\n" +
      "$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))\n" +
      "$r.SetInputToWaveFile('" + wavPath.replace(/'/g, "''") + "')\n" +
      "$res=$r.Recognize()\n" +
      "if($res){ Write-Output ('TEXT|'+$res.Text+'|'+$res.Confidence) } else { Write-Output 'NONE' }\n" +
      "$r.Dispose()\n";

    let csPath;
    try {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
      csPath = path.join(TMP_DIR, 'chk_' + Date.now() + '.ps1');
      fs.writeFileSync(csPath, script, { encoding: 'utf8' });
    } catch (e) { return resolve({ ok: false, error: '写脚本失败: ' + e.message }); }

    let out = '', err = '';
    let ps;
    try {
      ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', csPath],
        { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: 'spawn 失败: ' + e.message }); }

    ps.stdout.on('data', d => { out += d.toString('utf8'); });
    ps.stderr.on('data', d => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { ps.kill(); } catch {} resolve({ ok: false, error: 'System.Speech 超时' }); }, timeoutMs);
    ps.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(csPath); } catch {}
      const line = out.split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('TEXT|') || s === 'NONE');
      if (line === 'NONE') return resolve({ ok: true, text: '', confidence: null, heard: false });
      const m = /^TEXT\|(.*)\|([\d.]+)$/.exec(line || '');
      if (!m) return resolve({ ok: false, error: (err || out || '无识别输出').trim().slice(0, 150) });
      resolve({ ok: true, text: m[1].trim(), confidence: Number(m[2]), heard: true });
    });
    ps.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

/* 文本归一化：去标点/空白，便于判断"识别对没对" */
function norm(s) {
  return String(s || '').replace(/[\s，。、！？,.!?；;：:"“”'’「」]/g, '');
}
/** 粗略字重合率（不引第三方）：识别文本与期望句的字符集交集占比 */
function similarity(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const setB = new Set(B);
  let hit = 0;
  for (const ch of new Set(A)) if (setB.has(ch)) hit++;
  return hit / new Set(A).size;
}

/**
 * 有序二元组（相邻两字）命中率 —— 比单字集合严格得多。
 *
 * 为什么需要：单看字符集，乱序幻觉「再几点啊下维斯」和提示句
 * 「贾维斯现在几点了」共享 几/点/维/斯 等好几个字，重合率能过 0.5，
 * 但没有任何两个字按原顺序相邻 → bigram 命中接近 0。
 * 用"识别文本里有多少相邻字对也出现在期望句中"衡量"是不是按句念的"。
 */
function bigramScore(heard, prompt) {
  const H = norm(heard), P = norm(prompt);
  if (H.length < 2 || P.length < 2) return 0;
  const pg = new Set();
  for (let i = 0; i + 1 < P.length; i++) pg.add(P.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i + 1 < H.length; i++) if (pg.has(H.slice(i, i + 2))) hit++;
  return hit / (H.length - 1);
}

/** 综合"像不像在念这句提示"：既要有字重合，更要有顺序（bigram） */
function promptMatch(heard, prompt) {
  return Math.min(similarity(heard, prompt), 0.5) / 0.5 * 0.4
    + Math.min(bigramScore(heard, prompt), 0.5) / 0.5 * 0.6;
}

/**
 * 体检单个设备。
 * @param {object} dev {index,name}
 * @param {object} opts {prompts, perPromptMs}
 */
async function checkDevice(dev, opts = {}) {
  const prompts = opts.prompts || DEFAULT_PROMPTS;
  const wavPath = path.join(TMP_DIR, `chk_${dev.index}_${Date.now()}.wav`);

  const rec = await mr.record({
    device: dev.index,
    maxMs: opts.maxMs || 7000,
    silenceMs: 900,
    outPath: wavPath,
  });

  if (!rec.ok || !fs.existsSync(wavPath)) {
    return { device: dev, ok: false, stage: 'record', error: rec.error || '录音失败' };
  }

  /* 信号 + 带宽 */
  let analysis = null;
  try { analysis = mq.analyze(wavPath); } catch (e) { analysis = { error: e.message }; }

  const result = {
    device: dev,
    ok: true,
    recording: {
      ms: rec.ms, peak: rec.peak, sawSpeech: rec.sawSpeech,
      threshold: rec.threshold,
    },
    grade: analysis?.grade || 'unknown',
    gradeLabel: analysis?.gradeInfo?.label || (analysis?.why || '未知'),
    hf3k: analysis?.hf3k ?? null,
    spectrum: analysis?.spectrum || null,
    hasSignal: analysis?.hasSignal !== false,
    wavPath,
  };

  if (!result.hasSignal || rec.sawSpeech === false) {
    result.verdict = 'no_speech';
    result.verdictText = '没采到有效语音（可能没说话/麦被静音），无法判定设备好坏——请按提示再试';
    return result;
  }

  /* 双引擎识别 */
  const engines = {};
  const t0 = Date.now();
  try {
    const w = await whisper.transcribe(wavPath, { vad: false });
    engines.whisper = w.ok
      ? { ok: true, text: w.text || '', ms: Date.now() - t0 }
      : { ok: false, error: w.reason || '不可用', fallback: w.fallback };
  } catch (e) { engines.whisper = { ok: false, error: e.message }; }

  try {
    engines.system = await recognizeWavSystem(wavPath);
  } catch (e) { engines.system = { ok: false, error: e.message }; }

  result.engines = engines;

  /* 综合判定 —— 关键：不能因为 whisper 吐出字就算"可用"。
   *
   * 实测踩到（2026-09-11 安静环境自动体检）：没人说话、只有底噪/键盘声时，
   * HUAWEI 窄带耳机的 VAD 仍判 sawSpeech=是，whisper 幻觉出
   * 「再几点啊；下维斯」，系统识别器 conf=0.00。只看"有没有字"就会把
   * 一段噪声误判成 usable —— 这正是项目反复警惕的"看起来成功其实没连上"。
   *
   * 所以"可用"必须有质量证据，二选一：
   *   ① 系统识别器听清且置信度够（≥0.5）
   *   ② whisper 文本与引导句之一有显著重合（像人话、且在说提示内容）
   * 都不满足但确实出了字 → uncertain（疑似噪声/幻觉），不是 usable。
   */
  const wh = engines.whisper;
  const sy = engines.system;
  const whText = wh && wh.ok ? wh.text : '';
  const whHeard = norm(whText).length >= 2;
  const syHeard = !!(sy && sy.ok && sy.heard && norm(sy.text).length >= 2);
  const syConfident = syHeard && sy.confidence != null && sy.confidence >= 0.5;

  /* 与引导句的最高"在念这句"分。
   * 关键判据是有序 bigram 命中率，不是单字集合：
   * 乱序幻觉「再几点啊下维斯」与「贾维斯现在几点了」单字重合 0.57，
   * 但只有"几点""维斯"两段撞上，bigram 命中 0.33 —— 过不了 0.5。
   * 真正照念时 bigram 命中接近 1。 */
  let bestBigram = 0;
  for (const p of prompts) {
    bestBigram = Math.max(bestBigram, bigramScore(whText, p), syHeard ? bigramScore(sy.text, p) : 0);
  }

  result.quality = {
    whisperHeard: whHeard, systemHeard: syHeard,
    systemConfidence: sy && sy.confidence != null ? +Number(sy.confidence).toFixed(3) : null,
    bestBigram: +bestBigram.toFixed(2),
  };

  /* "可用"的质量证据，二选一：
   *   ① 系统识别器听清且 conf≥0.5
   *   ② whisper/系统文本与某句提示的有序 bigram 命中≥0.5（确实在照念）
   * 单字撞得多但语序乱（典型底噪幻觉）不算。 */
  const looksLikeRealSpeech = syConfident || bestBigram >= 0.5;

  if (syConfident || (whHeard && looksLikeRealSpeech)) {
    result.verdict = 'usable';
    result.verdictText = syConfident
      ? `可用于交互（系统识别器确认：${sy.text.trim()}，conf=${sy.confidence.toFixed(2)}）`
      : `可用于交互（whisper 识别：${whText.trim()}）`;
    if (result.grade === 'narrowband') {
      result.verdict = 'usable_narrow';
      result.verdictText += '；窄带麦高频缺失，唤醒容错低，请说清楚些或换宽带麦';
    }
  } else if (whHeard || syHeard) {
    result.verdict = 'uncertain';
    result.verdictText = '检测到声音但识别质量不足（疑似底噪/远场/没念提示句）：'
      + `whisper「${whText || '—'}」系统conf=${sy && sy.confidence != null ? sy.confidence.toFixed(2) : '—'}`
      + '。请对着麦清楚念提示句后重测，不要据此判断设备可用。';
  } else {
    result.verdict = 'poor';
    result.verdictText = '采到声音但两个引擎都没识别出内容，设备不适合语音交互';
  }

  return result;
}

/**
 * 全机体检：枚举所有输入设备逐个测。
 * @returns {ok, devices:[...], recommended, summary}
 */
async function runCheckup(opts = {}) {
  const list = mr.listDevices();
  if (!list.ok || !list.devices.length) {
    return { ok: false, error: list.error || '没有检测到输入设备', devices: [] };
  }

  /* 可指定只测某几个设备 index；默认全部 */
  let devs = list.devices;
  if (Array.isArray(opts.only) && opts.only.length) {
    devs = devs.filter(d => opts.only.includes(d.index));
  }

  const devices = [];
  for (const d of devs) {
    /* 逐个测，避免两个录音进程同时抢麦 */
    const r = await checkDevice(d, opts);
    devices.push(r);
    if (opts.onDevice) opts.onDevice(r);
  }

  /* 推荐：明确 usable 优先，窄带 usable_narrow 次之；
   * uncertain/poor/no_speech 都不推荐（宁缺毋滥，不能把噪声当合格设备） */
  const rank = { usable: 3, usable_narrow: 2, poor: 1, uncertain: 0, no_speech: 0 };
  const usable = devices
    .filter(d => d.verdict === 'usable' || d.verdict === 'usable_narrow')
    .sort((a, b) => (rank[b.verdict] - rank[a.verdict]));
  const recommended = usable[0]
    ? { index: usable[0].device.index, name: usable[0].device.name, verdict: usable[0].verdict }
    : null;

  return {
    ok: true,
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
    prompts: opts.prompts || DEFAULT_PROMPTS,
    devices,
    recommended,
    summary: recommended
      ? `推荐使用「${recommended.name}」（${recommended.verdict === 'usable' ? '宽带可用' : '窄带可用，需说清楚'}）`
      : '还没有设备通过体检：请对着麦克风清楚念提示句后重测（没念/远场/底噪都不会判合格）',
  };
}

/** 把报告格式化成给用户/模型看的纯文本 */
function formatReport(rep) {
  if (!rep.ok) return '语音体检失败：' + rep.error;
  const L = [];
  L.push('【麦克风设备体检】' + rep.at);
  L.push('请念：' + rep.prompts.join(' / '));
  L.push('');
  rep.devices.forEach((d, i) => {
    L.push(`设备${i + 1} [${d.device.index}] ${d.device.name}`);
    if (!d.ok) { L.push('  ✗ ' + d.error); L.push(''); return; }
    L.push(`  录音 ${d.recording.ms}ms peak=${d.recording.peak} 检测语音=${d.recording.sawSpeech ? '是' : '否'}`);
    L.push(`  带宽分级：${d.gradeLabel}（hf3k=${d.hf3k ?? '?'}%）`);
    if (d.engines) {
      const wh = d.engines.whisper, sy = d.engines.system;
      L.push('  whisper: ' + (wh?.ok ? `「${wh.text}」(${wh.ms}ms)` : '不可用(' + (wh?.error || '') + ')'));
      L.push('  系统识别: ' + (sy?.ok ? (sy.heard ? `「${sy.text}」conf=${sy.confidence?.toFixed(2)}` : '没听清') : '不可用(' + (sy?.error || '') + ')'));
      if (d.quality) L.push(`  质量：有序字对命中 ${d.quality.bestBigram}`);
    }
    L.push('  → ' + d.verdictText);
    L.push('');
  });
  L.push('结论：' + rep.summary);
  L.push('（体检只诊断不启用；要常驻唤醒/按钮说话，确认设备可用后再开启）');
  return L.join('\n');
}

module.exports = {
  runCheckup, checkDevice, recognizeWavSystem,
  formatReport, similarity, bigramScore, promptMatch, norm, DEFAULT_PROMPTS,
};
