/* ════════════════════════════════════════════════════════════════
   voicecore.js — 贾维斯语音晶核（融合形态：声核粒子 + 声纹晶体）

   设计（来自 voiceforms_design.html 选定的「融合·晶核」）：
     内层发光二十面体晶体  = 贾维斯的"核"，安静时低多边晶体缓慢自转
     外层声核粒子球        = 说话时随真实声压呼吸、炸开、转快
     静是晶体，动是声核；两者共用同一旋转轴，是一个物体。

   独立 WebGL2 overlay：不碰星图(#graph / starfield.js)的 context，
   挂在右下角自己的 <canvas> 上。懒加载——首次 setState/setEnergy 或
   start() 才建 GL 上下文，避免页面一打开就占用多个 WebGL context。

   对外 API（window.VOICECORE）：
     VOICECORE.mount(canvasOrId)  绑定 canvas（不传则找 #voicecore-canvas）
     VOICECORE.start()            启动渲染循环（mount 后自动 start）
     VOICECORE.setState('idle'|'listen'|'speak')
     VOICECORE.setEnergy(0..1)    真实麦声压（内部再做平滑）
     VOICECORE.available()        => 是否拿到 WebGL2
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const PALETTE = {
    idle:   { a: [0.14, 0.40, 0.72], b: [0.30, 0.60, 1.00], glow: 0.10,
              pSpin: 0.07, cSpin: 0.09 },
    think:  { a: [0.16, 0.52, 0.86], b: [0.40, 0.74, 1.00], glow: 0.20,
              pSpin: 0.10, cSpin: 0.13 },
    listen: { a: [0.18, 0.70, 0.96], b: [0.55, 0.93, 1.00], glow: 0.42,
              pSpin: 0.16, cSpin: 0.20 },
    speak:  { a: [0.18, 0.88, 0.55], b: [1.00, 0.62, 0.18], glow: 0.95,
              pSpin: 0.30, cSpin: 0.38 },
  };

  const POINT_V = `#version 300 es
precision highp float;
uniform float uTime,uEnergy,uSize,uPersp,uDPR,uSpin;
uniform vec3 uAxis; uniform float uSpread;
in vec3 aPos; in float aSeed;
out float vSeed; out float vDepth;
mat4 rotAxis(vec3 ax,float a){float c=cos(a),s=sin(a),t=1.0-c;vec3 n=normalize(ax);
 return mat4(t*n.x*n.x+c,t*n.x*n.y-s*n.z,t*n.x*n.z+s*n.y,0.,
 t*n.x*n.y+s*n.z,t*n.y*n.y+c,t*n.y*n.z-s*n.x,0.,
 t*n.x*n.z-s*n.y,t*n.y*n.z+s*n.x,t*n.z*n.z+c,0.,0.,0.,0.,1.);}
void main(){vSeed=aSeed;
 /* 转速由 uSpin 从 JS 按状态给定（待机很慢、说话才快），能量只加一点点 */
 float spin=uTime*(uSpin+uEnergy*0.22);
 mat4 R=rotAxis(uAxis,spin);
 vec3 p=aPos;
 float breath=uSpread*0.05*sin(uTime*1.4+aSeed);
 float pulse=uEnergy*uSpread*(0.12+0.10*sin(uTime*9.+aSeed*6.2831));
 float jit=uEnergy*0.05*sin(uTime*13.+aSeed*21.);
 p=p*(1.0+breath+pulse)+normalize(aPos)*jit;
 vec4 wp=R*vec4(p,1.); vDepth=wp.z;
 float persp=1.0/(1.0+wp.z*uPersp);
 gl_Position=vec4(wp.xy*0.60*persp,0.,1.);
 gl_PointSize=uSize*uDPR*(1.+uEnergy*1.5+0.3*sin(uTime*9.+aSeed*6.28)*uEnergy)*(0.8+0.4*aSeed);
}`;
  const POINT_F = `#version 300 es
precision highp float;
uniform vec3 uA,uB; uniform float uEnergy;
in float vSeed; in float vDepth; out vec4 o;
void main(){vec2 d=gl_PointCoord-.5;float r=length(d);if(r>.5)discard;
 float core=smoothstep(.5,.05,r);
 float df=.30+.70*clamp(vDepth+.9,0.,1.)/1.9;
 vec3 col=mix(uA,uB,clamp(uEnergy*.9+vSeed*.15,0.,1.));
 o=vec4(col*(.8+.6*core),core*df*(.5+.5*uEnergy));}`;
  const GLOW_V = `#version 300 es
precision highp float;
uniform float uTime,uEnergy,uScale,uDPR;
void main(){gl_Position=vec4(0.,0.,0.,1.);
 gl_PointSize=uScale*uDPR*(1.+uEnergy*.5+.03*sin(uTime*1.4));}`;
  const GLOW_F = `#version 300 es
precision highp float;
uniform vec3 uA,uB; uniform float uEnergy; out vec4 o;
void main(){vec2 d=gl_PointCoord-.5;float r=length(d);if(r>.5)discard;
 float g=pow(smoothstep(.5,0.,r),2.4);
 vec3 col=mix(uA,uB,clamp(uEnergy,0.,1.));
 o=vec4(col*1.2,g*(.09+.15*uEnergy));}`;

  // 晶体（二十面体）
  const CVS = `#version 300 es
precision highp float;
uniform float uTime,uEnergy; uniform vec3 uAxis; uniform float uSpin;
in vec3 aPos; in float aSeed; out float vSeed; out vec3 vN;
mat4 rot(vec3 ax,float a){float c=cos(a),s=sin(a),t=1.-c;vec3 n=normalize(ax);
 return mat4(t*n.x*n.x+c,t*n.x*n.y-s*n.z,t*n.x*n.z+s*n.y,0.,
 t*n.x*n.y+s*n.z,t*n.y*n.y+c,t*n.y*n.z-s*n.x,0.,
 t*n.x*n.z-s*n.y,t*n.y*n.z+s*n.x,t*n.z*n.z+c,0.,0.,0.,0.,1.);}
void main(){vSeed=aSeed;
 float grow=.40+uEnergy*.22+.03*sin(uTime*2.+aSeed*6.);
 vec3 p=aPos*grow*(1.+uEnergy*.04*sin(uTime*12.+aSeed*17.));
 mat4 R=rot(uAxis,uTime*uSpin);
 vec4 wp=R*vec4(p,1.);vN=normalize(mat3(R)*aPos);
 float persp=1./(1.+wp.z*.2);
 gl_Position=vec4(wp.xy*.62*persp,0.,1.);}`;
  const CFS = `#version 300 es
precision highp float;
uniform vec3 uA,uB; uniform float uEnergy;
in float vSeed; in vec3 vN; out vec4 o;
void main(){
 float light=.55+.45*max(dot(normalize(vN),normalize(vec3(.3,.5,.8))),0.);
 vec3 base=mix(uA,uB,clamp(uEnergy*.7+vSeed*.25,0.,1.));
 vec3 col=base*(.5+.7*light)+uA*0.3;
 o=vec4(col,.05+uEnergy*.10+light*.09);}`;
  const LVS = `#version 300 es
precision highp float;
uniform float uTime,uEnergy; uniform vec3 uAxis; uniform float uSpin;
in vec3 aPos; out vec3 vN;
mat4 rot(vec3 ax,float a){float c=cos(a),s=sin(a),t=1.-c;vec3 n=normalize(ax);
 return mat4(t*n.x*n.x+c,t*n.x*n.y-s*n.z,t*n.x*n.z+s*n.y,0.,
 t*n.x*n.y+s*n.z,t*n.y*n.y+c,t*n.y*n.z-s*n.x,0.,
 t*n.x*n.z-s*n.y,t*n.y*n.z+s*n.x,t*n.z*n.z+c,0.,0.,0.,0.,1.);}
void main(){
 float grow=.40+uEnergy*.22+.03*sin(uTime*2.);
 vec3 p=aPos*grow*(1.+uEnergy*.04*sin(uTime*12.));
 mat4 R=rot(uAxis,uTime*uSpin);
 vec4 wp=R*vec4(p,1.);vN=normalize(mat3(R)*aPos);
 float persp=1./(1.+wp.z*.2);
 gl_Position=vec4(wp.xy*.62*persp,0.,1.);}`;
  const LFS = `#version 300 es
precision highp float;
uniform vec3 uA,uB; uniform float uEnergy; in vec3 vN; out vec4 o;
void main(){float l=.6+.4*max(dot(normalize(vN),normalize(vec3(.3,.5,.8))),0.);
 vec3 col=mix(uB,uA,.15)+uB*.4; o=vec4(col,l*(.6+uEnergy*.4));}`;

  function fibSphere(n, radius) {
    const p = new Float32Array(n * 3), s = new Float32Array(n), ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, rd = Math.sqrt(1 - y * y), th = ga * i;
      p[i * 3] = Math.cos(th) * rd * radius; p[i * 3 + 1] = y * radius; p[i * 3 + 2] = Math.sin(th) * rd * radius;
      s[i] = Math.random();
    }
    return { p, s };
  }

  function icosa() {
    const phi = (1 + Math.sqrt(5)) / 2, V = [
      [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
      [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
      [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1]];
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const verts = [], seed = [];
    F.forEach((fi, k) => fi.forEach(vi => {
      const v = V[vi], l = Math.hypot(v[0], v[1], v[2]);
      verts.push(v[0] / l, v[1] / l, v[2] / l); seed.push((k % 7) / 7 + Math.random() * 0.1);
    }));
    const idx = [];
    for (let f = 0; f < F.length; f++) { const o = f * 3; idx.push(o, o + 1, o + 1, o + 2, o + 2, o); }
    return { verts, seed, edges: new Uint16Array(idx) };
  }

  const api = {
    _gl: null, _cv: null, _state: 'idle', _targetE: 0.1, _E: 0.1,
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

    start() {
      if (this._running || !this._gl) return;
      this._running = true; this._t0 = performance.now();
      // C1 共享调度器：只负责画一帧；排帧交给共享调度器。
      // _running 一旦为 false 本 draw 自动注销，优先级高于页面复活。
      if (!window.AnimGate.sharedLoop.isRunning()) window.AnimGate.sharedLoop.start();
      window.AnimGate.register(function (now) {
        if (!this._running) return false;   // 自动注销
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
      const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); return o; };
      const prog = (v, f) => { const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f));
        gl.linkProgram(p); return p; };
      const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
      this._prog = (t, src) => sh(t, src); this._program = prog; this._buf = buf;

      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

      // 外层粒子
      const sphereP = prog(POINT_V, POINT_F), sphereG = prog(GLOW_V, GLOW_F);
      const { p, s } = fibSphere(380, 1);
      const sBuf = buf(p), sSeed = buf(s);
      this.SP = {
        p: sphereP, g: sphereG, sBuf, sSeed,
        aP: gl.getAttribLocation(sphereP, 'aPos'), aS: gl.getAttribLocation(sphereP, 'aSeed'),
        U: this._locs(sphereP, ['uTime', 'uEnergy', 'uSize', 'uAxis', 'uSpread', 'uPersp', 'uDPR', 'uSpin', 'uA', 'uB']),
        G: this._locs(sphereG, ['uTime', 'uEnergy', 'uScale', 'uDPR', 'uA', 'uB']),
      };
      // 内层晶体
      const { verts, seed, edges } = icosa();
      const cp = prog(CVS, CFS), lp = prog(LVS, LFS);
      const cBuf = buf(new Float32Array(verts)), cSeed = buf(new Float32Array(seed));
      const eib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edges, gl.STATIC_DRAW);
      this.CR = {
        cp, lp, cBuf, cSeed, eib, edgeCount: edges.length,
        aP: gl.getAttribLocation(cp, 'aPos'), aS: gl.getAttribLocation(cp, 'aSeed'),
        lP: gl.getAttribLocation(lp, 'aPos'),
        U: this._locs(cp, ['uTime', 'uEnergy', 'uAxis', 'uSpin', 'uA', 'uB']),
        LU: this._locs(lp, ['uTime', 'uEnergy', 'uAxis', 'uSpin', 'uA', 'uB']),
      };
    },

    _locs(prog, names) {
      const gl = this._gl, o = {};
      names.forEach(n => { o[n] = gl.getUniformLocation(prog, n); });
      return o;
    },

    _attr(buf, loc, size) {
      const gl = this._gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); }
    },

    _frame(t) {
      const gl = this._gl; if (!gl) return;
      this._resize();
      const P = PALETTE[this._state];
      // 无真实声压时的状态底噪：待机很弱、思考轻微、聆听中幅。说话走合成波形。
      const floor = this._state === 'idle' ? 0.08 : this._state === 'think' ? 0.16 : 0;
      this._E += ((Math.max(floor, this._targetE)) - this._E) * (this._targetE > this._E ? 0.32 : 0.08);
      const E = this._E;
      for (let i = 0; i < 3; i++) {
        this._cA[i] += (P.a[i] - this._cA[i]) * 0.08;
        this._cB[i] += (P.b[i] - this._cB[i]) * 0.08;
      }
      const A = this._cA, B = this._cB, dpr = this._dpr || 1;
      // 转速按状态：待机/思考很慢，聆听略快，说话最快；能量再小幅加成。
      const cSpin = P.cSpin + E * 0.10;
      const pSpin = P.pSpin + E * 0.05;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const SP = this.SP, CR = this.CR;

      // 1) 中心柔光
      gl.useProgram(SP.g);
      gl.uniform1f(SP.G.uTime, t); gl.uniform1f(SP.G.uEnergy, E); gl.uniform1f(SP.G.uScale, 96);
      gl.uniform1f(SP.G.uDPR, dpr);
      gl.uniform3fv(SP.G.uA, A); gl.uniform3fv(SP.G.uB, B); gl.drawArrays(gl.POINTS, 0, 1);

      // 2) 内层晶体：半透明面 + 发光棱
      gl.useProgram(CR.cp);
      this._attr(CR.cBuf, CR.aP, 3); this._attr(CR.cSeed, CR.aS, 1);
      gl.uniform1f(CR.U.uTime, t); gl.uniform1f(CR.U.uEnergy, E);
      gl.uniform1f(CR.U.uSpin, cSpin); gl.uniform3f(CR.U.uAxis, 0.4, 1, 0.15);
      gl.uniform3fv(CR.U.uA, A); gl.uniform3fv(CR.U.uB, B);
      gl.drawArrays(gl.TRIANGLES, 0, 60);
      gl.useProgram(CR.lp);
      this._attr(CR.cBuf, CR.lP, 3);
      gl.uniform1f(CR.LU.uTime, t); gl.uniform1f(CR.LU.uEnergy, E);
      gl.uniform1f(CR.LU.uSpin, cSpin); gl.uniform3f(CR.LU.uAxis, 0.4, 1, 0.15);
      gl.uniform3fv(CR.LU.uA, A); gl.uniform3fv(CR.LU.uB, B);
      gl.lineWidth(2); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, CR.eib);
      gl.drawElements(gl.LINES, CR.edgeCount, gl.UNSIGNED_SHORT, 0);

      // 3) 外层声核粒子
      gl.useProgram(SP.p);
      this._attr(SP.sBuf, SP.aP, 3); this._attr(SP.sSeed, SP.aS, 1);
      gl.uniform1f(SP.U.uTime, t); gl.uniform1f(SP.U.uEnergy, E); gl.uniform1f(SP.U.uSize, 3.4);
      gl.uniform1f(SP.U.uSpread, 1.35); gl.uniform1f(SP.U.uPersp, 0.16); gl.uniform1f(SP.U.uDPR, dpr);
      gl.uniform1f(SP.U.uSpin, pSpin);
      gl.uniform3f(SP.U.uAxis, 0.35, 1, 0.2); gl.uniform3fv(SP.U.uA, A); gl.uniform3fv(SP.U.uB, B);
      gl.drawArrays(gl.POINTS, 0, 380);
    },
  };

  window.VOICECORE = api;
})();
