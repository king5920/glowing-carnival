'use strict';
/**
 * 所有工具的统一注册入口
 *
 * 新增工具时：
 * 1. 在 src/tools/ 下建文件，导出一个 async 函数
 * 2. 在这里 register(name, {description, parameters, rateLimit}, fn)
 * 3. 就会自动出现在模型可选工具列表里
 *
 * 所有工具默认只读。写入工具必须显式 writable: true。
 */

const tools = require('./index');
const stock = require('./stock_quote');
const kl = require('./stock_kline');
const sb = require('./sandbox');
const mk = require('./market_board');
const wr = require('./weekly_report');
const ob = require('./obsidian');
const sh = require('./source_health');
const sd = require('./self_diagnose');
const memTidy = require('./memory_tidy');
const qb = require('./quant_bridge');
const nw = require('./news');
const ff = require('./stock_fundflow');

/* ───── A 股实时行情 ───── */

tools.register('get_stock_quote', {
  description: '查询A股个股实时行情（价格、涨跌幅、市值、PE、PB、换手率等）。支持同时查多只股票。',
  parameters: {
    type: 'object',
    properties: {
      codes: {
        type: 'array',
        items: { type: 'string' },
        description: '6位股票代码列表，如 ["600519", "000001"]',
        maxItems: 20,
      },
    },
    required: ['codes'],
  },
  rateLimit: 20,   // 每分钟 20 次
}, async ({ codes }) => {
  const rows = await stock.quote(codes);
  if (!rows.length) return { error: '未查到行情数据' };
  // 结果做格式化，方便模型理解，同时控制大小
  return {
    count: rows.length,
    stocks: rows.map(r => ({
      code: r.code,
      name: r.name,
      price: r.price,
      change_pct: r.changePct,
      high: r.high,
      low: r.low,
      open: r.open,
      prev_close: r.prevClose,
      volume_lots: r.volume,
      amount_yuan: r.amount,
      mcap_yuan: r.mcap,
      fmcap_yuan: r.fmcap,
      pe_ttm: r.pe,
      pb: r.pb,
      turnover_pct: r.turnover,
    })),
    note: '数据来源：东方财富 push2 行情接口，仅供参考，不构成投资建议。',
  };
});

/* ───── 大盘指数 + 行业板块 ───── */

tools.register('get_market_overview', {
  description: '查看大盘指数行情（上证、深成、创业板、科创50、沪深300、中证500）和行业板块涨跌榜。用于判断整体市场情绪。',
  parameters: {
    type: 'object',
    properties: {
      include_sectors: { type: 'boolean', description: '是否包含行业板块数据（可能拿不到，失败不报错）', default: true },
      top_n: { type: 'integer', description: '涨跌各取前几名', default: 5, minimum: 3, maximum: 15 },
    },
  },
  rateLimit: 30,
}, async ({ include_sectors = true, top_n = 5 } = {}) => {
  const indexes = await mk.indexes();
  const sectors = include_sectors ? await mk.sectors(top_n) : null;
  return {
    indexes: indexes.map(x => ({ name: x.short, price: x.price, changePct: x.changePct, high: x.high, low: x.low })),
    sectors: sectors ? {
      total: sectors.total,
      sampled: sectors.sampled,
      partial: sectors.partial,
      up_count: sectors.upSectors,
      down_count: sectors.downSectors,
      top: sectors.top.map(s => ({ name: s.name, changePct: s.changePct, turnover: s.turnover, leader: s.leader, upCount: s.upCount })),
      bottom: sectors.bottom.map(s => ({ name: s.name, changePct: s.changePct, turnover: s.turnover, downCount: s.downCount })),
    } : null,
    note: sectors
      ? (sectors.partial
          ? `板块共 ${sectors.total} 个，因东财单页上限 100，只抓了涨幅首末两页共 ${sectors.sampled} 个。top/bottom 是准确的涨跌两端，但 up_count/down_count 仅为样本内统计，不代表全市场涨跌家数——不要用它下"全线普涨/普跌"的结论。`
          : '板块为全量数据。')
      : '板块数据本次未取到（东财 push2 在本机被 TCP 层拦截，已自动尝试 push2delay 备用域名仍失败）。指数数据正常，来自腾讯。',
  };
});

/* ───── 周报生成（重型工具，成本较高）───── */

tools.register('generate_weekly_report', {
  description: '生成一周工作回顾。扫描本机所有 AI 编程助手的历史对话（Claude Code / Codex / OpenClaw），自动提取未完成事项、中断点、已完成事项，并汇总大盘行情，生成结构化 Markdown 周报。调用成本较高（约 8000 tokens），不要频繁调用。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '回顾多少天', default: 7, minimum: 1, maximum: 30 },
      write_to_sandbox: { type: 'boolean', description: '是否自动写入沙箱的 weekly/ 目录', default: true },
    },
  },
  rateLimit: 4,     // 每天最多 4 次，防止模型发疯反复调
}, async ({ days = 7, write_to_sandbox = true } = {}) => {
  const r = await wr.generateWeekly({ days });
  if (!r.ok) return { ok: false, error: r.error };

  let sandboxPath = null;
  if (write_to_sandbox) {
    // 文件名用日期范围
    const fname = `weekly_${r.dateRange.replace(/至| /g,'').replace(/-/g,'').slice(0,8)}-${r.dateRange.slice(-10).replace(/-/g,'')}.md`;
    sandboxPath = 'weekly/' + fname;
    try { sb.write(sandboxPath, r.markdown); }
    catch (e) {
      return { ok: false, error: '生成成功但写入沙箱失败: ' + e.message };
    }
  }

  return {
    ok: true,
    summary: {
      date_range: r.dateRange,
      sessions_scanned: r.stats.sessionsScanned,
      projects: r.stats.projects,
      candidates_total: r.stats.candidatesTotal,
      interruptions: r.stats.interruptionsTotal,
      chars: r.stats.outputChars,
      sandbox_path: sandboxPath,
      incomplete: r.incomplete,
    },
    // 给模型看的是摘要，不是全文 —— 全文已经写入沙箱，模型要读可以再调 sandbox_read
    preview: r.markdown.slice(0, 600) + '...',
  };
});

/* ───── A 股 K 线 + 技术指标 ───── */

tools.register('get_stock_kline', {
  description: '查询A股K线并自动算技术指标（MA5/10/20/60、区间涨跌、年化波动率、当前价在区间中的位置）。'
    + '支持日/周/月线，以及分钟线：m1(1分钟,仅当天)、m5(5分,约数月)、m15(15分)、m30(30分,可回溯到2023)、m60(60分,可回溯到2023)。'
    + '盘中看分时走势/短线择时用 m1/m5/m15，看更大级别用 m30/m60；判断中长期趋势用 day/week/month。'
    + '分钟K覆盖个股与指数（如上证000001、创业板399006）。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6位股票或指数代码', maxLength: 6 },
      period: { type: 'string', description: '周期：日周月 day/week/month；分钟 m1/m5/m15/m30/m60', enum: ['day', 'week', 'month', 'm1', 'm5', 'm15', 'm30', 'm60'], default: 'day' },
      limit: { type: 'integer', description: 'K线根数，默认60；日线上限280，分钟线上限1023', default: 60 },
      adjust: { type: 'string', description: '复权方式（分钟K部分源仅支持none）', enum: ['none', 'forward', 'backward'], default: 'forward' },
    },
    required: ['code'],
  },
  rateLimit: 20,
}, async ({ code, period, limit, adjust }) => {
  const r = await kl.kline(code, period || 'day', limit || 60, adjust || 'forward');
  const ind = kl.indicators(r.bars);

  // 腾讯 K 线接口不返回股票名称，用行情接口补一个（失败也无所谓，不阻塞主流程）
  let name = r.name;
  if (name === code) {
    try {
      const q = await stock.single(code);
      if (q && q.name) name = q.name;
    } catch (_) {}
  }

  const isMinute = /^m\d+$/.test(r.period || '');
  /* K 线原始数据很占 token（60 根 × 6 字段），所以：
   * - 指标全给（这才是模型真正要用的）
   * - 原始 K 线只给最近 10 根，让模型能看到近期形态
   * 需要更多时模型可以自己再调一次要更长周期。 */
  return {
    code: r.code,
    name,
    period: r.period,
    adjust: r.adjust,
    source: r.source,
    indicators: ind,
    recent_bars: r.bars.slice(-10),
    note: isMinute
      ? `分钟K来源：${r.source === 'eastmoney' ? '东方财富' : r.source === '10jqka' ? '同花顺' : '新浪财经'}，1分钟K通常仅当天，仅供参考，不构成投资建议。`
      : '数据来源：腾讯财经/新浪财经，仅供参考，不构成投资建议。',
  };
});

/* ───── 沙箱文件系统 ─────
 *
 * 边界由 sandbox.js 的代码保证（路径归一化 + 符号链接实地校验 + 配额），
 * 不依赖 prompt 里的口头约定。实测 11 种越界写法 + 4 种符号链接绕过全部拦截。
 */

tools.register('sandbox_list', {
  description: '列出沙箱目录下的文件和子目录。沙箱是贾维斯唯一可读写的区域。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径，根目录用 "." ', default: '.', maxLength: 200 },
    },
  },
  rateLimit: 40,
}, async ({ path: p }) => sb.list(p || '.'));

tools.register('sandbox_read', {
  description: '读取沙箱内的文本文件内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径，如 "notes/todo.md"', maxLength: 200 },
    },
    required: ['path'],
  },
  rateLimit: 40,
}, async ({ path: p }) => sb.read(p));

tools.register('sandbox_write', {
  description: '写入文件到沙箱（覆盖同名文件）。会自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径', maxLength: 200 },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  writable: true,
  rateLimit: 20,
}, async ({ path: p, content }) => sb.write(p, content));

tools.register('sandbox_append', {
  description: '追加内容到沙箱内的文件末尾（适合写日志、累积笔记）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径', maxLength: 200 },
      content: { type: 'string', description: '要追加的内容' },
    },
    required: ['path', 'content'],
  },
  writable: true,
  rateLimit: 20,
}, async ({ path: p, content }) => sb.append(p, content));

tools.register('sandbox_delete', {
  description: '删除沙箱内的单个文件（不支持删除目录）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径', maxLength: 200 },
    },
    required: ['path'],
  },
  writable: true,
  rateLimit: 10,
}, async ({ path: p }) => sb.remove(p));

/* ───── Obsidian 知识库 ───── */

tools.register('obsidian_overview', {
  description: '查看用户的 Obsidian 知识库结构（D:\\图书馆\\图书馆）：顶层目录、哪些可写、最近改动的笔记。想了解知识库有什么内容时先调这个。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 20,
}, async () => ob.overview());

tools.register('obsidian_list', {
  description: '列出 Obsidian 库内某个目录的内容。全库只读可访问。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '库内相对路径，如 "00-Inbox" 或 "AI智能体工作记录/精华"。留空列根目录。', maxLength: 300 },
    },
  },
  rateLimit: 30,
}, async ({ path: p }) => ob.list(p || ''));

tools.register('obsidian_read', {
  description: '读取 Obsidian 库内的笔记内容。全库只读可访问。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '库内相对路径，如 "00-Inbox/2026-09-03 每日同步.md"', maxLength: 300 },
    },
    required: ['path'],
  },
  rateLimit: 30,
}, async ({ path: p }) => ob.read(p));

tools.register('obsidian_write_note', {
  description: '在 Obsidian 库内新建笔记。只能写 00-Inbox/ 和 AI智能体工作记录/ 两个目录，其余目录禁止写入。同名文件会自动加序号，绝不覆盖用户已有笔记。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '库内相对路径，必须以 00-Inbox/ 或 AI智能体工作记录/ 开头', maxLength: 300 },
      content: { type: 'string', description: '笔记完整内容（Markdown）。建议带 YAML frontmatter，格式参照库内既有笔记。', maxLength: 100000 },
      dry_run: { type: 'boolean', description: '为 true 时只预览不写盘' },
    },
    required: ['path', 'content'],
  },
  writable: true,
  rateLimit: 10,
}, async ({ path: p, content, dry_run }) => ob.createNote(p, content, { dryRun: !!dry_run }));

tools.register('obsidian_append', {
  description: '向 Obsidian 库内已有笔记追加一个 AI 产出区块。遵守库内 AGENTS.md 契约：不改动用户原文，只在文末追加带标记的区块，同一天重复调用会幂等跳过。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '库内相对路径（必须已存在）', maxLength: 300 },
      block: { type: 'string', description: '要追加的 Markdown 内容', maxLength: 50000 },
      heading: { type: 'string', description: '区块标题，默认 "## AI 关联建议"。写分析结论用 "## AI 综合"。', maxLength: 60 },
      dry_run: { type: 'boolean' },
    },
    required: ['path', 'block'],
  },
  writable: true,
  rateLimit: 10,
}, async ({ path: p, block, heading, dry_run }) =>
  ob.appendBlock(p, block, { heading, dryRun: !!dry_run }));

tools.register('write_weekly_to_obsidian', {
  description: '生成周报并写入 Obsidian 库的 00-Inbox（沿用库内「每日同步」的 frontmatter 和四段格式）。耗时约 60 秒。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '回溯天数，默认 7', minimum: 1, maximum: 60 },
      dry_run: { type: 'boolean', description: '为 true 时只预览不写盘' },
    },
  },
  writable: true,
  rateLimit: 3,
}, async ({ days, dry_run }) => {
  const r = await wr.writeToVault({ days: days || 7, dryRun: !!dry_run });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true, vault_path: r.vaultPath, bytes: r.bytes,
    created: r.created, dry_run: r.dryRun,
    incomplete: r.incomplete, stats: r.stats,
    preview: r.preview ? r.preview.slice(0, 600) : undefined,
  };
});

/* ───── 自我诊断 ───── */

tools.register('check_source_health', {
  description: '检查所有数据源的健康状况：成功率、连续失败次数、是否已降级、故障持续了几天。发现数据取不到时先调这个，能区分「接口挂了」和「本来就没这个数据」。',
  parameters: {
    type: 'object',
    properties: {
      only_problems: { type: 'boolean', description: '只返回有问题的源，默认 false' },
    },
  },
  rateLimit: 30,
}, async ({ only_problems }) => {
  if (only_problems) {
    const p = sh.problems();
    return { problems: p.length, list: p };
  }
  return { sources: sh.healthAll(), problems: sh.problems().length };
});

tools.register('diagnose_source', {
  description: '诊断一个故障数据源：实测所有候选替代源（真的发请求，不是猜），然后给出可执行的修复方案。这是「自己发现问题就去解决」能力的核心。耗时约 10-30 秒。',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: '源标识，如 eastmoney.sector（行业板块）、tencent.quote（个股行情）、stock.fundflow（资金流）',
        maxLength: 60,
      },
    },
    required: ['source'],
  },
  rateLimit: 6,
}, async ({ source }) => {
  const r = await sd.diagnose(source);
  return {
    source: r.source, label: r.label,
    degraded: r.degraded, broken_for_days: r.brokenForDays,
    last_error: r.lastReason,
    known_limits: r.knownLimits,
    probes: (r.probes || []).map(p => ({
      // 给完整 URL：截断过的 URL 会让模型误判「参数没发全」
      url: p.url,
      ok: p.ok, ms: p.ms, bytes: p.bytes, error: p.error,
    })),
    working_count: r.workingCount,
    analysis: r.analysis,
  };
});

tools.register('tidy_memory', {
  description: '整理记忆库：合并语义重复的记忆、按类别半衰期衰减旧记忆权重。相似度≥0.85 自动合并，0.70-0.85 交给模型判断是"同一件事"还是"不同侧面"。只降权不删除（合并除外）。',
  parameters: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: '为 true 时只报告会做什么，不改动记忆库' },
      use_model: { type: 'boolean', description: '是否让模型判断中等相似度的记忆对，默认 true' },
    },
  },
  writable: true,
  rateLimit: 6,
}, async ({ dry_run, use_model }) => {
  const r = await memTidy.tidy({ dryRun: !!dry_run, useModel: use_model !== false });
  return {
    ok: r.ok, dry_run: r.dryRun,
    scanned: r.scanned,
    merged: r.merged.map(m => ({
      kept: m.keptContent, dropped: m.droppedContent,
      similarity: m.sim, decided_by: m.by, reason: m.reason,
      new_content: m.newContent,
    })),
    kept_both: r.keptBoth,
    decayed_count: r.decayed.length,
    summary: r.summary,
    errors: r.errors,
    note: '相似度阈值基于本机实测分布设定：实测发现「老陈喜欢喝拿铁」和「喝咖啡习惯点拿铁」语义相同但余弦相似度只有 0.742，所以单一阈值必然出错，中间区间必须问模型。',
  };
});

/* ───── quant_research 桥接（量化能力） ─────
 *
 * 设计原则：**调用，不重写。**
 * 用户的 quant_research 有 694 个 Python 文件（backtest 32 / factor 37 /
 * strategy 77 / risk 97），是长期积累且经实盘检验的。
 * 在贾维斯里写简化版因子和回测的风险不是"算得慢"，而是**静默算错** ——
 * 上证指数那个 bug（标着指数实际取到平安银行 11.78 元）已经证明
 * 这类错误不报警、只是安静地给出错误结论。回测出错会直接影响真金白银。
 */

tools.register('quant_capabilities', {
  description: '列出本机 quant_research 量化系统能做什么（因子、回测、选股、风控、交易计划等），'
    + '以及最近已经生成过哪些报告。用户问"能不能回测""有什么量化功能"时先调这个。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 30,
}, async () => {
  const cap = qb.capabilities();
  return {
    ...cap,
    recent_reports: qb.recentReports(8),
    hint: '已有报告可以直接读（read_quant_report），比重跑一遍快得多也不占 CPU。',
  };
});

tools.register('run_quant_command', {
  description: '调用本机 quant_research 量化系统执行一个命令。'
    + '快命令（system-status/snapshot/signal/risk/gate/candidates/today-summary）直接跑；'
    + '慢命令（backtest/screen/brain/plan/review/morning 等）必须 confirm=true 才会执行。'
    + '注意：这个系统只做分析，不含任何真实下单能力。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '子命令名，如 system-status / snapshot / signal / risk / candidates / backtest / screen / brain / plan',
      },
      confirm: {
        type: 'boolean',
        description: '慢命令需要设为 true 才执行。先把预估耗时告诉用户再确认。',
        default: false,
      },
    },
    required: ['command'],
  },
  rateLimit: 12,
}, async ({ command, confirm = false } = {}) => {
  const r = await qb.run(String(command || '').trim(), { confirm: !!confirm });
  if (r.needConfirm) {
    return {
      status: 'need_confirm',
      command: r.command,
      desc: r.desc,
      estimate_sec: Math.round(r.estimateMs / 1000),
      message: r.error,
      note: '先告诉用户预估耗时，得到同意后再带 confirm=true 重新调用。',
    };
  }
  return r;
});

tools.register('read_quant_report', {
  description: '读取 quant_research 已经生成的报告文件（reports/plans/reviews/snapshots/runs 目录）。'
    + '比重新跑一遍命令快得多。先用 quant_capabilities 看有哪些文件。',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '目录：reports / plans / reviews / snapshots / runs' },
      file: { type: 'string', description: '文件名（不含路径）' },
    },
    required: ['dir', 'file'],
  },
  rateLimit: 30,
}, async ({ dir, file } = {}) => qb.readReport(String(dir || ''), String(file || '')));

/* ───── 新闻（用户指出的真缺口） ─────
 *
 * 之前贾维斯能看行情、能算指标，但**不知道为什么涨跌**。
 * 三个源全部实测通过：财联社（主）→ 新浪（备胎）、东财（个股）。
 */

tools.register('get_market_news', {
  description: '获取市场快讯（财联社电报为主，失败自动降级到新浪财经）。'
    + '用于解释盘面异动原因、了解宏观和政策消息。返回带时间戳和关联个股。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '条数', default: 15, minimum: 3, maximum: 40 },
    },
  },
  rateLimit: 20,
}, async ({ limit = 15 } = {}) => nw.marketNews(limit));

tools.register('get_stock_news', {
  description: '获取指定股票的相关新闻（东财搜索）。用于查某只股票近期发生了什么。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6位股票代码，如 600519' },
      limit: { type: 'integer', description: '条数', default: 10, minimum: 3, maximum: 25 },
    },
    required: ['code'],
  },
  rateLimit: 20,
}, async ({ code, limit = 10 } = {}) => nw.newsForStock(String(code || '').trim(), limit));

/* ── 个股资金流拆解 ──
 *
 * 补上健康表里挂了很久却**从没有人调用**的那个源。
 * 之前 stock.fundflow 一直显示"未探测"，不是接口坏了，
 * 而是整个代码库没有任何函数去请求它 —— 面板上一个长期亮着的红灯，
 * 时间久了就被当成背景噪声，真出问题时反而不会去看。
 *
 * 主力/超大单/大单口径是东财独家，腾讯只有行情快照。
 * 实测 push2 主域已被封，push2delay 镜像可用（em_client 自动切）。 */
tools.register('get_fund_flow', {
  description: '查个股资金流：当日主力/大单/中单/小单四档拆解（东财独家）'
    + ' + 近 20 日净流入趋势（新浪，独立风控面）。'
    + '用于判断利好是否有真实资金承接、是持续流入还是一日游。'
    + '⚠ 两个口径不同：东财「主力」只含超大单+大单（四档合计为 0，是零和拆分），'
    + '新浪「净额」是全口径，所以同一天可能反向——'
    + '主力为正而净额为负 = 主力吸筹、散户抛售，这是正常现象不是数据错误。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6位股票代码，如 300383。注意：指数没有资金流拆解' },
      days: { type: 'integer', description: '趋势取最近几个交易日', default: 20, minimum: 1, maximum: 120 },
    },
    required: ['code'],
  },
  rateLimit: 20,
}, async ({ code, days = 20 } = {}) => ff.fundFlowSummary(String(code || '').trim(), days));

/* ── 收盘扫描：指数判时机 · 板块定方向 · 龙头选个股 ──
 *
 * 用户 2026-09-09 提的框架，原话：
 *   「收盘后自动扫描指数和热门板块，整理出近10日内资金活跃的板块，
 *     判断哪些板块会成为主线，指数判时机，板块定方向，龙头选个股」
 *
 * 用户选择「规则分数和模型判断**并列展示**」，所以这个工具只出规则分数，
 * 模型解读由模型自己在回答里给 —— 两者分开，分歧时用户能看见。 */
tools.register('close_scan', {
  description: '收盘扫描：一次拿到①指数判时机（能不能出手）②板块定方向（近10日资金活跃度+主线打分）'
    + '③龙头选个股（每个板块的领涨股）。'
    + '10日/5日主力净额来自东财一次请求，无需累积历史。'
    + '注意：grade 里的"主线候选"有资金体量硬门槛（10日≥50亿）；'
    + '标"情绪驱动,资金体量不足"的是龙头涨停但资金没进的板块，次日容易散。'
    + '规则分数可复现，但阈值仅按单日样本校准过，请把它当筛选器而非结论。',
  parameters: {
    type: 'object',
    properties: {
      topN: { type: 'integer', description: '返回前几个板块', default: 12, minimum: 3, maximum: 30 },
    },
  },
  rateLimit: 10,
}, async ({ topN = 12 } = {}) => {
  const cs = require('./close_scan');
  const r = await cs.scan({ topN });
  return { text: cs.formatScan(r), ...r };
});

/* ── 主线阈值校准记录 ──
 *
 * 用户 2026-09-09：「"10日≥50亿"这个门槛是单日样本定的……
 * 每天扫完存一份到沙箱，攒够样本再回归」。
 * 补上「过滤阈值必须来自实测样本」的空缺。 */
tools.register('calibration_status', {
  description: '查主线判定阈值的校准进度：已攒多少天样本、当前分布、'
    + '以及回归结论（样本不足时会明确拒绝下结论，不给似是而非的数字）。'
    + '用于回答"那个50亿门槛到底准不准"。',
  parameters: {
    type: 'object',
    properties: {
      minDays: { type: 'integer', description: '至少多少天样本才出结论', default: 20, minimum: 5, maximum: 120 },
    },
  },
  rateLimit: 20,
}, async ({ minDays = 20 } = {}) => {
  const cal = require('./calibration');
  const a = cal.analyze(minDays);
  const h = cal.history();
  /* 顺手回填一次 —— 用户随时问进度时，数据应该是最新的，
   * 而不是等下一次 patrol 才更新。回填是纯本地计算，很便宜。 */
  let bf = null;
  try { bf = cal.backfill(); } catch (e) { bf = { ok: false, error: e.message }; }
  return {
    ...a,
    backfill: bf,
    dates: h.map(r => r.date),
    file: cal.SCAN_FILE,
    howItWorks: '板块历史K线三个域名全部不可用（push2his/push2 被 TCP 拦、push2delay 返 0 行），'
      + '所以前向收益靠"每天存板块指数点位、日后做差"计算。'
      + '缺记录的那天留 null 而非填 0，避免把"没数据"伪装成"没涨"。',
  };
});

/* ── 当前时间（贾维斯的时钟兜底）──
 *
 * 每轮对话其实已经注入了 clock.nowBlock()，所以简单的时间问题
 * （现在几点/明天开盘吗）不需要调这个工具。
 * 它的作用是：工具循环跑了很久、或需要对"时间"做二次确认时，
 * 能拿到一个实时的权威值，而不是去拉行情反推（收盘后会反推错）。
 * 零成本、纯本地。 */
tools.register('get_current_time', {
  description: '获取当前权威时间：日期、星期、时分、是否交易日、当前盘前/盘中/盘后、'
    + '以及下一个交易日。回答时间、日程、开盘休市类问题时用它；'
    + '不要用行情数据反推时间（收盘后价格不动会被误判成盘中）。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 5,
}, async () => {
  const clock = require('../clock');
  const now = new Date();
  const nxt = clock.nextTradingDay(now);
  return {
    text: clock.nowBlock(now),
    iso: clock.dateKey(now),
    weekday: '周' + '日一二三四五六'[now.getDay()],
    hhmm: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
    isTradingDay: clock.isTradingDay(now),
    session: clock.tradingSession(now),
    nextTradingDay: nxt ? { date: clock.dateKey(nxt.date), offsetDays: nxt.offsetDays } : null,
    calendarVerifiedThrough: clock.DATA_VERIFIED_THROUGH,
  };
});

/* ── 放音乐 / 视频（打开网页版）──
 *
 * 用户 2026-09-10 选择"打开网页版音乐/视频"。
 * 贾维斯自己没有喇叭（沙箱只能读写文本），它做的是"替你点开"：
 * 用默认浏览器打开对应平台的搜索页，你本来的登录态都在。
 *
 * 语义诚实：工具只负责打开页面，控制不了播放状态，
 * 所以描述里明确告诉模型别对用户说"正在播放"。 */

/* 平台 → 搜索 URL 模板，%s 放 URL 编码后的关键词。
 * 只放稳定的搜索页，不写死具体歌曲链接（容易失效）。 */
const MEDIA_SITES = {
  netease:  { label: '网易云音乐', music: true,  url: q => `https://music.163.com/#/search/m/?s=${q}&type=1` },
  qqmusic:  { label: 'QQ音乐',    music: true,  url: q => `https://y.qq.com/n/ryqq/search?w=${q}` },
  bilibili: { label: 'B站',      music: false, url: q => `https://search.bilibili.com/all?keyword=${q}` },
  youtube:  { label: 'YouTube',  music: false, url: q => `https://www.youtube.com/results?search_query=${q}` },
};

tools.register('play_media', {
  description: '在用户电脑的默认浏览器里打开音乐或视频的搜索结果页（网易云/QQ音乐/B站/YouTube）。'
    + '用于"放首歌/放音乐/看XX视频"这类请求。'
    + '注意：你只是帮用户【打开网页】，无法控制实际播放，'
    + '所以不要说"正在为您播放"，应说"已经帮你打开XX的搜索页，点一下就能听"。'
    + '没有指定平台时，纯音乐默认网易云，视频/不确定类型默认B站。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '歌曲名/歌手/视频关键词，如 "周杰伦 晴天" 或 "航拍中国"' },
      platform: {
        type: 'string',
        enum: ['auto', 'netease', 'qqmusic', 'bilibili', 'youtube'],
        description: '平台，默认 auto（音乐→网易云，视频→B站）',
      },
      kind: { type: 'string', enum: ['auto', 'music', 'video'], description: '内容类型，默认 auto' },
    },
    required: ['keyword'],
  },
  rateLimit: 5,
}, async ({ keyword, platform = 'auto', kind = 'auto' }) => {
  if (!keyword || !String(keyword).trim()) {
    return { ok: false, text: '没说要放什么，请给出歌曲名或视频关键词。' };
  }
  const q = encodeURIComponent(String(keyword).trim());

  /* 平台自动选择 */
  let site;
  if (platform === 'auto') {
    const wantVideo = kind === 'video' || /视频|电影|剧|纪录片|番|up主|教程/.test(keyword);
    site = wantVideo ? MEDIA_SITES.bilibili : MEDIA_SITES.netease;
  } else {
    site = MEDIA_SITES[platform];
  }
  if (!site) return { ok: false, text: `不认识的平台：${platform}` };

  const target = site.url(q);
  const opener = require('./desktop_open');
  const r = await opener.openUrl(target);
  if (!r.ok) return { ok: false, text: '打开失败：' + r.error };

  return {
    ok: true,
    text: `已经在浏览器打开【${site.label}】搜索"${keyword}"的页面，点第一个结果就能${site.music ? '听' : '看'}。`
      + '我这边控制不了播放（暂停/切歌需要你在页面上操作）。',
    platform: site.label, keyword: String(keyword).trim(), url: target,
  };
});

tools.register('open_url', {
  description: '用默认浏览器打开一个 http/https 网页。用于用户明确给了网址、或要查某个网站时。'
    + '只允许网页链接，拒绝可执行文件和危险协议。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '完整的 http(s) 网址' } },
    required: ['url'],
  },
  rateLimit: 5,
}, async ({ url }) => {
  const opener = require('./desktop_open');
  const r = await opener.openUrl(url);
  if (!r.ok) return { ok: false, text: '打开失败：' + r.error };
  return { ok: true, text: `已在浏览器打开 ${r.url}`, url: r.url };
});

/* ── 联网搜索（免费源，Bing HTML 抓取）──
 *
 * 内置 web_search 的 key 已失效，这是替代。
 * 用户明确要求：坏了就明说，绝不编造。
 * 非官方接口，Bing 改版可能失效 —— 失效时工具会返回 ok:false，
 * 模型必须如实告诉用户"现在搜不了"，不能用记忆冒充搜索结果。 */
tools.register('web_search', {
  description: '联网搜索最新信息（新闻、公告、实时事件、不了解的新事物）。'
    + '需要时效性、或超出你知识范围的问题先用这个。返回标题/链接/摘要。'
    + '重要：如果返回"暂时不可用"，必须如实告诉用户搜不了，'
    + '绝不能凭记忆编造新闻或数据冒充搜索结果。行情数据仍优先用专门的行情工具。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      count: { type: 'integer', description: '返回条数（1-10）', default: 6 },
    },
    required: ['query'],
  },
  rateLimit: 8,
}, async ({ query, count = 6 }) => {
  const ws = require('./web_search_free');
  const r = await ws.search(query, count);
  return { text: ws.formatResults(r), ...r };
});

/* ── 错误账本（自我进化）──
 *
 * 用户 2026-09-10：「能找到自己的错误并自进化」。
 * 工具失败会自动记账（brain.js 里），这个工具用来回看：
 * 最近犯了哪些错、哪类错误反复犯、哪些已值得固化成测试。 */
tools.register('review_lessons', {
  description: '查看贾维斯自己的错误账本：最近的工具失败、反复出现的错误模式、'
    + '以及哪些错误已重复到值得写成测试（第③层候选）。'
    + '当用户问"你最近犯了什么错/哪里总出问题/自我进化得怎样"时使用。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: '最近记录条数', default: 30 },
    },
  },
  rateLimit: 10,
}, async ({ limit = 30 } = {}) => {
  const lessons = require('./lessons');
  const o = lessons.overview(limit);
  if (o.error) return { ok: false, text: '读取错误账本失败：' + o.error };
  const L = [];
  L.push(`【错误账本】共记录 ${o.total} 条，涉及 ${o.distinctPatterns} 类错误模式。`);
  if (o.repeatOffenders && o.repeatOffenders.length) {
    L.push('');
    L.push('反复犯的错（最该警惕）：');
    o.repeatOffenders.forEach(x => {
      L.push(`· ${x.scope} — ${x.pattern}（${x.occurrence} 次）`);
      if (x.guard) L.push(`  自查方式：${x.guard}`);
    });
  }
  if (o.recent && o.recent.length) {
    L.push('');
    L.push('最近的失败：');
    o.recent.slice(0, Math.min(8, limit)).forEach(r => {
      L.push(`· [${r.ts}] ${r.scope} ${r.pattern}：${String(r.actual).slice(0, 80)}`);
    });
  }
  if (o.candidatesForTest && o.candidatesForTest.length) {
    L.push('');
    L.push(`有 ${o.candidatesForTest.length} 类错误已重复≥2次，达到"建议固化成测试"的门槛（第③层，目前只报告不自动改代码）。`);
  }
  return { text: L.join('\n'), ...o };
});

/* 保存一条教训（错误账本第②.5层：用户纠正闭环）。
 *
 * 通常由 brain 检测到用户纠正后，模型先复述+询问，用户确认才调本工具。
 * 也用于用户明确说"记住这个教训"。 */
tools.register('save_lesson', {
  description: '把一条确认过的教训存入错误账本。只在用户明确同意记下、或用户直接要求"记住这个教训"时调用。'
    + '存的是"下次怎么不再犯"，不是记仇或记用户观点。每条必须有 actual（错在哪）和 guard（下次怎么自查）。',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: '出错环节，如 web:回答 / logic:推理 / time:时间 / tool:工具名' },
      pattern: { type: 'string', description: '错误类型，如 事实错误/时间概念错误/单次观测就下结论/没读真实结构就猜字段' },
      expected: { type: 'string', description: '正确应该怎样' },
      actual: { type: 'string', description: '实际错在哪' },
      rootCause: { type: 'string', description: '根本原因（一句话）' },
      guard: { type: 'string', description: '下次怎么避免，必须是可执行的自查方式' },
    },
    required: ['actual', 'guard'],
  },
  writable: true,
  rateLimit: 10,
}, async (c) => {
  const corr = require('./correction');
  const r = corr.confirmLesson(c);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, text: `教训已入错误账本（${r.repeated ? '同类复发，次数+1' : '新增'}，#${r.id}）：${c.actual}｜自查：${c.guard}`, ...r };
});

/* ── 盯盘预警：大盘时机（总开关）+ 主线板块调整（方向）── */

tools.register('market_timing', {
  description: '判断当前大盘是否进入可关注的买入时机（情绪+技术多条件共振）。'
    + '这是"大盘定时机"的总开关：没到买入窗口时，板块机会只观察不动手。'
    + '返回每一项条件的满足情况、炸板率/涨停数/连板高度，以及阈值是否已标定。'
    + '阈值标定前结论仅供观察，不要向用户打包票。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 12,
}, async () => {
  const sentiment = require('./sentiment');
  const alerts = require('./alerts');
  const db = require('../db');
  const snap = await sentiment.snapshot();
  const days = db.alertSampleDates().length;
  const m = alerts.judgeMarket(snap, days);
  const se = snap.sentiment || {};
  const L = [];
  L.push(`【大盘时机】${m.buy ? '✅ 情绪技术共振，进入买入窗口' : '⏸ 时机未到，只观察不动手'}（${m.passed}/${m.total} 项满足）`);
  if (!m.calibrated) L.push(`⚠ 阈值尚未标定（样本 ${days}/${alerts.MIN_CAL_DAYS} 个交易日），当前为保守临时阈值，仅供观察`);
  m.checks.forEach(c => L.push(`${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`));

  /* 结构与反向上下文（轻量，不复刻 market_phase 全文）：
     用日K给一句缠论阶段，并标注顺势(右侧)与情绪冰点(左侧)是两套独立口径，
     避免模型把"散户恐慌"直接等同"可以买"。 */
  try {
    const kline = require('./stock_kline');
    const k = await kline.kline('000001', 'day', 240);
    const chan = require('./chan');
    const mk = chan.analyzeMarket({ day: k.bars });
    L.push(`结构定位：缠论「${mk.phase}」（${mk.reason}）— 这是"大盘定时机"的结构背景，未标定仅供观察`);
  } catch (_) { /* 结构取不到不影响顺势判断 */ }
  L.push('注：本工具是顺势(右侧)总开关。跌停家数和炸板率的分位在 market_phase，未标定，给不出入场时机。');

  return { text: L.join('\n'), buy: m.buy, confidence: m.confidence, calibrated: m.calibrated,
           sampleDays: days, sentiment: se, checks: m.checks };
});

/* ── 大盘缠论生命阶段 + 散户崩溃冰点（阶段3）── */

tools.register('market_phase', {
  description: '大盘"现在处在什么生命阶段 + 散户有没有崩溃"的结构化判断（仅上证指数）。'
    + '缠论部分按日K给出六阶段：退潮期/磨底期/筑底期/启动期/主升期/高位震荡期，'
    + '并带走势类型、笔中枢位置、买卖点/背驰数量等证据；'
    + '情绪部分只给两列数：跌停家数、炸板率，以及它们在此前定型日里的分位和样本天数。'
    + '方法论：大盘定买卖时机。缠论画法未标定。这两列数给不出入场时机，'
    + '绝不能说"可以买"，也不对个股给买卖建议。',
  parameters: {
    type: 'object',
    properties: {
      withMinute: { type: 'boolean', description: '是否叠加60分/30分级别做timing细化（更慢）', default: false },
    },
  },
  rateLimit: 15,
}, async ({ withMinute = false } = {}) => {
  const sentiment = require('./sentiment');
  const kline = require('./stock_kline');
  const db = require('../db');
  const mp = require('./market_phase');
  const r = await mp.assess({
    getBars: (period) => kline.kline('000001', period, period === 'day' ? 240 : 320).then(k => k.bars),
    snapshot: () => sentiment.snapshot(),
    alertSamples: () => db.alertSamplesDaily(),
  }, { withMinute });

  const L = [`【大盘状态】${r.summary}`];
  if (r.chan) {
    const d = r.chan.levels.day || {};
    const trendCn = { up: '上涨', down: '下跌', range: '震荡' }[d.trend] || '趋势待定';
    const posCn = { above: '价在中枢上方', below: '价在中枢下方', inside: '价在中枢内' }[d.pricePos] || '位置待定';
    L.push(`结构：${trendCn}走势，${posCn}`
      + `；笔${d.strokeCount} 笔中枢${d.segZoneCount} 买卖点${d.pointCount} 背驰${d.divergenceCount}`);
    if (r.chan.reason) L.push('阶段理由：' + r.chan.reason);
  }
  const t = r.sentimentTape;
  if (t && Array.isArray(t.rows)) {
    if (t.intraday) L.push('盘中未定型');
    t.rows.forEach(row => {
      if (row.value == null) L.push(`${row.name}：缺失`);
      else {
        const shown = row.name === '炸板率' ? (+row.value).toFixed(1) : String(Math.round(row.value));
        const pct = row.pct == null ? '分位空' : ((row.pct * 100).toFixed(1) + '%');
        const n = row.n == null ? '样本空' : (row.n + '天');
        L.push(`${row.name}：${shown}，分位 ${pct}，样本 ${n}`);
      }
    });
    L.push(t.note);
  }
  if (!r.calibrated) L.push('⚠ 缠论画法未标定。这两列数给不出入场时机。');
  if (r.ledger && Array.isArray(r.ledger.items)) {
    L.push('【标定总账】只复述下面的结论，样本不够或未标定的不要说成已经验证');
    r.ledger.items.forEach(it => L.push(`· ${it.name}：${it.label}${it.detail ? ' — ' + it.detail : ''}`));
    const dead = r.ledger.items.filter(it => it.state === 'fail').map(it => it.name);
    if (dead.length) L.push('样本外无效，转述时不要当成有效边缘：' + dead.join('、'));
    L.push('选股未纳入标定：尚无选股策略。');
  }
  if (r.errors && r.errors.length) L.push('（' + r.errors.join('；') + '）');
  return { text: L.join('\n'), ...r };
});

/* ── A. 集合竞价：短线风向标（同花顺 fuyao）── */
tools.register('auction_benchmark', {
  description: '当日（或指定交易日）集合竞价"短线风向标"：同花顺官方精选的竞价异动个股，'
    + '带竞价涨跌幅与概念标签。用于开盘前/早盘感知资金第一票的方向（大盘定时机的盘前补充）。'
    + '只覆盖主板+创业板白名单（已剔科创/北交/ST）。官方精选清单非买入建议，转述保留"仅供观察"。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: '交易日 YYYYMMDD，缺省当日；非交易日不回退' },
    },
  },
  rateLimit: 12,
}, async ({ date } = {}) => {
  const fy = require('./fuyao');
  if (!fy.hasKey()) return { text: '未配置同花顺 fuyao Key（.env 的 FUYAO_API_KEY）', items: [] };
  const r = await fy.auctionBenchmark(date || undefined);
  const items = r.items.filter(x => x.inUniverse);
  if (!items.length) return { text: `竞价风向标（${r.date || ''}）：暂无白名单内标的（可能未到竞价/非交易日）`, date: r.date, items: [] };
  const lines = [`【竞价风向标 · ${r.date}】共 ${items.length} 只（主板+创业板）`];
  for (const x of items) {
    const pct = x.auctionPct == null ? '—' : (x.auctionPct >= 0 ? '+' : '') + x.auctionPct.toFixed(2) + '%';
    lines.push(`· ${x.name}(${x.ticker}) 竞价${pct}｜${x.tags.join('/')}`);
  }
  lines.push('⚠ 官方精选清单，仅供观察，非买入建议');
  return { text: lines.join('\n'), date: r.date, items };
});

/* ── B1. 个股异动原因（涨停为什么涨，官方题材关键词）── */
tools.register('stock_anomaly', {
  description: '查个股"当日为什么异动"：返回同花顺官方异动解读与题材关键词（如 涨停/大跌/快速拉升）。'
    + '两种用法：① 给 thscodes（6位代码即可，最多50只）查指定股票；'
    + '② 给 scope="limit_up" 拉当日全部涨停异动，用于给涨停池/龙头打官方题材标签。'
    + '只返回主板+创业板白名单。内容为公开信息AI摘要，非投资建议。',
  parameters: {
    type: 'object',
    properties: {
      codes: { type: 'array', items: { type: 'string' }, description: '6位股票代码列表（如 ["600519","000001"]），最多50' },
      scope: { type: 'string', enum: ['limit_up'], description: '不传 codes 时：limit_up=当日全部涨停异动' },
    },
  },
  rateLimit: 12,
}, async ({ codes, scope } = {}) => {
  const fy = require('./fuyao');
  if (!fy.hasKey()) return { text: '未配置同花顺 fuyao Key', items: [] };
  const norm = (codes || []).map(c => /\.(SH|SZ|BJ)$/i.test(c) ? c : (/^(6)/.test(c) ? c + '.SH' : c + '.SZ'));
  const items = (norm && norm.length)
    ? await fy.anomalyByStocks(norm)
    : scope === 'limit_up' ? await fy.anomalyList(['LIMIT_UP']) : [];
  if (!items.length) return { text: '当日未查到这些股票的异动解读（或无涨停异动）', items: [] };
  const lines = [`【个股异动原因 · 当日】${items.length} 条`];
  for (const x of items.slice(0, 30)) {
    lines.push(`· ${x.name}(${x.ticker})[${x.tag || ''}] 关键词:${x.keywords.join('/') || '—'}`);
  }
  if (items.length > 30) lines.push(`…另有 ${items.length - 30} 条见结构化 items`);
  lines.push('⚠ 公开信息AI摘要，仅供参考，以上市公司公告为准');
  return { text: lines.join('\n'), items };
});

/* ── B2. 龙虎榜：谁在买（机构 / 游资）── */
tools.register('dragon_tiger', {
  description: '龙虎榜（按交易日，近一年）：看上榜个股是谁在买——机构净买入/机构席位数、游资净买入、'
    + '净买额、上榜概念与涨停原因、当日/3日榜。board: all 全部(默认) / org 机构榜 / hot_money 游资榜。'
    + '只保留主板+创业板白名单。金额单位亿元。用于龙头"能不能追"的席位判断；数据客观呈现，非买入建议。',
  parameters: {
    type: 'object',
    properties: {
      board: { type: 'string', enum: ['all', 'org', 'hot_money'], description: '榜单类型', default: 'all' },
      date: { type: 'string', description: '交易日 YYYYMMDD，缺省最近一个有榜交易日' },
      topN: { type: 'integer', description: '按净买额取前N只（默认15）', default: 15 },
    },
  },
  rateLimit: 12,
}, async ({ board = 'all', date, topN = 15 } = {}) => {
  const fy = require('./fuyao');
  if (!fy.hasKey()) return { text: '未配置同花顺 fuyao Key', items: [] };
  const r = await fy.dragonTiger(board, date || undefined);
  const n = Math.max(1, Math.min(50, topN | 0 || 15));

  // 游资榜：按游资聚合呈现
  if (board === 'hot_money' && r.hotMoneyItems.length) {
    const hm = r.hotMoneyItems.slice().sort((a, b) => b.netBuyYi - a.netBuyYi);
    const lines = [`【龙虎榜·游资 ${r.tradeDate}】${hm.length} 路游资`];
    for (const h of hm.slice(0, n)) {
      const tops = h.rows.slice().sort((a, b) => b.netBuyYi - a.netBuyYi).slice(0, 3)
        .map(s => `${s.name}${s.netBuyYi >= 0 ? '+' : ''}${s.netBuyYi.toFixed(2)}亿`).join('、');
      lines.push(`· ${h.name} 净买${h.netBuyYi.toFixed(2)}亿｜${tops}`);
    }
    lines.push('⚠ 席位数据客观呈现，非买入建议');
    return { text: lines.join('\n'), tradeDate: r.tradeDate, board, hotMoneyItems: hm };
  }

  const items = r.stockItems.slice().sort((a, b) => b.netBuyYi - a.netBuyYi).slice(0, n);
  if (!items.length) return { text: `龙虎榜（${r.tradeDate} ${board}）白名单内暂无数据`, items: [] };
  const lines = [`【龙虎榜 ${r.tradeDate} · ${board === 'org' ? '机构榜' : '全部'}】按净买额前 ${items.length}`];
  for (const x of items) {
    let orgTxt;
    if (x.orgNetYi == null) orgTxt = '机构—';
    else {
      const seats = (x.orgBuyNum != null && (x.orgBuyNum || x.orgSellNum)) ? `(${x.orgBuyNum || 0}买${x.orgSellNum || 0}卖)` : '';
      orgTxt = `机构${x.orgNetYi >= 0 ? '+' : ''}${x.orgNetYi.toFixed(2)}亿${seats}`;
    }
    lines.push(`· ${x.name}(${x.ticker}) ${x.changePct >= 0 ? '+' : ''}${x.changePct.toFixed(1)}% 净买${x.netBuyYi >= 0 ? '+' : ''}${x.netBuyYi.toFixed(2)}亿｜${orgTxt}｜${x.driver}`
      + (x.limitReason ? `｜${x.limitReason}` : ''));
  }
  lines.push('⚠ 席位数据客观呈现，非买入建议');
  return { text: lines.join('\n'), tradeDate: r.tradeDate, board, items };
});

tools.register('sector_trend', {
  description: '板块跨日持续性追踪（主线识别）：基于自建的每日序列，判断哪些板块"连续多日净流入"、'
    + '资金是加速还是衰竭、涨幅有没有兑现资金。'
    + '这回答的是"主线不是一天能看出来的"——与 close_scan（当日截面）、'
    + 'sector_watch（盘中分钟异动）互补。'
    + '数据从建表当天开始积累，不足 5 个交易日时只列分布、不下主线结论。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '回看几个交易日', default: 10, minimum: 2, maximum: 60 },
      topN: { type: 'integer', description: '返回前几个板块', default: 12, minimum: 3, maximum: 30 },
      code: { type: 'string', description: '只看某个板块代码（如 BK0459），给了就返回该板块完整轨迹' },
    },
  },
  rateLimit: 20,
}, async ({ days = 10, topN = 12, code } = {}) => {
  const st = require('./sector_trend');
  if (code) {
    const r = st.track(code, days);
    if (!r.ok) return { ok: false, text: r.error };
    const lines = [`【${r.name} 轨迹】${r.grade} | ${r.days}日累计${r.totalYi}亿`
      + (r.streak ? ` | 连续${r.streak}天流入` : '')];
    r.series.forEach(s => lines.push(`  ${s.date}  净额${s.todayYi}亿  涨跌${s.changePct}%`
      + (s.fwdD1 != null ? `  次日${s.fwdD1}%` : '')));
    lines.push(r.note);
    return { ok: true, text: lines.join('\n'), data: r };
  }
  const r = st.trend({ days, topN });
  return { ok: true, text: st.formatTrend(r), data: r };
});

tools.register('sector_validate', {
  description: '检验"主线候选"这个判断到底准不准：统计主线候选的次日平均涨幅和胜率，'
    + '与其他板块对比。样本不足 30 条时拒绝给结论（少量样本算出的胜率是噪音）。'
    + '这是唯一能回答"这套打分有没有用"的工具，回答时必须如实转述结论，包括"还不知道"。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 30,
}, async () => {
  const st = require('./sector_trend');
  st.backfillForward();
  const v = st.validate();
  if (v.status === 'insufficient') return { ok: true, text: '【信号有效性】' + v.note, data: v };
  const L = [`【信号有效性】样本 ${v.samples} 条，覆盖 ${v.days} 个交易日`];
  L.push(`主线候选：${v.mainline.n} 条，次日平均 ${v.mainline.avgD1}%，胜率 ${v.mainline.winRateD1}%`);
  L.push(`其他板块：${v.baseline.n} 条，次日平均 ${v.baseline.avgD1}%，胜率 ${v.baseline.winRateD1}%`);
  L.push(`超额收益 edge = ${v.edge}%`);
  L.push(v.note);
  return { ok: true, text: L.join('\n'), data: v };
});

tools.register('sector_watch', {
  description: '盘中板块资金异动盯盘：对比两个时点的板块主力净额，找出"刚刚突然涌入/撤离"的板块。'
    + '与 close_scan 的区别：close_scan 看截面（现在谁有资金），这个看变化（刚刚谁变了）。'
    + '首次运行只建基线、不报异动（需要两个时点才能做差）。'
    + '阈值未标定前所有结论仅供观察，绝不说"可以买"。',
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: '非交易时段也强制执行（默认只在盘中跑）', default: false },
    },
  },
  rateLimit: 3,
}, async ({ force = false } = {}) => {
  const sw = require('./sector_watch');
  const r = await sw.watch({ force });
  return { ok: r.ok !== false, text: sw.formatWatch(r), data: r };
});

tools.register('sector_adjustment', {
  description: '扫描收盘扫描确认的主线板块，判断哪些龙头缩量回踩到关键均线（"调整到位"候选）。'
    + '这是"板块定方向"：只在大盘有买入时机时才提示动手，否则只列入观察。'
    + '措辞只能是"回踩支撑、值得关注"，绝不替用户下买入结论。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 12,
}, async () => {
  const sentiment = require('./sentiment');
  const alerts = require('./alerts');
  const db = require('../db');
  const snap = await sentiment.snapshot();
  const market = alerts.judgeMarket(snap, db.alertSampleDates().length);
  const r = await alerts.scanMainlineAdjustments({ market, maxSectors: 8 });
  if (!r.ok) return { ok: false, text: r.error };
  const L = [`【主线板块调整】数据时点 ${r.dataTime}，主线 ${r.mainlineCount} 个，大盘窗口=${market.buy ? '开' : '关'}`];
  r.sectors.forEach(x => {
    const tag = { near_support: '🎯回踩到位', pulling: '⬇回调中', broken: '✗已跌破',
                  strong: '高位未调', not_leader: '非强龙头', unknown: '数据不足' }[x.state] || x.state;
    L.push(`${tag} ${x.sector} 龙头${x.leader}：${x.reason}`);
  });
  L.push(r.note);
  if (market.buy && r.ready.length) L.push('方向可关注：' + r.ready.join('、'));
  return { text: L.join('\n'), ...r };
});

tools.register('morning_brief', {
  description: '生成盘前简报：采集隔夜宏观/政策/行业板块快讯（已过滤个股），用模型分成利好/利空/中性。'
    + '通常交易日开盘前半小时自动跑；用户问"今早有什么消息/盘前简报"也可手动调。'
    + '抓不到新闻会明说，不编造。',
  parameters: { type: 'object', properties: {} },
  rateLimit: 12,
}, async () => {
  const mb = require('./morning_brief');
  const r = await mb.briefing();
  if (!r.ok) return { ok: false, text: r.error || '盘前简报失败' };
  return { text: r.text, ...r };
});

/* ── 麦克风一键体检（语音"不挑设备"验收台）──
 *
 * 会真实录音，所以默认只在用户明确要"测试麦克风/语音体检"时调用，
 * 调用前要告诉用户：接下来请对着麦克风念提示句。
 * 只诊断、不自动开启常驻监听。 */
tools.register('voice_checkup', {
  description: '麦克风/语音设备体检：逐个输入设备真实录一段音，检测信号强度、带宽（是否窄带）、'
    + '并用 faster-whisper 和系统识别器双引擎识别，报告每个麦能不能用、推荐用哪个。'
    + '当用户问"麦克风行不行/语音能不能用/测试一下语音/哪个麦好"时使用。'
    + '调用时必须先提示用户：请对着麦克风念出返回的引导句（需要几秒钟）。只诊断不自动开启监听。',
  parameters: {
    type: 'object',
    properties: {
      deviceIndex: { type: 'integer', description: '只测指定设备序号；不传则测全部输入设备' },
    },
  },
  writable: true,       // 要录音
  rateLimit: 3,         // 体检较重且占用麦克风，限频
}, async ({ deviceIndex } = {}) => {
  const chk = require('../voice_checkup');
  const opts = Number.isInteger(deviceIndex) ? { only: [deviceIndex] } : {};
  const rep = await chk.runCheckup(opts);
  return { text: chk.formatReport(rep), ...rep };
});

/* ── 持续选股：候选池 + 买卖点信号（用户 2026-09-12 拍板新增）──
 *
 * 与 close_scan/sector_* 的分工：
 *   close_scan 定大盘时机与板块方向；这两个工具只看"池子里每只个股"的
 *   规则分数（选股）与条件式技术状态（买卖点），
 *   全部为规则打分、阈值未标定，仅供筛选参考，不构成交易建议。
 */

tools.register('stock_pool_status', {
  description: '查最近一次持续选股的候选池：每只股票的四维规则分数（趋势/位置/强势/量价，0-100）'
    + '与逐分理由、来源板块、是否领涨股。'
    + '这是"持续选股"的结果查询：候选锁死在主线/强势板块领涨股 + 连板≥2，'
    + '按分数排序取前 15。'
    + '⚠ 规则打分可复现但阈值未用历史样本标定，仅供筛选参考，不构成交易建议。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: '查哪天的池子（YYYY-MM-DD）；不传取最近一次' },
    },
  },
  rateLimit: 20,
}, async ({ date } = {}) => {
  const db = require('../db');
  const rows = date ? db.stockPoolAt(date) : db.latestStockPool();
  if (!rows.length) {
    return { ok: true, empty: true, text: '候选池为空（可能还没跑过选股，或当日无候选入池）' };
  }
  const L = [`【候选池】${rows[0].date} 共 ${rows.length} 只（按分数降序）`];
  rows.forEach(r => {
    L.push(`${r.score}分 ${r.name}(${r.code}) 来源:${r.source}${r.sector ? '/' + r.sector : ''}`
      + `${r.leader ? '/领涨股' : ''}\n    理由: ${(r.reasons || []).join('；')}`);
  });
  return { ok: true, date: rows[0].date, count: rows.length, pool: rows, text: L.join('\n') };
});

tools.register('stock_signal_status', {
  description: '查最近一次买卖点条件式信号：池内个股当前处于什么技术状态'
    + '（回踩支撑可关注/放量突破/站上MA20金叉/跌破MA20警惕/RSI超买警惕）。'
    + '每条都带触发描述、参照价、大盘窗口状态。'
    + '⚠ 这是条件式触发描述而非确定性买卖指令；阈值未标定，仅供观察参考。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: '查哪天的信号（YYYY-MM-DD）；不传取最近一次' },
      limit: { type: 'integer', description: '返回条数', default: 30, minimum: 1, maximum: 100 },
    },
  },
  rateLimit: 20,
}, async ({ date, limit = 30 } = {}) => {
  const db = require('../db');
  const rows = date ? db.stockSignalsOn(date) : db.latestStockSignals(limit);
  if (!rows.length) {
    return { ok: true, empty: true, text: '暂无买卖点信号（可能还没跑过，或池内个股无触发形态）' };
  }
  const L = [`【买卖点信号】${rows[0].date} 共 ${rows.length} 条`];
  rows.forEach(s => {
    const tag = { buy_near_support: '回踩支撑', buy_breakout: '放量突破',
                  buy_golden_cross: 'MA20金叉', sell_broken_ma20: '跌破MA20',
                  sell_overbought: '超买滞涨' }[s.sig_type] || s.sig_type;
    L.push(`[${tag}] ${s.name}(${s.code}) ${s.trigger_desc}`
      + ` 大盘窗口:${s.market_ok ? '开' : '关'} 判定:${s.as_of}`);
  });
  return { ok: true, date: rows[0].date, count: rows.length, signals: rows, text: L.join('\n') };
});

/* ── 换声音（edge-tts 多女声）──
 *
 * 用户 2026-09-10 拍板：edge-tts 神经语音优先，SAPI 只做离线兜底。
 * 入参支持音色 id / 中文名 / 拼音昵称（由 voice.normalizeVoice 归一）。
 * list=true 只查询不切换，方便模型先看有哪些声音再决定。 */

tools.register('set_tts_voice', {
  description: '切换贾维斯说话的声音（edge-tts 神经语音，当前 8 个中文女声）。'
    + '用户说"换个声音/声音甜一点/用你的声音说话"等语音指令时用这个。'
    + 'voice 支持音色 id（如 zh-CN-XiaoxiaoNeural）、中文名（晓晓/晓伊/小北/小妮/曉臻/仙雲/曉曼/曉佳）'
    + '或拼音昵称（xiaoxiao/xiaoyi/xiaobei 等）。'
    + 'list=true 只列出可选音色和当前音色，不切换。'
    + '切换后本进程立即生效；断网/服务异常时自动降级为 SAPI 离线女声（固定 Huihui），不中断朗读。',
  parameters: {
    type: 'object',
    properties: {
      voice: { type: 'string', description: '要切换到的音色（id/中文名/拼音昵称），list 模式可不传' },
      list: { type: 'boolean', description: '为 true 时只查不切换', default: false },
    },
  },
  writable: true,
  rateLimit: 10,
}, async ({ voice, list = false } = {}) => {
  const v = require('../voice');
  if (list) {
    const cur = v.getTtsVoice();
    return {
      ok: true, current: cur,
      voices: v.listTtsVoices().map(x => ({ id: x.id, name: x.name, region: x.region })),
      hint: '直接传 voice 即可切换，如 "晓伊" / "小北" / "zh-CN-XiaoxiaoNeural"。',
    };
  }
  if (!voice || !String(voice).trim()) {
    return { ok: false, error: '没说要换成哪个声音。可先调 set_tts_voice?list=true 看可选音色。' };
  }
  return v.setTtsVoice(String(voice).trim());
});

module.exports = tools;
module.exports.sandbox = sb;
module.exports.MEDIA_SITES = MEDIA_SITES;