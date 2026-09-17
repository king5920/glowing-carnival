'use strict';
/**
 * chan_chart.js —— 把 chan.analyzeLevelV2 的结果渲染成单文件 HTML（内联 SVG）。
 * 用途：阶段1"对图"——生成和用户通达信缠论主图同风格的对照图，离线打开即可。
 * 纯字符串拼接、零依赖；后续 Stage3 也可直接喂给 web 面板。
 *
 * 画面（仿用户截图风格）：
 *   主图：K线(青/红)、笔=黄色折线、线段端点黄圈+价、线段中枢=两条水平绿线夹灰带、
 *         一/二/三买=红▲、一/二/三卖=绿▼；
 *   副图：智能MACD（DIF 白 / DEA 黄 / 红绿柱），并标顶底背驰。
 */

function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/**
 * @param {Array} bars 原始K线（升序）
 * @param {object} v analyzeLevelV2(bars) 结果
 * @param {object} opt {title, width, height, tailN?}
 */
function renderChart(bars, v, opt = {}) {
  const W = opt.width || 1400;
  const title = opt.title || '缠论结构对照图（JARVIS chan.js 复刻）';
  const data = (opt.tailN && bars.length > opt.tailN) ? bars.slice(bars.length - opt.tailN) : bars;
  const n = data.length;
  if (!n) return '<html><body>无数据</body></html>';

  // 用日期映射 bar 下标（供笔/线段/中枢坐标定位）
  const dateIdx = new Map();
  data.forEach((b, i) => dateIdx.set(b.date.slice(0, 10), i));
  const idxOfDate = d => dateIdx.has((d || '').slice(0, 10)) ? dateIdx.get((d || '').slice(0, 10)) : null;

  const padL = 12, padR = 70, padT = 30, mainH = opt.height || 520, volH = 0, macdH = 150;
  const plotW = W - padL - padR;
  const cw = plotW / n;
  const bw = Math.max(1.2, cw * 0.62);

  let hi = -Infinity, lo = Infinity;
  data.forEach(b => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
  const pad = (hi - lo) * 0.04; hi += pad; lo -= pad;
  const x = i => padL + i * cw + cw / 2;
  const y = p => padT + (1 - (p - lo) / (hi - lo)) * mainH;

  const macdTop = padT + mainH + 24;
  const hist = (v.macd && v.macd.hist) || [];
  const dif = (v.macd && v.macd.dif) || [];
  const dea = (v.macd && v.macd.dea) || [];
  let mh = 0;
  for (let i = 0; i < n; i++) {
    const gi = bars.length - n + i;
    mh = Math.max(mh, Math.abs(hist[gi] || 0), Math.abs(dif[gi] || 0), Math.abs(dea[gi] || 0));
  }
  mh = mh || 1;
  const my = val => macdTop + macdH / 2 - (val / mh) * (macdH / 2 - 6);

  let svg = '';

  /* 网格 + 价格刻度 */
  for (let g = 0; g <= 4; g++) {
    const p = lo + (hi - lo) * g / 4;
    const yy = y(p);
    svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#1c2733" stroke-width="1"/>`;
    svg += `<text x="${W - padR + 4}" y="${yy + 3}" fill="#6b7c93" font-size="11">${p.toFixed(0)}</text>`;
  }
  /* 日期刻度（约12个） */
  for (let i = 0; i < n; i += Math.ceil(n / 12)) {
    svg += `<text x="${x(i)}" y="${padT + mainH + 16}" fill="#6b7c93" font-size="10" text-anchor="middle">${(data[i].date || '').slice(0, 10).slice(5)}</text>`;
  }

  /* K线：涨青(此处A股习惯红涨绿跌，按用户截图黑底：涨红 #e54d4d，跌青 #1fbfb8) */
  data.forEach((b, i) => {
    const up = b.close >= b.open;
    const col = up ? '#e54d4d' : '#1fbfb8';
    const xo = x(i);
    svg += `<line x1="${xo}" y1="${y(b.high)}" x2="${xo}" y2="${y(b.low)}" stroke="${col}" stroke-width="1"/>`;
    const yo = y(b.open), yc = y(b.close);
    const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
    svg += `<rect x="${xo - bw / 2}" y="${top}" width="${bw}" height="${hgt}" fill="${col}"/>`;
  });

  /* 笔中枢（方案A主口径）：绿色虚线夹灰带，多个、贴合实际震荡 */
  const base = bars.length - n;
  const zones = v.pivotZones || v.segZones || [];
  zones.forEach((z) => {
    // 笔中枢区间用 fromStroke/toStroke 对应笔端点日期
    const sA = (v.strokes[z.fromStroke] || {}).from;
    const sB = (v.strokes[z.toStroke] || {}).to;
    const di0 = sA ? idxOfDate(sA.date) : null;
    const di1 = sB ? idxOfDate(sB.date) : null;
    if (di0 == null || di1 == null) return;
    const yg = y(z.zG), yd = y(z.zD);
    svg += `<rect x="${x(di0)}" y="${yg}" width="${x(di1) - x(di0)}" height="${yd - yg}" fill="#2e7d5b" opacity="0.16"/>`;
    svg += `<line x1="${x(di0)}" y1="${yg}" x2="${x(di1)}" y2="${yg}" stroke="#39d98a" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    svg += `<line x1="${x(di0)}" y1="${yd}" x2="${x(di1)}" y2="${yd}" stroke="#39d98a" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    svg += `<text x="${x(di0) + 2}" y="${yg - 3}" fill="#39d98a" font-size="10">中枢${z.zD.toFixed(0)}~${z.zG.toFixed(0)}</text>`;
  });

  /* 笔：黄色折线（连接各笔端点） */
  let pts = [];
  (v.strokes || []).forEach((s, si) => {
    const a = idxOfDate(s.from.date), bpos = idxOfDate(s.to.date);
    if (a == null || bpos == null) return;
    if (!pts.length || pts[pts.length - 1].i !== a) pts.push({ i: a, p: s.from.price });
    pts.push({ i: bpos, p: s.to.price });
  });
  if (pts.length > 1) {
    const poly = pts.map(q => `${x(q.i)},${y(q.p)}`).join(' ');
    svg += `<polyline points="${poly}" fill="none" stroke="#f2c200" stroke-width="1.3" opacity="0.95"/>`;
  }
  /* 线段端点黄圈+价（用 segments，比笔更粗的标注） */
  (v.segments || []).forEach(s => {
    const i = idxOfDate(s.to.date); if (i == null) return;
    svg += `<circle cx="${x(i)}" cy="${y(s.to.price)}" r="3.2" fill="none" stroke="#ffd84d" stroke-width="1.3"/>`;
    svg += `<text x="${x(i) + 4}" y="${y(s.to.price) + (s.dir === 'up' ? -5 : 12)}" fill="#ffd84d" font-size="10">${s.to.price.toFixed(0)}</text>`;
  });

  /* 三类买卖点：买红▲ 卖绿▼ */
  (v.points || []).forEach(pt => {
    const i = idxOfDate(pt.date); if (i == null) return;
    const isBuy = pt.kind.includes('买');
    const col = isBuy ? '#ff5b5b' : '#27e089';
    const yo = isBuy ? y(pt.price) + 14 : y(pt.price) - 14;
    const tri = isBuy
      ? `${x(i)},${yo - 6} ${x(i) - 5},${yo + 3} ${x(i) + 5},${yo + 3}`
      : `${x(i)},${yo + 6} ${x(i) - 5},${yo - 3} ${x(i) + 5},${yo - 3}`;
    svg += `<polygon points="${tri}" fill="${col}"/>`;
    svg += `<text x="${x(i) + 6}" y="${yo + 3}" fill="${col}" font-size="11" font-weight="bold">${pt.kind}</text>`;
  });

  /* 背驰文字标注（顶背驰抬到更高、底背驰压到更低，避开买卖点三角） */
  (v.divergences || []).forEach(d => {
    const i = idxOfDate(d.at); if (i == null) return;
    const top = d.type === '顶背驰';
    const yy = top ? y(d.price) - 34 : y(d.price) + 40;
    svg += `<text x="${x(i)}" y="${yy}" fill="#c792ea" font-size="10" text-anchor="middle" font-weight="bold">${d.type}</text>`;
  });

  /* MACD 副图 */
  svg += `<text x="${padL}" y="${macdTop - 6}" fill="#8aa0b8" font-size="11">智能MACD(12,26,9)</text>`;
  svg += `<line x1="${padL}" y1="${my(0)}" x2="${W - padR}" y2="${my(0)}" stroke="#26313d" stroke-width="1"/>`;
  const difPts = [], deaPts = [];
  for (let i = 0; i < n; i++) {
    const gi = base + i, xo = x(i);
    const h = hist[gi];
    if (h != null) {
      const col = h >= 0 ? '#e54d4d' : '#1fbfb8';
      svg += `<rect x="${xo - bw / 2}" y="${Math.min(my(0), my(h))}" width="${bw}" height="${Math.max(1, Math.abs(my(h) - my(0)))}" fill="${col}" opacity="0.7"/>`;
    }
    if (dif[gi] != null) difPts.push(`${xo},${my(dif[gi])}`);
    if (dea[gi] != null) deaPts.push(`${xo},${my(dea[gi])}`);
  }
  svg += `<polyline points="${difPts.join(' ')}" fill="none" stroke="#e8e8e8" stroke-width="1"/>`;
  svg += `<polyline points="${deaPts.join(' ')}" fill="none" stroke="#f2c200" stroke-width="1"/>`;

  /* 图例 */
  const leg = `
    <rect x="${padL}" y="6" width="14" height="3" fill="#f2c200"/><text x="${padL + 18}" y="11" fill="#cfd8e3" font-size="11">笔</text>
    <circle cx="${padL + 48}" cy="8" r="3" fill="none" stroke="#ffd84d"/><text x="${padL + 55}" y="11" fill="#cfd8e3" font-size="11">线段端点</text>
    <rect x="${padL + 128}" y="4" width="14" height="8" fill="#2e7d5b" opacity="0.4"/><text x="${padL + 146}" y="11" fill="#cfd8e3" font-size="11">笔中枢</text>
    <text x="${padL + 220}" y="11" fill="#ff5b5b" font-size="11">▲买卖点</text>`;

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#0d1117;color:#c9d4e1;font-family:'Microsoft YaHei',sans-serif}
.box{padding:10px}.note{color:#8aa0b8;font-size:12px;padding:0 14px 10px;line-height:1.7}</style></head>
<body><div class="box"><h3 style="margin:4px 0 2px 4px;font-weight:600">${esc(title)}</h3>
<div class="note">区间 ${esc(data[0].date)} ~ ${esc(data[n - 1].date)} ｜ K线 ${n} 根 ｜ 笔 ${v.strokeCount} ｜ 线段 ${v.segmentCount} ｜ 笔中枢 ${v.pivotZoneCount != null ? v.pivotZoneCount : (v.segZones || []).length} ｜ 买卖点 ${(v.points || []).length} ｜ 背驰 ${(v.divergences || []).length}
<br>本图为 JARVIS chan.js 工程化复刻（非 DLL 逐位结果），中枢按【笔中枢】绘制，仅用于与通达信缠论主图人工对图，未标定、仅供观察。</div>
<svg width="${W}" height="${macdTop + macdH + 24}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117;display:block">
${leg}${svg}
</svg></div></body></html>`;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
void clamp;  // 保留工具函数（tailN 裁剪曾用）

/** 给 v 挂上日期→全量bars下标表（renderChart 定位中枢用） */
function attachDateIndex(v, bars) {
  const m = new Map();
  (bars || []).forEach((b, i) => m.set(b.date.slice(0, 10), i));
  v._dateIdx = m;
  return v;
}

module.exports = { renderChart, attachDateIndex };
