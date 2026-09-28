/* A 情绪星球（抽屉详情版）：手写 WebGL1 fbm 湍流星球，零依赖。
 * 表面平静/冷色 = 情绪低迷，沸腾/暖色 = 情绪亢奋；数据经 mount(canvas, score) 传入。
 * 动效纪律：挂 window.AnimGate 共享循环（失焦自动暂停）；reduced-motion 只渲一帧静态。
 * 生命周期：抽屉关闭后 canvas 脱离 DOM，下一帧自检 isConnected=false → 停渲 + loseContext，
 * 不泄漏 GL 上下文（浏览器 WebGL 上下文总数有上限）。 */
(function () {
  "use strict";

  const VS = "attribute vec2 aP; void main(){ gl_Position = vec4(aP,0.,1.); }";
  const FS = [
    "precision highp float;",
    "uniform float uT; uniform vec2 uR; uniform float uV;",
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }",
    "float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);",
    "  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }",
    "float fbm(vec2 p){ float v=0.0,a=0.5; mat2 m=mat2(0.8,0.6,-0.6,0.8);",
    "  for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p*2.02+vec2(3.1,1.7); a*=0.5; } return v; }",
    "void main(){",
    "  vec2 p = (gl_FragCoord.xy*2.0-uR)/min(uR.x,uR.y);",
    "  float t = uT; float v = uV;",
    "  float activity = 0.25 + v*1.6;",
    "  float r = length(p); float R = 0.66;",
    "  vec3 col = vec3(0.0); float alpha = 0.0;",
    "  if(r < R){",
    "    float z = sqrt(R*R - r*r);",
    "    vec3 n = normalize(vec3(p, z));",
    "    float lon = atan(n.z, n.x) + t*0.05*activity;",
    "    vec2 sp = vec2(lon*1.2, n.y*2.0);",
    "    vec2 q;",
    "    q.x = fbm(sp*1.8 + vec2(0.0, t*0.06*activity));",
    "    q.y = fbm(sp*1.8 + vec2(5.2, 1.3) - t*0.04*activity);",
    "    vec2 w;",
    "    w.x = fbm(sp*1.8 + 2.2*q + vec2(1.7, 9.2) + t*0.09*activity);",
    "    w.y = fbm(sp*1.8 + 2.2*q + vec2(8.3, 2.8) - t*0.07*activity);",
    "    float turb = fbm(sp*1.8 + 2.4*w);",
    "    float det = fbm(sp*6.5 + w*2.0 - vec2(t*0.12*activity, 0.0));",
    "    float det2 = noise(sp*14.0 + q*3.0);",
    "    float bands = 0.5 + 0.5*sin(n.y*7.0 + w.x*3.0 + t*0.10*activity);",
    "    bands = pow(bands, 2.0)*0.35;",
    "    vec3 cold = vec3(0.10,0.42,0.62);",
    "    vec3 warm = vec3(0.85,0.62,0.22);",
    "    vec3 hot  = vec3(0.85,0.30,0.22);",
    "    vec3 tint = v < 0.5 ? mix(cold*0.5, cold, v*2.0) : mix(cold, warm, (v-0.5)*2.0);",
    "    tint = mix(tint, hot, smoothstep(0.82, 1.0, v)*0.7);",
    "    vec3 surf = mix(tint*0.35, tint*1.35, clamp(turb*1.6, 0.0, 1.0));",
    "    surf += tint*1.35*pow(det, 3.5)*0.8;",
    "    surf -= tint*0.35*pow(1.0-det2, 6.0)*0.5;",
    "    surf += tint*bands*(0.3+0.7*turb);",
    "    vec3 L = normalize(vec3(-0.55, 0.65, 0.55));",
    "    float dif = 0.30 + 0.70*max(dot(n, L), 0.0);",
    "    vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));",
    "    float spec = pow(max(dot(n, Hv), 0.0), 42.0) * (0.5+activity*0.3);",
    "    float rim = pow(1.0 - n.z, 2.4);",
    "    col = surf*dif + vec3(0.9,0.95,1.0)*spec*0.7 + tint*rim*1.0;",
    "    alpha = 1.0;",
    "  } else {",
    "    float d = r - R;",
    "    float halo1 = exp(-d*22.0)*0.55;",
    "    float halo2 = exp(-d*7.0)*0.22;",
    "    vec3 hc = mix(vec3(0.12,0.50,0.75), vec3(0.85,0.65,0.25), smoothstep(0.55, 1.0, uV));",
    "    col = hc*(halo1 + halo2)*(0.55 + uV*0.6);",
    "    alpha = halo1 + halo2;",
    "  }",
    "  gl_FragColor = vec4(col, alpha);",
    "}"
  ].join("\n");

  /**
   * 挂载星球到 canvas。
   * @param {HTMLCanvasElement} cv 目标画布（需在 DOM 中）
   * @param {number|null} score 情绪值 0-100；null 显示低活动静态
   */
  function mount(cv, score) {
    if (!cv) return;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const uV = Math.max(0, Math.min(1, (score == null || isNaN(score)) ? 0.2 : score / 100));

    let gl = null;
    try { gl = cv.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false }); } catch (e) { gl = null; }
    if (!gl) { cv.style.display = "none"; return; }

    function resize() {
      const r = cv.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      gl.viewport(0, 0, cv.width, cv.height);
    }
    function sh(type, src) {
      const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o);
      return o;
    }
    let uT, uR, uVU;
    try {
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw gl.getProgramInfoLog(pr);
      gl.useProgram(pr);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(pr, "aP"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
      uT = gl.getUniformLocation(pr, "uT"); uR = gl.getUniformLocation(pr, "uR"); uVU = gl.getUniformLocation(pr, "uV");
    } catch (e) { cv.style.display = "none"; return; }

    resize();
    addEventListener("resize", resize);

    const t0 = performance.now();
    let dead = false;
    function draw() {
      /* 抽屉关闭 → canvas 脱离 DOM：停渲并显式丢上下文 */
      if (!cv.isConnected) {
        if (!dead) {
          dead = true;
          removeEventListener("resize", resize);
          const ext = gl.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        }
        return false;
      }
      gl.uniform1f(uT, reduceMotion ? 4.0 : (performance.now() - t0) / 1000);
      gl.uniform2f(uR, cv.width, cv.height);
      gl.uniform1f(uVU, uV);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }
    if (reduceMotion) { draw(); }
    else if (window.AnimGate) {
      if (!window.AnimGate.sharedLoop.isRunning()) window.AnimGate.sharedLoop.start();
      const off = window.AnimGate.register(function () { if (!draw()) off(); });
    } else {
      (function loop() { if (draw()) requestAnimationFrame(loop); })();
    }
  }

  window.MPlanet = { mount: mount };
})();
