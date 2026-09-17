'use strict';
/**
 * 主线判定的校准记录 —— 攒样本、回归验证阈值。
 *
 * ══════════ 为什么需要这个（用户 2026-09-09 第四优先）══════════
 *
 * 用户的原话：
 *   「"10日≥50亿"这个门槛是单日样本定的。要验证它，
 *     得把每天的 close_scan 结果存下来，跑一两个月回看：
 *     被判"主线候选"的次日/三日表现如何，
 *     被判"体量不足"的是不是真的散了。
 *     这个我现在就能开始做——每天扫完存一份到沙箱，攒够样本再回归。」
 *
 * 这条正好击中本项目一条铁律的空缺：
 * **过滤阈值必须来自实测样本**，而我此前只有单日样本。
 * 单日样本只够排除明显不合理（16 个主线显然不对），
 * 不足以确定 50亿 到底该是 30亿 还是 80亿。
 *
 * ── 设计要点 ──
 * 1. 每天一个 JSONL 追加，不覆盖 —— 历史不可变，回归才有意义
 * 2. 存**判定当时**的完整依据（分数/各维度/阈值），不只存结论。
 *    因为将来改了阈值，还要能重算"如果当时用新阈值会怎样"
 * 3. 同时存 forward 字段占位，日后回填次日/三日涨幅
 * 4. 落盘失败必须显式报错（今天刚被静默 catch 咬过一次）
 */

const sb = require('./sandbox');
const fs = require('fs');
const path = require('path');

const DIR = 'calibration';
const SCAN_FILE = DIR + '/close_scan_history.jsonl';

/* ══════ 为什么不用 sb.read 读样本 ══════
 *
 * sandbox.read 有 `MAX_READ_CHARS = 40000` 截断（保护模型上下文，合理），
 * 且会**返回 truncated:true 但内容已被 slice**。
 *
 * 我第一版直接用 sb.read，实测造 25 天样本时只读回 10 天 ——
 * 而 backfill() 会拿读到的内容**整份重写文件**，
 * 于是超出 40KB 的历史样本会被**静默删除**。
 * 攒两个月的数据可能一次回填就没了，且没有任何报错。
 *
 * 这是今天第 N 次「没看返回结构就用」的错误：
 * read 明明返回了 truncated 标志，我没读。
 *
 * 修法：校准样本走原始 fs 读取（它是内部数据文件，不进模型上下文），
 * 只在需要给模型看时才用 sb.read 的截断版本。 */
function absFile() { return sb.safePath(SCAN_FILE); }

function readRaw() {
  const abs = absFile();
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

function writeRaw(text) {
  const abs = absFile();
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return { bytes: Buffer.byteLength(text) };
}

/** 把一次扫描结果压缩成一行 JSONL */
function buildRecord(scan) {
  const date = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
  return {
    date,
    at: scan.at,
    dataTime: scan.dataTime,
    /* 时点和覆盖率一起存 —— 日后回归时要能剔除
     * "那天数据没抓全"或"拿的是盘中快照"的脏样本。
     * 不存这两个字段，坏样本会污染整个回归结论。 */
    staleWarning: scan.staleWarning || null,
    coverage: scan.coverage || null,
    coverageComplete: !!scan.coverageComplete,
    timing: scan.timing ? {
      stance: scan.timing.stance,
      avgPct: scan.timing.avgPct,
      diverge: scan.timing.diverge,
    } : null,
    /* 判定当时用的阈值 —— 必须存，否则将来改了阈值就无法解释历史判定 */
    thresholds: scan.thresholds || null,
    scanned: scan.scanned,
    mainlineCount: scan.mainlineCount,
    /* 存前 30 个板块的完整判定依据。
     * 只存主线候选是不够的 —— 回归时最需要看的恰恰是
     * "被判体量不足的那些后来涨了吗"（假阴性）。 */
    sectors: (scan.sectors || []).slice(0, 30).map(s => ({
      code: s.code, name: s.name, kind: s.kind,
      score: s.score, grade: s.grade,
      volumeOk: s.volumeOk,
      changePct: s.changePct,
      /* 板块指数点位 —— 回填前向收益的唯一依据。
       * 板块历史K线三个域名全部拿不到（见 close_scan.js 注释），
       * 所以只能靠每天存点位、日后做差。 */
      level: s.level,
      todayYi: s.todayYi, d5Yi: s.d5Yi, d10Yi: s.d10Yi,
      upCount: s.upCount, downCount: s.downCount,
      accel: s.accel, upRatio: s.upRatio,
      leader: s.leader, leaderCode: s.leaderCode, leaderPct: s.leaderPct,
      /* 日后回填：次日/三日/五日 板块涨幅（%）。
       * null 表示还没到时间或还没回填。 */
      forward: { d1: null, d3: null, d5: null },
    })),
  };
}

/**
 * 追加一天的扫描记录。
 *
 * @returns { ok, date, file, bytes, skipped } skipped=true 表示当天已存过
 */
function record(scan) {
  if (!scan || !scan.ok) {
    return { ok: false, error: '扫描结果无效，不记录' };
  }

  const rec = buildRecord(scan);

  /* ══ level 缺失检查 ══
   * 没有 level 的样本**永远无法回填前向收益**，等于白存。
   * 实测踩过：先写了记录、后加 f2 字段，导致首日样本全是 level=undefined，
   * 而 record 的当天去重逻辑又让它无法被覆盖 —— 只能手工删文件。
   * 所以这里显式返回缺失数，让调用方能立刻发现而不是几周后才察觉。 */
  const noLevel = rec.sectors.filter(s => !Number.isFinite(s.level)).length;
  if (noLevel === rec.sectors.length && rec.sectors.length > 0) {
    return { ok: false, error: `全部 ${noLevel} 个板块都缺 level（板块指数点位），`
      + '这样的样本无法回填前向收益，拒绝写入。检查 close_scan 是否取了 f2 字段。' };
  }

  /* 同一天只存一份（以先存的为准）——
   * patrol 冷却 20 小时理论上一天一次，但手动调用会重复。
   * 重复样本会让某天在回归里被算两次，扭曲统计。 */
  const existing = readRaw();
  if (existing.includes(`"date":"${rec.date}"`)) {
    return { ok: true, skipped: true, date: rec.date, file: SCAN_FILE,
             reason: '当天已有记录，跳过（避免重复样本扭曲回归）' };
  }

  const line = JSON.stringify(rec) + '\n';
  /* 用原始 fs 追加，绕开 sandbox 的 40000 字符读取截断。
   * 落盘失败会抛出 —— 今天刚被"静默 catch 导致一条都没存"咬过。 */
  const r = writeRaw(existing + line);

  return { ok: true, date: rec.date, file: SCAN_FILE,
           sectors: rec.sectors.length, noLevel, bytes: r.bytes };
}

/** 读回全部历史记录 */
function history() {
  const raw = readRaw();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

/**
 * 回归分析：阈值到底该定在哪。
 *
 * ⚠ 样本不足时**明确拒绝出结论**，不给似是而非的数字。
 * 这是本项目「基于单次观测下结论」这个反复犯的错误的直接防御 ——
 * 我在语音那边犯过 5 次，不能在这里再犯。
 *
 * @param minDays 至少多少天样本才给结论
 */
function analyze(minDays = 20) {
  const rows = history();
  const clean = rows.filter(r => r.coverageComplete && !r.staleWarning);

  const base = {
    totalDays: rows.length,
    cleanDays: clean.length,
    dropped: rows.length - clean.length,
    minDaysRequired: minDays,
  };

  if (clean.length < minDays) {
    return Object.assign(base, {
      ready: false,
      verdict: `样本不足：干净样本 ${clean.length} 天 < 要求 ${minDays} 天。`
        + '现在下结论就是"基于少量观测下结论"，不做。'
        + `按每交易日一份，还需约 ${minDays - clean.length} 个交易日。`,
      /* 即便不给结论，也把已攒的分布报出来供人工观察 */
      peek: clean.length ? {
        mainlinePerDay: +(clean.reduce((a, r) => a + (r.mainlineCount || 0), 0) / clean.length).toFixed(1),
        d10Distribution: bucketD10(clean),
      } : null,
    });
  }

  /* 有足够天数后才做真正的前向验证。
   * forward 未回填的记录不能参与 —— 否则等于用空气验证。 */
  const withFwd = [];
  const fwdDays = new Set();
  clean.forEach(r => (r.sectors || []).forEach(s => {
    if (s.forward && s.forward.d3 !== null) { withFwd.push(s); fwdDays.add(r.date); }
  }));

  /* ══ 必须同时要求【条数】和【独立天数】══
   *
   * 只看条数会被"板块×天"的乘法效应骗过：
   * 每天存 30 个板块，2 天就有 60 条 —— 看起来样本很多，
   * 实际只有 2 天的市场环境，仍然是"基于少量观测下结论"。
   * 同一天的 30 个板块高度相关（同涨同跌），不是独立样本。
   *
   * 所以独立天数才是真正的样本量，条数只是辅助。 */
  const MIN_FWD_DAYS = Math.max(10, Math.floor(minDays * 0.6));
  if (fwdDays.size < MIN_FWD_DAYS || withFwd.length < 50) {
    return Object.assign(base, {
      ready: false,
      verdict: `天数够了(${clean.length}天)，但已回填 d3 的样本`
        + `只覆盖 ${fwdDays.size} 个独立交易日(需 ${MIN_FWD_DAYS})、${withFwd.length} 条(需 50)。`
        + '同一天的多个板块高度相关，不算独立样本，所以必须同时满足天数和条数。',
      needBackfill: true,
      fwdDays: fwdDays.size,
      fwdSamples: withFwd.length,
    });
  }

  const main = withFwd.filter(s => s.grade === '主线候选');
  const emo = withFwd.filter(s => /情绪驱动/.test(s.grade || ''));
  const avg = arr => arr.length
    ? +(arr.reduce((a, s) => a + s.forward.d3, 0) / arr.length).toFixed(2) : null;
  /* 标准差：均值差异必须大于波动才有意义。
   * 只比均值会把噪声当信号 —— 主线组 +2% vs 情绪组 +1.8%
   * 在标准差 5% 的情况下毫无区分力。 */
  const sd = arr => {
    if (arr.length < 2) return null;
    const m = arr.reduce((a, s) => a + s.forward.d3, 0) / arr.length;
    return +Math.sqrt(arr.reduce((a, s) => a + (s.forward.d3 - m) ** 2, 0) / (arr.length - 1)).toFixed(2);
  };

  const mAvg = avg(main), eAvg = avg(emo);
  const mSd = sd(main), eSd = sd(emo);
  /* 效应量（Cohen's d 的粗略版）：差异 / 合并标准差。
   * |d| < 0.2 视为无实际区分力，即便均值方向"对"。 */
  let effect = null;
  if (mAvg !== null && eAvg !== null && mSd && eSd) {
    const pooled = Math.sqrt((mSd ** 2 + eSd ** 2) / 2);
    if (pooled > 0) effect = +((mAvg - eAvg) / pooled).toFixed(2);
  }

  let verdict;
  if (mAvg === null || eAvg === null) {
    verdict = '两组之一没有样本，无法比较';
  } else if (effect !== null && Math.abs(effect) < 0.2) {
    verdict = `⚠ 硬门槛无实际区分力：主线候选 ${mAvg}%(σ${mSd}) vs 情绪驱动 ${eAvg}%(σ${eSd})，`
      + `效应量仅 ${effect}（|d|<0.2 视为噪声）。50亿 门槛需重调或换维度。`;
  } else if (mAvg > eAvg) {
    verdict = `硬门槛有效：主线候选三日均涨 ${mAvg}%(σ${mSd}) > 情绪驱动 ${eAvg}%(σ${eSd})，`
      + `效应量 ${effect}。当前 ${clean.length} 天样本支持保留 50亿 门槛。`;
  } else {
    verdict = `⚠ 门槛方向错了：主线候选 ${mAvg}% ≤ 情绪驱动 ${eAvg}%（效应量 ${effect}）。`
      + '说明"资金体量大"反而跑输，阈值逻辑需要重新审视。';
  }

  return Object.assign(base, {
    ready: true,
    fwdDays: fwdDays.size,
    mainlineN: main.length, mainlineAvgD3: mAvg, mainlineSd: mSd,
    emotionalN: emo.length, emotionalAvgD3: eAvg, emotionalSd: eSd,
    effectSize: effect,
    verdict,
    d10Distribution: bucketD10(clean),
  });
}

function bucketD10(rows) {
  const b = {};
  rows.forEach(r => (r.sectors || []).forEach(s => {
    const k = s.d10Yi >= 100 ? '≥100亿' : s.d10Yi >= 50 ? '50-100亿'
      : s.d10Yi >= 30 ? '30-50亿' : s.d10Yi >= 10 ? '10-30亿'
        : s.d10Yi > 0 ? '0-10亿' : '净流出';
    b[k] = (b[k] || 0) + 1;
  }));
  return b;
}

/**
 * 回填前向收益。
 *
 * ══════ 为什么只能用「存下来的点位做差」══════
 *
 * 理想做法是取板块历史K线，但实测**三个域名全部不可用**：
 *   push2his   /api/qt/stock/kline/get?secid=90.BK0459 → TCP 层被拦
 *   push2delay 同上                                    → 返回 0 行
 *   push2      同上                                    → TCP 层被拦
 * 龙头个股的历史K线也是 0 行。
 *
 * 所以唯一可行路径：每天扫描时存下板块指数点位 `level`，
 * 回填时用「后一天存的 level」÷「当初存的 level」算涨幅。
 *
 * 这个方案有个**额外好处**：它不依赖任何额外请求，
 * 纯粹从已有样本里算，不会因为上游封域名而失效。
 *
 * 代价：必须**连续**记录。缺一天，跨那天的 d1 就算不出来
 * （只能算到下一个有记录的交易日，会偏大）。
 * 所以下面用「实际相隔的记录数」而不是「日历天数」来配对，
 * 并且把真实间隔写进 forwardMeta，让回归时能识别不连续的样本。
 *
 * @returns { ok, filled, pending, days }
 */
function backfill() {
  const rows = history();
  if (rows.length < 2) {
    return { ok: true, filled: 0, pending: 0, days: rows.length,
             note: '样本少于 2 天，还没有可回填的对象' };
  }

  /* 按日期升序（history 本身是追加顺序，正常就是升序，但不能假设） */
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  /* 建索引：date → { code → level } */
  const levelByDate = rows.map(r => {
    const m = new Map();
    (r.sectors || []).forEach(s => {
      if (Number.isFinite(s.level) && s.level > 0) m.set(s.code, s.level);
    });
    return m;
  });

  let filled = 0, pending = 0;

  /* 对每一天的每个板块，看后面第 1/3/5 条记录能不能配上 */
  const OFFSETS = { d1: 1, d3: 3, d5: 5 };
  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    for (const s of (rec.sectors || [])) {
      if (!s.forward) s.forward = { d1: null, d3: null, d5: null };
      const base = Number(s.level);
      if (!Number.isFinite(base) || base <= 0) continue;   // 老样本没存 level

      for (const [key, off] of Object.entries(OFFSETS)) {
        if (s.forward[key] !== null) continue;             // 已填过
        const j = i + off;
        if (j >= rows.length) { pending++; continue; }     // 还没到时间
        const later = levelByDate[j].get(s.code);
        if (!Number.isFinite(later) || later <= 0) {
          /* 那天这个板块没进前 30 名 —— 数据缺失，不是 0 涨幅。
           * 必须留 null，填 0 会把"没记录"伪装成"没涨"，
           * 那是最恶劣的一种数据污染。 */
          continue;
        }
        s.forward[key] = +(((later - base) / base) * 100).toFixed(2);
        /* 记录真实间隔的记录数，便于回归时剔除不连续样本 */
        s.forward[key + 'Gap'] = `${rec.date}→${rows[j].date}`;
        filled++;
      }
    }
  }

  /* 整份重写（JSONL 逐行覆盖）。回填是就地更新，不能用 append。
   *
   * ⚠ 必须用 writeRaw 而不是 sb.write ——
   * 如果上面的 history() 读到的是被截断的内容，
   * 这里的整份重写就会**静默删掉超出 40KB 的历史样本**。
   * readRaw/writeRaw 配对使用才安全。 */
  const out = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeRaw(out);

  return { ok: true, filled, pending, days: rows.length,
           bytes: Buffer.byteLength(out) };
}

module.exports = { record, history, analyze, backfill, buildRecord, SCAN_FILE };
