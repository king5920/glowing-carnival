/* charts.js —— §5 图表共享原语（Canvas 2D 手绘，零外部库）
 *
 * 设计纪律（DESIGN.md §1/§5）：
 *   - 所有颜色都走 :root CSS 变量，本文件零写死 hex
 *   - 涨跌双通道编码（§1.1）：位置 + 符号 + 色相 + 明度至少两项并行
 *   - 色盲备援：极值柱加斜线纹理；tooltip 是 DOM 元素、不是动画，unaffected by reduced-motion
 *   - Canvas 数据图表都是一次性重画、不入 AnimGate.gatedLoop（不新增 rAF 链）
 *
 * 复用点：resizeTo 逻辑与 ui/app.js:1503-1518 的 fx/gx/rx/sx 保持同一套 DPR 处理。
 */
(function(){
  'use strict';

  /* ═══ 从 :root 读 CSS 变量值 ═══
   * 每次调用实时读——支持运行时主题切换；调用频率不高（图表绘制），不缓存。 */
  const _style = getComputedStyle(document.documentElement);
  function css(name){
    const v = _style.getPropertyValue(name);
    return v ? v.trim() : null;
  }

  /* ═══ DPR 感知 canvas 重置（返回物理像素尺寸 + ctx）═══
   * 参考 ui/app.js:1503-1518：让 CSS 像素尺寸和绘制坐标一致，避免 DPR 错位。
   * clientWidth/Height 为 0 时（尚未布局）用显式传入的 w/h 兜底。 */
  function resizeCanvas(cv, w, h){
    if(!cv) return null;
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const cw = cv.clientWidth || w || 0;
    const ch = cv.clientHeight || h || 0;
    if(!cw || !ch) return null;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d');
    if(!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cw, h: ch, dpr };
  }

  /* ═══ 颜色阶梯插值 ═══
   * stops: [{ v: 0, c: '--cy' }, { v: 0.5, c: '--gd' }, { v: 1, c: '--rd' }]
   * c 允许传 CSS 变量名（--xxx）或直接的 hex/rgb/rgba 字符串。
   * 返回 rgba(r,g,b,a) 便于 alpha 二次调节。
   */
  function hexToRgb(str){
    const s = String(str).trim();
    if(s.startsWith('#')){
      const h = s.slice(1);
      const n = h.length === 3
        ? h.split('').map(c => parseInt(c + c, 16))
        : [0,2,4].map(i => parseInt(h.slice(i, i+2), 16));
      return n;
    }
    const m = s.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if(m) return [+m[1], +m[2], +m[3]];
    return [0,0,0];
  }

  function resolveColor(c){
    if(typeof c !== 'string') return null;
    if(c.startsWith('--')){
      const v = css(c);
      return v ? hexToRgb(v) : null;
    }
    return hexToRgb(c);
  }

  function colorLadder(v, stops, alpha){
    if(!stops || !stops.length) return 'rgba(120,120,120,1)';
    v = Math.max(0, Math.min(1, +v || 0));
    for(let i = 0; i < stops.length - 1; i++){
      const a = stops[i], b = stops[i+1];
      if(v >= a.v && v <= b.v){
        const t = (v - a.v) / (b.v - a.v || 1);
        const ra = resolveColor(a.c), rb = resolveColor(b.c);
        if(!ra || !rb) return 'rgba(120,120,120,1)';
        const r = Math.round(ra[0] + (rb[0] - ra[0]) * t);
        const g = Math.round(ra[1] + (rb[1] - ra[1]) * t);
        const b2 = Math.round(ra[2] + (rb[2] - ra[2]) * t);
        return 'rgba(' + r + ',' + g + ',' + b2 + ',' + (alpha == null ? 1 : alpha) + ')';
      }
    }
    const edge = v <= stops[0].v ? stops[0] : stops[stops.length - 1];
    const rgb = resolveColor(edge.c);
    if(!rgb) return 'rgba(120,120,120,1)';
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (alpha == null ? 1 : alpha) + ')';
  }

  /* ═══ 文本绘制（§2 排版纪律：tabular-nums + letter-spacing）═══ */
  function drawText(ctx, text, x, y, opts){
    opts = opts || {};
    const fs = opts.font ? parseInt(opts.font, 10) : 11;
    ctx.save();
    ctx.font = (opts.weight || 400) + ' ' + fs + 'px "Microsoft YaHei","PingFang SC",sans-serif';
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'alphabetic';
    ctx.fillStyle = opts.fill || css('--txt') || '#DBE6F4';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* ═══ 坐标轴（tick + label + 淡网格线）═══
   * cfg = { x, y, w, h, xTicks:[{v,label}], yTicks:[{v,label}],
   *         xRange:[min,max], yRange:[min,max] }
   * 数据点转像素：
   *   px = x + (v - xRange[0]) / (xRange[1] - xRange[0]) * w
   *   py = y + h - (v - yRange[0]) / (yRange[1] - yRange[0]) * h
   */
  function drawAxis(ctx, cfg){
    if(!cfg || !ctx) return;
    ctx.save();
    ctx.strokeStyle = css('--line') || 'rgba(140,175,225,.2)';
    ctx.lineWidth = 1;
    /* 网格线（横向） */
    ctx.beginPath();
    (cfg.yTicks || []).forEach(t => {
      const py = cfg.y + cfg.h - (t.v - cfg.yRange[0]) / (cfg.yRange[1] - cfg.yRange[0] || 1) * cfg.h;
      ctx.moveTo(cfg.x, py);
      ctx.lineTo(cfg.x + cfg.w, py);
    });
    ctx.stroke();
    /* 坐标轴框 */
    ctx.strokeStyle = css('--line') || 'rgba(140,175,225,.3)';
    ctx.beginPath();
    ctx.moveTo(cfg.x, cfg.y); ctx.lineTo(cfg.x, cfg.y + cfg.h);
    ctx.lineTo(cfg.x + cfg.w, cfg.y + cfg.h);
    ctx.stroke();
    /* Y 轴刻度标签 */
    (cfg.yTicks || []).forEach(t => {
      const py = cfg.y + cfg.h - (t.v - cfg.yRange[0]) / (cfg.yRange[1] - cfg.yRange[0] || 1) * cfg.h;
      drawText(ctx, t.label, cfg.x - 6, py + 3, { align: 'right', font: 10, fill: css('--faint') || '#8ba0b8' });
    });
    /* X 轴刻度标签 */
    (cfg.xTicks || []).forEach(t => {
      const px = cfg.x + (t.v - cfg.xRange[0]) / (cfg.xRange[1] - cfg.xRange[0] || 1) * cfg.w;
      drawText(ctx, t.label, px, cfg.y + cfg.h + 12, { align: 'center', font: 10, fill: css('--faint') || '#8ba0b8' });
    });
    ctx.restore();
  }

  /* ═══ 实心柱 ═══ */
  function drawBar(ctx, x, y, w, h, fill, stroke){
    if(w <= 0 || h <= 0) return;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    if(stroke){
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    ctx.restore();
  }

  /* ═══ 斜线纹理（色盲备援，用于情绪温度极值柱）═══
   * 在指定矩形区域绘制 45° 斜线填充；不改变柱体填充色。 */
  function drawHatch(ctx, x, y, w, h, color){
    if(w <= 0 || h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    const step = 5;
    for(let i = -h; i < w; i += step){
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ═══ 蜡烛图单根（涨=实心 --rd，跌=空心 --gn）═══
   * §5 表格：蜡烛图 涨#F0485E实心 / 跌#089981空心。
   * top/bottom 为蜡烛实体上下（收盘价对应）；high/low 为影线上下。 */
  function drawCandle(ctx, x, top, bottom, high, low, w, up, down, upFill, downFill){
    if(w <= 0) return;
    upFill = upFill || css('--rd') || '#F0485E';
    downFill = downFill || css('--gn') || '#089981';
    ctx.save();
    /* 影线（贯穿最高到最低） */
    ctx.strokeStyle = up ? upFill : downFill;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();
    /* 实体 */
    const bh = Math.max(1, Math.abs(bottom - top));
    if(up){
      ctx.fillStyle = upFill;
      ctx.fillRect(x - w / 2, top, w, bh);
    } else {
      /* 跌=空心：边框 + 底色，让色盲场景有形状区分 */
      ctx.fillStyle = css('--panel') || 'rgba(24,38,58,.6)';
      ctx.fillRect(x - w / 2, top, w, bh);
      ctx.strokeStyle = downFill;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - w / 2 + 0.5, top + 0.5, w - 1, bh - 1);
    }
    ctx.restore();
  }

  /* ═══ Hover 绑定（数据点命中 + tooltip 弹出）═══
   * canvas 上放一个 DOM tooltip，位置跟随鼠标、内容取自 tooltip(hit)。
   * tooltip 是 DOM 元素、不是动画，prefers-reduced-motion 下仍可用。
   *
   * hit(x, y) → data | null  —— 命中检测，x/y 是 CSS 像素坐标（相对 canvas）
   * tooltip(d) → 整句中文 string —— §5 通用条款：live 更新用 role=status 整句播报
   */
  function bindHover(canvas, opts){
    if(!canvas || !opts || typeof opts.hit !== 'function') return null;
    /* 每次调用返回一个新的 tooltip 元素；重复调用不会累积（复用旧引用） */
    let tip = null;
    function ensureTip(){
      if(tip) return tip;
      const host = canvas.parentElement;
      if(!host) return null;
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('role', 'status');
      tip.setAttribute('aria-live', 'polite');
      tip.style.display = 'none';
      host.appendChild(tip);
      return tip;
    }

    function onMove(e){
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = opts.hit(x, y);
      const t = ensureTip();
      if(!t) return;
      if(!hit || !opts.tooltip){
        t.style.display = 'none';
        return;
      }
      const text = opts.tooltip(hit);
      if(!text){ t.style.display = 'none'; return; }
      t.textContent = text;
      t.style.display = 'block';
      /* 位置：跟随鼠标、但不越界 */
      const hostRect = t.parentElement.getBoundingClientRect();
      const tw = t.offsetWidth, th = t.offsetHeight;
      let px = x + 12, py = y + 12;
      if(px + tw + 8 > rect.width) px = x - tw - 12;
      if(py + th + 8 > rect.height) py = y - th - 12;
      t.style.left = px + 'px';
      t.style.top = py + 'px';
    }
    function onLeave(){
      if(tip) tip.style.display = 'none';
    }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return {
      /* 供 CDP 验证用：手动触发 hover 事件（不需真实鼠标） */
      simulate(x, y){
        const rect = canvas.getBoundingClientRect();
        onMove({ clientX: rect.left + x, clientY: rect.top + y });
      },
      getTip(){ return tip; },
      unbind(){
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mouseleave', onLeave);
        if(tip && tip.parentElement) tip.parentElement.removeChild(tip);
        tip = null;
      },
    };
  }

  /* ═══ §5 情绪温度 60 日热力柱 ═══
   * 输入 data: [{ date, limit_up, limit_down, broken, broken_rate, ladder_height, seal_fund_yi }]
   *   —— 每日一条，按 date 升序（调用方排序）。
   *
   * 编码（§1.1 双通道 + §5 表格）：
   *   - 主通道：broken_rate 从低→高，色相 冷青(--cy) → 暖金(--gd) → 恐慌红(--rd)
   *     低 broken_rate = 冷静期（好）；高 = 炸板严重 = 恐慌期（不好）
   *   - 位置通道：柱高 ∝ broken_rate（视觉高度 = 情绪强度）
   *   - 色盲备援：极值柱（>=90% 或 <=10%）加斜线纹理 drawHatch，形状通道独立于色相
   *
   * Hover tooltip 整句（§5 通用条款 role=status 整句播报）：
   *   「YYYY-MM-DD 炸板率 42.5% · 涨停 88 · 跌停 12 · 最高连板 7 · 封单 4.5 亿」
   */
  function drawSentimentHeatmap(canvas, data){
    const R = resizeCanvas(canvas);
    if(!R) return null;
    const { ctx, w, h } = R;
    ctx.clearRect(0, 0, w, h);

    if(!data || !data.length){
      drawText(ctx, '无情绪数据', w / 2, h / 2, { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return { hit: function(){ return null; } };
    }

    /* 布局：上留 6px 呼吸，下留 14px 给 X 轴 label */
    const padTop = 6, padBottom = 14, padLeft = 6, padRight = 6;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    if(plotW <= 0 || plotH <= 0){
      drawText(ctx, '无情绪数据', w / 2, h / 2, { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return { hit: function(){ return null; } };
    }

    /* 颜色阶梯：低→中→高 broken_rate，冷静→警戒→恐慌 */
    const ladder = [
      { v: 0,    c: '--cy' },   /* 冷静：冷青 */
      { v: 0.5,  c: '--gd' },   /* 警戒：暖金 */
      { v: 1,    c: '--rd' },   /* 恐慌：红 */
    ];

    const n = data.length;
    const gap = n > 60 ? 0 : 1;   /* ≤60 根有缝、>60 贴合 */
    const slotW = plotW / n;
    const barW = Math.max(1, slotW - gap);

    /* 预计算每根柱的几何与数据引用，供 hitTest 复用 */
    const bars = [];
    for(let i = 0; i < n; i++){
      const d = data[i];
      const rate = (typeof d.broken_rate === 'number') ? Math.max(0, Math.min(100, d.broken_rate)) : 50;
      const t = rate / 100;
      const x = padLeft + i * slotW;
      const barH = Math.max(2, t * plotH);
      const y = padTop + plotH - barH;
      const fill = colorLadder(t, ladder);
      const isExtreme = (rate >= 90 || rate <= 10) && data[i].broken_rate != null;
      bars.push({ x, y, w: barW, h: barH, d, t, isExtreme });

      ctx.fillStyle = fill;
      ctx.fillRect(x, y, barW, barH);
      if(isExtreme){
        /* 极值柱加斜线纹理，色盲备援——不改变主色 */
        drawHatch(ctx, x, y, barW, barH, 'rgba(255,255,255,.5)');
      }
    }

    /* X 轴稀疏 label：起止 + 中间 1-2 个（若数据足够） */
    function fmtDay(s){
      /* 输入 '2026-09-16' 或 '2026-09-16T15:00' → 输出 '09-16' */
      if(!s) return '';
      const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? (m[2] + '-' + m[3]) : String(s).slice(0, 10);
    }
    const labelIdx = [0, n > 12 ? Math.floor(n / 2) : 1, n - 1];
    labelIdx.forEach(i => {
      if(i < 0 || i >= n) return;
      const b = bars[i];
      drawText(ctx, fmtDay(b.d.date), b.x + barW / 2, h - 2, { align: 'center', font: 9, fill: css('--faint') || '#8ba0b8' });
    });

    /* Hit 检测：x 落在哪根柱上 */
    function hit(cx, cy){
      if(cx < padLeft || cx > padLeft + plotW) return null;
      if(cy < padTop || cy > padTop + plotH + padBottom) return null;
      const idx = Math.floor((cx - padLeft) / slotW);
      if(idx < 0 || idx >= n) return null;
      return bars[idx].d;
    }

    /* Tooltip 整句（§5 通用条款）：全中文数字带单位 */
    function tooltip(d){
      const parts = [];
      const day = String(d.date || '').slice(0, 10);
      parts.push(day);
      const rate = (typeof d.broken_rate === 'number') ? d.broken_rate.toFixed(1) + '%' : '—';
      parts.push('炸板率 ' + rate);
      parts.push('涨停 ' + (d.limit_up == null ? '—' : d.limit_up));
      parts.push('跌停 ' + (d.limit_down == null ? '—' : d.limit_down));
      parts.push('最高连板 ' + (d.ladder_height == null ? '—' : d.ladder_height));
      const seal = (typeof d.seal_fund_yi === 'number') ? d.seal_fund_yi.toFixed(1) + '亿' : '—';
      parts.push('封单 ' + seal);
      return parts.join(' · ');
    }

    return { hit: hit, tooltip: tooltip, bars: bars };
  }

  window.Charts = {
    css,
    resizeCanvas,
    colorLadder,
    drawText,
    drawAxis,
    drawBar,
    drawHatch,
    drawCandle,
    drawSentimentHeatmap,
    bindHover,
    /* 供测试用 */
    _hexToRgb: hexToRgb,
    _resolveColor: resolveColor,
  };
})();
