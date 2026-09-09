'use strict';
/**
 * GLSL 着色器结构校验（离线）
 *
 * 为什么要有这个文件：
 * 着色器编译失败只会往 console.error 打日志，**画面直接黑屏**。
 * 项目只允许 better-sqlite3 一个依赖，装不了真 WebGL 上下文，
 * 但绝大多数低级错误（in/out 不匹配、uniform 没上传、attribute 没绑定）
 * 都能靠静态分析抓住 —— 这些错误一旦发生就是整屏黑，代价极高。
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'starfield.js'), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
const A = (c, m) => { if (!c) throw new Error(m); };

/* GLSL 允许一行里写多个声明：`in vec3 pos; in float act;`
 * 也允许逗号分隔同类型：`uniform float uT,uPulse,uSpread;`
 * 第一版测试的正则用了 ^\s*in\s+ 行首锚定，只抓到每行第一个声明，
 * 于是误报"顶点输出了片元没接收"——**是测试错了，不是着色器错了**。
 * 这里改成全局扫描 + 展开逗号列表。 */
function declsOf(src, keyword) {
  const out = [];
  const re = new RegExp(`\\b${keyword}\\s+(\\w+)\\s+([\\w,\\s]+?);`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const type = m[1];
    m[2].split(',').forEach(v => {
      const name = v.trim();
      if (name) out.push({ type, name });
    });
  }
  return out;
}
const namesOf = list => list.map(d => d.name);
const sigOf = list => list.map(d => `${d.type} ${d.name}`);

/* 抓出所有 GLSL 源码（模板字符串，以 #version 300 es 开头） */
const shaders = [];
{
  const re = /`(#version 300 es[\s\S]*?)`/g;
  let m;
  while ((m = re.exec(SRC))) shaders.push(m[1]);
}

console.log('\n── 着色器发现 ──');
test('找到成对的着色器（顶点+片元）', () => {
  A(shaders.length >= 4, `只找到 ${shaders.length} 个着色器源，至少应有 4 个（2 程序 × 2 阶段）`);
  A(shaders.length % 2 === 0, `着色器数量 ${shaders.length} 不是偶数，顶点/片元没配对`);
});

/* 配对，并靠 attribute 特征识别哪个程序是哪个。
 *
 * 不能假设源码里的顺序：第一版测试假设 PL 在前，实际 PN 在前，
 * 于是把 PN 的 uPulse 报成"PL 声明了却没上传"——**又是测试自己的错**。
 * 识别依据：线条程序有 aA/aB 两个端点，光点程序有 pos。 */
const pairs = [];
for (let i = 0; i < shaders.length; i += 2) {
  const vs = shaders[i], fsh = shaders[i + 1];
  const attrs = namesOf(declsOf(vs, 'in'));
  const prog = attrs.includes('aA') ? 'PL' : attrs.includes('pos') ? 'PN' : null;
  pairs.push({
    vs, fsh, prog,
    name: prog === 'PL' ? '线条程序 PL' : prog === 'PN' ? '光点程序 PN' : `程序${i / 2}`,
  });
}

test('两个程序都能被识别（PL 线条 / PN 光点）', () => {
  const found = pairs.map(p => p.prog).filter(Boolean).sort();
  A(found.join(',') === 'PL,PN',
    `识别到 [${found.join(',')}]，应恰好是 PL 和 PN —— attribute 特征可能变了`);
});

console.log('\n── 语法结构 ──');

pairs.forEach(({ vs, fsh, name: nm }) => {
  test(`${nm}：括号配平`, () => {
    [['{', '}'], ['(', ')']].forEach(([o, c]) => {
      [[vs, '顶点'], [fsh, '片元']].forEach(([s, lbl]) => {
        const a = (s.split(o).length - 1);
        const b = (s.split(c).length - 1);
        A(a === b, `${lbl}着色器 ${o}${c} 不配平：${a} 个 ${o} vs ${b} 个 ${c}`);
      });
    });
  });

  test(`${nm}：顶点 out 与片元 in 严格匹配`, () => {
    /* 这是最容易黑屏的错误：顶点输出了片元没接收（或反之），
     * 程序链接直接失败。加了新 varying 时特别容易漏。 */
    const vsOut = sigOf(declsOf(vs, 'out'));
    const fsIn = sigOf(declsOf(fsh, 'in'));
    vsOut.forEach(o => A(fsIn.includes(o),
      `顶点输出 [${o}] 但片元没有对应的 in → 链接失败、黑屏`));
    fsIn.forEach(i => A(vsOut.includes(i),
      `片元输入 [${i}] 但顶点没有对应的 out → 链接失败、黑屏`));
  });

  test(`${nm}：没有给未声明的变量赋值`, () => {
    [[vs, '顶点'], [fsh, '片元']].forEach(([s, lbl]) => {
      const decl = new Set(['gl_Position', 'gl_PointSize', 'gl_PointCoord', 'gl_FragCoord']);
      ['in', 'out', 'uniform'].forEach(kw => namesOf(declsOf(s, kw)).forEach(v => decl.add(v)));
      // 局部变量声明
      [...s.matchAll(/\b(?:float|vec2|vec3|vec4|int|mat2|mat3|mat4|bool)\s+([\w]+)\s*[=;]/g)]
        .forEach(x => decl.add(x[1]));
      // 检查所有赋值目标
      [...s.matchAll(/^\s*([a-zA-Z_]\w*)\s*=[^=]/gm)].forEach(x => {
        const v = x[1];
        if (['if', 'for', 'while', 'return', 'else'].includes(v)) return;
        A(decl.has(v), `${lbl}着色器给未声明的变量 [${v}] 赋值`);
      });
    });
  });
});

console.log('\n── JS 侧接线 ──');

test('每个 uniform 都在 JS 侧上传（否则值恒为 0）', () => {
  pairs.forEach(({ vs, fsh, prog: p }) => {
    if (!p) return;
    const us = new Set();
    [vs, fsh].forEach(s => namesOf(declsOf(s, 'uniform')).forEach(v => us.add(v)));
    us.forEach(u => {
      const pat = new RegExp(`getUniformLocation\\(${p},'${u}'\\)`);
      A(pat.test(SRC),
        `${p} 声明了 uniform ${u} 但 JS 从未上传 —— 值恒为 0，效果静默失效`);
    });
  });
});

test('每个 attribute 都在 JS 侧绑定', () => {
  pairs.forEach(({ vs, prog: p }) => {
    if (!p) return;
    namesOf(declsOf(vs, 'in')).forEach(a => {
      const pat = new RegExp(`attr\\(${p},'${a}'`);
      A(pat.test(SRC), `${p} 顶点着色器声明了 attribute ${a} 但 JS 未绑定`);
    });
  });
});

console.log('\n── 语义色相接线 ──');

test('nodeHue 存在且覆盖所有节点类型', () => {
  A(/function nodeHue/.test(SRC), 'nodeHue 函数不存在');
  const seg = SRC.slice(SRC.indexOf('function nodeHue'));
  const body = seg.slice(0, seg.indexOf('\n  }') + 4);
  ['core', 'galaxy', 'entity', 'memory', 'corefill', 'filler'].forEach(k => {
    A(body.includes(`'${k}'`), `nodeHue 没有处理节点类型 ${k}`);
  });
  A(/default/.test(body), 'nodeHue 没有 default 分支');
});

test('nodeHue 用 decayState 而不是 segmentedDecay', () => {
  /* 这是修过的 bug：segmentedDecay 是检索得分（混了情绪保留项），
   * 不是"还剩多少没忘"。用它分档会导致所有记忆都显示新鲜。 */
  const seg = SRC.slice(SRC.indexOf('function nodeHue'));
  const body = seg.slice(0, seg.indexOf('\n  }') + 4);
  A(!/segmentedDecay/.test(body),
    'nodeHue 用了 segmentedDecay —— 那是检索得分不是留存比例，会让所有记忆都显示新鲜');
});

test('nodeHue 对真实数据有足够区分度（不能退化成一种颜色）', () => {
  /* ══ 这个测试来自一次真实的失败 ══
   * 第一版 nodeHue 按 decayState 分三档（fading/normal/fresh），
   * 逻辑看着没问题、shader 测试全过，但拿真实数据一算：
   * 57 条记忆全是 fresh → 全部同一个色相 → 画面和改之前一样单调。
   *
   * 教训：视觉改动必须用真实数据验证区分度，
   * "代码正确"和"看起来有区别"是两件事。
   *
   * 这里复刻 nodeHue 的记忆分支，喂入真实的类别/retention 组合。 */
  function memHue(cat, rt) {
    if (rt < 0.6) return 0.02;
    const CAT = { person: 0.32, project: 0.25, interest: 0.19, place: 0.13, event: 0.07 };
    const base = CAT[cat] == null ? 0.16 : CAT[cat];
    const fine = Math.max(0, Math.min(1, (rt - 0.90) / 0.10));
    return Math.max(0.02, Math.min(0.38, base + (fine - 0.5) * 0.09));
  }

  /* 模拟真实分布：记忆库年轻时 retention 全部挤在 0.97~1.0，
   * 这正是第一版翻车的场景。 */
  const cats = ['interest', 'project', 'person', 'event', 'place'];
  const hues = [];
  cats.forEach(c => {
    for (let k = 0; k < 6; k++) hues.push(memHue(c, 0.975 + k * 0.005));
  });

  const uniq = new Set(hues.map(h => h.toFixed(3)));
  const span = Math.max(...hues) - Math.min(...hues);

  A(uniq.size >= 8,
    `retention 全部挤在 0.975~1.0 时只产生 ${uniq.size} 种色相 —— 画面会单调`);
  A(span >= 0.15,
    `色相跨度只有 ${span.toFixed(3)}，视觉上区分不出来`);

  // 类别之间必须真的分开，不能靠 retention 的微调凑数
  const byCat = cats.map(c => memHue(c, 0.99));
  for (let i = 0; i < byCat.length; i++) {
    for (let j = i + 1; j < byCat.length; j++) {
      A(Math.abs(byCat[i] - byCat[j]) >= 0.05,
        `类别 ${cats[i]} 和 ${cats[j]} 色相太接近（${byCat[i].toFixed(3)} vs ${byCat[j].toFixed(3)}）`);
    }
  }
});

test('nodeHue 在真正褪色时压过类别色（褪色是更重要的信号）', () => {
  function memHue(cat, rt) {
    if (rt < 0.6) return 0.02;
    const CAT = { person: 0.32, project: 0.25, interest: 0.19, place: 0.13, event: 0.07 };
    const base = CAT[cat] == null ? 0.16 : CAT[cat];
    const fine = Math.max(0, Math.min(1, (rt - 0.90) / 0.10));
    return Math.max(0.02, Math.min(0.38, base + (fine - 0.5) * 0.09));
  }
  // 一条褪色的人物记忆，不该还显示成"人物暖色"
  const faded = memHue('person', 0.4);
  const fresh = memHue('person', 0.99);
  A(faded < 0.05, `褪色记忆色相 ${faded.toFixed(3)} 应该接近 0（冷蓝）`);
  A(fresh - faded > 0.25, '褪色与新鲜的色差不够明显');
});

test('记忆节点携带 retention / cat / mergedCount', () => {
  A(/retention:\s*m\.retention/.test(SRC),
    '记忆节点没有传 retention，色相拿不到衰减数据');
  A(/cat:\s*m\.category/.test(SRC),
    '记忆节点没有传 category，类别色相会全部退回默认值');
  A(/mergedCount:\s*m\.mergedCount/.test(SRC),
    '记忆节点没有传 mergedCount，合并光环永远不会出现');
});

test('hue/ring 缓冲已创建并填充', () => {
  ['bHue', 'bRing'].forEach(b => {
    A(SRC.includes(`${b}=gl.createBuffer()`), `${b} 缓冲未创建`);
  });
  A(/hues\[i\]\s*=\s*nodeHue\(n\)/.test(SRC), 'hues 数组未填充');
  A(/rings\[i\]\s*=/.test(SRC), 'rings 数组未填充');
});

console.log('\n── 状态机 ──');

test('所有状态都定义了 flow（能量流强度）', () => {
  const seg = SRC.slice(SRC.indexOf('const S = {'));
  const body = seg.slice(0, seg.indexOf('};') + 2);
  ['idle', 'listen', 'think', 'speak', 'alert'].forEach(s => {
    const m = new RegExp(`${s}:\\s*\\{[^}]*flow:`).test(body);
    A(m, `状态 ${s} 缺少 flow 参数 —— 插值时会变成 NaN，能量流直接失效`);
  });
});

test('待机时能量流接近关闭（否则画面一直很吵）', () => {
  const seg = SRC.slice(SRC.indexOf('const S = {'));
  const body = seg.slice(0, seg.indexOf('};') + 2);
  const idle = /idle:\s*\{[^}]*flow:\s*([\d.]+)/.exec(body);
  const think = /think:\s*\{[^}]*flow:\s*([\d.]+)/.exec(body);
  A(idle && think, '解析不出 idle/think 的 flow 值');
  const iv = parseFloat(idle[1]), tv = parseFloat(think[1]);
  A(iv <= 0.2, `待机 flow=${iv} 太高，画面会一直在流动，看不出什么时候在干活`);
  A(tv >= 0.8, `思考 flow=${tv} 太低，"正在处理"表现不明显`);
  A(tv > iv * 3, `思考(${tv}) 与待机(${iv}) 差距不够，状态区分不出来`);
});

test('eff 里带上了 flow（最容易漏的接线）', () => {
  const seg = SRC.slice(SRC.indexOf('const eff = {'));
  const body = seg.slice(0, seg.indexOf('};') + 2);
  A(/flow:/.test(body),
    'eff 对象没有 flow —— uniform 会拿到 undefined，能量流静默失效');
});

console.log('\n── 图例 ──');

test('图例存在且与色相分档对应', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  A(html.includes('id="legend"'), '没有图例 —— 颜色有含义但用户不知道等于没做');
  ['c-person', 'c-project', 'c-interest', 'c-place', 'c-event', 'c-ent', 'c-fade', 'c-ring']
    .forEach(c => {
      A(html.includes(`lg-d ${c}`), `图例缺少 ${c} 分档`);
      A(new RegExp(`#legend \\.lg-d\\.${c}`).test(html), `图例 ${c} 没有配色`);
    });
});

test('图例说的是类别而不是新鲜度（不能说假话）', () => {
  /* 色相实际表达的是类别 —— 因为实测所有记忆都还是 fresh，
   * 按新鲜度上色会退化成一种颜色。
   * 图例如果写"新鲜/正常/变淡"就是在说假话，比没有图例更糟。 */
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const seg = html.slice(html.indexOf('id="legend"'), html.indexOf('</div>', html.indexOf('c-ring')));
  A(/记忆类别/.test(seg), '图例标题应说明这是类别维度');
  A(!/>新鲜</.test(seg),
    '图例还写着"新鲜" —— 但色相表达的是类别，这是在误导用户');
});

console.log('\n───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────\n');
process.exit(fail ? 1 : 0);
