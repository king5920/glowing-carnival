'use strict';
/**
 * ══════════════ quant_research 桥接 ══════════════
 *
 * 为什么是"桥接"而不是"实现"：
 *
 * 用户的 quant_research 有 694 个 Python 文件 ——
 * backtest 32 个、factor 37 个、strategy 77 个、risk 97 个。
 * 那是长期积累的、经过实盘检验的计算逻辑。
 *
 * 如果在贾维斯里重写一套简化版因子/回测，会出三件事：
 *   ① 两套逻辑漂移 → 同一个因子两个数，用户不知道信哪个
 *   ② 单依赖约束崩塌 → 回测需要 pandas/numpy
 *   ③ **静默给错结论** → 最危险的一条
 *
 * 第三条有实证：周报里标着「上证指数」的周线，实际取到的是
 * 平安银行股价 11.78 元（上证应在 3000-4000）。它不报错，只是安静地错。
 * 回测比行情复杂十倍，简化实现出错概率更高，
 * 而错的回测结论会直接影响真金白银。
 *
 * 所以：**贾维斯当指挥官，quant_research 当执行者。**
 *   贾维斯的价值 = 记忆 + 主动 + 对话 + 归档
 *   quant_research 的价值 = 计算正确
 *
 * ── 安全边界 ──
 * 1. 只允许白名单子命令，不接受任意命令拼接
 * 2. 用 spawn 数组参数，不走 shell，杜绝命令注入
 * 3. 强制超时 + 输出截断（回测可能跑很久、打很多日志）
 * 4. **只读不写**：不允许 trade / order 这类会真实下单的命令
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const QUANT_ROOT = process.env.JARVIS_QUANT_ROOT || 'C:\\Users\\99904\\quant_research';

/* ══════ 白名单 ══════
 *
 * 从 main.py 的 docstring 抄来的真实子命令，逐个标注风险。
 * **绝不包含任何会真实下单的命令** —— 贾维斯可以建议，不能交易。
 * safe=false 的命令需要用户明确确认才跑（耗时长或有副作用）。 */
const COMMANDS = {
  'system-status':  { safe: true,  timeout: 60000,  desc: '系统状态与数据新鲜度' },
  'snapshot':       { safe: true,  timeout: 120000, desc: '市场快照' },
  'signal':         { safe: true,  timeout: 120000, desc: '当前信号' },
  'today-summary':  { safe: true,  timeout: 90000,  desc: '当日总结' },
  'risk':           { safe: true,  timeout: 120000, desc: '风控检查' },
  'gate':           { safe: true,  timeout: 120000, desc: '交易门禁' },
  'candidates':     { safe: true,  timeout: 180000, desc: '候选股池' },
  'screen':         { safe: false, timeout: 300000, desc: '选股筛选（较慢）' },
  'brain':          { safe: false, timeout: 300000, desc: '交易大脑决策' },
  'plan':           { safe: false, timeout: 240000, desc: '生成交易计划' },
  'review':         { safe: false, timeout: 300000, desc: '复盘' },
  /* ══════ morning：必须走 workflow，不能走裸 morning ══════
   *
   * main.py 里有**两个**早盘入口，名字几乎一样但行为完全不同：
   *
   *   1) `main.py morning`               → cmd_morning()
   *      只有 3 个 print 块（市场情绪 / 资金流向 / 风控），
   *      **一个文件都不写**。跑完打印「✅ 早盘流程完成」。
   *
   *   2) `main.py workflow --name morning` → cmd_workflow()
   *      core/workflow.py 里定义的真 6 步流水线：
   *      candidates → snapshot → gate → brain → plan → today-summary
   *      每步落盘到 runs/ reports/ plans/。
   *
   * ══ 这个坑的实测证据 ══
   * 我先前调的是 (1)，结果：
   *   耗时 40 秒、exit 0、输出「✅ 早盘流程完成」，
   *   但 system-status 里 8 项数据**全部仍然过期**
   *   （最久 42 天），reports/plans 文件时间戳一动没动。
   *
   * 也就是说自动刷新一直在"假装成功"——
   * 巡视以为刷新好了，用户以为数据是新的，实际停在 42 天前。
   * 这正是本项目最怕的那类 bug：**看起来在工作但实际没连上**。
   *
   * 所以这里映射成真流水线。argv 由 buildArgs() 统一生成。 */
  'morning':        { safe: false, timeout: 600000, desc: '早盘全流程（6 步，落盘）',
                      argv: ['workflow', '--name', 'morning'] },
  'backtest':       { safe: false, timeout: 600000, desc: '回测（很慢）' },
  'review-plans':   { safe: false, timeout: 180000, desc: '计划复盘' },
  'workflow':       { safe: false, timeout: 300000, desc: '工作流' },
  'review-attribution': { safe: false, timeout: 240000, desc: '归因分析' },
};

/** 把白名单里的命令名翻译成真正的 main.py 参数数组。
 *
 * 绝大多数命令就是它本身；只有少数（morning）需要映射到
 * 别的子命令 + 参数，原因见上面 COMMANDS.morning 的注释。 */
function buildArgs(cmd) {
  const spec = COMMANDS[cmd];
  const argv = (spec && Array.isArray(spec.argv)) ? spec.argv : [cmd];
  return ['main.py'].concat(argv);
}

const MAX_OUTPUT = 24000;        // 超出截断，保留头尾（结论通常在尾部）

/** 找 Python 解释器：优先项目自带虚拟环境 */
function findPython() {
  const cands = [
    path.join(QUANT_ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(QUANT_ROOT, 'venv', 'Scripts', 'python.exe'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'python';
}

function trimOutput(s) {
  if (s.length <= MAX_OUTPUT) return s;
  /* 头尾都留：开头有上下文，结尾有结论。
   * 只留开头会砍掉最重要的部分。 */
  const head = s.slice(0, Math.floor(MAX_OUTPUT * 0.35));
  const tail = s.slice(-Math.floor(MAX_OUTPUT * 0.6));
  return head + `\n\n…… [中间省略 ${s.length - MAX_OUTPUT} 字符] ……\n\n` + tail;
}

/**
 * 跑一个 quant_research 子命令。
 * @param {string} cmd    白名单内的子命令
 * @param {object} opts   { confirm:boolean } safe=false 的命令需要 confirm
 */
function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const spec = COMMANDS[cmd];
    if (!spec) {
      return resolve({
        ok: false,
        error: `不支持的命令 "${cmd}"。可用：${Object.keys(COMMANDS).join(', ')}`,
      });
    }
    /* 慢命令需要显式确认 —— 回测能跑 10 分钟，
     * 不该因为一句随口的话就占满 CPU。 */
    if (!spec.safe && !opts.confirm) {
      return resolve({
        ok: false,
        needConfirm: true,
        command: cmd,
        desc: spec.desc,
        estimateMs: spec.timeout,
        error: `「${cmd}」(${spec.desc}) 耗时可能到 ${Math.round(spec.timeout / 1000)} 秒，需要确认后才跑`,
      });
    }
    if (!fs.existsSync(path.join(QUANT_ROOT, 'main.py'))) {
      return resolve({ ok: false, error: `找不到 ${QUANT_ROOT}\\main.py` });
    }

    const py = findPython();
    const t0 = Date.now();
    let out = '', err = '', done = false;

    /* 关键：数组参数 + 不走 shell。
     * 白名单已经限制了 cmd，但双重保险 —— 万一以后有人放宽白名单，
     * 至少不会变成命令注入。 */
    const child = spawn(py, buildArgs(cmd), {
      cwd: QUANT_ROOT,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',    // 否则中文输出乱码
        PYTHONUTF8: '1',
      }),
    });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      resolve({
        ok: false,
        command: cmd,
        timedOut: true,
        elapsedMs: Date.now() - t0,
        partialOutput: trimOutput(out),
        error: `超时（${Math.round(spec.timeout / 1000)}秒）。已拿到的输出在 partialOutput 里`,
      });
    }, spec.timeout);

    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });

    child.on('error', e => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ ok: false, error: `启动失败: ${e.message}（解释器 ${py}）` });
    });

    child.on('close', code => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({
        ok: code === 0,
        command: cmd,
        desc: spec.desc,
        exitCode: code,
        elapsedMs: Date.now() - t0,
        output: trimOutput(out),
        stderr: err ? trimOutput(err).slice(0, 2000) : null,
      });
    });
  });
}

/** 列出能干什么（给模型看，让它知道有哪些能力） */
function capabilities() {
  return {
    root: QUANT_ROOT,
    available: fs.existsSync(path.join(QUANT_ROOT, 'main.py')),
    commands: Object.entries(COMMANDS).map(([k, v]) => ({
      command: k, desc: v.desc, needConfirm: !v.safe,
      estimateSec: Math.round(v.timeout / 1000),
    })),
    note: '贾维斯只调用不重写 —— 因子/回测/风控逻辑全在 quant_research 里，'
        + '避免两套实现算出不同的数。不提供任何真实下单能力。',
  };
}

/** 读最近产出的报告文件（比重跑一遍便宜得多） */
function recentReports(limit = 8) {
  const dirs = ['reports', 'plans', 'reviews', 'snapshots', 'runs'];
  const rows = [];
  for (const d of dirs) {
    const full = path.join(QUANT_ROOT, d);
    try {
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        if (!/\.(md|json|txt)$/i.test(f)) continue;
        const p = path.join(full, f);
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          rows.push({ dir: d, file: f, bytes: st.size, mtime: st.mtimeMs });
        } catch (_) {}
      }
    } catch (_) {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit).map(r => ({
    dir: r.dir, file: r.file, bytes: r.bytes,
    modified: new Date(r.mtime).toISOString().slice(0, 16).replace('T', ' '),
    ageHours: +((Date.now() - r.mtime) / 3600000).toFixed(1),
  }));
}

/** 读某个报告的内容 */
function readReport(dir, file) {
  const dirs = ['reports', 'plans', 'reviews', 'snapshots', 'runs'];
  if (!dirs.includes(dir)) return { ok: false, error: `目录 ${dir} 不在白名单` };
  // 防目录穿越
  if (!/^[\w\u4e00-\u9fa5.\-]+$/.test(file) || file.includes('..')) {
    return { ok: false, error: '非法文件名' };
  }
  const p = path.join(QUANT_ROOT, dir, file);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > 512 * 1024) return { ok: false, error: `文件过大 ${st.size} 字节` };
    return { ok: true, dir, file, bytes: st.size, content: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { run, capabilities, recentReports, readReport, COMMANDS, QUANT_ROOT };
