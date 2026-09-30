/* audiobus.js — 统一的真实音频分析总线（浏览器 WebAudio）
 * ─────────────────────────────────────────────────────────
 * 目的：让语音核既能随【贾维斯 TTS 播放】起伏，也能随【用户麦克风】起伏。
 *
 * 纪律：
 *   - 整个页面只建一个 AudioContext（懒建，首次需要时）；
 *   - 同一个 <audio> 元素只接一次 MediaElementSource（重复创建会抛错）；
 *   - 麦克风需用户手势/授权；失败/拒绝 → enableMic 抛出，调用方诚实提示；
 *   - 分析不到（没在播放/没授权）→ read() 返回 0，绝不臆造；
 *   - 不录音、不上传，只在本地读频谱。
 *
 * 对外：window.AudioBus
 *   attachTTS(audioEl)            把 TTS 的 Audio 元素接入分析
 *   async enableMic()            请求并接入麦克风
 *   micEnabled()
 *   read() -> {level, bands:Float32Array(6)}
 * ───────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let ctx = null;
  let ttsAnalyser = null, micAnalyser = null;
  let ttsFreq = null, micFreq = null;
  const attached = new WeakSet();

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持 WebAudio');
    ctx = new AC();
    ttsAnalyser = ctx.createAnalyser();
    ttsAnalyser.fftSize = 256; ttsAnalyser.smoothingTimeConstant = 0.7;
    ttsFreq = new Uint8Array(ttsAnalyser.frequencyBinCount);
    return ctx;
  }

  function attachTTS(audioEl) {
    if (!audioEl || attached.has(audioEl)) return;
    const c = ensureCtx();
    const src = c.createMediaElementSource(audioEl);
    src.connect(ttsAnalyser);
    /* 关键：MediaElementSource 会接管该元素的声音路由，
     * 必须把 analyser 再连到 destination，否则 TTS 会变哑。 */
    ttsAnalyser.connect(c.destination);
    attached.add(audioEl);
  }

  async function enableMic() {
    const c = ensureCtx();
    if (micAnalyser) return true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = c.createMediaStreamSource(stream);
    micAnalyser = c.createAnalyser();
    micAnalyser.fftSize = 256; micAnalyser.smoothingTimeConstant = 0.6;
    src.connect(micAnalyser);
    /* 不连 destination → 避免麦克风回放啸叫 */
    micFreq = new Uint8Array(micAnalyser.frequencyBinCount);
    _micStream = stream;
    return true;
  }
  let _micStream = null;
  function micEnabled() { return !!micAnalyser; }

  /* 取一个 analyser 的电平和 6 频段 */
  function measure(an, freq) {
    an.getByteFrequencyData(freq);
    let sum = 0;
    for (let i = 0; i < freq.length; i++) sum += freq[i];
    const level = Math.min(1, sum / freq.length / 110);
    const bands = new Float32Array(6);
    for (let i = 0; i < 6; i++) {
      let s = 0, c0 = Math.floor(i * freq.length / 6), c1 = Math.floor((i + 1) * freq.length / 6);
      for (let k = c0; k < c1; k++) s += freq[k];
      bands[i] = Math.min(1, s / (c1 - c0) / 130);
    }
    return { level, bands };
  }

  function read() {
    const parts = [];
    /* TTS 与麦克风取能量较大者合并；频段也逐档取大 */
    if (ctx) {
      if (ttsAnalyser) parts.push(measure(ttsAnalyser, ttsFreq));
      if (micAnalyser) parts.push(measure(micAnalyser, micFreq));
    }
    return mergeReads(parts);
  }

  /* 纯函数：把多路 {level,bands} 逐档取大合并；Node 可测 */
  function mergeReads(parts) {
    const out = { level: 0, bands: new Float32Array(6) };
    for (const p of (parts || [])) {
      out.level = Math.max(out.level, p.level);
      for (let i = 0; i < 6; i++) out.bands[i] = Math.max(out.bands[i], p.bands[i]);
    }
    return out;
  }

  window.AudioBus = { attachTTS, enableMic, micEnabled, read, mergeReads };
})();
