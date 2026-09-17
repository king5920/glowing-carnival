/**
 * starfield.js —— 贾维斯中央形象：双层脑（Cortex）
 *
 * 结构借鉴预览版 G_mesh6 的 ② 双层脑，但每个节点都对应真实数据：
 *
 *   外皮层 cortex (r≈0.95)  = 所有记忆节点，球面均布 + linkNear 就近连线
 *   内核 core     (r≈0.40)  = 双星核心(你+贾维斯) + 五星系中枢 + 实体节点
 *   放射连接                = 记忆 → 所属实体 → 星系中枢 → 双星核心
 *
 * 视觉密度 = 真实记忆量。记忆越多，皮层越密，越接近预览版的 Cortex 效果。
 * 记忆不足 30 条时用极小的"占位神经节"(sz=0.40)补皮层骨架，避免早期太空。
 * 占位节点是唯一的装饰性元素，已明确标记 kind='filler'。
 *
 * 教训记录：readPixels 必须在 rAF 内调用，否则帧缓冲已被下一帧 clear，
 * 会误判为"0 像素、没渲染"。之前为此浪费了 6 轮排查。
 */
(function () {
  'use strict';
  const cv = document.getElementById('graph');
  const gl = cv.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) {
    /* 无 WebGL2：不再只 console.error 留一片黑，明确降级到静态示意，
       并告知"对话/记忆不受影响"——坏了明说，不让用户以为整个系统挂了。 */
    console.error('WebGL2 不可用，3D 星图降级为静态示意');
    document.body.classList.add('no-webgl');
    if (window.STAR === undefined) window.STAR = null;
    return;
  }

  const GALAXIES = ['person', 'place', 'event', 'interest', 'project'];
  const GAL_CN = { person: '人物', place: '地点', event: '事件', interest: '兴趣', project: '项目' };

  /* DPR 钳到 1.75（研究建议 1.5–2）：2K/4K 屏下肉眼几乎无差，
     但像素填充量比 DPR=2 少约 23%，星图是常驻动画，这点省电/降温值得。*/
  const DPR = Math.min(devicePixelRatio || 1, 1.75);
  /* 用 var 提升到作用域顶：初始 resize() 在调度器定义之前就会执行，
     此时还不能唤醒 rAF（TDZ），靠这个旗标跳过；调度器就绪后置 true。*/
  var schedulerReady = false;
  function resize() {
    // 按 canvas 自身 CSS 盒尺寸设缓冲，不用 innerWidth——星图只占中央舞台一块
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width * DPR));
    const h = Math.max(1, Math.floor(r.height * DPR));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, cv.width, cv.height);
    /* 初始那次 resize 早于调度器变量初始化（TDZ），不能唤醒；
       首屏由 build 后的 wake('boot') 负责，这里只响应之后的窗口缩放。*/
    if (schedulerReady) wake('resize');
  }
  resize(); addEventListener('resize', resize);

  function sh(t, s) {
    const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(o));
    return o;
  }
  function prog(v, f) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    return p;
  }

  const PN = prog(`#version 300 es
  in vec3 pos; in float act; in float sz; in float hue; in float ring; in float dim;
  uniform mat4 uMVP; uniform float uT,uPulse,uSpread,uWake;
  out float vD; out float vA; out float vHue; out float vRing; out float vCore; out float vIn; out float vSz; out float vDim;
  void main(){
    vec4 cp=uMVP*vec4(pos*uSpread,1.0);
    vD=clamp(1.0-(cp.w-1.2)/2.6,0.05,1.0);
    /* 双星核（你 / 贾维斯，sz=4.4，次大的星系中枢才 2.8）：
       阈值 3.5 只命中这两颗，是全图唯一的冷色能量核。 */
    vCore=step(3.5,sz);
    /* 苏醒波：按节点到球心的归一化半径排相位，核(近)先亮、皮层(远)后亮。
       vIn=该节点"点亮进度" 0未亮→1已亮；uWake 为全局波前(0→1)。 */
    float rad=clamp(length(pos)/1.0,0.0,1.0);
    vIn=clamp((uWake*1.28-rad*1.06)/0.20, 0.0, 1.0);
    vA=act; vHue=hue; vRing=ring; vSz=sz; vDim=dim; gl_Position=cp;
    float br=1.0+0.30*uPulse*sin(uT*2.6+act*11.0+sz*3.0);
    /* 尺寸公式：加性为主，乘性只作用于基础项。
     *
     * 旧写法 (2.0+3.4*vD+6.5*act)*sz*br 有个隐藏放大：
     * 真实节点 sz 大(core 4.4)且 act 高(0.62)，两者相乘 → 约 40px；
     * 骨架 sz 0.78、act 0.26 → 约 2.9px。差 14 倍，
     * 结果几个真实节点像刺一样凸出来（用户指出"太凸出"）。
     *
     * 但第一版修完又过头了：sqrt 压缩太狠 + 线条加粗，
     * 核心节点完全分辨不出来，画面变成"只有线没有点"。
     * 最终取 pow(sz, 0.62)：4.4→2.5、0.78→0.85，差 2.9 倍，
     * 既有层次又不刺眼。基础项也整体上调，保证骨架点看得清。 */
    float s=pow(max(sz,0.05),0.62);
    /* 合并过的记忆额外放大；未被苏醒波扫到的点 vIn=0（开场尚不存在）；
       双星核放大 1.9 倍，暗场里成为清晰的两颗反应炉焦点。 */
    gl_PointSize=(4.6*s + 2.4*vD + 2.2*act)*br*(1.0+0.22*ring)
               *(1.0+0.90*vCore)*vIn;
  }`, `#version 300 es
  precision highp float; in float vD; in float vA; in float vHue; in float vRing; in float vCore; in float vIn; in float vSz; in float vDim;
  uniform float uGlow,uWarm,uT; out vec4 o;
  void main(){
    vec2 d=gl_PointCoord-0.5; float r=length(d);
    float m=1.0-smoothstep(0.0,0.5,r);

    /* ── 语义色相 ──
     * 原来所有节点共享同一个 uWarm 色调，只靠激活度区分明暗，
     * 所以画面上只有"亮点"和"暗点"两种东西 —— 这是单调的根源。
     *
     * 现在 hue 由数据决定（衰减状态 / 节点种类），每颗星带自己的语义：
     *   0.0 冷蓝  = 正在变淡的记忆
     *   0.35 青   = 新鲜记忆
     *   0.6 琥珀  = 实体
     *   1.0 金白  = 核心
     * uWarm 仍然叠加全局情绪，两者相乘而不是互相覆盖。 */
    /* fresh 原为 vec3(0.44,0.93,0.74)（色相 156.7°，落在绿带 [120°,180°]）：
       记忆类别语义在金融仪表盘里会被读成"跌色"，违反 DESIGN.md §1.1 反向纪律。
       改青色 (0.53,0.88,0.95) 色相 190°，与图例 c-person #86e1f3 对齐，
       冷→暖编码保留：褪色蓝(224°)→新鲜青(190°)→实体琥珀→核心金白。 */
    vec3 fade=vec3(0.42,0.55,0.92);
    vec3 fresh=vec3(0.53,0.88,0.95);
    vec3 amber=vec3(1.0,0.74,0.34);
    vec3 gold=vec3(1.0,0.95,0.78);
    vec3 c = vHue<0.35 ? mix(fade,fresh,vHue/0.35)
           : vHue<0.60 ? mix(fresh,amber,(vHue-0.35)/0.25)
                       : mix(amber,gold,(vHue-0.60)/0.40);
    // 全局情绪：唤醒时整体偏暖
    c = mix(c, vec3(1.0,0.72,0.26), uWarm*0.42);
    // 激活时冲向白热
    c = mix(c, vec3(1.0,0.98,0.92), vA*0.80);

    /* ── 明亮常态 ──
       用户偏好：待机时皮层就保持明亮、蓝白饱满、结构点清晰可见，
       不做"压暗周边只剩双核"的暗场聚光。冷核仍保留，但靠自身青白辉光区分，
       不靠把周围压黑。暗场只存在于开场第 0.25s（由苏醒波 vIn 控制点的显隐）。 */
    float dim=1.0;

    /* ── 冷色能量核（仅双星：你 / 贾维斯）──
       冷青白（品牌青 #3fd0ff 一带）覆盖任意语义暖色；紧致辉光 + 白心，
       刻意"小而亮"而非"大而散"，避免糊成一团光雾。 */
    vec3 coreC=vec3(0.70,0.88,1.0);
    c = mix(c, coreC, vCore);
    float breathe=0.88+0.12*sin(uT*2.0);
    float coreGlow=(1.0-smoothstep(0.0,0.40,r))*vCore*breathe;

    /* STAGE4 ??????????/??????????? + additive ???
       ????????????????? draw call????????????? */
    float imp=smoothstep(1.8,3.4,vSz)*(1.0-vCore);
    vec3 impAdd=vec3(0.55,0.80,1.0)*(1.0-smoothstep(0.06,0.5,r))*imp*0.55;

    /* ── 合并光环 ──
     * 吞并过其他记忆的星带一圈缓慢呼吸的环，
     * 让"这里发生过合并"在星图上直接可见（原来只能点开卡片才知道）。 */
    float halo=0.0;
    if(vRing>0.5){
      float rr=0.30+0.06*sin(uT*1.6);
      halo=(1.0-smoothstep(0.0,0.055,abs(r-rr)))*0.55;
    }

    float a = (m*m*(0.85+0.30*vD)*(0.62+0.60*vA) + halo*vRing)*dim
            + coreGlow*coreGlow*(0.62+0.38*vD);
    // 核辉光（冷青白）独立叠加，不被暗场压；中心近白高光做成"反应炉"亮心
    vec3 coreAdd = coreC*coreGlow*coreGlow*1.5*(0.75+0.5*vD)
                 + vec3(0.92,0.97,1.0)*(1.0-smoothstep(0.0,0.16,r))*vCore*1.0;
    /* 苏醒波前闪光：节点刚被点亮(vIn 约 0.35~0.95)时闪一道青白高光，
       像光沿网络传到、把星点逐个引燃。vIn=1 后闪光归零。 */
    float flash=exp(-pow((vIn-0.62)/0.22,2.0));
    vec3 wakeAdd=vec3(0.62,0.82,1.0)*flash*0.9*(1.0-vCore);
    o=vec4((c*uGlow*(1.5+0.9*vD)+vec3(halo*0.8)*dim+coreAdd+wakeAdd+impAdd)*vDim, min(1.0,a)*vDim);
  }`);

  /* 线条：屏幕空间四边形加粗。
   *
   * 为什么不用 gl.lineWidth()？
   * 实测本机 Intel Iris Xe 的 ALIASED_LINE_WIDTH_RANGE = [1, 1]，
   * 也就是硬件只支持 1px 线，gl.lineWidth(2) 会被静默忽略。
   * 这是桌面 GL 驱动的普遍情况，不是可以靠参数解决的。
   *
   * 做法：每条边送 6 个顶点（两个三角形拼成一个四边形），
   * 顶点着色器里先把两个端点投影到裁剪空间，算出屏幕方向的法线，
   * 再按 uThick 沿法线偏移。这样线宽由我们完全控制。
   *
   * 属性说明：
   *   aA / aB  这条边的两个端点（每个顶点都带完整两端，才能算方向）
   *   aSide    -1 或 +1，决定往法线哪一侧偏
   *   aEnd     0 或 1，决定这个顶点落在 A 端还是 B 端
   */
  const PL = prog(`#version 300 es
  in vec3 aA; in vec3 aB; in float aSide; in float aEnd; in float act; in float dim;
  uniform mat4 uMVP; uniform float uSpread, uThick, uAspect, uWake;
  out float vD; out float vA; out float vT; out float vW; out float vDim;
  void main(){
    vec4 pa=uMVP*vec4(aA*uSpread,1.0);
    vec4 pb=uMVP*vec4(aB*uSpread,1.0);
    // 转到 NDC 并按宽高比校正，保证法线在屏幕上是垂直的
    vec2 na=pa.xy/pa.w, nb=pb.xy/pb.w;
    vec2 dir=normalize((nb-na)*vec2(uAspect,1.0));
    vec2 nrm=vec2(-dir.y,dir.x)/vec2(uAspect,1.0);

    vec4 cp = mix(pa, pb, aEnd);
    vD=clamp(1.0-(cp.w-1.2)/2.6,0.05,1.0);
    vA=act;
    /* 苏醒波：两端点都被点亮后这条边才出现（取较小进度）。 */
    float rA=clamp(length(aA)/1.0,0.0,1.0), rB=clamp(length(aB)/1.0,0.0,1.0);
    float inA=clamp((uWake*1.28-rA*1.06)/0.20,0.0,1.0);
    float inB=clamp((uWake*1.28-rB*1.06)/0.20,0.0,1.0);
    vW=min(inA,inB);
    /* vT = 沿边的参数位置（0=A端 1=B端），传给片元做能量流动。
     * 加上端点的世界坐标做相位偏移，否则所有边会同步闪烁像霓虹灯。 */
    vT=aEnd + dot(aA, vec3(1.7, 2.3, 3.1)); vDim=dim;
    // 偏移量随 w 缩放，使线宽在屏幕上恒定（不随距离变细）
    cp.xy += nrm * aSide * uThick * cp.w;
    gl_Position=cp;
  }`,
    `#version 300 es
  precision highp float; in float vD; in float vA; in float vT; in float vW; in float vDim;
  uniform float uGlow,uWarm,uT,uFlow; out vec4 o;
  void main(){
    vec3 cool=vec3(0.34,0.60,1.0), warm=vec3(1.0,0.68,0.24);
    vec3 c=mix(cool,warm,uWarm);

    /* ── 能量沿边流动 ──
     * 一个窄亮带沿着边跑。思考时 uFlow 高、跑得快，
     * 让"正在处理"这件事在整张网上可见，而不只是几个点变亮。
     * 只在激活的边上出现，否则整张网都在流会很吵。 */
    float wave=fract(vT*1.4 - uT*0.55);
    float pulse=exp(-pow((wave-0.5)*7.0,2.0)) * uFlow * (0.25+0.75*vA);
    c += vec3(0.55,0.80,1.0)*pulse*0.85;

    // 线条加粗后总亮度上升明显，透明度要相应下调，否则线会盖过光点。
    // vW：苏醒波到达前整条边透明（开场时边随节点一起从核向外长出）。
    o=vec4(c*uGlow*vDim, ((0.17+0.42*vA)*vD + pulse*0.30)*vW*vDim);
  }`);

  /* ── 矩阵（列主序，配合 uniformMatrix4fv transpose=false） ── */
  const PB = prog(`#version 300 es
  /* ??????3 ??????????z ???????????? */
  void main(){
    vec2 v=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
    gl_Position=vec4(v*2.0-1.0, 0.999, 1.0);
  }`, `#version 300 es
  precision highp float; uniform vec2 uRes; uniform float uT,uWarm,uGlow; out vec4 o;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
               mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x), f.y); }
  float fbm(vec2 p){ float v=0.0,a=0.5;
    for(int i=0;i<3;i++){ v+=a*vnoise(p); p*=2.13; a*=0.5; } return v; }
  void main(){
    vec2 uv=gl_FragCoord.xy/uRes;
    vec2 c=uv-0.5; c.x*=uRes.x/uRes.y;
    float r=length(c);

    /* ????? #0B1526 -> ?? #03060C ?????? --bg #0A1320 ??? */
    vec3 col=mix(vec3(0.043,0.082,0.149), vec3(0.012,0.024,0.047), smoothstep(0.05,0.85,r));

    /* ???????????60s ???????rAF ??????? */
    float n1=fbm(c*2.6+vec2(uT*0.016,-uT*0.006));
    col+=vec3(0.10,0.23,0.36)*pow(n1,2.6)*0.60*smoothstep(1.0,0.15,r);

    /* ?????????????? uWarm ?????? 8% ??? */
    float n2=fbm(c*3.4-vec2(uT*0.011,0.0)+7.31);
    col+=vec3(0.30,0.19,0.08)*pow(n2,3.2)*(0.20+0.45*uWarm)*smoothstep(1.1,0.2,r);

    /* vignette??????????????? */
    col*=1.0-0.38*smoothstep(0.55,1.10,r);
    o=vec4(col,1.0);
  }`);

  const persp = (f, a, n, fa) => { const t = 1 / Math.tan(f / 2);
    return [t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]; };
  function mul(A, B) { const C = new Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + j] * B[i * 4 + k]; C[i * 4 + j] = s; } return C; }
  const rY = a => { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; };
  const rX = a => { const c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; };
  const tr = (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];

  /* ── 状态语义 ──
   * flow = 能量沿边流动的强度。待机时几乎关闭，
   * 否则画面一直在流，反而看不出"什么时候真的在干活"。 */
  const S = {
    /* 明亮常态：待机皮层就饱满清晰（用户偏好）。glow 从原版 .42 提到 .62，
       让蓝白神经球明亮通透；不做全局暖染。开场时另有 intro glow 增益。*/
    idle:   { spin: .10, pulse: .22, glow: .62, warm: .14, spread: 1.00, flow: 0.04 },
    listen: { spin: .38, pulse: .55, glow: .90, warm: .52, spread: 1.06, flow: 0.35 },
    think:  { spin: 1.15, pulse: .95, glow: 1.08, warm: .28, spread: .90, flow: 1.00 },
    speak:  { spin: .62, pulse: 1.55, glow: 1.40, warm: .92, spread: 1.10, flow: 0.80 },
    alert:  { spin: .30, pulse: 1.50, glow: 1.20, warm: 1.00, spread: 1.00, flow: 0.75 },
  };
  const lerp = (a, b, k) => a + (b - a) * k;
  let cur = { ...S.idle }, tgt = S.idle;

  /* ── 苏醒开场（boot wake animation）──
     uWake 0→1 驱动 shader 里的从核向外点亮波。时间线由 playWake() 推进，
     frame() 每帧把 wakeVal 上传给两个 program。reduced-motion 时直接置 1（终态）。 */
  let wakeVal = 0;          // 当前波前值
  let wakeStart = 0;        // performance.now() 起始
  let wakeActive = false;
  const WAKE_MS = 1900;     // 开场总时长
  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ── 图数据 ── */
  let nodes = [], edges = [], act = null, baseAct = null, sizes = null, hues = null, rings = null;
  let contentR = 1.0;
  let bPos, bAct, bSz, bHue, bRing, bEA, bEB, bESide, bEEnd, bEAct, eA, eB, eSide, eEnd, eAct;
  let bDim, bEDim, dimArr = null, eDimArr = null;
  let galHubIdx = {}, semEdges = [], hoverIdx = -1;
  let focRy = 0, focRx = 0, focZ = 1, focTRy = 0, focTRx = 0, focTZ = 1;
  const nameToIdx = new Map();     // 实体名 → 节点索引
  const memToIdx = new Map();      // 记忆 id → 节点索引
  let lastVP = null;               // 最近一帧的 MVP 矩阵（点击拾取要用）
  let lastSpread = 1;              // 最近一帧的 spread（着色器里缩放过坐标，拾取要还原）

  const CORE_R = 0.44;             // 内核半径（对齐预览版 ② 的 0.44）
  const CORTEX_R = 0.95;           // 外皮层半径
  /* 星图整体缩放（2026-09-13 用户：把神经网络弄小点）。
     1 = 撑满舞台；<1 整体缩小（相机推远）。拾取复用 lastVP，
     点击命中会自动跟着缩，无需另改 pick。0.78 ≈ 画面上小一圈并留白。 */
  const BRAIN_SCALE = 0.78;
  /* 点数下限由"轮廓平滑度"决定，不是随手取的。
   *
   * 球面点投影到 2D 后，只有靠近轮廓的一圈点决定视觉边缘。
   * 离线实测（皮层 R=0.95，扁 0.82/0.90）轮廓点数与平均角隙：
   *   130 点 → 25 轮廓点 → 14.4°  明显 20 边形（用户指出"圆形不标准"）
   *   180 点 → 32 轮廓点 → 11.3°
   *   240 点 → 48 轮廓点 →  7.5°  肉眼看不出棱角
   *   320 点 → 59 轮廓点 →  6.1°
   * 阈值取"平均角隙 < 10°"，即 240 点。 */
  const MIN_CORTEX = 240;          // 皮层最少节点数
  const MIN_CORE = 150;            // 内核最少节点数（内核半径小、屏幕占比小，
                                   // 但同样需要足够轮廓点才不显棱角）
  /* 放射连接：内核↔皮层。
   *
   * 预览版 ② 有 35 条。但我们的内核里有真实语义节点（你/贾维斯/中枢/实体），
   * 这些连线在视觉上是"跨层长边"，会横穿球心把两层糊在一起
   * —— 用户明确指出"内圈的神经点和外圈的神经点有线条连接"不好看。
   *
   * 设为 0 = 完全关闭。两层各自独立成球，层次反而更清楚。
   * 语义上的层间关系仍由"记忆→实体"的检索高亮体现，不依赖几何连线。 */
  const RADIAL_EVERY = 0;          // 0 = 不画放射连接
  const LINE_PX = 1.25;            // 线条半宽（设备像素）。硬件 lineWidth 只支持 1px，
                                   // 所以用三角带自己画，这个值可以自由调

  /**
   * 球面网格连线：kNN 对称化 + 局部相对阈值。
   *
   * ══════ 为什么要替换 linkNearIdx ══════
   * 用户看图指出"网格有漏洞、形状不统一"，实测证实且比预想严重：
   *
   *   平均度 2.85（球面三角网理论值≈6）—— 网格只有一半密度
   *   51/130 个点只有 2 度（39%）    —— 这些就是肉眼看到的漏洞
   *   没有一个点达到 maxDeg=5 上限   —— 说明度上限不是瓶颈
   *
   * 旧算法两个结构性缺陷：
   *
   * 1) **全局固定 maxDist**：斐波那契球点间距有 1.70 倍波动
   *    （最小 0.1650 / 最大 0.2811），一个阈值不可能同时适配。
   *
   * 2) **先到先得吃配额**：短边优先 + `deg>=maxDeg 就 continue`，
   *    早处理的点占满名额，后面的点无边可连 → 有的六边形有的三角形。
   *    这正是"形状不统一"的来源。
   *
   * 新算法：**每点主动连自己最近的 k 个邻居，双向取并集**。
   * 每个点都保证拿到邻居，不存在配额竞争。
   * 再用局部相对阈值（以两端点各自的最近邻距离为基准）滤掉异常长边。
   *
   * 实测 130 点：平均度 5.75，弱连点 0，84 个点整齐 6 度，单一连通分量。
   *
   * @param {number[]} idxList  参与连线的节点下标
   * @param {number} k          每点连接的最近邻数量
   * @param {number} rel        相对阈值倍数（边长 <= rel × 两端最近邻距离的较大者）
   */
  function linkSphereMesh(idxList, k, rel) {
    const n = idxList.length;
    if (n < 3) return;
    const P = idxList.map(i => nodes[i].p);
    const dist = (a, b) => {
      const dx = a[0]-b[0], dy = a[1]-b[1], dz = a[2]-b[2];
      return Math.sqrt(dx*dx + dy*dy + dz*dz);
    };

    // 每点的最近邻距离 —— 局部尺度基准
    const nn = new Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d = dist(P[i], P[j]);
        if (d < nn[i]) nn[i] = d;
      }
    }

    /* 用 Set 去重：i→j 和 j→i 会同时命中，这正是"对称化"的含义 ——
     * 只要任一方认为对方是近邻，边就存在。 */
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const ord = [];
      for (let j = 0; j < n; j++) if (j !== i) ord.push([dist(P[i], P[j]), j]);
      ord.sort((a, b) => a[0] - b[0]);
      const take = Math.min(k, ord.length);
      for (let t = 0; t < take; t++) {
        const d = ord[t][0], j = ord[t][1];
        // 局部相对阈值：两端点各自的尺度取较大者，避免跨越稀疏区的长边
        if (d > rel * Math.max(nn[i], nn[j])) continue;
        const key = i < j ? i + ',' + j : j + ',' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([idxList[i], idxList[j]]);
      }
    }
  }

  /**
   * 皮层球面定位：第 gi 个槽位（共 total 个）的坐标。
   *
   * 关键：记忆节点和占位节点**必须调用同一个函数**，否则半径不一致就会凸起。
   *
   * 之前的 bug：记忆用 `CORTEX_R*(0.94+strength*0.10)`（0.94~1.04），
   * 占位用固定 `CORTEX_R*0.95`。strength=1 的记忆比周围外凸 9%，
   * 视觉上就是几个点戳在球面之外（用户指出"外圈出现不规则凸起"）。
   *
   * 现在半径严格恒定，记忆的"强弱"只通过亮度和点大小体现，绝不动几何。
   */
  function cortexPos(gi, total) {
    const y = 1 - (gi / Math.max(1, total - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = gi * 2.39996;
    const rr = CORTEX_R;
    /* 形状系数。原为 y*0.82, z*0.90 —— "略扁像大脑"。
     *
     * 但压扁 18% 会让轮廓变成明显的椭圆，用户看到的就是
     * "圆形不标准"（左侧和右下出现直边段）。
     * 实测 filler 层半径 spread 因此高达 0.1701，而内核只有 0.0436。
     *
     * 改成 0.95/0.97：保留一点点非正球的有机感，
     * 但轮廓在视觉上已经是圆的。 */
    return [Math.cos(th) * r * rr, y * rr * 0.95, Math.sin(th) * r * rr * 0.97];
  }

  /**
   * 用真实数据重建双层脑。
   * data = { entities:[{name,category,memCount}], memories:[{id,entity,category,weight,strength}] }
   */
  function build(data) {
    data = data || {};
    const ents = data.entities || [];
    const mems = data.memories || [];
    nodes = []; edges = []; semEdges = []; nameToIdx.clear(); memToIdx.clear(); hoverIdx = -1;

    /* ═══ 内核：双星核心 ═══ */
    nodes.push({ p: [-0.17, 0, 0], sz: 4.4, name: '你', kind: 'core' });
    nodes.push({ p: [ 0.17, 0, 0], sz: 4.4, name: '贾维斯', kind: 'core' });
    edges.push([0, 1]);

    /* ═══ 内核：五星系中枢 ═══
       落在内核球面上（占据 5 个斐波那契槽位），不再用压扁系数。

       之前写 `[cos(a)*R, sin(a)*R*0.58, sin(a*1.5)*R*0.40]`，
       R 是 CORE_R*0.78 但 y/z 各乘 0.58/0.40，
       实测半径从 0.222 跳到 0.353（spread 0.130）—— 内核根本不是球。 */
    const hubIdx = {};
    const HUB_SLOTS = 5;
    GALAXIES.forEach((g, i) => {
      // 用与 corefill 同一套斐波那契规则，但取中间纬度带（避开两极太挤）
      const t = (i + 0.5) / HUB_SLOTS;          // 0.1, 0.3, 0.5, 0.7, 0.9
      const y = 1 - t * 2;                       // 0.8 .. -0.8
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * 2.39996 + 0.3;
      const R = CORE_R * 0.74;                   // 略小于内核骨架，形成内圈
      hubIdx[g] = nodes.length;
      nodes.push({
        p: [Math.cos(th) * r * R, y * R * 0.95, Math.sin(th) * r * R * 0.97],
        sz: 2.8, name: GAL_CN[g], cat: g, kind: 'galaxy', memCount: 0,
      });
      edges.push([hubIdx[g], Math.cos(th) > 0 ? 1 : 0]);
    });

    /* ═══ 内核：实体节点 ═══
       同样贴在球面上：以所属中枢的方向为基准做小角度偏转，
       而不是在直角坐标里自由偏移。

       之前实体是 `hub.p + [cos*rad, sin*rad*0.85, sin*rad*0.7]`，
       直接在笛卡尔空间加偏移量，半径完全失控
       （实测 spread 0.239，从 0.205 到 0.444）—— 这是"内圈不是圆形"的主因。 */
    galHubIdx = hubIdx;   // STAGE1/3????????? + ??????
    const entIdx = {};
    const perGal = {};
    let entSeq = 0;                             // 全局序号，用于打散经度
    ents.forEach(e => {
      const g = GALAXIES.includes(e.category) ? e.category : 'event';
      const k = (perGal[g] = (perGal[g] || 0) + 1);
      const hub = nodes[hubIdx[g]];
      const R = CORE_R * 0.88;                  // 实体在中枢之外一层，仍是球面

      /* 把中枢方向转成球坐标，再加一个小角度扰动，保证结果仍在半径 R 的球上。
       *
       * 扰动角用全局序号 entSeq 的黄金角，而不是每个星系内部的 k。
       * 用 k 的话，各星系的第 1 个实体都拿到同一个扰动方向，
       * 5 个实体会朝同一侧偏 —— 实测重心偏移 0.135。 */
      const hp = hub.p;
      const hl = Math.hypot(hp[0], hp[1], hp[2]) || 1;
      let theta = Math.atan2(hp[2] / hl, hp[0] / hl);   // 经度
      let phi = Math.acos(Math.max(-1, Math.min(1, hp[1] / hl)));  // 极角
      const ang = (entSeq++) * 2.39996;
      const spread = 0.30 + 0.05 * Math.sqrt(k);        // 弧度级偏转
      theta += Math.cos(ang) * spread;
      phi = Math.max(0.25, Math.min(Math.PI - 0.25, phi + Math.sin(ang) * spread * 0.8));

      const sp = Math.sin(phi);
      const idx = nodes.length;
      nodes.push({
        p: [Math.cos(theta) * sp * R, Math.cos(phi) * R * 0.95, Math.sin(theta) * sp * R * 0.97],
        sz: 1.5 + Math.min(2.2, Math.log10((e.memCount || 0) + 1) * 1.6),
        name: e.name, cat: g, kind: 'entity', memCount: e.memCount || 0,
      });
      edges.push([idx, hubIdx[g]]);
      entIdx[e.name] = idx;
      nameToIdx.set(e.name, idx);
    });

    // 星系中枢大小随该星系记忆数增长
    GALAXIES.forEach(g => {
      const hub = nodes[hubIdx[g]];
      const tot = mems.filter(m => (m.category || 'event') === g).length;
      hub.sz = 2.4 + Math.min(2.2, Math.log10(tot + 1) * 1.3);
      hub.memCount = tot;
    });

    /* ═══ 内核骨架：把内核补成一个真正的球 ═══
       这是"双层脑"之所以是双层的关键。

       之前的错误：我只把真实实体放进内核，5 个实体 + 5 个中枢 + 2 核心 = 12 个点，
       内核几乎是空的，外层 85 个占位球壳把画面全占了 —— 看起来就是一个空心球，
       "双层"完全没体现。用户一眼就看出来了。

       预览版 ② 的做法是内核 70 点 (r=0.44) + 皮层 150 点 (r=1.0)，
       两层都是实心球面，再加 35 条放射连接把两层缝起来。
       这里补齐内核骨架，让它达到 MIN_CORE。 */
    const coreSkelStart = nodes.length;
    const coreReal = nodes.length;   // 已有的真实内核节点数
    const coreFill = Math.max(0, MIN_CORE - coreReal);
    for (let i = 0; i < coreFill; i++) {
      /* 标准斐波那契球，半径恒定。
       *
       * 之前写 `rr = CORE_R * (0.86 + 0.14*((i%3)/2))`，想做"轻微分层"，
       * 但 i%3 让相邻编号的点半径在 0.86/0.93/1.00 之间来回跳。
       * 斐波那契球上相邻编号的点在空间上也相邻，
       * 结果球面被搅成锯齿状 —— 用户指出"内圈不是圆形"。
       *
       * 分层要靠"多个同心球壳"实现（外层整圈一个半径），
       * 而不是让单层球面上的点各自乱抖。这里先做成干净的单层球。 */
      const y = 1 - (i / Math.max(1, coreFill - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * 2.39996;
      const rr = CORE_R;
      // 形状系数与皮层一致（0.95/0.97），两层轮廓才协调
      nodes.push({
        p: [Math.cos(th) * r * rr, y * rr * 0.95, Math.sin(th) * r * rr * 0.97],
        sz: 0.78, kind: 'corefill',
      });
    }
    const coreSkelEnd = nodes.length;

    /* 内核骨架就近连线 → 内核也有网格质感
     *
     * 邻域系数 1.9 是实测反推的结果，不是拍脑袋：
     * 离线复算 50 点内核球的真实最近邻距离，中位 0.1920、最大 0.2018，
     * 而理论值 2R/sqrt(N) = 0.1245。要覆盖最大最近邻需 1.62 倍，
     * 逐档实测 k=1.35→3 条边/45 孤立点、k=1.6→33 边/5 孤立点、
     * k=1.9→96 边/0 孤立点。**1.9 是零孤立点的最小系数。**
     *
     * 我曾误判 1.9 "太大导致内核不圆"而收到 1.25，
     * 结果整图边数从 415 崩到 52，网格几乎全断。
     * 内核不圆的真因是半径抖动（旧 i%3 分层），与邻域半径无关。
     *
     * maxDeg 从 4 提到 6：球面三角网每点平均 6 个邻居。 */
    /* 内核骨架球面网格。
     *
     * 原来用 linkNearIdx（全局固定半径 + 度上限），和皮层是同一个毛病：
     * 逐档试系数（1.35/1.6/1.9）本质是在给"一个阈值适配所有点"打补丁。
     * 曾误判 1.9"太大导致内核不圆"而收到 1.25，结果整图边数从 415 崩到 52。
     * 内核不圆的真因是半径抖动（旧 i%3 分层），与邻域半径无关。
     *
     * 换成 kNN 对称化后不需要调系数：每个点都保证连上最近的邻居。
     * 内核点比皮层密，rel 稍紧一点（1.4）避免穿透球心的短路边。 */
    {
      const cs = [];
      for (let i = coreSkelStart; i < coreSkelEnd; i++) cs.push(i);
      linkSphereMesh(cs, 6, 1.4);
    }

    /* ═══ 外皮层：记忆节点（斐波那契球面均布） ═══
       记忆按类别排序后再铺球面，同类记忆自然落在相邻纬度带上。 */
    const cortexStart = nodes.length;

    const ordered = [];
    GALAXIES.forEach(g => {
      mems.filter(m => (m.category || 'event') === g).forEach(m => ordered.push(m));
    });
    mems.filter(m => !GALAXIES.includes(m.category || 'event')).forEach(m => ordered.push(m));

    /* STAGE5 ??????????? id ??????????????
     * ??????????????????????????????????
     * ?? 100 ? + ??????"?????????"??????
     * ??????????????????????? */
    const CAT_CAP = 100;
    const SLOT_CAP = CAT_CAP * GALAXIES.length + 20;   // 520
    let slotOfMem = null;
    if (window.STARPLUS) {
      const byCat = {};
      ordered.forEach(m => {
        const g = GALAXIES.includes(m.category) ? m.category : 'event';
        (byCat[g] = byCat[g] || []).push(m.id);
      });
      let overflow = false;
      slotOfMem = new Map();
      GALAXIES.forEach((g, gi) => {
        const ids = byCat[g] || [];
        if (ids.length > CAT_CAP) { overflow = true; return; }
        const m2 = window.STARPLUS.assignSlots(ids, CAT_CAP);
        ids.forEach(id => slotOfMem.set(id, gi * CAT_CAP + m2.get(id)));
      });
      if (overflow) slotOfMem = null;
    }

    ordered.forEach((m, i) => {
      const g = GALAXIES.includes(m.category) ? m.category : 'event';
      const st = m.strength == null ? 0.5 : m.strength;
      // 先按自身编号铺开；若后面有占位点，会用共享槽位重排（见 cortexPos 调用）。
      // 半径恒定 —— strength 只影响亮度和点大小，不影响几何位置。
      const idx = nodes.length;
      nodes.push({
        p: slotOfMem ? cortexPos(slotOfMem.get(m.id), SLOT_CAP) : cortexPos(i, Math.max(1, ordered.length)),
        sz: 0.95 + st * 2.0,
        kind: 'memory', memId: m.id, entity: m.entity || null,
        cat: m.category, strength: st,
        /* 供 nodeHue / 光环使用：decayState 决定色相冷暖，
         * mergedCount 决定是否带合并光环。
         * 这两个字段后端 starmap() 已经在返回了，之前前端没用。 */
        decayState: m.decayState || null,
        mergedCount: m.mergedCount || 0,
        retention: m.retention == null ? null : m.retention,
      });
      memToIdx.set(m.id, idx);
      /* STAGE1 ??????? -> ??????? -> ??????
         ????????????? BFS ????? */
      semEdges.push([idx, entIdx[m.entity] != null ? entIdx[m.entity] : hubIdx[g]]);
      /* 语义归属（记忆 → 实体/中枢）**不再画成几何连线**。
       *
       * 这里原本是 `edges.push([idx, entIdx[m.entity] ?? hubIdx[g]])`，
       * 把皮层记忆（R=0.95）直连内核实体（R≈0.39）。
       * 这是真正的"跨层长边"—— 用户看到的斜穿球面的长线就是它，
       * 也是"内圈的神经点和外圈的神经点有线条连接"的根源。
       * 我第一次修时只关了 RADIAL_EVERY，漏掉了这一处，所以长边没消失。
       *
       * 归属关系仍然保留在节点数据里（entity 字段 + memToIdx/nameToIdx），
       * 检索命中时靠 activate() 高亮传播来表达，不依赖几何连线。 */
    });

    /* 占位神经节：记忆不足时补皮层骨架。唯一的装饰性节点，极小极暗。
       关键：必须和记忆节点"共用同一套球面螺旋编号"，插在记忆之间，
       否则 34 个占位点单独铺满球面、3 条记忆挤在别处，linkNear 找不到邻居。 */
    const fill = Math.max(0, MIN_CORTEX - ordered.length);
    const total = ordered.length + fill;

    /* 给记忆分配槽位。
     *
     * 之前用 `Math.floor(k * total / ordered.length)`，即等间隔取槽位
     * （5 条记忆 → 0, 26, 52, 78, 104）。看起来"均匀"，但槽位的经度是
     * `gi * 2.39996`（黄金角），**等差的 gi 会让经度也成等差**，
     * 于是 5 条记忆聚在相近的经度上 ——
     * 实测记忆层重心偏移 0.578（骨架层只有 0.002），
     * 视觉上就是内圈的亮点全挤在一侧、看起来歪。
     *
     * 改用黄金比例做低差异序列分配：frac(k * φ⁻¹) 把 k 映射到 [0,1)
     * 且任意前缀都近似均匀（Weyl 等分布），经度自然散开。 */
    const PHI_INV = 0.6180339887498949;
    const slotOf = (k) => {
      if (ordered.length === 0) return 0;
      const f = (k * PHI_INV) % 1;
      return Math.min(total - 1, Math.floor(f * total));
    };

    // 重排：把已放好的记忆节点按 total 重新分配槽位，再插入占位点
    if (fill > 0 && slotOfMem) {
      /* ??????????????????????????????
         ?????????????????????????? */
      const usedSlots = new Set(slotOfMem.values());
      const freeSlots = [];
      for (let gi = 0; gi < SLOT_CAP; gi++) if (!usedSlots.has(gi)) freeSlots.push(gi);
      const fstep = freeSlots.length / fill;
      for (let k = 0; k < fill; k++) {
        const s = freeSlots[Math.min(freeSlots.length - 1, Math.floor(k * fstep))];
        nodes.push({ p: cortexPos(s, SLOT_CAP), sz: 0.72, kind: 'filler' });
      }
    } else if (fill > 0) {
      const used = new Set();
      for (let k = 0; k < ordered.length; k++) {
        let gi = slotOf(k);
        while (used.has(gi)) gi = (gi + 1) % total;   // 撞槽就顺移
        used.add(gi);
        nodes[cortexStart + k].p = cortexPos(gi, total);
      }
      // 占位点填进剩余槽位
      for (let gi = 0; gi < total; gi++) {
        if (used.has(gi)) continue;
        nodes.push({ p: cortexPos(gi, total), sz: 0.72, kind: 'filler' });
      }
    }

    /* 皮层球面网格 —— Cortex "神经网"纹理的来源。
     *
     * 用 kNN 对称化而非固定半径：用户看图发现"网格有漏洞、形状不统一"，
     * 实测旧算法平均度只有 2.85（理论值≈6）、51/130 点只有 2 度。
     * 详见 linkSphereMesh 的注释。
     *
     * k=6 是球面三角网的理论邻居数（欧拉公式：平均度趋近 6）。
     * rel=1.45 由实测选定：
     *   1.45 → 平均度 5.75，最长边/中位 1.25，无弱连点
     *   放宽到 kNN 无过滤 → 平均度 6.22 但最长/中位 1.38，出现刺眼长边
     * 取 1.45 在"网格完整"和"没有跨区长边"之间。 */
    const cortexEnd = nodes.length;
    const cn = [];
    for (let i = cortexStart; i < cortexEnd; i++) cn.push(i);
    linkSphereMesh(cn, 6, 1.45);

    /* ═══ 放射连接：把内核和皮层缝起来 ═══
       预览版 ② 有 35 条（`for(let i=0;i<70;i+=2) edges.push([i, 70+((i*7)%150)])`）。

       但预览版的内核是纯装饰点阵，我们的内核里有真实语义节点，
       这些跨层长边会横穿球心把两层糊在一起。
       RADIAL_EVERY=0 时完全关闭，两层各自独立成球，层次更清楚。 */
    if (RADIAL_EVERY > 0 && cn.length > 0) {
      const coreAll = [];
      for (let i = 0; i < coreSkelEnd; i++) {
        const k = nodes[i].kind;
        if (k === 'core' || k === 'galaxy' || k === 'entity' || k === 'corefill') coreAll.push(i);
      }
      for (let i = 0; i < coreAll.length; i += RADIAL_EVERY) {
        const target = cn[(i * 7) % cn.length];
        edges.push([coreAll[i], target]);
      }
    }

    /* ═══ 背景星尘（极少，只做景深） ═══ */
    for (let i = 0; i < 18; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const R = 1.45 + Math.random() * 0.35;
      nodes.push({
        p: [R*Math.sin(ph)*Math.cos(th), R*Math.sin(ph)*Math.sin(th)*0.6, R*Math.cos(ph)],
        sz: 0.24, kind: 'dust',
      });
    }

    /* ═══ 上传 GPU ═══ */
    const N = nodes.length;
    const nPos = new Float32Array(N * 3);
    sizes = new Float32Array(N);
    act = new Float32Array(N);
    hues = new Float32Array(N);
    rings = new Float32Array(N);
    baseAct = new Float32Array(N);   // 各节点底光缓存（按需渲染判定用，避免每帧重算）
    nodes.forEach((n, i) => {
      nPos[i*3]=n.p[0]; nPos[i*3+1]=n.p[1]; nPos[i*3+2]=n.p[2]; sizes[i]=n.sz;
      act[i] = baseGlow(n);
      baseAct[i] = act[i];
      hues[i] = nodeHue(n);
      rings[i] = (n.mergedCount > 0) ? 1 : 0;
    });

    /* 边缓冲：每条边 6 个顶点（两个三角形拼成加粗四边形）。
     * 每个顶点都要带上两个端点坐标，才能在着色器里算屏幕方向。
     *   顶点顺序: (0,-1) (1,-1) (0,+1)  |  (1,-1) (1,+1) (0,+1)
     * 其中第一个数是 aEnd（落在 A 端还是 B 端），第二个是 aSide（法线偏向）。 */
    const E = edges.length;
    const QUAD = [[0,-1],[1,-1],[0,1],[1,-1],[1,1],[0,1]];
    eA = new Float32Array(E * 6 * 3);
    eB = new Float32Array(E * 6 * 3);
    eSide = new Float32Array(E * 6);
    eEnd = new Float32Array(E * 6);
    eAct = new Float32Array(E * 6);
    edges.forEach((e, i) => {
      const a = nodes[e[0]].p, b = nodes[e[1]].p;
      for (let v = 0; v < 6; v++) {
        const o = (i * 6 + v) * 3;
        eA[o]=a[0]; eA[o+1]=a[1]; eA[o+2]=a[2];
        eB[o]=b[0]; eB[o+1]=b[1]; eB[o+2]=b[2];
        eEnd[i*6+v]  = QUAD[v][0];
        eSide[i*6+v] = QUAD[v][1];
      }
    });

    if (!bPos) { bPos=gl.createBuffer(); bAct=gl.createBuffer(); bSz=gl.createBuffer();
                 bHue=gl.createBuffer(); bRing=gl.createBuffer();
                 bEA=gl.createBuffer(); bEB=gl.createBuffer();
                 bESide=gl.createBuffer(); bEEnd=gl.createBuffer(); bEAct=gl.createBuffer(); bDim=gl.createBuffer(); bEDim=gl.createBuffer(); }
    gl.bindBuffer(gl.ARRAY_BUFFER,bPos); gl.bufferData(gl.ARRAY_BUFFER,nPos,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bSz);  gl.bufferData(gl.ARRAY_BUFFER,sizes,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bHue); gl.bufferData(gl.ARRAY_BUFFER,hues,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bRing);gl.bufferData(gl.ARRAY_BUFFER,rings,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bEA);  gl.bufferData(gl.ARRAY_BUFFER,eA,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bEB);  gl.bufferData(gl.ARRAY_BUFFER,eB,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bESide);gl.bufferData(gl.ARRAY_BUFFER,eSide,gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bEEnd); gl.bufferData(gl.ARRAY_BUFFER,eEnd,gl.STATIC_DRAW);
    /* STAGE1 ??????? 1????????????? 1.0/0.45/0.12 ?? */
    dimArr = new Float32Array(N).fill(1);
    eDimArr = new Float32Array(E * 6).fill(1);
    gl.bindBuffer(gl.ARRAY_BUFFER,bDim); gl.bufferData(gl.ARRAY_BUFFER,dimArr,gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,bEDim); gl.bufferData(gl.ARRAY_BUFFER,eDimArr,gl.DYNAMIC_DRAW);

    let maxR = 0.5;
    nodes.forEach(n => { if (n.kind !== 'dust')
      maxR = Math.max(maxR, Math.hypot(n.p[0], n.p[1], n.p[2])); });
    contentR = maxR;
    wake('build');   // 重建（新记忆/新星）后把画面重新画出来
  }

  /** 每类节点的底光（不会衰减到全黑） */
  function baseGlow(n) {
    switch (n.kind) {
      // 真实节点靠"亮"而不是靠"大"来突出。
      // 用尺寸拉层次会重现"某些点太凸出"的问题（用户已指出过一次），
      // 亮度差异在视觉上同样清晰，但不会破坏球面的均匀感。
      case 'core':   return 0.95;
      case 'galaxy': return 0.70;
      case 'entity': return 0.58;
      case 'memory': return 0.40 + (n.strength || 0.5) * 0.35;
      // 骨架节点亮度对齐预览版 ②：它每个节点都是清晰亮点，
      // 密集点阵本身就是"神经网"的质感来源。
      case 'corefill': return 0.26;   // 内核骨架略亮，因为被外层遮挡
      case 'filler':   return 0.22;
      default:         return 0.10;   // dust
    }
  }

  /**
   * 节点的语义色相 [0,1]。
   *
   * ══════ 为什么要有这个 ══════
   * 原来所有节点共享同一个全局 uWarm 色调，只靠激活度区分明暗，
   * 画面上只有"亮点"和"暗点"两种东西 —— 用户说"界面很单调"，
   * 根源就在这里：**数据里已有的差异一个都没画出来**。
   *
   * 现在色相承载真实语义，不是随机上色：
   *
   *   0.00 冷蓝  正在变淡的记忆（retention < 0.6）
   *   0.20 蓝青  正常记忆
   *   0.35 青    新鲜记忆（retention >= 0.9）
   *   0.60 琥珀  实体（人/项目/地点）
   *   0.85 金    星系（五大类别）
   *   1.00 金白  核心
   *
   * 记忆用冷→暖表达"新鲜度"，实体和核心用暖色表达"结构性"。
   * 这样一眼能看出：哪些记忆在褪色、结构骨架在哪里。
   */
  function nodeHue(n) {
    switch (n.kind) {
      case 'core':   return 1.0;
      case 'galaxy': return 0.85;
      case 'entity': return 0.60;
      case 'memory': {
        /* ══════ 为什么不直接用 decayState 的三档 ══════
         *
         * 第一版按 decayState 分三档（fading/normal/fresh），
         * 实测发现 **57 条记忆全是 fresh**，retention 全在
         * 0.9753~0.9999 之间 —— 三档压成一档，画面上只有一种颜色，
         * 界面不会比之前丰富。
         *
         * 记忆库还年轻，衰减要几周才显现。"等几周就好了"不是答案。
         *
         * 改用**类别基色 + retention 连续微调**：
         *   ① 类别决定基色 —— 这个维度一直存在，不依赖时间流逝
         *   ② retention 在窄区间内也映射出可见差异
         *
         * 这样即使全部 fresh，画面也有真实层次；
         * 等衰减真的发生（retention < 0.6），会明显偏冷蓝。 */
        const rt = n.retention == null ? 0.95 : n.retention;
        if (rt < 0.6) return 0.02;                    // 明显褪色 → 冷蓝，压过类别

        // 五大类别各占一段色相，人物偏暖、事件偏冷
        const CAT_BASE = {
          person:   0.32,
          project:  0.25,
          interest: 0.19,
          place:    0.13,
          event:    0.07,
        };
        const base = CAT_BASE[n.cat] == null ? 0.16 : CAT_BASE[n.cat];

        /* retention 在 [0.90, 1.0] 窄区间里重映射到 [0,1]，
         * 再压到 ±0.045 的微调 —— 同类记忆之间也有细微冷暖差。 */
        const fine = Math.max(0, Math.min(1, (rt - 0.90) / 0.10));
        return Math.max(0.02, Math.min(0.38, base + (fine - 0.5) * 0.09));
      }
      // 骨架点保持中性偏冷，不参与语义表达
      case 'corefill': return 0.14;
      case 'filler':   return 0.10;
      default:         return 0.08;
    }
  }

  /** 真实检索命中 → 点亮该实体，并沿边扩散一层 */
  function activate(entityName, strength) {
    if (!act) return;
    const i = nameToIdx.get(entityName);
    if (i == null) return;
    act[i] = Math.max(act[i], strength == null ? 1.0 : strength);
    edges.forEach(e => {
      if (e[0] === i) act[e[1]] = Math.max(act[e[1]], 0.72);
      if (e[1] === i) act[e[0]] = Math.max(act[e[0]], 0.72);
    });
    wake('activate');
  }

  /** 按记忆 id 点亮（比实体更精确） */
  function activateMemory(memId, strength) {
    if (!act) return;
    const i = memToIdx.get(memId);
    if (i == null) return;
    act[i] = Math.max(act[i], strength == null ? 1.0 : strength);
    edges.forEach(e => {
      if (e[0] === i) act[e[1]] = Math.max(act[e[1]], 0.66);
      if (e[1] === i) act[e[0]] = Math.max(act[e[0]], 0.66);
    });
    wake('activateMemory');
  }

  function setState(s) {
    if (!S[s]) return;
    tgt = S[s];
    wake('state');
    // 非待命时给 body 打标记，CSS 让星图从 0.92 回到不透明（轻微，不抢读数）
    document.body.classList.toggle('st-active', s !== 'idle');
  }

  /* ═══════════ 点击拾取 ═══════════
   *
   * 星图之前是纯展示：一堆匿名光点，点了没反应，记忆内容完全看不到。
   *
   * 投影和最近点搜索的数学在 ui/pickmath.js 里 ——
   * 抽出去是为了能用 Node 做数值验算（项目只允许 better-sqlite3
   * 一个依赖，装不了 puppeteer 跑真实浏览器）。
   * 拾取偏移这种 bug 肉眼看不出来，必须靠数值测试。
   */

  /**
   * 拾取屏幕坐标处的节点。
   * @param {number} px 画布内 CSS 像素 x
   * @param {number} py 画布内 CSS 像素 y
   */
  function pick(px, py) {
    const PM = window.PICKMATH;
    if (!PM || !lastVP || !nodes.length) return null;
    const dpr = cv.width / (cv.clientWidth || cv.width) || 1;
    const best = PM.pickNode(nodes, px * dpr, py * dpr, {
      VP: lastVP, spread: lastSpread,
      width: cv.width, height: cv.height,
      kinds: ['memory', 'entity'],   // 骨架填充点不可点
    });
    if (!best) return null;
    const n = nodes[best.index];
    return {
      memId: n.memId == null ? null : n.memId,
      entity: n.entity || n.name || null,
      kind: n.kind,
      nodeIndex: best.index,
      distPx: Math.round(best.dist),
    };
  }

  /* 选中高亮：被选中的节点持续亮着，直到取消。
   * 用独立的 selIdx 而不是复用 act[]，因为 act 每帧衰减，
   * 选中状态必须稳定不闪。 */
  let selIdx = -1;
  function select(nodeIndex) {
    selIdx = (nodeIndex == null || nodeIndex < 0) ? -1 : nodeIndex;
    if (selIdx >= 0 && act) {
      act[selIdx] = 1.0;
      // 邻居也稍微点亮，形成"聚焦"感
      edges.forEach(e => {
        if (e[0] === selIdx) act[e[1]] = Math.max(act[e[1]], 0.5);
        if (e[1] === selIdx) act[e[0]] = Math.max(act[e[0]], 0.5);
      });
    }
  }
  /** 每帧维持选中节点的亮度，抵抗 act 衰减 */
  function holdSelection() {
    if (selIdx >= 0 && act && selIdx < act.length) act[selIdx] = 1.0;
  }

  /**
   * 五轴意识状态驱动星图表现。
   *
   * 与 setState() 的区别：setState 是"对话阶段"（think/speak…），切换很快；
   * setMood 是"长期情绪底色"，缓慢变化。两者叠加：
   *   最终参数 = 对话状态基准 × 情绪修正系数
   *
   * 映射（都是乘性修正，保持在 ±35% 内，避免情绪把画面搞失控）：
   *   唤醒 arousal   → 转速、脉动幅度（紧张时转得快、跳得急）
   *   心境 valence   → 暖色比例（心情好偏暖，低落偏冷蓝）
   *   沉浸 immersion → 收缩 spread（专注时向内聚拢）
   *   警觉 connection→ 整体亮度（想搭话时更亮一点）
   */
  let mood = { spin: 1, pulse: 1, glow: 1, warm: 1, spread: 1 };
  function setMood(m) {
    if (!m) return;
    const a = num(m.arousal, 0), v = num(m.valence, 0);
    const im = num(m.immersion, 0), cn = num(m.connection, 0);
    mood = {
      spin:   1 + a * 0.35,            // 唤醒高 → 转快
      pulse:  1 + a * 0.30,            // 唤醒高 → 脉动强
      glow:   1 + cn * 0.20 + v * 0.10,// 警觉/心境 → 亮度
      warm:   1 + v * 0.30,            // 心境好 → 更暖
      spread: 1 - im * 0.18,           // 沉浸高 → 聚拢
    };
    wake('mood');
  }
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function clampf(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function attr(p, name, buf, sz) {
    const l = gl.getAttribLocation(p, name); if (l < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 0, 0);
  }

  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let T = 0, ry = 0.35, rx = -0.16, drag = false, lx = 0, ly = 0;
  cv.addEventListener('pointerdown', e => { drag = true; lx = e.clientX; ly = e.clientY; wake('drag'); });
  addEventListener('pointerup', () => { if (drag) { drag = false; wake('dragend'); } });
  addEventListener('pointermove', e => {
    if (!drag) return;
    ry += (e.clientX - lx) * 0.006;
    rx = Math.max(-1.2, Math.min(1.2, rx + (e.clientY - ly) * 0.004));
    lx = e.clientX; ly = e.clientY;
    wake('drag');
  });

  /* ── 鼠标视差（idle 时球轻微"看向"指针）──
     不改拖拽用的 ry/rx，而是叠加一个独立的小角度 px/py，松手/移出自动回中。
     幅度克制（±0.16/±0.10 rad），带缓动；拖拽或减弱动效时不启用。 */
  let px = 0, py = 0, pxT = 0, pyT = 0, parOn = false;
  const PAR_Y = 0.16, PAR_X = 0.10;
  if (!reduceMotion) {
    cv.addEventListener('pointerenter', () => { parOn = true; wake('par'); });
    cv.addEventListener('pointerleave', () => { parOn = false; pxT = 0; pyT = 0; wake('par'); });
    cv.addEventListener('pointermove', ev => {
      if (drag) return;
      const r = cv.getBoundingClientRect();
      const nx = ((ev.clientX - r.left) / r.width) * 2 - 1;   // -1..1
      const ny = ((ev.clientY - r.top) / r.height) * 2 - 1;
      pxT = Math.max(-1, Math.min(1, nx)) * PAR_Y;
      pyT = Math.max(-1, Math.min(1, ny)) * PAR_X;
      parOn = true; wake('par');
    });
  }

  // 窗口失焦降频，省电
  let focused = true;
  addEventListener('blur', () => { focused = false; });
  addEventListener('focus', () => { focused = true; wake('focus'); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake('visible');
  });
  let lastDraw = 0;

  /* ══════════ 按需渲染（第三层：氛围层省电关键）══════════
   *
   * 原来无条件 requestAnimationFrame 永转：哪怕待命、页面静止，GPU 也一直在
   * 画这张上千节点的网。改成"动才画、静下来就停"：
   *   - 对话非 idle（思考/说话…）、情绪在变、有节点高亮在衰减、正在拖拽、
   *     刚 build/activate、reduced-motion 下的一次性绘制 → 持续画
   *   - 一切收敛到 idle 且高亮衰减到底后，停止调度，GPU 占用归零
   *   - 任何外部变化走 wake() 重新拉起；停之前会再补一帧，保证最后状态正确。
   * 拾取只依赖 lastVP 矩阵，停转后点击照样有效（矩阵停在最后一帧）。 */
  let rafOn = false;         // 当前是否已排了 rAF
  let forceFrames = 0;       // 唤醒后至少再画的帧数（确保状态变化被呈现）
  let lastStateKey = '';

  function wake(reason) {
    forceFrames = Math.max(forceFrames, 6);
    if (!rafOn) { rafOn = true; requestAnimationFrame(frame); }
  }

  /* 是否仍有"非画不可"的动态：判定逻辑抽到 ui/animgate.js（纯函数、可单测）。*/
  function stillAnimating() {
    if (!window.AnimGate) {
      // 兜底：脚本没加载时退回到内联保守判断（宁可不省电也不停在半帧）
      if (drag) return true;
      if (tgt !== S.idle) return true;
      return false;
    }
    return window.AnimGate.shouldAnimate({
      dragging: drag,
      forceFrames: 0,
      cur, tgt,
      targetIsIdle: tgt === S.idle,
      act,
      baseGlow: baseAct,
    });
  }
  schedulerReady = true;

  /* idle 慢转：待机时让球以极慢速度持续自转，但用极低帧率（~11fps），
     GPU 开销远小于满帧。失焦/隐藏/reduced-motion/开场播放中不启用。 */
  const IDLE_SPIN_MS = 50;          // idle 慢转帧间隔（≈20fps，顺滑且省电）
  function idleDrifting() {
    return focused && !reduceMotion && !drag && !wakeActive && focTZ === 1 && focZ === 1 &&
           tgt === S.idle && cur.glow - tgt.glow < 0.004 && cur.glow - tgt.glow > -0.004;
  }

  function frame(ts) {
    rafOn = true;
    // 失焦 100ms 节流；聚焦但纯待机慢转时用 90ms 低帧，其余满帧
    const minGap = !focused ? 100 : (idleDrifting() && forceFrames <= 0 ? IDLE_SPIN_MS : 0);
    if (ts - lastDraw < minGap) {
      // 节流跳过的这一帧也要判断该不该停，否则失焦静止时会永远空转
      if (forceFrames > 0 || stillAnimating() || idleDrifting()) requestAnimationFrame(frame);
      else rafOn = false;
      return;
    }
    lastDraw = ts;

    for (const k in cur) cur[k] = lerp(cur[k], tgt[k], 0.055);
    T += 0.016;

    // 对话状态 × 情绪底色 → 实际渲染参数
    // clamp 防止情绪把画面推到极端（转速过快/亮到糊）
    const eff = {
      spin:   clampf(cur.spin   * mood.spin,   0.05, 2.4),
      pulse:  clampf(cur.pulse  * mood.pulse,  0.10, 2.2),
      glow:   clampf(cur.glow   * mood.glow,   0.30, 1.8),
      warm:   clampf(cur.warm   * mood.warm,   0.00, 1.3),
      spread: clampf(cur.spread * mood.spread, 0.75, 1.30),
      /* flow 不乘 mood：能量流表达的是"正在处理"，
       * 不该被情绪放大 —— 否则心情好的时候待机也在流。 */
      flow:   clampf(cur.flow == null ? 0.08 : cur.flow, 0.0, 1.2),
    };

    if (!drag && !reduceMotion) {
      if (idleDrifting()) {
        /* idle 慢转：用独立的清晰转速，不复用被压到 0.1 的对话 spin。
           约 36s 一圈，肉眼明确可见但仍从容；低帧下保持恒定。 */
        ry += 0.009;
      } else {
        ry += 0.0020 * eff.spin * 6;
      }
    }
    // 鼠标视差缓动跟随（拖拽中冻结视差）
    if (!drag) { px += (pxT - px) * 0.08; py += (pyT - py) * 0.08; }

    if (!act) return;
    // 激活衰减，但各类节点保留自己的底光
    for (let i = 0; i < act.length; i++) {
      act[i] *= 0.972;
      const n = nodes[i];
      if (n) { const b = baseGlow(n); if (act[i] < b) act[i] = b; }
    }
    holdSelection();          // 选中的节点不参与衰减，保持常亮

    gl.bindBuffer(gl.ARRAY_BUFFER, bAct); gl.bufferData(gl.ARRAY_BUFFER, act, gl.DYNAMIC_DRAW);
    // 每条边 6 个顶点共享同一激活值
    edges.forEach((e, i) => {
      const v = Math.max(act[e[0]], act[e[1]]);
      const o = i * 6;
      eAct[o]=v; eAct[o+1]=v; eAct[o+2]=v; eAct[o+3]=v; eAct[o+4]=v; eAct[o+5]=v;
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, bEAct); gl.bufferData(gl.ARRAY_BUFFER, eAct, gl.DYNAMIC_DRAW);

    /* STAGE2 ?????????0.045 ? 2s ??????????? */
    focRy += (focTRy - focRy) * 0.045;
    focRx += (focTRx - focRx) * 0.045;
    focZ  += (focTZ  - focZ)  * 0.045;

    let M = mul(rY(ry + px + focRy), rX(rx + py + focRx));
    /* 相机距离：让内容球正好填满画面（不乘 spread，着色器已用 uSpread 缩放坐标）
     *
     * 之前写死 `1.15 + 1.55 * contentR`，没考虑画布宽高比。
     * 舞台是宽扁的（实测 1632×650，比例 2.5:1），垂直视野才是瓶颈，
     * 结果脑子只占画面中间一小块，跟预览版撑满的观感差很远。
     *
     * 正确算法：垂直半视角 fovY/2 下，要让半径 R 的球完整入镜，
     * 距离 d = R / tan(fovY/2)。persp() 的第一个参数是 fovY 弧度值 1.0。
     * 再留 8% 余量，避免边缘节点擦边被裁。 */
    const FOVY = 1.0;
    /* 留 8% → 18% 余量。
     * 形状系数从 y*0.82 改成 y*0.95 后，球的垂直尺寸增大约 16%，
     * 8% 余量不够，上下被裁掉了。contentR 取的是最大半径（水平方向），
     * 垂直方向虽然略小但点还有自身像素尺寸，需要更多留白。 */
    const fit = contentR / Math.tan(FOVY / 2) * 1.18 / BRAIN_SCALE * focZ;
    M = mul(tr(0, 0, -fit), M);
    const VP = mul(persp(FOVY, cv.width / cv.height, 0.1, 20), M);
    lastVP = VP;                 // 供点击拾取使用（见 pick）
    lastSpread = eff.spread;

    // 推进苏醒波 0→1（ease-out）。开场期间保持渲染；到 1 后不再变化。
    if (wakeActive) {
      const k = Math.min(1, (ts - wakeStart) / WAKE_MS);
      wakeVal = 1 - Math.pow(1 - k, 2.2);     // easeOutQuint 风
      if (k >= 1) wakeActive = false;
    }
    /* 开场期间给波前一个引燃增益（中段最亮、收尾平滑回到常态 glow）；
       非开场 wakeVal 恒为 1，增益为 0。 */
    {
      const intro = wakeActive ? Math.sin(Math.min(1, wakeVal) * Math.PI) : 0; // 0→1→0
      eff.glow = clampf(eff.glow + intro * 0.45, 0.0, 1.8);
    }

    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);

    /* ????????? + vignette??? GL ??????? Canvas/rAF */
    gl.useProgram(PB);
    gl.uniform2f(gl.getUniformLocation(PB,'uRes'), cv.width, cv.height);
    gl.uniform1f(gl.getUniformLocation(PB,'uT'), T);
    gl.uniform1f(gl.getUniformLocation(PB,'uWarm'), eff.warm);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(PL);
    attr(PL,'aA',bEA,3); attr(PL,'aB',bEB,3);
    attr(PL,'aSide',bESide,1); attr(PL,'aEnd',bEEnd,1); attr(PL,'act',bEAct,1); attr(PL,'dim',bEDim,1);
    gl.uniformMatrix4fv(gl.getUniformLocation(PL,'uMVP'),false,new Float32Array(VP));
    gl.uniform1f(gl.getUniformLocation(PL,'uGlow'),eff.glow);
    gl.uniform1f(gl.getUniformLocation(PL,'uWarm'),eff.warm);
    gl.uniform1f(gl.getUniformLocation(PL,'uSpread'),eff.spread);
    // 线宽：NDC 单位。乘以 2/height 换算成"约 N 个设备像素"
    gl.uniform1f(gl.getUniformLocation(PL,'uThick'), LINE_PX * 2 / cv.height);
    gl.uniform1f(gl.getUniformLocation(PL,'uAspect'), cv.width / cv.height);
    gl.uniform1f(gl.getUniformLocation(PL,'uT'), T);
    /* 能量流强度：思考/说话时明显，待机时几乎关闭。
     * 待机也流的话画面会一直很吵，反而看不出"什么时候在干活"。 */
    gl.uniform1f(gl.getUniformLocation(PL,'uFlow'), eff.flow);
    gl.uniform1f(gl.getUniformLocation(PL,'uWake'), wakeVal);
    gl.drawArrays(gl.TRIANGLES, 0, edges.length * 6);

    gl.useProgram(PN);
    attr(PN,'pos',bPos,3); attr(PN,'act',bAct,1); attr(PN,'sz',bSz,1);
    attr(PN,'hue',bHue,1); attr(PN,'ring',bRing,1); attr(PN,'dim',bDim,1);
    gl.uniformMatrix4fv(gl.getUniformLocation(PN,'uMVP'),false,new Float32Array(VP));
    gl.uniform1f(gl.getUniformLocation(PN,'uT'),T);
    gl.uniform1f(gl.getUniformLocation(PN,'uPulse'),eff.pulse);
    gl.uniform1f(gl.getUniformLocation(PN,'uGlow'),eff.glow);
    gl.uniform1f(gl.getUniformLocation(PN,'uWarm'),eff.warm);
    gl.uniform1f(gl.getUniformLocation(PN,'uSpread'),eff.spread);
    gl.uniform1f(gl.getUniformLocation(PN,'uWake'), wakeVal);
    gl.drawArrays(gl.POINTS, 0, nodes.length);

    /* ── 决定下一帧是否还画 ──
       强制帧数没耗完（刚被唤醒）、或画面仍有动态 → 继续；
       reduced-motion 下只在有强制帧时画，绝不持续自转。
       否则停止调度：补到这里的最后一帧就是静止的正确画面。 */
    if (forceFrames > 0) forceFrames--;
    const gate = window.AnimGate;
    const keepGoing = wakeActive || idleDrifting() || focAnimating() || (gate
      ? gate.scheduleNext({
          forceFrames, reduceMotion, dragging: drag,
          cur, tgt, targetIsIdle: tgt === S.idle,
          act, baseGlow: baseAct,
        })
      : (forceFrames > 0 || stillAnimating()));
    if (keepGoing) requestAnimationFrame(frame);
    else rafOn = false;
  }

  build({});

  /* ── 苏醒开场 ──
     每次加载播放一次"核心先亮→光沿网络向外扩散点亮整球"，约 1.9s 后回落待机。
     reduced-motion / 无 rAF：直接终态，不播。 */
  if (prefersReducedMotion()) {
    wakeVal = 1;
  } else {
    wakeStart = performance.now();
    wakeActive = true;
  }
  wake('boot');   // 首屏画几帧；wakeActive 期间持续渲染，结束后待机自动停转

  /* STAGE1 ?????????????+?? 1.0 / ?? 0.45 / ?? 0.12 */
  function hover(px, py) {
    let idx = -1;
    if (typeof px === 'number' && px >= 0) {
      const hit = pick(px, py);
      if (hit) idx = hit.nodeIndex;
    }
    if (idx === hoverIdx) return;
    hoverIdx = idx;
    applyDepthFocus(idx);
  }
  function applyDepthFocus(idx) {
    if (!dimArr || !eDimArr) return;
    if (idx == null || idx < 0 || !window.STARPLUS) {
      dimArr.fill(1); eDimArr.fill(1);
    } else {
      const lv = window.STARPLUS.neighborLevels(nodes.length, edges, idx, semEdges);
      for (let i = 0; i < dimArr.length; i++)
        dimArr[i] = lv.l1.has(i) ? 1.0 : (lv.l2.has(i) ? 0.45 : 0.12);
      edges.forEach((e, i) => {
        const a1 = lv.l1.has(e[0]), b1 = lv.l1.has(e[1]);
        const a2 = lv.l2.has(e[0]), b2 = lv.l2.has(e[1]);
        const v = (a1 && b1) ? 1.0 : ((a1 || b1 || (a2 && b2)) ? 0.45 : 0.12);
        for (let k = 0; k < 6; k++) eDimArr[i * 6 + k] = v;
      });
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bDim); gl.bufferData(gl.ARRAY_BUFFER, dimArr, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bEDim); gl.bufferData(gl.ARRAY_BUFFER, eDimArr, gl.DYNAMIC_DRAW);
    wake('hover');
  }

  /* STAGE2 ???? + ??????? = ????? - ????????? */
  function focus(nodeIndex) {
    const n = nodes[nodeIndex];
    if (!n || !window.STARPLUS) return;
    const t = window.STARPLUS.cameraTarget(n.p);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    focTRy = wrap(t.ry - ry - px);
    focTRx = wrap(t.rx - rx - py);
    focTZ = 0.55;
    wake('focus');
  }
  function unfocus() {
    focTRy = 0; focTRx = 0; focTZ = 1;
    wake('unfocus');
  }
  function focAnimating() {
    return Math.abs(focRy - focTRy) > 0.002 || Math.abs(focRx - focTRx) > 0.002 ||
           Math.abs(focZ - focTZ) > 0.004;
  }

  /* STAGE3 ?????????????????????=?????????????? */
  function pulseAlong(idxs, strength) {
    if (!idxs || !idxs.length || !act) return;
    const offs = window.STARPLUS ? window.STARPLUS.pulseOffsets(idxs.length)
                                 : idxs.map((_, i) => i * 260);
    idxs.forEach((ni, i) => {
      setTimeout(() => {
        if (ni >= 0 && ni < act.length) { act[ni] = Math.max(act[ni], strength); wake('pulse'); }
      }, offs[i]);
    });
  }
  function entityPath(entityName) {
    const ei = nameToIdx.get(entityName);
    if (ei == null) return null;
    const n = nodes[ei];
    const hub = (n && galHubIdx[n.cat] != null) ? galHubIdx[n.cat] : null;
    const path = [1];
    if (hub != null) path.push(hub);
    path.push(ei);
    return path;
  }
  function pulseWrite(entityName)  { const p = entityPath(entityName); if (p) pulseAlong(p, 1.35); }
  function pulseRecall(entityName) { const p = entityPath(entityName); if (p) pulseAlong(p.slice().reverse(), 1.35); }

  window.STAR = {
    build, activate, activateMemory, setState, setMood,
    hover, focus, unfocus, pulseWrite, pulseRecall,
    /** 重播苏醒开场（调试/演示用） */
    replayWake: () => {
      if (prefersReducedMotion()) { wakeVal = 1; return; }
      wakeVal = 0; wakeStart = performance.now(); wakeActive = true;
      wake('boot');
    },
    pick, select,
    /** 记忆 id → 节点索引（面板高亮用） */
    nodeIndexOfMemory: (memId) => memToIdx.has(memId) ? memToIdx.get(memId) : -1,
    stats: () => ({
      nodes: nodes.length, edges: edges.length,
      memories: nodes.filter(n => n.kind === 'memory').length,
      entities: nodes.filter(n => n.kind === 'entity').length,
      corefill: nodes.filter(n => n.kind === 'corefill').length,
      filler:   nodes.filter(n => n.kind === 'filler').length,
    }),
    mood: () => ({ ...mood }),
    /** 调试：各层节点的半径分布。用来验证"是否真的共球面"。 */
    debugRadii: () => {
      const byKind = {};
      nodes.forEach(n => {
        const R = Math.hypot(n.p[0], n.p[1], n.p[2]);
        (byKind[n.kind] = byKind[n.kind] || []).push(R);
      });
      const out = {};
      for (const k in byKind) {
        const a = byKind[k].slice().sort((x, y) => x - y);
        out[k] = {
          n: a.length,
          min: +a[0].toFixed(4),
          max: +a[a.length - 1].toFixed(4),
          spread: +(a[a.length - 1] - a[0]).toFixed(4),
        };
      }
      return out;
    },
    /** 调试：各层节点的空间重心。分布均匀时应接近原点。 */
    debugCentroid: () => {
      const byKind = {};
      nodes.forEach(n => {
        const b = byKind[n.kind] = byKind[n.kind] || { n: 0, x: 0, y: 0, z: 0 };
        b.n++; b.x += n.p[0]; b.y += n.p[1]; b.z += n.p[2];
      });
      const out = {};
      for (const k in byKind) {
        const b = byKind[k];
        out[k] = { n: b.n,
          cx: +(b.x / b.n).toFixed(4),
          cy: +(b.y / b.n).toFixed(4),
          cz: +(b.z / b.n).toFixed(4) };
      }
      return out;
    },
    /** 调试：最长的边是哪些（用来定位"斜穿球面的长边"）。 */
    debugLongEdges: (topN) => {
      const list = edges.map(e => {
        const a = nodes[e[0]].p, b = nodes[e[1]].p;
        return {
          len: +Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]).toFixed(4),
          from: nodes[e[0]].kind, to: nodes[e[1]].kind,
          fromName: nodes[e[0]].name || '', toName: nodes[e[1]].name || '',
        };
      });
      list.sort((p, q) => q.len - p.len);
      return list.slice(0, topN || 15);
    },
  };
})();
