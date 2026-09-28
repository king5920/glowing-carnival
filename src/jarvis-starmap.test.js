'use strict';
/**
 * 星图拾取 + 记忆可视化数据测试
 *
 * 为什么要有这个文件：
 * 点击拾取最容易出的 bug 是「看起来能点、实际偏几十像素」，
 * 这种问题肉眼看不出来。项目只允许 better-sqlite3 一个依赖，
 * 装不了 puppeteer 跑真实浏览器，所以把投影数学抽成
 * ui/pickmath.js，在 Node 里做数值验算。
 */

const assert = require('assert');
const PM = require('../ui/pickmath');
const mem = require('./memory');
const db = require('./db');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

/* 造一批和真实皮层一致的球面点（cortexPos 用的斐波那契球，R=0.95） */
function cortexPoints(n, R = 0.95) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.39996;
    out.push({
      p: [Math.cos(th) * r * R, y * R * 0.95, Math.sin(th) * r * R * 0.97],
      sz: 2.0, kind: 'memory', memId: 100 + i,
    });
  }
  return out;
}

const W = 1632, H = 650;                 // 实测舞台尺寸（宽扁 2.5:1）
const VP = PM.buildVP({ rx: 0.15, ry: 0.3, contentR: 0.95, aspect: W / H });

console.log('\n── 投影数学 ──');

test('投影往返自洽：投出去再点回来命中自己', () => {
  const nodes = cortexPoints(40);
  let checked = 0, hits = 0;
  for (let i = 0; i < nodes.length; i++) {
    const pr = PM.project(nodes[i].p, VP, 1);
    if (!pr) continue;                                  // 相机背后
    const { px, py } = PM.ndcToPx(pr.sx, pr.sy, W, H);
    if (px < 0 || px > W || py < 0 || py > H) continue;  // 视野外
    checked++;
    const best = PM.pickNode(nodes, px, py, {
      VP, spread: 1, width: W, height: H, kinds: ['memory'],
    });
    if (best && best.index === i) hits++;
  }
  assert(checked >= 8, `只有 ${checked} 个点在视野内，样本太小`);
  assert(hits === checked, `${checked} 个点里只有 ${hits} 个能点回自己`);
});

test('投影误差为零（不是近似命中）', () => {
  const nodes = cortexPoints(20);
  for (let i = 0; i < nodes.length; i++) {
    const pr = PM.project(nodes[i].p, VP, 1);
    if (!pr) continue;
    const { px, py } = PM.ndcToPx(pr.sx, pr.sy, W, H);
    if (px < 0 || px > W || py < 0 || py > H) continue;
    const best = PM.pickNode(nodes, px, py, {
      VP, spread: 1, width: W, height: H, kinds: ['memory'],
    });
    if (best && best.index === i) {
      assert(best.dist < 0.01, `#${i} 命中但误差 ${best.dist.toFixed(3)}px，应为 0`);
    }
  }
});

test('spread 变化会移动屏幕位置（所以拾取必须用当帧 spread）', () => {
  const p = cortexPoints(8)[3].p;
  const a = PM.project(p, VP, 0.90);
  const b = PM.project(p, VP, 1.15);
  assert(a && b, '投影失败');
  const dxPx = Math.abs((a.sx - b.sx) * W / 2);
  assert(dxPx > 5,
    `spread 0.90→1.15 只移动了 ${dxPx.toFixed(1)}px，` +
    '如果真没影响就说明测试构造有问题');
});

test('用错的 spread 拾取会偏移（回归保护）', () => {
  const nodes = cortexPoints(30);
  // 找一个在视野内的点
  let target = -1, px = 0, py = 0;
  for (let i = 0; i < nodes.length; i++) {
    const pr = PM.project(nodes[i].p, VP, 1.15);
    if (!pr) continue;
    const c = PM.ndcToPx(pr.sx, pr.sy, W, H);
    if (c.px > 60 && c.px < W - 60 && c.py > 60 && c.py < H - 60) {
      target = i; px = c.px; py = c.py; break;
    }
  }
  if (target < 0) return;                    // 没找到合适样本就跳过
  // 用正确 spread 能命中
  const good = PM.pickNode(nodes, px, py, {
    VP, spread: 1.15, width: W, height: H, kinds: ['memory'],
  });
  assert(good && good.index === target, '正确 spread 下应该命中');
  // 用错的 spread 命中距离明显变大（或直接落空）
  const bad = PM.pickNode(nodes, px, py, {
    VP, spread: 0.85, width: W, height: H, kinds: ['memory'],
  });
  const badDist = bad ? bad.dist : Infinity;
  assert(!bad || bad.index !== target || badDist > good.dist + 3,
    '用错 spread 居然同样精准，说明 spread 没真正参与计算');
});

console.log('\n── 拾取过滤 ──');

test('骨架填充点不可拾取', () => {
  const nodes = cortexPoints(10);
  // 在第一个真实点旁边放一个 corefill 占位点，位置几乎重合
  const near = nodes[0].p.slice();
  nodes.push({ p: near, sz: 6.0, kind: 'corefill' });   // 更大，正常会抢命中
  const pr = PM.project(nodes[0].p, VP, 1);
  if (!pr) return;
  const { px, py } = PM.ndcToPx(pr.sx, pr.sy, W, H);
  const best = PM.pickNode(nodes, px, py, {
    VP, spread: 1, width: W, height: H, kinds: ['memory', 'entity'],
  });
  assert(best, '应该命中记忆点');
  assert(nodes[best.index].kind === 'memory',
    `命中了 ${nodes[best.index].kind}，骨架点不该可点`);
});

test('点空白处返回 null', () => {
  const nodes = cortexPoints(12);
  // 画布角落，离球体很远
  const best = PM.pickNode(nodes, 3, 3, {
    VP, spread: 1, width: W, height: H, kinds: ['memory'],
  });
  assert(best === null, '空白处不该命中任何节点');
});

test('命中半径随深度变化（远处点也要能点中）', () => {
  const nearR = PM.hitRadiusPx(2.0, 1.0);
  const farR  = PM.hitRadiusPx(2.0, 3.0);
  assert(nearR > farR, `近处半径 ${nearR} 应大于远处 ${farR}`);
  assert(farR >= 7, `远处半径 ${farR} 小于最小值 7px，会点不中`);
});

test('相机背后的点不参与拾取', () => {
  const nodes = [{ p: [0, 0, 100], sz: 5, kind: 'memory', memId: 1 }];
  const pr = PM.project(nodes[0].p, VP, 1);
  // z=100 在相机后方（相机在 z 正方向朝 -z 看）
  if (pr === null) { assert(true); return; }
  // 若投影成功，w 必须为正
  assert(pr.w > 0, 'w 应为正');
});

console.log('\n── 记忆可视化数据 ──');

test('starmap 提供点击面板所需的全部字段', () => {
  const s = mem.starmap();
  assert(s.memories.length > 0, '没有记忆可测');
  const need = ['id', 'content', 'weight', 'strength', 'retention',
                'decayState', 'mergedCount', 'readCount', 'ageDays', 'category'];
  for (const m of s.memories) {
    for (const f of need) {
      assert(m[f] !== undefined, `记忆 #${m.id} 缺字段 ${f}`);
    }
  }
});

test('decayState 用纯时间比例分档，不是检索得分', () => {
  /* 这是个真实修过的 bug：
   * 原来用 segmentedDecay（检索得分）分档，它混了情绪保留项（0.3+w*0.7），
   * 结果 18 条记忆全是 fresh —— 分档等于没有。 */
  for (const [days, w, want] of [
    [1, 0.9, 'fresh'], [30, 0.9, 'normal'], [180, 0.9, 'fading'],
    [1, 0.3, 'fresh'], [30, 0.3, 'fading'],
  ]) {
    const r = PM_retention(days, w);
    const got = r >= 0.9 ? 'fresh' : r >= 0.6 ? 'normal' : 'fading';
    assert(got === want,
      `${days}天/权重${w}: 期望 ${want} 实际 ${got} (retention=${r.toFixed(3)})`);
  }
});
function PM_retention(d, w) { return mem.retentionRatio(d, w); }

test('retentionRatio 与 segmentedDecay 是不同的东西', () => {
  // 一年后：纯时间衰减应该很低，检索得分仍然不低（情绪保留托着）
  const ret = mem.retentionRatio(365, 0.9);
  const score = mem.segmentedDecay(365, 0.9);
  assert(ret < 0.25, `一年后时间留存 ${ret.toFixed(3)} 应该很低`);
  assert(score > 0.5, `一年后检索得分 ${score.toFixed(3)} 应该仍不低（情绪保留）`);
  assert(score > ret, '检索得分应高于纯时间留存，否则两者没区别');
});

test('retentionRatio 单调递减', () => {
  let prev = 1.1;
  for (const d of [0, 1, 7, 30, 90, 180, 365, 1000]) {
    const r = mem.retentionRatio(d, 0.6);
    assert(r <= prev, `${d}天 留存 ${r} 比上一档 ${prev} 还高`);
    assert(r >= 0 && r <= 1, `留存 ${r} 越界`);
    prev = r;
  }
});

test('高权重记忆衰减更慢', () => {
  const hi = mem.retentionRatio(90, 0.9);
  const lo = mem.retentionRatio(90, 0.3);
  assert(hi > lo, `90天后 权重0.9 留存 ${hi.toFixed(3)} 应大于 权重0.3 的 ${lo.toFixed(3)}`);
});

console.log('\n── 合并历史 ──');

test('合并历史表存在且可查', () => {
  const ms = db.allMerges(10);
  assert(Array.isArray(ms), 'allMerges 应返回数组');
});

test('合并历史保存了被删记忆的原文', () => {
  const ms = db.allMerges(50);
  if (!ms.length) return;                  // 还没发生合并就跳过
  for (const m of ms) {
    assert(m.dropped_text && m.dropped_text.length > 0,
      `#${m.id} 没保存被删原文 —— 合并不可逆，这是唯一的恢复依据`);
    assert(m.kept_before && m.kept_before.length > 0,
      `#${m.id} 没保存合并前保留方的内容`);
    assert(m.similarity > 0, `#${m.id} 相似度为 0`);
    assert(['similarity', 'model'].includes(m.decided_by),
      `#${m.id} decided_by 异常: ${m.decided_by}`);
  }
});

test('被合并删除的记忆确实查不到了', () => {
  const ms = db.allMerges(50);
  if (!ms.length) return;
  for (const m of ms) {
    assert(!db.memById(m.dropped_id),
      `#${m.dropped_id} 已记录为被合并，却仍能查到 —— 数据不一致`);
    assert(db.memById(m.kept_id),
      `#${m.kept_id} 是保留方，却查不到`);
  }
});

test('mergeCountMap 与 allMerges 一致', () => {
  const map = db.mergeCountMap();
  const ms = db.allMerges(500);
  const recount = {};
  ms.forEach(m => recount[m.kept_id] = (recount[m.kept_id] || 0) + 1);
  for (const k of Object.keys(recount)) {
    assert(map[k] === recount[k],
      `#${k} mergeCountMap 说 ${map[k]} 次，实际 ${recount[k]} 次`);
  }
});

test('starmap.mergeStats 与实际合并数一致', () => {
  const s = mem.starmap();
  const ms = db.allMerges(500);
  // mergeStats.total 只统计"保留方仍存在"的合并
  const alive = ms.filter(m => db.memById(m.kept_id)).length;
  assert(s.mergeStats.total === alive,
    `mergeStats.total=${s.mergeStats.total} 但存活合并记录 ${alive} 条`);
});


console.log('\n── 球面网格质量 ──');

/* 用户看图指出"网格有漏洞、形状不统一"，实测旧算法：
 *   平均度 2.85（球面三角网理论值≈6）
 *   51/130 点只有 2 度 —— 就是肉眼看到的漏洞
 * 根因是全局固定 maxDist + 先到先得吃度数配额。
 * 换成 kNN 对称化后不需调参。这些测试锁住质量下限。 */

function fibSphere(n, R, sy, sz) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.39996;
    out.push([Math.cos(th) * r * R, y * R * (sy || 1), Math.sin(th) * r * R * (sz || 1)]);
  }
  return out;
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* 与 ui/starfield.js 的 linkSphereMesh 同构。
 * 这里复刻是因为 starfield.js 是浏览器 IIFE，Node 无法直接 require。 */
function meshEdges(P, k, rel) {
  const n = P.length;
  if (n < 3) return [];
  const nn = new Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = dist3(P[i], P[j]);
      if (d < nn[i]) nn[i] = d;
    }
  }
  const seen = new Set(), E = [];
  for (let i = 0; i < n; i++) {
    const ord = [];
    for (let j = 0; j < n; j++) if (j !== i) ord.push([dist3(P[i], P[j]), j]);
    ord.sort((a, b) => a[0] - b[0]);
    for (let t = 0; t < Math.min(k, ord.length); t++) {
      const d = ord[t][0], j = ord[t][1];
      if (d > rel * Math.max(nn[i], nn[j])) continue;
      const key = i < j ? i + ',' + j : j + ',' + i;
      if (seen.has(key)) continue;
      seen.add(key);
      E.push([i, j]);
    }
  }
  return E;
}
function meshStats(P, E) {
  const n = P.length, deg = new Array(n).fill(0);
  E.forEach(([i, j]) => { deg[i]++; deg[j]++; });
  const adj = Array.from({ length: n }, () => []);
  E.forEach(([i, j]) => { adj[i].push(j); adj[j].push(i); });
  const seen = new Array(n).fill(false);
  let comps = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    comps++;
    const st = [s]; seen[s] = true;
    while (st.length) {
      const v = st.pop();
      adj[v].forEach(w => { if (!seen[w]) { seen[w] = true; st.push(w); } });
    }
  }
  const lens = E.map(([i, j]) => dist3(P[i], P[j])).sort((a, b) => a - b);
  return {
    avgDeg: deg.reduce((a, b) => a + b, 0) / n,
    weak: deg.filter(d => d <= 2).length,
    isolated: deg.filter(d => d === 0).length,
    comps,
    lenRatio: lens.length ? lens[lens.length - 1] / lens[Math.floor(lens.length / 2)] : 0,
  };
}

test('皮层网格：各规模平均度接近球面三角网理论值 6', () => {
  for (const n of [20, 40, 80, 130, 180, 250]) {
    const P = fibSphere(n, 0.95, 0.95, 0.97);
    const s = meshStats(P, meshEdges(P, 6, 1.45));
    assert(s.avgDeg >= 5.0,
      `${n} 点平均度只有 ${s.avgDeg.toFixed(2)}，网格过稀会出现肉眼可见的漏洞`);
    assert(s.avgDeg <= 7.0, `${n} 点平均度 ${s.avgDeg.toFixed(2)} 过密，纹理会糊成一坨`);
  }
});

test('皮层网格：没有弱连点（漏洞的直接来源）', () => {
  for (const n of [20, 40, 80, 130, 180, 250]) {
    const P = fibSphere(n, 0.95, 0.95, 0.97);
    const s = meshStats(P, meshEdges(P, 6, 1.45));
    assert(s.weak === 0,
      `${n} 点有 ${s.weak} 个点度数<=2 —— 这些位置就是用户看到的"漏洞"`);
  }
});

test('皮层网格：单一连通分量（网格不断裂）', () => {
  for (const n of [20, 40, 80, 130, 180, 250]) {
    const P = fibSphere(n, 0.95, 0.95, 0.97);
    const s = meshStats(P, meshEdges(P, 6, 1.45));
    assert(s.comps === 1, `${n} 点分裂成 ${s.comps} 块，网格断开了`);
  }
});

test('皮层网格：没有异常长边（不会斜穿球面）', () => {
  for (const n of [40, 130, 250]) {
    const P = fibSphere(n, 0.95, 0.95, 0.97);
    const s = meshStats(P, meshEdges(P, 6, 1.45));
    assert(s.lenRatio < 1.6,
      `${n} 点最长边是中位数的 ${s.lenRatio.toFixed(2)} 倍，会出现刺眼的斜穿长边`);
  }
});

test('内核网格：同样达标', () => {
  for (const n of [150, 180]) {
    const P = fibSphere(n, 0.44);
    const s = meshStats(P, meshEdges(P, 6, 1.4));
    assert(s.weak === 0, `内核 ${n} 点有 ${s.weak} 个弱连点`);
    assert(s.comps === 1, `内核 ${n} 点分裂成 ${s.comps} 块`);
    assert(s.avgDeg >= 5.0, `内核 ${n} 点平均度 ${s.avgDeg.toFixed(2)} 过稀`);
  }
});

test('新算法明显优于旧的固定半径算法（回归保护）', () => {
  /* 旧算法：全局 maxDist + 度上限，先到先得。
   * 保留这个对比是为了防止有人"简化"回去。 */
  const n = 130;
  const P = fibSphere(n, 0.95, 0.95, 0.97);

  const maxDist = 1.9 * 2 * 0.95 / Math.sqrt(Math.max(4, n));
  const cand = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist3(P[i], P[j]);
      if (d < maxDist) cand.push([d, i, j]);
    }
  }
  cand.sort((a, b) => a[0] - b[0]);
  const deg = new Array(n).fill(0), oldE = [];
  for (const [, i, j] of cand) {
    if (deg[i] >= 5 || deg[j] >= 5) continue;
    oldE.push([i, j]); deg[i]++; deg[j]++;
  }

  const oldS = meshStats(P, oldE);
  const newS = meshStats(P, meshEdges(P, 6, 1.45));

  assert(oldS.weak > 20,
    `旧算法弱连点只有 ${oldS.weak} 个，与实测的 51 不符，测试构造可能不对`);
  assert(newS.weak === 0, '新算法应该零弱连点');
  assert(newS.avgDeg > oldS.avgDeg + 2,
    `新算法平均度 ${newS.avgDeg.toFixed(2)} 相比旧的 ${oldS.avgDeg.toFixed(2)} 提升不足`);
});

test('starfield.js 已改用 kNN 对称化（不是固定半径）', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'ui', 'starfield.js'), 'utf8');
  assert(src.includes('linkSphereMesh'), 'starfield.js 没有 linkSphereMesh');
  assert(!src.includes('function linkNearIdx'),
    '旧的 linkNearIdx 还在 —— 留着会有人再用错');
  assert(!/linkNearIdx\(/.test(src), '还有地方在调用 linkNearIdx');
});

/* ══════════ §6 抽屉联动：相机偏移数学（C3） ══════════
 * 偏移错了肉眼很难发现（"好像歪了一点"），所以公式抽进 pickmath.js 做数值验算。 */

test('worldPerPx：fit 距离处的世界/像素换算与投影公式一致', () => {
  const fit = 2.0, fovy = 1.0, h = 650;
  const wpp = PM.worldPerPx(fit, fovy, h);
  /* 垂直可视世界高 = 2*fit*tan(fovy/2)，均分到 h 像素 */
  const expect = 2 * fit * Math.tan(fovy / 2) / h;
  assert(Math.abs(wpp - expect) < 1e-12, `wpp=${wpp} 期望 ${expect}`);
  /* 高度为 0 不能除零崩掉 */
  assert(isFinite(PM.worldPerPx(fit, fovy, 0)), 'height=0 必须兜底');
});

test('camShiftTarget：右抽屉负、左抽屉正、关闭为零', () => {
  const wpp = 0.003;
  const right = PM.camShiftTarget(true, false, wpp, 200);
  const left = PM.camShiftTarget(true, true, wpp, 200);
  assert(right < 0, `右抽屉偏移应为负（场景左移），实际 ${right}`);
  assert(left > 0, `左抽屉偏移应为正（场景右移），实际 ${left}`);
  assert(Math.abs(right + left) < 1e-12, '左右偏移应等大反向');
  assert(PM.camShiftTarget(false, false, wpp, 200) === 0, '关闭必须归零');
  assert(PM.camShiftTarget(false, true, wpp, 200) === 0, '关闭必须归零（左抽屉同）');
});

test('camShiftTarget：默认让位 200px，偏移量随 wpp 线性缩放', () => {
  const wpp = 0.004;
  const dflt = PM.camShiftTarget(true, false, wpp);
  const expl = PM.camShiftTarget(true, false, wpp, 200);
  assert(Math.abs(dflt - expl) < 1e-12, '默认 shiftPx 应为 200');
  const half = PM.camShiftTarget(true, false, wpp / 2, 200);
  assert(Math.abs(half - dflt / 2) < 1e-12, 'wpp 减半偏移应减半（线性关系）');
});
console.log('\n───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────\n');
process.exit(fail ? 1 : 0);
