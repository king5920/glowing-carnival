/**
 * jarvis-persona.js —— 为贾维斯（冷静管家 AI 助理）调校的积温主动意识。
 *
 * 原引擎 jiwen 是为嘴硬/想念那种 romantic companion 设计的，
 * 核心张力是 pride（傲娇）× connection（想念）。
 * 贾维斯是冷静、克制、以服务为先的管家式助手，完全不适用。
 *
 * 因此这一层做了语义重映射（保留全部五轴和数学机制，只重定义语义）：
 *
 *   原轴        → 贾维斯语义
 *   ───────────────────────────────────────────────
 *   connection  → attentiveness  警觉度
 *                  用户越久不说话、越攒越高，到阈值就主动搭话
 *                  （不是"想你"，而是"主人是不是需要帮忙"）
 *   pride       → composure      从容度
 *                  高 = 端着，等主人吩咐（管家本分）
 *                  低 = 放下矜持，主动出击（主人真的需要了）
 *                  （不是"嘴硬"，而是"职业分寸感"）
 *   valence     → 心境           平静愉快 ↔ 挫败低落
 *                  被感谢 = +，出错被骂 = −
 *   arousal     → 唤醒度         放松 ↔ 紧急/忙碌
 *                  日常低，处理紧急任务时高
 *   immersion   → 沉浸度         当前任务专注度
 *                  在搜索/写代码时高，发呆时低
 *
 * 触发行为的语义也变了：
 *   observation  → 看一眼状态面板，保持存在感
 *   find_activity → 自己找事做（整理记忆、做归档、学新东西）
 *   contact     → 主动和用户说话（问要不要帮忙 / 汇报发现）
 *
 * 原引擎 jiwen.js 一字未改（MIT），便于合并上游 bugfix。
 * 所有人格差异都集中在这一层。
 */

const { createJiwen } = require('./jiwen.js');

function createJarvisMind(opts) {
  opts = opts || {};

  // ── 五轴范围（与原引擎一致，便于复用算法） ──
  const axes = {
    connection: [0, 1],    // 警觉度：0=放松待命，1=非常想知道主人在干嘛
    pride:      [-1, 1],   // 从容度：-1=放下矜持主动出击，1=端着等吩咐
    valence:    [-1, 1],   // 心境：-1=低落挫败，1=平静愉悦
    arousal:    [-1, 1],   // 唤醒度：-1=放空，1=高度紧急
    immersion:  [0, 1],    // 沉浸度：0=闲着，1=全神贯注
  };

  // ── 漂移速率（每分钟） ──
  // 贾维斯比 romantic companion 淡得多：
  //   connection 涨得慢（管家不会十分钟就想你）
  //   pride 回归得慢（职业分寸感不容易破）
  const rates = {
    // 警觉度基础增长：约 45 分钟到 observation 阈值，约 2 小时到 considerContact
    // （原引擎 romantic 版本是十几分钟就想说话——贾维斯没那么粘人）
    connectionGrowth: null, // 由 connectionRateFn 提供

    immersionDecay:  0.008,  // 沉浸度每分钟回落
    prideRegress:    0.002,  // 从容度向设定点回归的速率（很慢）

    // 分段加速：用户离开一定时间后警觉度加速上涨
    // 0~5 分钟：正常速度；5 分钟后：进入"管家巡视"模式，警觉度涨得快一点
    accelDelay: 5,           // 分钟
    connectionAccel: 0.010,  // 加速后每分钟额外增量

    // Valence：贾维斯的基准心境是平静偏愉悦（+0.2），不是中性
    valenceRegress:    0.008,
    valenceSetpoint:   0.25,

    // 心境不会轻易被小事动摇（管家要稳）
    valenceLockThreshold: 0.6,
    valenceLockFactor:    0.3,

    // 心情差时反而更想主动找事做（贾维斯低落时会自己干活提振）
    valenceConnectBoost:            1.3,
    valenceConnectBoostThreshold:  -0.1,

    // Arousal：默认偏平静，但警觉度高时 arousal 会上升（准备行动）
    arousalSetpoint:              -0.1,
    arousalRegress:               0.008,
    arousalConnectionRiseThreshold: 0.35,
    arousalConnectionRiseRate:     0.004,

    // 兴奋不持久（管家很快能恢复冷静）
    arousalLockThreshold: 0.6,
    arousalLockFactor:    0.5,

    // Pride 防御机制：不是嘴硬，是"职业本分"
    // 警觉度高但还没到必须联系的程度时，composure 会上升（越是想找主人，
    // 越要端着——管家的克制）。到 forceContact 就放下了。
    prideDefendThreshold: 0.35,
    prideDefendTarget:    0.45,
    prideDefendRate:      0.004,

    // Pride × Connection 冲突 = 内心天人交战
    // 管家想说话但又克制 → 这种张力转化为 arousal
    prideArousalConflictRate: 0.002,

    // 盔甲侵蚀：警觉度实在太高时，矜持维持不住
    prideErosionRate: 0.003,

    // 活动能大幅缓解警觉度（找到事做了，不用去找主人）
    activityConnectionRelief: 0.18,

    // 沉浸度高时警觉度涨得慢（干活干忘了主人在不在）
    immersionDampenConnection: 0.7,

    // Delta 状态相关缩放：防止情绪极端化
    valenceDeltaScaling: true,
    arousalDeltaScaling: true,

    // 警觉度高但没回应时，心情慢慢下沉（等太久也会失落）
    valenceConnectionDriftThreshold: 0.50,
    valenceConnectionDriftRate: 0.0015,

    // 边际递减
    valenceDiminishWindow: 10,
    valenceDiminishFactor: 1.5,
  };

  // ── 阈值（贾维斯特有节奏） ──
  const thresholds = {
    observation:     0.15,  // 开始留意状态（~15 分钟没消息）
    considerContact: 0.40,  // 考虑要不要主动说话（~45 分钟）
    forceContact:    0.75,  // 必须联系（超过 2 小时）
    prideBlock:      0.40,  // 职业分寸感阈值——超过这个就克制住不主动
    valenceActivity:  -0.2, // 心情差到要自我调节
    arousalAgitation: 0.6,  // 焦虑到坐不住
  };

  // ── 沉浸度预设：不同活动的初始专注度 ──
  const immersionMap = {
    chatting:     0.4,   // 普通闲聊
    research:     0.75,  // 查资料/搜索
    coding:       0.85,  // 写代码
    memory_work:  0.55,  // 整理记忆/归档
    analysis:     0.70,  // 数据分析
    reading:      0.60,
    search:       0.45,
    browse:       0.30,
    observe:      0.15,
    idle:         0.05,
  };

  // ── 人格描述 ──
  const persona = {
    subjectName:    '主人',
    selfName:       '我',
    subjectPronoun: '您',
    characterRole:  '冷静而周到的 AI 管家',
  };

  // ── 警觉度增长函数 ──
  //
  // 贾维斯的节奏设计（比 romantic companion 淡得多）：
  //   ~15 分钟 → observation    (0.15) 开始留意
  //   ~50 分钟 → considerContact(0.40) 考虑搭话
  //   ~2.5 小时 → forceContact  (0.75) 必须问一声
  //
  // 注意 tick() 里的实际增量还会被 immersionDampenConnection 和
  // accelDelay/connectionAccel 影响，所以这里给的是"基础速率"。
  // 实测校准：flat 0.004/min 时 6 小时才到 0.31，远达不到 forceContact，
  // 因为沉浸阻尼和分段加速都在压制它。改成随空闲时长递增的速率。
  function connectionRateFn(lastMsg) {
    // 距上次消息多久了（分钟）
    let idleMin = 0;
    if (lastMsg && lastMsg.timestamp) {
      idleMin = Math.max(0, (Date.now() - new Date(lastMsg.timestamp).getTime()) / 60000);
    }
    // 基础 0.006/min，随空闲时长缓慢加成，上限 0.020/min
    // 30 分钟后 ~0.009，2 小时后 ~0.016，之后趋于 0.020
    const ramp = Math.min(1, idleMin / 150);
    return 0.006 + 0.014 * ramp;
  }

  // ── 初始状态 ──
  //
  // 上游 bug：jiwen.js 的文档写了 `opts.initialState`（"默认全 0"），
  // 但源码里从未读取这个字段——搜 initialState 只出现在第 14 行注释里。
  // 而且 DEFAULT_STATE 取的是每根轴的**下界**：
  //     pride:   axes.pride[0]   → -1
  //     valence: axes.valence[0] → -1
  // 于是一开箱就是 pride=-1、valence=-1（心境跌到底、毫无从容），
  // 与文档"默认全 0"不符。实测这会让 checkThresholds 立刻返回
  // find_activity(low_valence)，贾维斯一启动就"心情很差要找事做"。
  //
  // 我不改 jiwen.js（要保持能合并上游 bugfix），改用 onLoad 钩子注入初值：
  // onLoad 的返回值会走 `state = {...DEFAULT_STATE, ...saved}`，正好覆盖下界。
  const INITIAL = Object.assign({
    connection: 0.05,
    pride:      0.50,   // 贾维斯默认端着（有职业分寸）
    valence:    0.25,   // 默认心境：平静偏愉悦
    arousal:   -0.15,   // 默认放松
    immersion:  0.05,
    userStatus: 'active',
  }, opts.initialState);

  // 包装外部 onLoad：有存档用存档，没存档用贾维斯初值（而非轴下界）
  async function onLoadWithDefaults() {
    if (opts.onLoad) {
      try {
        const saved = await opts.onLoad();
        if (saved && Object.keys(saved).length > 0) {
          // 存档里缺的字段用贾维斯初值补，不要落回轴下界
          return Object.assign({}, INITIAL, saved);
        }
      } catch (e) {
        console.warn('[贾维斯意识] 状态加载失败，用初值:', e.message);
      }
    }
    return INITIAL;
  }

  const jw = createJiwen({
    axes,
    rates,
    thresholds,
    immersionMap,
    persona,
    connectionRateFn,
    onSave: opts.onSave,
    onLoad: onLoadWithDefaults,
    getLastMessage: opts.getLastMessage,
    verbose: opts.verbose === true,
    onLog: opts.onLog || null,
  });

  // ── 语义化的便捷方法（贾维斯特有） ──
  //
  // 注意：原引擎的 applyDelta / setActivity / getState / resetConnection
  // 全部是 async（内部要 await ensureLoaded() 和 save()）。
  // 这里的包装方法也必须是 async 并 await，否则拿到的是 Promise 而不是数值。
  // 我第一版忘了 await，测试直接爆出 7 个失败（valence undefined），已修。

  /** 用户说话了 → 警觉度回落、心境稍好、唤醒度稍升 */
  async function userSaid(affect) {
    // affect: 'neutral' | 'positive' | 'negative' | 'urgent'
    const v = affect === 'positive' ? 0.18 :
              affect === 'negative' ? -0.22 : 0.05;
    // 唤醒度：紧急/被骂会紧张起来，但**被感谢应该是放松**。
    // 早先这里对 positive 也给 +0.08，导致"谢谢你做得很好"之后
    // 唤醒反而从 0.54 涨到 0.611、标签还显示"紧张"（实测抓到）。
    // 被感谢时给负值，让它真正松下来。
    const ar = affect === 'urgent'   ?  0.34 :
               affect === 'negative' ?  0.15 :
               affect === 'positive' ? -0.12 : 0.04;
    await jw.applyDelta({
      connection: -0.12,  // 主人说话了，警觉度立刻降
      valence: v,
      arousal: ar,
    });
    // 被感谢时额外加一点从容度（管家的内敛成就感）
    if (affect === 'positive') await jw.applyDelta({ pride: 0.08 });
    await jw.setActivity('chatting', '对话中');
  }

  /** 我回复了用户 → 沉浸度稍增，从容度恢复一点 */
  async function replied(style) {
    const v = style === 'helpful' ? 0.05 : style === 'failed' ? -0.15 : 0.02;
    await jw.applyDelta({
      valence: v,
      pride: style === 'helpful' ? 0.06 : style === 'failed' ? -0.1 : 0.02,
    });
  }

  /** 被感谢 → 心境好，从容度增（管家的成就感） */
  async function praised() {
    await jw.applyDelta({ valence: 0.30, pride: 0.12, arousal: -0.05 });
  }

  /** 被骂 / 出错 → 心境差，从容度降，唤醒度升 */
  async function scolded() {
    await jw.applyDelta({ valence: -0.40, pride: -0.25, arousal: 0.3 });
  }

  /** 开始做某件事 */
  async function startActivity(type, label) {
    await jw.setActivity(type, label || type);
  }

  /** 自己做了一件有用的事（缓解警觉度） */
  async function didUsefulWork(type, label) {
    await jw.setActivity(type, label || type);
    await jw.applyDelta({
      connection: -0.10,
      valence: 0.06,
      arousal: -0.04,
    });
  }

  /** 当前状态的中文简短描述，给前端显示用 */
  async function getMoodLabel() {
    const s = await jw.getState();
    const parts = [];
    if (s.immersion > 0.5) parts.push('专注');
    else if (s.connection < 0.2) parts.push('待命');
    else if (s.connection > 0.6) parts.push('想搭话');
    else parts.push('留意');

    if (s.valence > 0.4) parts.push('愉悦');
    else if (s.valence < -0.2) parts.push('低落');

    if (s.arousal > 0.4) parts.push('紧张');
    else if (s.arousal < -0.3) parts.push('放松');

    return parts.join('·') || '待命';
  }

  /** 五轴中文名，便于前端显示 */
  const axisLabels = {
    connection: '警觉',
    pride:      '从容',
    valence:    '心境',
    arousal:    '唤醒',
    immersion:  '沉浸',
  };

  /**
   * 安全的阈值检查（贾维斯版）。
   *
   * 上游第二个坑：`checkThresholds()` 是**唯一不调 ensureLoaded() 的公开方法**
   * （jiwen.js L422，其余 13 处都 await ensureLoaded()）。
   * 它直接读闭包里的 `state`，而 state 在 load() 前还是 DEFAULT_STATE，
   * 也就是各轴的**下界** —— valence = axes.valence[0] = -1。
   *
   * 后果：进程刚起来、还没 tick 过就调 checkThresholds()，
   * 会拿 valence=-1 去比 valenceActivity 阈值(-0.2)，
   * 立刻返回 find_activity(low_valence, urgency=1)——
   * 贾维斯一启动就"心情糟透了要找事做"。
   *
   * 原引擎默认 axes 里 valence 也是 [-1,1]，所以这个坑在上游同样存在，
   * 只是它的 demo 都先 tick 再 check，没暴露出来。
   *
   * 修法：包一层，先确保状态已加载（await 任意一个 async 读方法即可）。
   *
   * 注意必须先把原函数存到局部变量 rawCheck。
   * 因为最后是 `Object.assign(jw, { checkThresholds: checkThresholdsSafe })`,
   * 它会**就地覆盖 jw.checkThresholds**；如果这里写 `jw.checkThresholds()`
   * 就变成自己调自己 → 无限递归 → V8 heap out of memory。
   * （我第一版就是这么写的，测试直接把 4 GB 堆吃满崩掉。）
   */
  const rawCheck = jw.checkThresholds;
  async function checkThresholdsSafe() {
    await jw.getState();          // 触发 ensureLoaded()
    return rawCheck();
  }

  // 保留原引擎的全部方法，追加贾维斯特有的方法。
  // 注意 checkThresholds 被替换成安全版（先确保状态已加载），
  // 原始同步版仍可通过 checkThresholdsRaw 访问。
  return Object.assign(jw, {
    checkThresholdsRaw: rawCheck,
    checkThresholds: checkThresholdsSafe,
    userSaid,
    replied,
    praised,
    scolded,
    startActivity,
    didUsefulWork,
    getMoodLabel,
    axisLabels,
    persona,
  });
}

module.exports = { createJarvisMind };
