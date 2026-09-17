/**
 * mind.js —— 贾维斯主动意识单例
 *
 * 用 jarvis-persona.js 包装 jiwen.js，接入数据库持久化，
 * 并提供一个 SSE 广播器，把状态变化推给所有在线前端。
 *
 * 对外：
 *   mind.init()                 —— 启动（加载状态 + 启动心跳）
 *   mind.onUserMessage(text)    —— 用户说一句话，更新状态
 *   mind.onAssistantReply(text, ok) —— 助理回复了，更新状态
 *   mind.onPraised() / onScolded() —— 情绪事件（后面接 NLP 分析）
 *   mind.addClient(sseWriter)   —— 注册一个 SSE 客户端（由 server.js 调）
 *   mind.removeClient(sseWriter)
 *   mind.getSnapshot()          —— 同步拿当前状态快照
 *
 * 主动行为：
 *   心跳每 30 秒 tick 一次（~ 实际时长的 0.5 分钟），检查阈值。
 *   触发 contact 时，若没在冷却期，就推一条 proactive 事件给前端，
 *   前端决定怎么展示（状态面板通知 / 直接显示一句话）。
 */

const db = require('./db');
const { createJarvisMind } = require('./jarvis-persona.js');
const patrol = require('./patrol');
const clock = require('./clock');

const STATE_KEY = 'jarvis_mind_v1';

// ── 单例状态 ──
let jiwen = null;
const clients = new Set();
let _lastUserMsg = null;    // 给 connectionRateFn 用的最后一条用户消息
let _lastProactiveAt = 0;   // 主动消息冷却
const PROACTIVE_COOLDOWN_MS = 45 * 60 * 1000;  // 45 分钟才会再主动一次

// getStyleHint() 要在 SSE 流里同步调用（不能 await），所以缓存一份最近快照。
// 由 getSnapshot() 和 broadcastState() 共同维护。
let _cachedState = null;

// ── 初始化 ──
function init() {
  if (jiwen) return;

  jiwen = createJarvisMind({
    onLoad: async () => {
      const saved = db.loadState(STATE_KEY);
      return saved || null;
    },
    onSave: async (s) => {
      db.saveState(STATE_KEY, s);
    },
    getLastMessage: () => _lastUserMsg,
    verbose: false,
    onLog: (msg) => {
      // 原引擎的调试日志。生产环境关掉，debug 时可以打开。
      // 不进 console 以免污染日志。
    },
  });

  // 立即触发一次加载（否则第一次 checkThresholds 看到的是初始值）
  jiwen.load();

  startHeartbeat();
}

// ── SSE 广播 ──
function broadcast(ev, data) {
  for (const c of clients) {
    try { c(ev, data); } catch (_) { /* 挂了的客户端下轮清掉 */ }
  }
}

/* ── 飞书主动推送 ──
 *
 * 设计约束（都是为了不让你关掉通知）：
 *
 * 1) **只推 worthReporting 的**，和网页同一个门槛。
 * 2) **同内容去重**：同一个异动每 15 分钟推一次的话，你会直接关通知，
 *    那就等于全都收不到了。用内容指纹判重，1 小时内不重复推。
 * 3) **每天有上限**：再怎么异动，一天推 8 条以上就是骚扰。
 * 4) **静默失败**：推送失败绝不能影响本机巡视和展示。
 */
const _pushed = new Map();          // 内容指纹 → 上次推送时间
const PUSH_DEDUP_MS = 60 * 60 * 1000;
const PUSH_DAILY_MAX = 8;
let _pushDay = '';
let _pushCount = 0;

function _fingerprint(text) {
  // 只取前 60 字做指纹：盘面异动的措辞里带百分比，
  // 数字微小变化不该被当成"新异动"重复推。
  return String(text).replace(/[\d.%+-]/g, '').slice(0, 60);
}

/* ══════ 测试禁投递闸门 ══════
 *
 * 2026-09-09 用户报告：一天收到 100 多条「测试异动-1788947806320」这类垃圾消息。
 *
 * 根因：jarvis-patrol.test.js 里三条去重测试直接调 pushToFeishu()，
 * 而这个函数**没有任何测试保护**，一路打到真实飞书 API。
 * 我今天为了验证别的改动跑了十几遍测试，每跑一次用户手机上多 4 条。
 *
 * 这比"测试污染数据库"更糟 —— 它污染的是**用户的注意力**，
 * 而且用户只能通过关掉整个通知来止损，那样真异动也收不到了。
 *
 * 修法：进程处于测试态时，走完全部去重/上限逻辑但**不投递**，
 * 返回 delivered:false + dryRun:true。
 * 这样去重行为仍然可测（测试断言的正是去重），但不会打扰任何人。
 *
 * 判定优先用显式环境变量，其次自动识别 test 文件入口 ——
 * 只依赖环境变量的话，后人跑测试忘了设就又开始发消息。 */
function _isTestMode() {
  if (process.env.JARVIS_FEISHU_DRYRUN === '1') return true;
  if (process.env.JARVIS_FEISHU_DRYRUN === '0') return false;   // 显式允许真发
  if (process.env.NODE_ENV === 'test') return true;
  const entry = (process.argv[1] || '');
  return /\.test\.js$/i.test(entry) || /[\\/]test[\\/]/i.test(entry);
}

async function pushToFeishu(text, isHigh) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _pushDay) { _pushDay = today; _pushCount = 0; }
  if (_pushCount >= PUSH_DAILY_MAX) return { ok: false, reason: '今日推送已达上限' };

  const fp = _fingerprint(text);
  const last = _pushed.get(fp) || 0;
  const now = Date.now();
  if (now - last < PUSH_DEDUP_MS) return { ok: false, reason: '同类异动近期已推送' };

  /* 测试态：记账但不投递。必须放在去重之后 ——
   * 否则去重状态不会更新，测试就测不到去重行为了。 */
  if (_isTestMode()) {
    _pushed.set(fp, now);
    _pushCount++;
    return { ok: true, delivered: false, dryRun: true, reason: '测试态不投递' };
  }

  let feishu;
  try { feishu = require('./feishu'); } catch { return { ok: false, reason: '飞书模块缺失' }; }
  if (!feishu.configured()) return { ok: false, reason: '飞书未配置' };

  const conf = feishu.loadConfig();
  const oid = conf && conf.ownerOpenId;
  if (!oid) return { ok: false, reason: '缺少 ownerOpenId，无法主动推送' };

  try {
    // 高优先级用卡片（手机上更醒目），普通异动用纯文本
    if (isHigh && typeof feishu.sendCard === 'function') {
      await feishu.sendCard(oid, '盘面异动', text);
    } else {
      await feishu.send(oid, text);
    }
    _pushed.set(fp, now);
    _pushCount++;
    return { ok: true, delivered: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function addClient(writer) {
  // writer(ev, data) 是 SSE 写入函数
  clients.add(writer);
  // 立即推一份当前状态
  if (jiwen) {
    getSnapshot().then(s => writer('mind_state', s));
  }
}
function removeClient(writer) {
  clients.delete(writer);
}

// ── 状态快照（给前端渲染用） ──
async function getSnapshot() {
  if (!jiwen) return null;
  const s = await jiwen.getState();
  const triggers = await jiwen.checkThresholds();
  const mood = await jiwen.getMoodLabel();
  const snap = {
    axes: {
      警觉: +s.connection.toFixed(3),
      从容: +s.pride.toFixed(3),
      心境: +s.valence.toFixed(3),
      唤醒: +s.arousal.toFixed(3),
      沉浸: +s.immersion.toFixed(3),
    },
    mood,
    triggers: triggers.map(t => ({ action: t.action, reason: t.reason || null, urgency: +t.urgency.toFixed(3) })),
    lastUserMsg: _lastUserMsg ? { id: _lastUserMsg.id, at: _lastUserMsg.timestamp } : null,
  };
  // 这里就更新缓存，而不是只在 broadcastState() 里更新。
  // 否则 getStyleHint() 在"只调过 getSnapshot、没广播过"的路径上会读到 null，
  // 导致语气注入静默失效（实测：警觉=1.0 时 styleHint 仍返回 null）。
  _cachedState = snap;
  return snap;
}

// ── 外部事件钩子 ──
async function onUserMessage(text, msgId) {
  if (!jiwen) return;
  _lastUserMsg = { id: msgId || Date.now(), content: text, timestamp: new Date().toISOString() };

  // 简易情绪分类：靠关键词粗判，够驱动五轴即可
  // 后续可以换成 LLM 分析，但每轮多花一次调用不划算
  let affect = 'neutral';
  const t = String(text || '').toLowerCase();
  if (/谢谢|感谢|厉害|棒|好的|赞|漂亮|优秀|爱你|乖/.test(t)) affect = 'positive';
  else if (/笨蛋|蠢货|什么垃圾|没用|废物|滚|傻|出错|错了|不对/.test(t)) affect = 'negative';
  else if (/紧急|快点|急|马上|立刻|赶紧|崩|炸了|宕机|死了/.test(t)) affect = 'urgent';

  await jiwen.userSaid(affect);
  broadcastState();
}

async function onAssistantReply(text, ok) {
  if (!jiwen) return;
  if (ok === false) await jiwen.replied('failed');
  else await jiwen.replied('helpful');
  broadcastState();
}

async function onPraised() { if (jiwen) { await jiwen.praised(); broadcastState(); } }
async function onScolded() { if (jiwen) { await jiwen.scolded(); broadcastState(); } }

async function broadcastState() {
  const s = await getSnapshot();
  _cachedState = s;
  broadcast('mind_state', s);
}

// getStyleHint 要在 SSE 流里同步调用（不能 await），
// 缓存变量 _cachedState 已在文件顶部声明。

/**
 * 把当前情绪状态翻译成一段 system prompt，注入对话。
 *
 * 这是 jiwen 的核心价值所在：五轴状态不只决定"是否主动搭话"，
 * 更要决定"这一句话怎么说"。否则状态机就只是个装饰。
 *
 * 原引擎有 getStyleGuidance()，但措辞是为 romantic companion 写的
 * （"你在想她""你有点闹脾气"之类），对管家不适用，这里自己写。
 *
 * 返回 null 表示状态平淡、无需特别提示（省 token）。
 */
function getStyleHint() {
  const snap = _cachedState;
  if (!snap || !snap.axes) return null;
  const a = snap.axes;

  const hints = [];

  // 心境
  // 阈值说明：贾维斯基准心境是 +0.25，scolded() 一次约 -0.40 → 落到 -0.15。
  // 早先把负向阈值定在 -0.25，结果"被骂一次"根本触发不了语气收敛（实测返回 null）。
  // 改成 -0.10：一次责备就能让语气变化，符合"管家会察觉主人不满"的直觉。
  if (a.心境 > 0.55) hints.push('你现在心情不错，语气可以稍微轻快一点，但仍然克制。');
  else if (a.心境 < -0.10) hints.push('你刚刚受了点挫（也许是出错或被责备），语气更简短收敛，不要强装热情，也不要过度道歉。');

  // 唤醒度
  if (a.唤醒 > 0.45) hints.push('当前事态紧张，回答要短、要快、直给结论，不要铺垫。');
  else if (a.唤醒 < -0.35) hints.push('当前很平静，可以从容一些。');

  // 警觉度（用户很久没说话）
  if (a.警觉 > 0.6) hints.push('用户已经离开了一段时间，你有点想知道他在做什么，但不要显得粘人或抱怨。');

  // 从容度
  if (a.从容 < 0.1) hints.push('你现在不太端着了，可以更主动地提建议。');
  else if (a.从容 > 0.6) hints.push('保持管家的分寸感，等对方提要求，不要过度主动。');

  if (!hints.length) return null;
  return '【当前状态对语气的要求】\n' + hints.join('\n');
}

// ── 心跳：每 60 秒推进 1 分钟（1:1 真实节奏） ──
//
// 为什么不按"真实墙钟时间差"推进？
// 因为进程在电脑睡眠时也可能挂着。按真实时间差算的话，
// 早上一开机就是"离开 10 小时" → 直接 forceContact，
// 一开电脑就被追问，体验很差。
//
// 固定节拍的语义是"贾维斯只在陪着你的那段时间里累积情绪"，
// 更像一个真实存在的管家，而不是按墙钟走的闹钟。
//
// 1:1 节奏下各阈值对应的真实时长（已实测标定）：
//   observation      0.15  ≈ 25 分钟   开始留意
//   considerContact  0.40  ≈ 1 小时    考虑搭话（但被 pride 挡住）
//   pride_block            ≈ 1.5 小时  改为自己找事做
//   forceContact     0.75  ≈ 3 小时    真的开口问一句
const TICK_INTERVAL_MS = 60 * 1000;   // 每 60 秒心跳
const TICK_MINUTES = 1;               // 推进 1 分钟

let _timer = null;
function startHeartbeat() {
  if (_timer) return;
  _timer = setInterval(heartbeatTick, TICK_INTERVAL_MS);
  // 启动后立即也推一次状态
  setTimeout(broadcastState, 500);
}

async function heartbeatTick() {
  if (!jiwen) return;

  await jiwen.tick(TICK_MINUTES);
  const triggers = await jiwen.checkThresholds();

  /* ── 盘前简报（用户 2026-09-10 点名的每日定时工作）──
   *
   * 交易日 08:40-09:05 自动跑一次，独立于情绪触发和静默窗口：
   *   - 静默窗口 09:00 才开，但简报 08:55 就该到，所以放在静默过滤之前
   *   - 它是"用户安排的具体工作"，按用户的规则豁免静默
   *   - 20h 冷却 + 窗口判断保证一天最多一次；开机晚了窗口内仍会补
   *   - 先标记避免失败后反复重试；产出只进网页/记忆，不推飞书
   */
  try {
    if (patrol.morningBriefDue && patrol.morningBriefDue()) {
      patrol.markMorningBriefDone();
      broadcast('mind_activity', { reason: 'brief', urgency: 0, label: '生成盘前简报', task: 'morning_brief', findings: [] });
      const br = await patrol.runMorningBrief();
      if (br && br.ok && br.brief) {
        _lastProactiveAt = Date.now();
        broadcast('mind_proactive', {
          action: 'report', urgency: 'low',
          text: br.brief.text, findings: br.findings || [],
        });
      }
      return;   // 这一拍就做简报
    }
  } catch (e) {
    broadcast('mind_activity', { reason: 'brief', urgency: 0, label: '盘前简报出错', task: 'morning_brief',
      findings: [{ kind: 'error', severity: 'medium', text: e.message }] });
  }

  // ── 触发主动行为 ──
  const now = Date.now();
  const inCooldown = now - _lastProactiveAt < PROACTIVE_COOLDOWN_MS;

  // 找出最高优先级的触发
  let strongest = null;

  /* ══ 非交易时段静默（用户 2026-09-10 明确要求）══════
   *
   * 「不是交易时间段别巡视，除非我主动提问或安排其它具体工作」
   *
   * 边界：
   *   - 只拦【后台主动行为】（自己搭话 + 自己找事做巡视）
   *   - 用户主动提问走 brain.js，不经过心跳，永远照常响应
   *   - 收盘扫描是用户点名要的每日动作，交给 patrol.runOne 内部单独放行：
   *     窗口内（15:00-23:00）照常跑，这里的静默不挡它。
   *
   * 实现：非主动窗口时，把"搭话/找事做"两类触发直接压掉，
   * 但情绪 tick（上面的 jiwen.tick）照走 —— 心境还在累积，
   * 只是不开口、不外放。 */
  const proactiveOn = clock.isProactiveWindow(new Date());
  const activeTriggers = proactiveOn
    ? triggers
    : triggers.filter(t => t.action !== 'contact' && t.action !== 'find_activity');

  for (const t of activeTriggers) {
    if (!strongest || t.urgency > strongest.urgency) strongest = t;
  }

  if (strongest && strongest.action === 'contact' && !inCooldown) {
    _lastProactiveAt = now;
    // 生成一句主动搭话。
    // 先用简短模板，后面可以换成 LLM 生成（但要控制成本）。
    const lines = [
      '主人，有一段时间没说话了。需要帮忙吗？',
      '您已经离开一阵了。有什么我可以做的？',
      '工作累了吗？要不要查点什么或者整理下记忆？',
      '这里一切正常。如果有需要，随时叫我。',
    ];
    const pick = lines[Math.floor(Math.random() * lines.length)];
    broadcast('mind_proactive', {
      action: 'contact',
      urgency: strongest.urgency,
      text: pick,
    });
    // 主动搭话后也稍微降一点警觉度（"说了话了"）
    await jiwen.applyDelta({ connection: -0.15 });
  } else if (strongest && strongest.action === 'find_activity' && !inCooldown) {
    /* 找事做模式：管家自己去干活。
     *
     * Phase 5 之前这里只广播一个假标签（"整理记忆"），实际什么都没做。
     * 现在真的去跑后台巡视任务（扫大盘 / 巡会话），
     * 任务本身零成本（只调行情接口和读本地文件，不调模型）。
     *
     * 只有当巡视**发现值得报告的东西**时才推消息打扰用户；
     * 否则只广播一个活动状态给前端显示，不弹对话。 */
    let patrolResult = null;

    /* ── 周报优先：周末 + 冷却到期时，先把周报做掉 ──
     *
     * 周报是唯一的"贵"任务（约 8000 token + 60 秒），所以：
     *   - 只在周末触发（工作日你在干活，不需要总结）
     *   - 冷却 7 天，一周最多一次
     *   - 写进 Obsidian 而不是只广播，因为长内容在对话框里没法看
     *
     * 之前 weeklyDue()/markWeeklyDone() 写好了但**从没被调用过** ——
     * 等于周报永远不会自动生成，得手动喊。这里补上接线。 */
    if (patrol.weeklyDue()) {
      patrol.markWeeklyDone();          // 先标记，避免生成失败后一直重试
      broadcast('mind_activity', {
        reason: strongest.reason || 'weekly',
        urgency: strongest.urgency,
        label: '生成周报',
        task: 'weekly_report',
        findings: [],
      });
      try {
        const wr = require('./tools/weekly_report');
        const w = await wr.writeToVault({ days: 7 });
        _lastProactiveAt = now;         // 周报是大事，走完整冷却
        broadcast('mind_proactive', {
          action: 'report',
          urgency: strongest.urgency,
          text: w.ok
            ? `本周周报已经写好了，放在你的知识库里：\n· ${w.vaultPath}\n· 扫了 ${w.stats?.sessionsScanned || 0} 个会话、${w.stats?.candidatesTotal || 0} 条待办候选` +
              (w.incomplete ? '\n· 注意：这篇章节不完整，我已在文里标注' : '')
            : `周报生成失败：${w.error}`,
          findings: [],
        });
      } catch (e) {
        broadcast('mind_activity', {
          reason: 'weekly', urgency: strongest.urgency,
          label: '周报生成出错', task: 'weekly_report',
          findings: [{ kind: 'error', severity: 'medium', text: e.message }],
        });
      }
      return;    // 这一轮就干周报这一件事，不再跑别的巡视
    }

    try {
      patrolResult = await patrol.runOne({ reason: strongest.reason });
    } catch (e) {
      // 巡视失败不能影响心跳，静默记录
      patrolResult = { task: 'error', label: '巡视出错', result: { ok: false, reason: e.message }, worthReporting: false };
    }

    if (patrolResult) {
      broadcast('mind_activity', {
        reason: strongest.reason || 'unknown',
        urgency: strongest.urgency,
        label: patrolResult.label,
        task: patrolResult.task,
        // 发现的内容给前端展示（即使不值得打扰，也可以在状态栏低调显示）
        findings: patrolResult.result?.findings || [],
      });

      /* 发现显著异动 → 才真的开口打扰 */
      if (patrolResult.worthReporting) {
        const fs = patrolResult.result.findings || [];
        const high = fs.filter(f => f.severity === 'high');
        const lines = (high.length ? high : fs).slice(0, 3).map(f => '· ' + f.text);
        _lastProactiveAt = now;   // 真打扰了，走完整冷却
        const reportText = (patrolResult.task === 'market_scan' ? '盘面有动静：\n' : '巡视发现：\n')
          + lines.join('\n');
        broadcast('mind_proactive', {
          action: 'report',
          urgency: strongest.urgency,
          text: reportText,
          findings: fs,
        });

        /* 同时推到飞书 —— 人不在电脑前也能收到。
         *
         * 只推 worthReporting 的，和网页保持同一个门槛：
         * 你要的是"只报显著异动"，手机推送尤其不能滥用，
         * 一旦开始推无关内容，你会直接关掉通知，那就等于全都收不到了。
         *
         * 用 .catch 静默失败：推送失败不能影响本机的巡视和展示。 */
        pushToFeishu(reportText, high.length > 0).catch(() => {});
      }
    } else {
      // 所有巡视任务都在冷却中，退回原来的"没事可做"表现
      broadcast('mind_activity', {
        reason: strongest.reason || 'unknown',
        urgency: strongest.urgency,
        label: '待命',
        task: null,
        findings: [],
      });
    }

    // 干活能缓解警觉度，也让沉浸度上去（这样下轮不会重复触发）
    await jiwen.didUsefulWork('patrol', patrolResult?.label || '巡视');
    // 半冷却：不要紧接着又弹 contact（如果上面已经报告过就已经是全冷却了）
    if (!patrolResult?.worthReporting) {
      _lastProactiveAt = now - PROACTIVE_COOLDOWN_MS / 2;
    }
  }

  // 每次心跳都广播当前五轴状态
  broadcastState();
}

module.exports = {
  init,
  addClient,
  removeClient,
  getSnapshot,
  getStyleHint,
  onUserMessage,
  onAssistantReply,
  onPraised,
  onScolded,
  // 让 server.js 能把飞书那边的对话推到网页，两端看到同一个会话
  broadcast,
  // 主动推送（供测试和手动触发）
  pushToFeishu,
  // 给测试/调试用
  _getRaw: () => jiwen,
};
