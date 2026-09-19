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

  /* ═══ §5 板块涨幅分布直方图 ═══
   * 输入 data: {
   *   date: 'YYYY-MM-DD',
   *   buckets: [{ range: '<-3%', side: 'down', count: 128, pct: 13.3 }, ...],
   *   total: 961,
   *   min: -6.0, max: 7.86,
   * }
   *
   * 编码（§1.1 双通道 + §5 表格 A 股口径）：
   *   - 位置通道：中轴=0 分界，负档向左延伸（跌区），正档向右延伸（涨区）
   *   - 色相通道：跌档 --gn 青绿 / 涨档 --rd 红（A 股口径）
   *   - 明度通道：柱高 ∝ count（视觉高度 = 板块数量）
   *   - 双通道备援：柱下方 range label（"-3~-1%"）+ hover 整句，形状不依赖色相
   *
   * 档界偏离 §5 参考值（原稿是 <-7/-7~-3/-3~0/0~3/3~7/>7，个股 scale）。
   * 实际样本 961 板块 range 在 -6%~+7.9%、主体在 -2%~+2%，档界改为
   * <-3/-3~-1/-1~0/0~1/1~3/>3 匹配板块 scale、中间带 ±1%。
   * 见 DESIGN.md §5 涨跌分布注。
   *
   * Hover tooltip 整句（§5 通用条款 role=status）：
   *   「-3~-1% 板块 128 个 · 占 13.3%」（跌区）/「0~1% 板块 342 个 · 占 35.6%」（涨区）
   */
  function drawDistribution(canvas, data){
    const R = resizeCanvas(canvas);
    if(!R) return null;
    const { ctx, w, h } = R;
    ctx.clearRect(0, 0, w, h);

    if(!data || !data.buckets || !data.buckets.length){
      drawText(ctx, '无分布数据', w / 2, h / 2, { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return { hit: function(){ return null; } };
    }

    /* 布局：上留 6px 呼吸（柱顶余白），下留 16px 给 range label */
    const padTop = 6, padBottom = 16, padLeft = 6, padRight = 6;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    if(plotW <= 0 || plotH <= 0){
      drawText(ctx, '无分布数据', w / 2, h / 2, { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return { hit: function(){ return null; } };
    }

    const buckets = data.buckets;
    const n = buckets.length;
    const maxCount = buckets.reduce((m, b) => Math.max(m, b.count || 0), 0) || 1;
    const slotW = plotW / n;
    const gap = n > 8 ? 0 : 2;
    const barW = Math.max(2, slotW - gap);

    /* 预计算每档几何与数据引用 */
    const bars = [];
    for(let i = 0; i < n; i++){
      const b = buckets[i];
      const count = b.count || 0;
      const t = count / maxCount;
      const x = padLeft + i * slotW + gap / 2;
      const barH = Math.max(2, t * plotH);
      const y = padTop + plotH - barH;
      const fill = b.side === 'down'
        ? colorLadder(1, [{ v: 0, c: '--gn' }, { v: 1, c: '--gn' }], 0.85)   /* 青绿跌档 */
        : colorLadder(1, [{ v: 0, c: '--rd' }, { v: 1, c: '--rd' }], 0.85);   /* 红涨档 */
      bars.push({ x, y, w: barW, h: barH, d: b });
      drawBar(ctx, x, y, barW, barH, fill);
      /* range label 在柱下方（色盲备援：即使不看颜色也能识别档位） */
      drawText(ctx, b.range, x + barW / 2, h - 3,
        { align: 'center', font: 8.5, fill: css('--faint') || '#8ba0b8' });
    }

    /* 中轴虚线（0 分界）：位置通道的关键参照 */
    const midIdx = buckets.findIndex(b => b.side === 'up');   /* 第一个 up 档位置 = 中轴右侧 */
    const midX = midIdx > 0 ? (padLeft + midIdx * slotW) : (plotW / 2);
    ctx.save();
    ctx.strokeStyle = css('--line') || 'rgba(140,175,225,.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(midX, padTop);
    ctx.lineTo(midX, padTop + plotH);
    ctx.stroke();
    ctx.restore();

    /* Hit 检测：x 落在哪一档上 */
    function hit(cx, cy){
      if(cx < padLeft || cx > padLeft + plotW) return null;
      if(cy < padTop || cy > padTop + plotH + padBottom) return null;
      const idx = Math.floor((cx - padLeft) / slotW);
      if(idx < 0 || idx >= n) return null;
      return bars[idx].d;
    }

    /* Tooltip 整句（§5 通用条款）：range + count + pct 都带单位 */
    function tooltip(d){
      const count = (d.count == null) ? 0 : d.count;
      const pct = (typeof d.pct === 'number') ? d.pct.toFixed(1) + '%' : '—';
      const side = d.side === 'down' ? '跌区' : '涨区';
      return d.range + ' ' + side + ' ' + count + ' 个板块 · 占 ' + pct;
    }

    return { hit: hit, tooltip: tooltip, bars: bars };
  }

  /* ═══ §5 大盘 K 线图（C3-C）═══
   * 输入 bars: [{ date, open, close, high, low, volume }, ...]（按 date 升序）
   * opts: { volRatio?: number } 成交量区占 plotH 的比例，默认 0.25（§5 底部 25%）
   *
   * 编码（§1.1 双通道 + A 股红涨绿跌）：
   *   - 色相通道：close>open → --rd 红；close<open → --gn 绿（A 股口径，与美股相反）
   *   - 形状通道：涨=实心实体、跌=空心实体（色盲备援，不依赖色相判涨跌）
   *   - 位置通道：影线贯穿 high/low，实体上下由 open/close 决定
   *   - 均线：MA5 --cy 青 / MA10 --gd 金 / MA20 --info 蓝，三色相分离
   *   - 成交量：底部 25% 区域柱状，颜色随当日涨跌同色、透明度 0.5（不与价格抢位）
   *
   * Hover tooltip 整句（§5 通用条款 role=status）：
   *   「2026-09-18 开3892.0 高3920.0 低3889.0 收3911.9 · +0.51% · 量4.86亿」
   *
   * 纪律：纯 canvas 绘制、不建任何 DOM（tooltip 由共享 bindHover 负责）；
   * 数据到位一次性重画，不入 AnimGate.gatedLoop、不新增 rAF 链。 */
  function drawKline(canvas, bars, opts){
    opts = opts || {};
    const num = function(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; };
    const EMPTY = '暂无K线数据';
    const fallback = { hit: function(){ return null; },
                       tooltip: function(){ return EMPTY; }, bars: [], mas: [], layout: null };
    const empty = function(ctx, w, h){
      drawText(ctx, EMPTY, w / 2, h / 2,
        { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return fallback;
    };

    const R = resizeCanvas(canvas);
    if(!R) return null;
    const { ctx, w, h } = R;
    ctx.clearRect(0, 0, w, h);

    if(!bars || !bars.length) return empty(ctx, w, h);

    /* 颜色：A 股红涨绿跌（--rd 涨 / --gn 跌），全部走 :root CSS 变量 */
    const upColor   = css('--rd') || '#F0485E';
    const downColor = css('--gn') || '#089981';
    const maSpec = [
      { k: 5,  c: css('--cy')   || '#3FD0FF' },
      { k: 10, c: css('--gd')   || '#F2B23E' },
      { k: 20, c: css('--info') || '#4F8CFF' },
    ];

    /* 布局：右留 48px 放价格刻度，下留 16px 放日期；
     * 价格区占上 75%，成交量区占底部 25%，中间 4px 呼吸 */
    const padTop = 8, padBottom = 16, padLeft = 6, padRight = 48;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    if(plotW <= 12 || plotH <= 28) return empty(ctx, w, h);

    const volRatio = (typeof opts.volRatio === 'number')
      ? Math.max(0.1, Math.min(0.4, opts.volRatio)) : 0.25;
    const paneGap = 4;
    const volH = Math.max(6, plotH * volRatio);
    const priceH = Math.max(6, plotH - volH - paneGap);
    const priceTop = padTop;
    const volTop = padTop + priceH + paneGap;

    const n = bars.length;
    /* 价格量程：取 high/low 极值，全缺时用 close/open 兜底 */
    let minL = Infinity, maxH = -Infinity, maxVol = 0;
    for(let i = 0; i < n; i++){
      const lo = num(bars[i].low), hi = num(bars[i].high);
      if(lo != null && lo < minL) minL = lo;
      if(hi != null && hi > maxH) maxH = hi;
      const v = num(bars[i].volume);
      if(v != null && v > maxVol) maxVol = v;
    }
    if(!isFinite(minL) || !isFinite(maxH)){
      for(let i = 0; i < n; i++){
        for(let f = 0; f < 2; f++){
          const x2 = num(f === 0 ? bars[i].open : bars[i].close);
          if(x2 == null) continue;
          if(x2 < minL) minL = x2;
          if(x2 > maxH) maxH = x2;
        }
      }
    }
    if(!isFinite(minL) || !isFinite(maxH)) return empty(ctx, w, h);

    const span = (maxH - minL) || Math.abs(maxH) * 0.02 || 1;
    const minP = minL - span * 0.05, maxP = maxH + span * 0.05;

    const slotW = plotW / n;
    const candleW = Math.max(1, Math.min(11, slotW * 0.62));
    const cx = function(i){ return padLeft + (i + 0.5) * slotW; };
    const py = function(v){ return priceTop + priceH - (v - minP) / (maxP - minP || 1) * priceH; };
    const fmtPrice = function(v){
      if(v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      return a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
    };

    /* ── 背景：价格区横向网格 + 双区边框 + 右轴价格刻度 ── */
    const yTicks = [];
    const NT = 4;
    for(let t = 0; t <= NT; t++){
      const v = minP + (maxP - minP) * t / NT;
      yTicks.push({ y: py(v), label: fmtPrice(v) });
    }
    ctx.save();
    ctx.strokeStyle = css('--line') || 'rgba(140,175,225,.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    yTicks.forEach(function(t){
      const y = Math.round(t.y) + 0.5;
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
    });
    ctx.stroke();
    ctx.beginPath();
    const pTop = Math.round(priceTop) + 0.5, pBot = Math.round(priceTop + priceH) + 0.5;
    const vTop = Math.round(volTop) + 0.5, vBot = Math.round(volTop + volH) + 0.5;
    ctx.moveTo(padLeft, pTop); ctx.lineTo(padLeft, pBot); ctx.lineTo(padLeft + plotW, pBot);
    ctx.moveTo(padLeft, vTop); ctx.lineTo(padLeft, vBot); ctx.lineTo(padLeft + plotW, vBot);
    ctx.stroke();
    ctx.restore();
    yTicks.forEach(function(t){
      drawText(ctx, t.label, padLeft + plotW + 4, t.y + 3,
        { align: 'left', font: 9, fill: css('--faint') || '#8ba0b8' });
    });

    /* ── 蜡烛（涨=实心 --rd / 跌=空心 --gn）+ 底部成交量柱 ── */
    const rects = [];
    for(let i = 0; i < n; i++){
      const b = bars[i];
      const o = num(b.open), c = num(b.close), hi = num(b.high), lo = num(b.low);
      const ref = c != null ? c : (o != null ? o : (hi != null ? hi : lo));
      const bodyHi = Math.max(o == null ? ref : o, c == null ? ref : c);
      const bodyLo = Math.min(o == null ? ref : o, c == null ? ref : c);
      const wickHi = hi != null ? hi : bodyHi;
      const wickLo = lo != null ? lo : bodyLo;
      const up = (c != null && o != null) ? c > o : false;
      const x = cx(i);
      /* 注意 drawCandle 第 8 参是遗留的 down 标志（未使用），必须显式传 !up，
       * 否则 upFill/downFill 会整体错位一位、涨柱被当成 --gn 画 */
      drawCandle(ctx, x, py(bodyHi), py(bodyLo), py(wickHi), py(wickLo), candleW, up, !up, upColor, downColor);

      let volRect = null;
      const vol = num(b.volume);
      if(vol != null && vol > 0 && maxVol > 0){
        const vh = Math.max(1, vol / maxVol * volH);
        const vy = volTop + volH - vh;
        const vf = up
          ? colorLadder(1, [{ v: 0, c: upColor }, { v: 1, c: upColor }], 0.5)
          : colorLadder(1, [{ v: 0, c: downColor }, { v: 1, c: downColor }], 0.5);
        drawBar(ctx, x - candleW / 2, vy, Math.max(1, candleW), vh, vf);
        volRect = { x: x - candleW / 2, y: vy, w: Math.max(1, candleW), h: vh };
      }
      rects.push({ i: i, x: x, d: b, up: up, fill: up ? upColor : downColor,
                   bodyTop: py(bodyHi), bodyBot: py(bodyLo), vol: volRect });
    }

    /* ── 均线 MA5 / MA10 / MA20（三色相分离）── */
    const mas = [];
    for(let m = 0; m < maSpec.length; m++){
      const spec = maSpec[m];
      const pts = [];
      for(let i = spec.k - 1; i < n; i++){
        let sum = 0, ok = true;
        for(let j = i - spec.k + 1; j <= i; j++){
          const v = num(bars[j].close);
          if(v == null){ ok = false; break; }
          sum += v;
        }
        if(ok) pts.push({ x: cx(i), y: py(sum / spec.k) });
      }
      mas.push({ k: spec.k, color: spec.c, pts: pts });
      if(pts.length < 2) continue;
      ctx.save();
      ctx.strokeStyle = spec.c;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for(let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    /* ── X 轴稀疏日期 label（起止 + 中点）── */
    const fmtDay = function(s){
      const m2 = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m2 ? (m2[2] + '-' + m2[3]) : String(s || '').slice(0, 10);
    };
    [0, n > 8 ? Math.floor(n / 2) : 1, n - 1].forEach(function(i){
      if(i < 0 || i >= n) return;
      drawText(ctx, fmtDay(bars[i].date), cx(i), h - 4,
        { align: 'center', font: 9, fill: css('--faint') || '#8ba0b8' });
    });

    /* Hit 检测：x 落在哪一根蜡烛的槽位（覆盖价格区 + 量区） */
    function hit(hx, hy){
      if(hx < padLeft || hx > padLeft + plotW) return null;
      if(hy < padTop || hy > padTop + plotH) return null;
      const idx = Math.floor((hx - padLeft) / slotW);
      if(idx < 0 || idx >= n) return null;
      return bars[idx];
    }

    /* 成交量人话化：≥1亿→亿、≥1万→万 */
    function fmtVol(v){
      if(v == null) return '—';
      if(v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if(v >= 1e4) return (v / 1e4).toFixed(1) + '万';
      return String(Math.round(v));
    }

    /* Tooltip 整句（§5 通用条款）：开高低收 + 涨跌幅% + 量，全带单位 */
    function tooltip(b){
      const o = num(b.open), c = num(b.close), hi = num(b.high), lo = num(b.low);
      const chg = (c != null && o != null && o !== 0) ? (c - o) / o * 100 : null;
      const pct = chg == null ? '—' : (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
      return String(b.date || '').slice(0, 10)
        + ' 开' + fmtPrice(o) + ' 高' + fmtPrice(hi) + ' 低' + fmtPrice(lo) + ' 收' + fmtPrice(c)
        + ' · ' + pct + ' · 量' + fmtVol(num(b.volume));
    }

    return {
      hit: hit, tooltip: tooltip, bars: rects, mas: mas,
      layout: { padLeft: padLeft, padTop: padTop, padRight: padRight, padBottom: padBottom,
                plotW: plotW, plotH: plotH, priceTop: priceTop, priceH: priceH,
                volTop: volTop, volH: volH, slotW: slotW, candleW: candleW,
                minP: minP, maxP: maxP, maxVol: maxVol },
    };
  }

  /* ═══ §5-4 实时 TAPE：板块三柱条带（龙头涨幅 / 10日资金 / 板块涨幅）═══
   * 一板块一槽位，槽内 3 根竖柱；柱高按**各自指标范围**归一化
   * （跨板块可比、不跨指标混标度），底部板块名截断 4 字。
   * 色＝指标系列三色分离：龙头涨幅 --rd / 10日资金 --gd / 板块涨幅 --cy。
   * A 股红涨绿跌由 --rd 承载在"龙头涨幅"（涨）系列上；正负号走 tooltip 数值通道，
   * 不做正负分色（否则 3 指标会退化成红绿两色，破坏三色分离）。
   * 数据到位一次性重画（不入 AnimGate.gatedLoop，不新增 rAF 链）。
   * sectors 元素形状来自 tools/close_scan.js：name/leader/leaderPct/d10Yi/changePct */
  function drawTape(canvas, sectors, opts){
    opts = opts || {};
    const num = function(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; };
    const EMPTY = '暂无数据';
    /* 空数据兜底：与 drawKline 同形，hit 永远 null、tooltip 固定文案、layout=null */
    const fallback = { hit: function(){ return null; },
                       tooltip: function(){ return EMPTY; },
                       sectors: [], layout: null };
    const empty = function(ctx, w, h){
      drawText(ctx, EMPTY, w / 2, h / 2,
        { align: 'center', font: 11, fill: css('--faint') || '#8ba0b8' });
      return fallback;
    };

    const R = resizeCanvas(canvas);
    if(!R) return null;
    const ctx = R.ctx, w = R.w, h = R.h;
    ctx.clearRect(0, 0, w, h);

    if(!sectors || !sectors.length) return empty(ctx, w, h);

    /* 系列定义：k=数据字段，c=系列色（--rd/--gd/--cy 三色分离）。
     * 顺序即槽内左→右绘制顺序，hit/tooltip 复用同一数组，避免两处漂移。 */
    const SERIES = [
      { k: 'leaderPct', c: css('--rd') || '#F0485E' },   /* 龙头涨幅：A股涨色红 */
      { k: 'd10Yi',     c: css('--gd') || '#F2B23E' },   /* 10日资金：金色 */
      { k: 'changePct', c: css('--cy') || '#3FD0FF' },   /* 板块涨幅：青色 */
    ];

    const padTop = 6, padBottom = 15, padLeft = 6, padRight = 6;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;
    /* 画布过窄放不下 12 槽×3 柱（或高度连最小柱高都放不下）→ 走占位，不硬画糊 */
    if(plotW < 12 || plotH < 26) return empty(ctx, w, h);

    const n = sectors.length;
    const slotW = plotW / n;
    const groupGap = Math.max(2, slotW * 0.10);
    const barGap   = Math.max(1, slotW * 0.05);
    const barW     = Math.max(1, (slotW - groupGap - 2 * barGap) / 3);

    /* 每个指标各自范围归一化：min→0（最小柱高 2px）、max→全高。
     * hi<=lo 时抬一个 1 单位台阶，避免除零后所有柱等高糊成一条 */
    const ranges = {};
    SERIES.forEach(function(s){
      let lo = Infinity, hi = -Infinity;
      for(let i = 0; i < n; i++){
        const v = num(sectors[i][s.k]);
        if(v == null) continue;
        if(v < lo) lo = v;
        if(v > hi) hi = v;
      }
      ranges[s.k] = (isFinite(lo) && isFinite(hi)) ? [lo, hi <= lo ? lo + 1 : hi] : null;
    });

    /* 预计算每板块几何 + 数据引用，hitTest 直接复用，不重算布局 */
    const groups = [];
    for(let i = 0; i < n; i++){
      const d = sectors[i];
      const gx = padLeft + i * slotW + groupGap / 2;
      const bars = [];
      for(let k = 0; k < SERIES.length; k++){
        const spec = SERIES[k];
        const x = gx + k * (barW + barGap);
        const v = num(d[spec.k]);
        const rg = ranges[spec.k];
        if(v == null || !rg){
          /* 缺字段/全序列缺失 → 留空槽，不画柱（tooltip 里显示 —） */
          bars.push({ k: spec.k, x: x, y: padTop + plotH, w: barW, h: 0,
                      fill: spec.c, v: null, t: null });
          continue;
        }
        const t = Math.max(0, Math.min(1, (v - rg[0]) / (rg[1] - rg[0])));
        const barH = Math.max(2, t * plotH);
        const y = padTop + plotH - barH;
        bars.push({ k: spec.k, x: x, y: y, w: barW, h: barH, fill: spec.c, v: v, t: t });
        drawBar(ctx, x, y, barW, barH, spec.c);
      }
      groups.push({ i: i, x: padLeft + i * slotW, slotW: slotW, d: d, bars: bars });
      /* 底部板块名截断 4 字：形状/文字通道，色盲场景也能读出是哪一列 */
      drawText(ctx, String(d.name || '').slice(0, 4), padLeft + i * slotW + slotW / 2, h - 3,
        { align: 'center', font: 8.5, fill: css('--faint') || '#8ba0b8' });
    }

    /* 基线：plot 底边一条淡线，让"柱高"有共同参照 */
    ctx.save();
    ctx.strokeStyle = css('--line') || 'rgba(140,175,225,.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const baseY = Math.round(padTop + plotH) + 0.5;
    ctx.moveTo(padLeft, baseY);
    ctx.lineTo(padLeft + plotW, baseY);
    ctx.stroke();
    ctx.restore();

    /* Hit 检测：x 落在哪个槽位（覆盖 plot 区 + 底部名称区，命中整槽更宽容） */
    function hit(hx, hy){
      if(hx < padLeft || hx > padLeft + plotW) return null;
      if(hy < padTop || hy > padTop + plotH + padBottom) return null;
      const idx = Math.floor((hx - padLeft) / slotW);
      if(idx < 0 || idx >= n) return null;
      return groups[idx].d;
    }

    function fmtPct(v){
      if(v == null) return '—';
      return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    }
    function fmtYi(v){
      if(v == null) return '—';
      return v.toFixed(1) + '亿';
    }

    /* Tooltip 整句（§5 通用条款）：
     * 「人工智能 龙头肯特催化+10.03% · 10日资金12.5亿 · 板块+3.5%」
     * 板块名 + 龙头名 + 龙头涨幅 + 10日资金 + 板块涨幅，全带单位 */
    function tooltip(d){
      const name = String(d.name || '').slice(0, 6);
      const lead = String(d.leader || '—');
      return name + ' 龙头' + lead + fmtPct(num(d.leaderPct))
        + ' · 10日资金' + fmtYi(num(d.d10Yi))
        + ' · 板块' + fmtPct(num(d.changePct));
    }

    return {
      hit: hit, tooltip: tooltip, sectors: groups,
      layout: { padLeft: padLeft, padTop: padTop, padRight: padRight, padBottom: padBottom,
                plotW: plotW, plotH: plotH, slotW: slotW, barW: barW,
                barGap: barGap, groupGap: groupGap, n: n, ranges: ranges },
    };
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
    drawDistribution,
    drawKline,
    drawTape,
    bindHover,
    /* 供测试用 */
    _hexToRgb: hexToRgb,
    _resolveColor: resolveColor,
  };
})();
