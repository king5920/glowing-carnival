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
  description: '查询A股K线历史数据并自动计算技术指标（MA5/10/20/60、区间涨跌、年化波动率、当前价在区间中的位置）。用于判断趋势、高低位、波动水平。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '6位股票代码', maxLength: 6 },
      period: { type: 'string', description: '周期', enum: ['day', 'week', 'month'], default: 'day' },
      limit: { type: 'integer', description: 'K线根数，默认60，最多280', default: 60 },
      adjust: { type: 'string', description: '复权方式', enum: ['none', 'forward', 'backward'], default: 'forward' },
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
    note: '数据来源：腾讯财经/新浪财经，仅供参考，不构成投资建议。',
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

module.exports = tools;
module.exports.sandbox = sb;