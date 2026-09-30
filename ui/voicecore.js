/* ════════════════════════════════════════════════════════════════
   voicecore.js — 贾维斯语音核（点阵团 Cognitive Surface）

   2026-09-30 形态替换：原"声核粒子+二十面体晶体"改为
   与设计预览(_dots_preview.html)一致的**密集点阵软团**：
     · 成千上万个发光点构成脑状软团块；
     · 语音能量(真实音频分析)驱动鼓胀/起伏/局部凸起；
     · 安静时缓缓收拢成稳定团块，仍有缓慢自转。

   独立 WebGL2 overlay：不碰星图(starfield.js)的 context，
   挂在右下角自己的 <canvas> 上。懒加载——mount 才建 GL 上下文。

   对外 API（window.VOICECORE）：
     VOICECORE.mount(canvasOrId)
     VOICECORE.start()
     VOICECORE.setState('idle'|'think'|'listen'|'speak')
     VOICECORE.setEnergy(0..1)     已平滑的能量（音频总线或回退合成）
     VOICECORE.setBands(Float32Array(6)) 6 个频段能量（可选，缺省为0）
     VOICECORE.available()
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* 颜色：主色 + 频段高亮色（说话时局部泛亮） */
  const PALETTE = {
    idle:   { a: [0.55, 0.52, 1.00], b: [0.88, 0.84, 1.00], glow: 0.12, spin: 0.05 },
    think:  { a: [0.45, 0.58, 0.98], b: [0.72, 0.84, 1.00], glow: 0.20, spin: 0.08 },
    listen: { a: [0.40, 0.78, 0.98], b: [0.66, 0.92, 1.00], glow: 0.42, spin: 0.12 },
    speak:  { a: [0.62, 0.55, 1.00], b: [0.92, 0.84, 1.00], glow: 0.90, spin: 0.16 },
  };

  /* ── 点阵顶点（WebGL2 / GLSL ES3.0）── */
  const DOT_V = `#version 300 es
 precision highp float;
 uniform float uTime,uEnergy,uPulse,uDpr;
 uniform vec3 uBands[6];uniform mat4 uView;
 in vec3 aDir;out float vGlow;out float vBand;
 vec3 hash3(vec3 p){p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));
  return fract(sin(p)*43758.5453)*2.-1.;}
 float vnoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  float n=mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)),
                    dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),f.x),
                mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),
                    dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),f.x),f.y),
            mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),
                    dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),f.x),
                mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),
                    dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),f.x),f.y),f.z);
  return n;}
 mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
 void main(){
  vec3 d=normalize(aDir);
  float big=vnoise(d*1.6+vec3(uTime*0.18));
  float mid=vnoise(d*3.4-vec3(uTime*0.25));
  float fine=vnoise(d*7.0+vec3(uTime*0.5));
  float disp=big*(0.13+uEnergy*0.20)+mid*(0.05+uEnergy*0.10)+fine*(0.018+uEnergy*0.05)+uPulse*0.10;
  /* 按方向角映射到 6 频段（ES3 允许动态下标，这里用变量下标） */
  float ang=atan(d.z,d.x);
  int bi=int(floor((ang/6.2831+0.5)*6.0));
  bi=clamp(bi,0,5);
  float bv=uBands[bi].x;
  disp+=bv*0.06*(0.5+0.5*big);
  float rad=0.62+uEnergy*0.10;
  vec3 pos=d*(rad+disp);
  float spin=uTime*(0.05+uEnergy*0.10);
  pos.xz=rot2(spin)*pos.xz;pos.xy=rot2(spin*0.6)*pos.xy;
  gl_Position=uView*vec4(pos,1.0);
  gl_PointSize=(2.4+uEnergy*1.8)*uDpr/(1.0+pos.z*0.15);
  vGlow=clamp(0.62+uEnergy*0.8,0.,1.25);
  vBand=clamp(bv,0.,1.);
 }`;
  const DOT_F = `#version 300 es
 precision highp float;
 uniform vec3 uCol,uCol2;in float vGlow,vBand;out vec4 o;
 void main(){vec2 c=gl_PointCoord-.5;float dd=length(c);if(dd>.5)discard;
  float core=smoothstep(.5,.12,dd);
  vec3 col=mix(uCol,uCol2,vBand)*vGlow;
  o=vec4(col,core*clamp(vGlow,0.,1.)*0.42);}`;

  /* fibonacci 均匀布点（方向） */
  const N = 6000;
  function dotDirs() {
    const d = new Float32Array(N * 3), ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * i;
      d[i * 3] = Math.cos(th) * r; d[i * 3 + 1] = y; d[i * 3 + 2] = Math.sin(th) * r;
    }
    return d;
  }

  /* 标准透视矩阵（near/far），z 平移由 JS 端另给 view 矩阵（与预览一致） */
  function perspective(fov, asp, n, f) {
    const t = 1 / Math.tan(fov / 2);
    return new Float32Array([
      t / asp, 0, 0, 0,
      0, t, 0, 0,
      0, 0, (f + n) / (n - f), -1,
      0, 0, (2 * f * n) / (n - f), 0]);
  }
  function translateZ(z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1]);
  }
  /* 4x4 列序矩阵相乘 a*b */
  function mul4(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  const _viewMat = mul4(perspective(1.0, 1, 0.1, 10), translateZ(-4.0));

  const api = {
    _gl: null, _cv: null, _state: 'idle',
    _targetE: 0, _E: 0, _pulse: 0, _prevRaw: 0,
    _bands: new Float32Array(6),
    _cA: PALETTE.idle.a.slice(), _cB: PALETTE.idle.b.slice(),
    _running: false, _t0: 0,

    available() { return !!this._gl || !!document.createElement('canvas').getContext('webgl2'); },

    mount(target) {
      if (this._cv) return true;
      const cv = typeof target === 'string' ? document.getElementById(target)
        : (target || document.getElementById('voicecore-canvas'));
      if (!cv) return false;
      const gl = cv.getContext('webgl2', { antialias: true, alpha: true });
      if (!gl) { cv.style.display = 'none'; return false; }
      this._cv = cv; this._gl = gl;
      this._build(gl);
      this._resize();
      window.addEventListener('resize', () => this._resize());
      this.start();
      return true;
    },

    setState(s) { if (PALETTE[s]) this._state = s; },
    setEnergy(v) { this._targetE = Math.max(0, Math.min(1, +v || 0)); },
    setBands(b) { if (b && b.length) for (let i = 0; i < 6; i++) this._bands[i] = +b[i] || 0; },

    start() {
      if (this._running || !this._gl) return;
      this._running = true; this._t0 = performance.now();
      if (!window.AnimGate.sharedLoop.isRunning()) window.AnimGate.sharedLoop.start();
      window.AnimGate.register(function (now) {
        if (!this._running) return false;
        this._frame((now - this._t0) / 1000);
        return true;
      }.bind(this));
    },

    _resize() {
      const gl = this._gl, cv = this._cv; if (!gl || !cv) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const r = cv.getBoundingClientRect();
      const w = Math.max(2, Math.floor(r.width * dpr)), h = Math.max(2, Math.floor(r.height * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, cv.width, cv.height);
      this._dpr = dpr;
    },

    _build(gl) {
      const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.log(gl.getShaderInfoLog(o));
        return o; };
      const prog = (v, f) => { const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.log(gl.getProgramInfoLog(p));
        return p; };
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.disable(gl.DEPTH_TEST);

      const p = prog(DOT_V, DOT_F);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, dotDirs(), gl.STATIC_DRAW);
      const aP = gl.getAttribLocation(p, 'aDir');
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      this.DOT = {
        p, aP,
        U: { time: gl.getUniformLocation(p, 'uTime'), energy: gl.getUniformLocation(p, 'uEnergy'),
          pulse: gl.getUniformLocation(p, 'uPulse'), dpr: gl.getUniformLocation(p, 'uDpr'),
          view: gl.getUniformLocation(p, 'uView'), bands: gl.getUniformLocation(p, 'uBands[0]'),
          col: gl.getUniformLocation(p, 'uCol'), col2: gl.getUniformLocation(p, 'uCol2') },
      };
    },

    _frame(t) {
      const gl = this._gl; if (!gl) return;
      this._resize();
      const P = PALETTE[this._state];
      /* 能量：攻击快、释放慢（液态惯性）。回退底噪按状态。 */
      const raw = Math.max(this._targetE, this._state === 'idle' ? 0.05 : 0);
      this._E += (raw - this._E) * (raw > this._E ? 0.4 : 0.08);
      /* onset 脉冲 */
      const onset = Math.max(0, raw - this._prevRaw); this._prevRaw = raw;
      this._pulse = Math.max(this._pulse * 0.82, onset * 1.3);
      for (let i = 0; i < 3; i++) {
        this._cA[i] += (P.a[i] - this._cA[i]) * 0.08;
        this._cB[i] += (P.b[i] - this._cB[i]) * 0.08;
      }
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const D = this.DOT, dpr = this._dpr || 1;
      gl.useProgram(D.p);
      gl.uniformMatrix4fv(D.U.view, false, _viewMat);
      gl.uniform1f(D.U.time, t); gl.uniform1f(D.U.energy, this._E);
      gl.uniform1f(D.U.pulse, this._pulse); gl.uniform1f(D.U.dpr, dpr);
      gl.uniform3fv(D.U.bands, this._bands);
      gl.uniform3fv(D.U.col, this._cA); gl.uniform3fv(D.U.col2, this._cB);
      gl.drawArrays(gl.POINTS, 0, N);
    },
  };

  window.VOICECORE = api;
})();
