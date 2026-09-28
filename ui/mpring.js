/* B 全息环轨（大盘情绪 3D 仪表）
 * 手写 WebGL1 raymarch 圆环，零依赖；数据经 window.__mpRingUpdate(score, phase) 注入，
 * 与 #mpbox 同一帧 /api/market_phase 数据，无独立请求。
 * 动效纪律：挂载 window.AnimGate 共享循环（失焦自动暂停）；reduced-motion 只渲一帧静态。 */
(function () {
  "use strict";
  const cv = document.getElementById("mpRing");
  if (!cv) return;
  const valEl = document.getElementById("mpRingVal");
  const phaseEl = document.getElementById("mpRingPhase");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let uV = 0.28;

  window.__mpRingUpdate = function (score, phase) {
    if (score == null || isNaN(score)) {
      if (valEl) valEl.textContent = "—";
      if (phaseEl) phaseEl.textContent = phase || "待标定";
      return;
    }
    uV = Math.max(0, Math.min(1, score / 100));
    if (valEl) valEl.textContent = Math.round(score);
    if (phaseEl) phaseEl.textContent = phase || "";
  };

  const VS = "attribute vec2 aP; void main(){ gl_Position = vec4(aP,0.,1.); }";
  const FS = [
    "precision highp float;",
    "uniform float uT; uniform vec2 uR; uniform float uV;",
    "float sdTorus(vec3 p, vec2 t){ vec2 q = vec2(length(p.xz)-t.x, p.y); return length(q)-t.y; }",
    "float sdSphere(vec3 p, float r){ return length(p)-r; }",
    "vec2 map(vec3 p){",
    "  float arc = uV*6.28318;",
    "  float na = mod(atan(p.z, p.x) + 3.14159*0.5 + 6.28318, 6.28318);",
    "  float minor = 0.052 + step(na, arc)*0.020;",
    "  float d1 = sdTorus(p, vec2(0.80, minor));",
    "  float m1 = (na < arc) ? 2.0 : 1.0;",
    "  float ang = arc - 3.14159*0.5;",
    "  float d2 = sdSphere(p - vec3(cos(ang)*0.80, 0.0, sin(ang)*0.80), 0.075);",
    "  if(d2 < d1) return vec2(d2, 3.0);",
    "  return vec2(d1, m1);",
    "}",
    "vec3 calcN(vec3 p){ vec2 e = vec2(0.0015, 0.0);",
    "  return normalize(vec3(map(p+e.xyy).x - map(p-e.xyy).x, map(p+e.yxy).x - map(p-e.yxy).x, map(p+e.yyx).x - map(p-e.yyx).x)); }",
    "void main(){",
    "  vec2 uv = (gl_FragCoord.xy*2.0-uR)/min(uR.x,uR.y);",
    "  float spin = sin(uT*0.15)*0.10;",
    "  vec3 ro = vec3(sin(spin)*0.35, 1.02, 1.62);",
    "  vec3 ta = vec3(0.0, -0.02, 0.0);",
    "  vec3 fw = normalize(ta-ro), rt = normalize(cross(fw, vec3(0,1,0))), up = cross(rt, fw);",
    "  vec3 rd = normalize(fw*1.55 + rt*uv.x*1.22 + up*uv.y*1.22);",
    "  float t = 0.0; vec2 h = vec2(1e5, 0.0);",
    "  for(int i=0;i<72;i++){ vec3 p = ro + rd*t; h = map(p); if(h.x < 0.0012 || t > 5.0) break; t += h.x*0.9; }",
    "  if(h.x > 0.002){ gl_FragColor = vec4(0.0); return; }",
    "  vec3 p = ro + rd*t; vec3 n = calcN(p);",
    "  vec3 L = normalize(vec3(-0.5, 0.9, 0.6));",
    "  float dif = max(dot(n, L), 0.0);",
    "  float fre = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);",
    "  vec3 col;",
    "  if(h.y > 2.5){ col = vec3(1.0,0.80,0.34)*(0.9+dif*0.7) + vec3(1.0,0.85,0.5)*fre; }",
    "  else if(h.y > 1.5){",
    "    float prog = mod(atan(p.z, p.x) + 3.14159*0.5 + 6.28318, 6.28318) / max(uV*6.28318, 1e-3);",
    "    vec3 ec = mix(vec3(0.18,0.78,1.05), vec3(0.95,0.74,0.30), prog);",
    "    col = ec*(0.75 + dif*0.55) + ec*fre*0.9;",
    "  } else { col = vec3(0.10,0.16,0.22)*(0.25+dif*0.75) + vec3(0.20,0.45,0.60)*fre*0.55; }",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  let gl = null;
  try { gl = cv.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false }); } catch (e) { gl = null; }
  if (!gl) { cv.style.display = "none"; return; }

  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
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
  /* 面板可折叠、脚本执行时布局可能未稳定：用 ResizeObserver 跟踪舞台真实尺寸，
     避免初始化拿到 0x0 后画布永久停在 1x1（本组件此前因此渲染偏上被裁）。 */
  if (window.ResizeObserver) {
    let lastW = 0, lastH = 0;
    new ResizeObserver(() => {
      const r = cv.getBoundingClientRect();
      if (Math.abs(r.width - lastW) > 1 || Math.abs(r.height - lastH) > 1) {
        lastW = r.width; lastH = r.height;
        if (r.width > 0 && r.height > 0) { resize(); }
      }
    }).observe(cv.parentElement || cv);
  }
  addEventListener("load", function(){ resize(); });
  const t0 = performance.now();
  function draw() {
    gl.uniform1f(uT, reduceMotion ? 4.0 : (performance.now() - t0) / 1000);
    gl.uniform2f(uR, cv.width, cv.height);
    gl.uniform1f(uVU, uV);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (reduceMotion) { draw(); }
  else if (window.AnimGate) {
    if (!window.AnimGate.sharedLoop.isRunning()) window.AnimGate.sharedLoop.start();
    window.AnimGate.register(draw);
  } else {
    (function loop() { draw(); requestAnimationFrame(loop); })();
  }
})();