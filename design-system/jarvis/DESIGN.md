# JARVIS 设计系统 · DESIGN.md（v2 修订版）
> 来源：ui-ux-pro-max 数据库 + JARVIS 项目约束人工修订 + 评审意见闭环
> 方向宣言：**仪器感（instrument-grade）+ 生命感** —— 专业交易终端，密度优先，辉光克制，数字即主角
> 硬约束（优先级最高，冲突时其他条目一律让位）：生产依赖仅 better-sqlite3；前端零外部库、零网络字体、离线可完整运行
> **状态标注约定**：每节标注【目标态】=规范要求但 ui/ 未落地、【已验证】=现有代码已符合。权威源唯一：本文件。

---

## 1. 色彩系统【目标态】

| Token | 值 | 语义 | 使用纪律 |
|---|---|---|---|
| --bg | #0A1320 | 页面底 | **以 ui/index.html 现值为权威值**（v1 的 #060C15 作废），禁渐变紫蓝 |
| --panel | rgba(24,38,58,.60) | 面板 | 沿用现值；圆角 12px |
| --line | rgba(140,175,225,.20) | 描边 | 沿用现值 |
| --txt | #DBE6F4 | 主文字 | 对 --bg 对比度 ≥ 9:1 |
| --dim | #7C8EA6 | 次要文字 | 仅辅助信息，正文禁用 |
| --cy | #3FD0FF | **AI / 可交互 / 焦点环** | 与现有 --accent 同值，落地时 --accent 设为 --cy 的别名 |
| --gd | #F2B23E | **风控 / 警示** | 风控结论、退潮期、炸板率专属 |
| --rd | #F0485E | 涨 / 危险 | A股口径，见 1.1 双通道规则 |
| --gn | #089981 | 跌 / 安全 | A股口径，沿用现有 --down 值 |
| --num-hi | #9FC0FF | 数字高亮 | 编号/等宽数字 |
| --ok | #3FD48A | 系统状态 · 正常 | 数据源健康灯、成功反馈；不承载涨跌语义，见 §1.1 状态色豁免 |
| --warn | #FF9F1C | 系统状态 · 警告 | 数据源降级、提示；同值 --warm，别名共存 |
| --bad | #FF5C5C | 系统状态 · 异常 | 数据源不可用、错误指示；非涨跌语义，见 §1.1 状态色豁免 |
| --info | #4F8CFF | 系统状态 · 信息 | 中性通知；同值 --cool，别名共存 |

纪律：青金红绿不得跨语义混用；面板内禁止第五种强调色；辉光仅 text-shadow 0 0 10px 级别。

### 1.1 涨跌色双通道编码（强制，评审闭环）
红/绿在涨跌场景**永远不得单独承担语义**，必须同时满足以下至少两项：
- 符号通道：▲/▼ 或 +/- 前缀（列表、TAPE、个股行）
- 明度/填充通道：K 线涨=实心、跌=空心；直方图涨跌分列左右两侧（位置编码）
- 文字通道：hover/tooltip 必须有数值文本
反向纪律：红绿**禁止**出现在非涨跌语义（错误提示用 --gd 金 + 文字，不用红）；青金**禁止**进入 K 线/涨跌图表数据区。色盲场景下同屏语义色 ≤ 3 个。

**状态色豁免**（2026-09-17，B1 决策）：`--ok/--warn/--bad/--info` 是**系统状态**语义（数据源健康、错误指示、通知），不承载涨跌，不适用「非涨跌语义禁红绿」条款；同时也不参与涨跌双通道编码。四色已收入 §1 权威表，禁止再写死 hex；若状态色本身被误用于涨跌（例如把 `.lp-limit` 的金色改成 --bad），仍受 §1「青金红绿不得跨语义混用」约束。

## 2. 字体系统【目标态 · 已按零依赖修订】

**不引入任何外部字体（CDN 或打包均禁止，离线机器必须完整呈现）。** 仪器感由系统字体栈 + 排版手段达成：

| 角色 | 字体栈（全部本地回退） | 说明 |
|---|---|---|
| 数字/编号/表格 | Consolas → "Courier New" → monospace | 若用户机器恰好装有 Fira Code/JetBrains Mono 会自动优先命中（放栈首即可），无则 Consolas，**无网络请求** |
| 标题/正文 | "Microsoft YaHei" → "PingFang SC" → sans-serif | 中文仪器感靠字重对比（标题 700/正文 400，两级以上） |

排版手段替代字体个性：数字统一 font-variant-numeric: tabular-nums + letter-spacing: 0.02em；统计大数字字重 700、单位降 2 档字号。
字号采用双档制（2026-09-16 修订，原因见后）：
- **正文/交互档**（承载语义、可点、可读）：11 / 12.5 / 15 / 19 / 26，禁其他值。其中 11px 仅限标签式短文本（状态词、编号、单位），连续正文不低于 12.5px（与 §7 一致）。
- **元数据档**（badge、tag、坐标轴刻度、时间戳、caption；纯标注，不承载正文）：8 / 9 / 10 / 11px，须在 §3 密度预算内。
判定边界：需要被读懂的说明文字 → 正文档；仅用于对齐/标注/省空间的贴标 → 元数据档。

修订原因（原「5 档锁定」不可实现）：原条文与 §3「dense 9/10、8px 基准」及 §5 图表刻度需求互相矛盾。实测 ui/index.html 有 65 处硬编码字号，凡小于 12px 者全部是元数据贴标（.badge 8.5px、.limtag 8px、.scan-time 9px、坐标轴刻度、.tim-reason 10.5px 等）。强行并入 5 档会把 .badge 抬到 11px，撑破与其配套的 `padding:1px 6px` 胶囊贴标。此为规格与自身密度条文的冲突，非代码缺陷。
另注：token 层现为 --fs-xs:11px / --fs-sm:12px / --fs-base:13.5px / --fs-lg:15px，与正文档的 12.5 目标不一致（12 / 13.5 为过渡值），对齐属渲染变更，须目检后单独提交。

## 3. 间距与密度【目标态】（dense 9/10，8px 基准）

--space-1:4px · --space-2:8px · --space-3:12px · --space-4:16px · --space-5:24px · --space-6:32px
面板 padding 12-14px；条目行高 ≥ 32px；桌面密度豁免 44px 触控规则，但可点目标 ≥ 28px。

## 4. 动效系统【目标态】（motion 7/10，四层）

| 层 | 内容 | 时长/缓动 |
|---|---|---|
| L1 数据活着 | 数字 count-up、资金条生长（仅首入视口一次）、价格闪帧（涨红跌绿 + ▲▼ 符号，符合 1.1） | count-up 600ms；闪帧 1s 淡出 |
| L2 系统呼吸 | LIVE 灯 1.2s、雷达扫描 3s、LOGO 辉光 3s | keyframes infinite |
| L3 交互反馈 | hover 上浮 2px + 描边点亮；抽屉滑入 | 150-300ms；抽屉 320ms cubic-bezier(.22,1,.36,1) |
| L4 场景叙事 | AI 打字机（与流式接口同步）、TAPE 跑马灯、列表 stagger | stagger 每项 60ms back.out(1.4) |

硬预算（写进验收，非口号）：循环动画只用 transform/opacity；同屏 rAF Canvas ≤ 3；页面失焦（visibilitychange）全部暂停；prefers-reduced-motion 时 L2 全关、L1 直跳终值、L4 stagger 即时渲染。

## 5. 图表选型【目标态】（Canvas 手绘，无库）

| 场景 | 选型 | 规则 |
|---|---|---|
| 情绪温度 60 日 | 热力柱（冷青→暖金→恐慌红） | 必带数值图例；色盲备援：极值柱加纹理/标记 |
| 个股 K 线 | 蜡烛图 涨#F0485E实心 / 跌#089981空心 | 同屏 ≤ 500 根；量柱 40% 透明度 |
| 板块资金 | 水平条形 | 千分位/亿缩写；净流入右向、净流出左向（位置双通道） |
| 实时流 | 流式面积图 / TAPE | 缓冲 60-300s；必须提供暂停/继续按钮 |
| 涨跌分布 | 直方图，涨跌分列中轴两侧 | 配数值汇总文本 |

通用：每图必有图例 + hover 数值；live 更新用 role=status 整句播报（「炸板率 41.5%」），禁裸数字 aria-live。

## 6. 情景抽屉规则【目标态 · 未实现，以下为验收标准】

> 注：本节为待实现功能的验收口径，描述的是完工后必须通过的测试点，不代表现状。

- L0 列表 → L1 抽屉（详情/图表/3D 三 Tab，无内容 Tab 隐藏）→ L2 抽屉内下钻带返回
- 左栏条目从左滑出、右栏从右滑出；同屏仅一个抽屉；Esc/遮罩/× 均可关闭
- 打开时 focus 移入抽屉并 Tab 锁循环；关闭后焦点还原创发条目
- URL hash 同步（#drawer=sector:xxx）刷新可还原；<1400px 改底部全屏上滑

## 7. 反模式清单【目标态】

- ❌ 外部字体 CDN、紫蓝渐变、玻璃拟态堆叠、emoji 当图标
- ❌ 宽度/高度参与循环动画、裸数字 aria-live、无图例热力图
- ❌ hover 唯一触发、outline:none 无替代焦点样式、组件内写死 hex
- ❌ 连续正文 < 12.5px（11px 仅限标签式短文本：状态词、编号、单位；贴标类按 §2 元数据档 8/9/10/11px）、灰上灰、红绿单独承担涨跌语义、红用于非涨跌错误提示

## 8. 交付前检查单（与正文逐条挂钩，落地时逐项打勾并标注验证方式）

| # | 检查项 | 来源 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 四语义色无跨用；红绿均有双通道编码 | §1/§1.1 | 全页取色审查 + 灰度截图自查 | **部分已验证**（2026-09-16：星图闭环——图例 8 分档 + shader 4 色带全部移出绿带 [120°,180°]，且零红色；纪律已写成可执行测试 `jarvis-shader.test.js`「§1.1 反向纪律」并做突变验证（还原旧值必失败）。龙头涨幅面板确认合规——`pct()` 输出 `▲ +`/`▼ ` 前缀，构成符号双通道。**2026-09-17 板块卡闭环**：原代码用 `var(--down)` 绿表"流出"，属跨语义混用且正负都从左端画起、单通道；本次重写为位置(中轴左右)+色相(流入青 --cy / 流出灰蓝，hue≈215°)+符号(+/−)三通道并行，验证器 `scripts/verify-flowbar.js`（零依赖 CDP，构造负值样例让同一 CSS 引擎求值 + 读真实 DOM，退出码断言三通道，可作 §1.1 执行守卫）——首版锚点写反（正值 `right:50%` 占左半轨、与 §5「净流入右向」语义相反），几何断言对称化后才发现并修正为正值 `left:50%`/负值 `right:50%`，今日 8 板块 12 条柱 100% 满足「左缘贴中轴、右缘向轨道右端生长」。**§5 图表未落地**：K线/涨跌分布/情绪温度均为目标态、`ui/` 无对应 canvas，故本轮实际审查对象只有已存在的板块卡。**新增漂移扩大 §9 缺口**：6 处未登记绿带状态色（`#7fe3b0` ×3、`#4ad991` ×2、`#8ff0c0` ×1）+ 4 处金色漂移 `#ffcf6b`（4 处 `.b-main/.lp-up/.lp-limit/.limtag`）比 §9 记录的 4 个状态色 token 更多；截图 `_shots/flowbar-2026-09-17-clip.png`。**2026-09-17 已收敛**：走 §9 路线①——四状态色入 §1 权威表 + §1.1 显式豁免；`:root` 补 `--gd:#F2B23E`；10 处漂移全部替换为 `var(--gd)`/`var(--ok)`，rgba alpha 变体的 RGB 三元组同步对齐（`rgba(255,207,107,α)`→`rgba(242,178,62,α)`；`rgba(74,217,145,.6)/rgba(80,220,150,.36)`→`rgba(63,212,138,α)`）。详见 §13 Phase B。 |
| 2 | 无外部字体请求（F12 Network 无 fonts.* 域名） | §2 | 断网打开页面完整渲染 | **已验证**（2026-09-17：全库 `@font-face` / `fonts.googleapis` / `fonts.gstatic` / `url(http)` 全部 0 匹配；`--num` 栈首是本地回退 `"SF Mono",Consolas,"Roboto Mono"`；断网即可用，见 §13 A1） |
| 3 | 文字对比度 ≥4.5:1；--dim 不用于正文 | §1 | 对比度工具抽测 5 处 | **已验证**（2026-09-17：零依赖 CDP 抽测器 `scripts/check-contrast.js`（端口 9335），走 DOM 遍历 431 个带自身文字元素，按 WCAG 2.1 求相对亮度、祖先链 a-over 前向合成有效背景、gradient 首色解析、--bg #0A1320 兜底，含大字 AA 豁免（≥24px 或 ≥18.5px 粗体 → 3:1）。**首轮暴露 24 处违规**（10-11px 元数据标签），根源三条：①`--faint:#7888a0` 在 --panel 半透 bg 上仅 3.44:1（22 处，全为 `.en`/`.k`/`.vt`/`.lg-t`/`.hud-m`/时间戳等元数据），对纯 --bg 反而 5.16:1 达标；②`.hud-m` 内联 `rgba(160,190,230,.55)` 3.75:1；③`.lg-t` 内联 `rgba(160,180,210,.62)` 4.15:1。**已收敛**：`--faint` 提亮为 `#8ba0b8`（rgb 139,160,184），对 --panel 3.44→4.70:1、对 --bg 5.16→7.07:1，全 22 站点皆元数据无正文故整 token 安全；两处 rgba 内联收敛为 `var(--faint)`，同时清掉 §9 主题漂移。**复跑：431 元素 0 违规，最低 4.64:1**。DESIGN.md §2「元数据档 8-11px」是字号档豁免、非对比度豁免，故本轮按 WCAG 硬阈值收敛而非按元数据豁免放过。`--dim` 正文禁用条款：全库无 `--dim` 出现在正文级（≥12.5px 且非粗体）位置，仍合规。回归：668 项测试全绿。） |
| 4 | 正文档仅用 5 档（连续正文 ≥12.5）；元数据档限 8/9/10/11px；数字全局 tabular-nums | §2/§7 | CSS 扫描 font-size 值 + 断言 body 声明 font-variant-numeric | **部分已验证**（2026-09-16：tabular-nums 已全局生效；双档制已入文。**token 层 11/12/13.5/15 决定不动**——12/13.5 是过渡值，改它属渲染变更须目检后单独提交；改由 §2 双档 ladder 规约 65 处硬编码值，不反向拉动 token） |
| 5 | rAF Canvas ≤3；失焦动画暂停；reduced-motion 降级生效 | §4 | 性能面板 + 系统设置开启后目检 | **已满足**（2026-09-19 C1 rAF 链重构收官：`AnimGate` 重构为**共享调度器**——一条 rAF 链驱动所有注册的 draw 回调，`gatedLoop` 降为向后兼容适配层。实测（CDP 90 帧采样，包装 `requestAnimationFrame` 统计每帧调用次数）稳态 **rAF 链数 6 → 1**（唤醒瞬态最多 2 排帧），落在 ≤3 预算内；canvas 总数 12 不变（其中 4 个为一次性数据驱动绘制，不入调度器）。`AnimGate.registerCount()` = 6（app.js ×4 + starfield ×1 + voicecore ×1）共享同一条链。失焦暂停与 reduced-motion 由调度器统一下发（`page.active()` 失活即整链停帧、`page.onActive` 上升沿统一续帧；`info.reduceMotion` 逐帧传给每个 draw）；idle 检测双通道：draw 返回 `false` 自动注销 + 注册表清空即静默（`registry.length===0` 不再排 rAF）。原"残留第 2 条链"口径修正：静态搜生产源码 rAF 仅 animgate 一处，稳态实测每帧恰好 1 个 rAF 调用。见 §13 C1） |
| 6 | 每图有图例+hover数值；live 用 role=status 整句 | §5 | 逐图目检 + 读屏抽测 | **部分已验证**（2026-09-16：数据驱动渲染用真实数据确认——416 节点/931 边/248 记忆/105 实体，`filler=0` 即未退回空骨架；记忆类别图例 8 分档齐全；零依赖 CDP 截图见 §12。**2026-09-17**：`role=status` 已落地——`ui/index.html:869` `#srcbanner role="status" aria-live="assertive"`，`app.js:598-613` `renderSourceBanner` 输出整句中文（"行情源「XX」不可用，相关数据可能不是最新，请以实时行情软件为准"），非裸数字，见 §13 A4。**hover 数值不适用**：§5 图表（K线/涨跌分布/情绪温度）为【目标态·未落地】，`ui/` 无 canvas 图表；星图是 3D 网络图非数据图表，无 hover 需求。**2026-09-17 C3-A 部分闭环（情绪温度热力柱）**：`ui/charts.js`（398 行 Canvas 2D 共享原语，零外部库、零写死 hex，全走 `css('--xxx')` 从 `:root` 取值；6 项导出 API `css/resizeCanvas/colorLadder/drawText/drawAxis/drawBar/drawHatch/drawCandle/drawSentimentHeatmap/bindHover`）+ `src/server.js:511` `GET /api/sentiment/heatmap?days=60` 只读端点（`db.alertSamplesDaily().slice(-days)` 兜底 `{ok:false,error}`）+ `ui/index.html` `#mpHeatbox` DOM 锚点（`#mpbox` 兄弟级，不会被父级 innerHTML 覆写）+ 数据到位一次性重画、不入 `AnimGate.gatedLoop`（rAF 链数保持 6）。**图例**：冷静→恐慌 linear-gradient 冷青→暖金→恐慌红（3-stop `colorLadder`），斜纹标记极值柱（rate≥90 或 ≤10）作色盲备援。**hover tooltip 整句中文**：`「YYYY-MM-DD 炸板率 42.5% · 涨停 88 · 跌停 12 · 最高连板 7 · 封单 4.5 亿」` 6 段（日期+5 指标），`role=status` + `aria-live=polite`，`mouseleave` 干净隐藏。**验证双轨**：①`src/jarvis-charts.test.js` 37 项单测（`css()`/`colorLadder` 边界+插值+alpha/`hexToRgb` 三形式/6 项 draw 基元/主图数据形状+hit+tooltip 整句+极值斜纹+空数据兜底+缺字段兜底/`bindHover` DOM 生命周期/`resizeCanvas` DPR clamp）②`scripts/verify-charts.js` 端口 9338 CDP 契约（真实浏览器跑 60 天真实数据，6 断言：canvas 存在/模块 API 齐全/图例渐变/paintedPct≥5/hover 整句中文+role=status+aria-live+mouseleave 隐藏/未新增 rAF 链）；截图 `_shots/charts-sentiment.png`。**剩余 K线/涨跌分布/实时流/TAPE/个股 K 线**为 §5 剩余目标态，独立轮次落地后本项才升"已验证"。见 §13 C3。**2026-09-17 C3-B 部分闭环（板块涨幅分布直方图）**：`ui/charts.js` 追加 `drawDistribution(canvas, data)` 复用 `drawBar`+`colorLadder`+`drawText`+`setLineDash` 中轴虚线四基元（零新增导出，仍走 `css('--gn')/css('--rd')` 从 `:root` 取值，不写死 hex）+ `src/server.js:540` `GET /api/distribution?source=sector` 只读端点（`sector_daily.change_pct` 最新交易日聚合，961 板块样本，兜底 `{ok:false,error}`）+ `ui/index.html` `#scanDistbox` DOM 锚点（`#scanbox` 兄弟级，避开父级 innerHTML 覆写）+ 数据到位一次性重画、不入 `AnimGate.gatedLoop`（rAF 链数保持 6，CDP 断言 canvas 总数 10 且无新 rAF 链）。**图例**：跌区（--gn 青绿）+ 中轴渐变色带（`linear-gradient(90deg, --gn 50%, --rd 50%)`）+ 涨区（--rd 红）+「中轴=0 · 柱高∝板块数」注释——**§1.1 双通道合规**：位置（中轴左右）+ 色相（--gn/--rd）+ 明度（柱高）+ 形状（柱下方 range label 与 hover 整句）四通道并行，红绿不是唯一语义载体。**档界偏离 §5 参考值**（原稿 `<-7/-7~-3/-3~0/0~3/3~7/>7` 是个股 scale）：实际样本 961 板块 range 在 -6%~+7.9%、主体在 -2%~+2%，档界改为 `<-3/-3~-1/-1~0/0~1/1~3/>3` 匹配板块 scale、中间带 ±1%；样本名诚实地标为"板块涨幅分布"而非通用"涨跌分布"。**hover tooltip 整句中文**：`「-3~-1% 跌区 79 个板块 · 占 8.2%」` / `「0~1% 涨区 361 个板块 · 占 37.6%」`（档位+涨跌区+计数+占比，`%` 与"个板块"单位齐全），`role=status` + `aria-live=polite`，`mouseleave` 干净隐藏。**验证双轨**：①`src/jarvis-charts.test.js` 单测从 37 项扩到 50 项（新增 13 项：6 档全部画出/hit 三件套/hit 中间档返回对应桶/hit 越界返回 null/tooltip 整句中文含%含"个板块"含"占"/涨档"涨区"标注/涨档用 --rd 红跌档用 --gn 青绿（rgba 通道比对）/中轴虚线 setLineDash [2,3] + stroke/空 buckets 画"无分布数据"占位/空 buckets hit 安全/`data=null` 安全/count=0 时 maxCount 兜底 1 柱高 clamp 到 2px/padLeft 内边缘仍命中）②`scripts/verify-charts.js` 从单图 CDP 契约扩到双图（新增 distribution 就绪判定 + `probeOne()` 通用函数复用同一套 8 断言：canvas 存在/尺寸非零/`paintedPct≥3`/图例含"跌区""涨区""中轴=0"/渐变色带 + hover 整句中文含%"个板块""占"+role=status+aria-live+mouseleave 隐藏）；截图 `_shots/charts-c3.png` + `_shots/charts-c3-dist.png`（情绪图例 + 分布图例双区截图）。**§5 剩余图表**：C3-C 大盘 K 线本轮跳过——`minute_kline` 表全空（0 行，所有 code），无数据源可用；§5 第 4 项 实时流面积图/TAPE 需流式端点基建、§5 第 2 项 个股 K 线需个股数据抓取链路，均独立轮次。见 §13 C3。 |
| 7 | 抽屉焦点锁/Esc/hash还原/小屏上滑 | §6 | 键盘全程操作一遍 | **已验证**（2026-09-18 C2-A + C2-D + C2-B + C2-C1 + C2-C2 + 左栏左滑出 全部收官：`ui/drawer.js` 零依赖模块 + `#drawerPanel`/`#drawerBackdrop` DOM + leader/sectorDetail/stockDetail/entity/category 五类型注册 + `#leaderbox .lrow` 点击入口 + 星图实体点击入口 + `#galaxies .gal[data-cat]` 左滑入口。焦点锁 Tab/Shift+Tab 循环、Esc 关闭还焦、hash `#drawer=type:id` 写入/清空/刷新还原、遮罩点击关闭、× 按钮关闭均验证通过。**小屏 <1400px 底部全屏上滑** 已验证。**C2-B L2 下钻** 已验证。**C2-C1 图表 Tab** 已验证。**C2-C2 3D Tab** 已验证。**左栏左滑出** 已验证——`ui/app.js` `loadStarmap` 中 `.gal` 加 `tabindex="0" data-cat role="button" aria-label`，事件委托（click + keydown Enter/Space）调 `Drawer.open('category', cat, { side: 'left', title, sourceEl: gal })`；`ui/index.html` 注册 `category` 类型（fetcher 从 `/api/starmap` 按 category 过滤实体+记忆上限 30 条；render 渲染类别名+实体列表+记忆列表含 decay 中文标签）；CSS `.gal[data-cat]` 加 `cursor:pointer` + hover 背景 + `:focus-visible` 焦点环（`var(--accent)`）；`.from-left` CSS 已在 C2-A 就位，小屏 <1400px 自动变底部上滑。`src/jarvis-drawer.test.js` **94 项单测全绿**（新增 20 项 category 覆盖）；CDP **44 断言全绿**。截图 `_shots/drawer-verify.png`） |
| 8 | 375/768/1024/1440 无横向滚动 | §3 | 四档截图（`scripts/screenshot-cdp.js` 第 5 参数传四档，逐档断言 `scrollWidth` vs `clientWidth`，溢出则退出码 4） | **已验证**（2026-09-16 首轮：页面级横向滚动四档全为否、退出码 0。但发现窄屏**信息静默裁切**：顶栏 6 指标 + 3 数据源灯 + meta 在 375 溢出 490px、768 溢出 97px、1024 溢出 26px、1440 为 0，被祖先 overflow 裁成一条硬直截断线，无省略号无更多提示。最要紧的是 `#srcs` 数据源健康灯被切掉——窄屏用户看不出行情已降级，正是「假的可用比明确不可用更危险」要挡的。截图 `_shots/viewport-2026-09-16-{375x812,768x1024,1024x768,1440x900}.png`。窄屏顶栏收折方案动全局视觉，本轮不擅自改，需拍板。**2026-09-17 闭环（方案① 汉堡菜单）**：走用户拍板的方案①——`<1024px` 时把顶栏 6 指标 + `#model` + `#meta` 折进汉堡按钮触发的浮层面板，`#srcs` 数据源灯**始终留在顶栏、任何宽度绝对可见**。落地：CSS 拆分 `@media (max-width:900px)`（面板/布局收折）与 `@media (max-width:1024px)`（顶栏折叠）两条断点——单条 900 会在 1024 视口下漏 26px `#meta`，1024 单独不够又要在 900 断点前保持顶部密度。HTML 在 `#top` 内加 `<button id="tbmenu">`，紧随其后加 `<div id="tbmenuPanel" role="menu">`；JS IIFE 走「点开克隆 live DOM、非持续同步」策略（顶栏是慢变量，clone 一次就够），复用 `#ops` 抽屉的 click-toggle / click-outside / Esc / aria-expanded 四路交互纪律。新增零依赖 CDP 验证器 `scripts/verify-tbmenu.js`（端口 9336），375 视口五断言：①`#srcs` 数据源灯在视口内绝对可见（4/4 全在 x=279-318 区间，服务器动态渲染 4 盏——个股资金流拆解/腾讯行情/东财行业/腾讯K线——非初始 HTML 硬编码 3 盏，故断言改为「全在视口且 ≥3」而非精确计数）②汉堡按钮关闭态可见 ③面板打开 aria-hidden=false / btn aria-expanded=true / 6 指标同步 6/6 ④面板内文本对比度 ≥4.5:1（16 个文本元素、0 违规、最低 6.84:1）⑤Esc 关闭 + click-toggle 双路径。截图 `_shots/tbmenu-375-open.png`（729.1 KB）。§8 #8 硬纪律（"数据源降级必须显性化"）在 375 视口下达成。） |

## 9. Token 权威源与旧值映射（评审闭环）

本文件为唯一权威源。ui/index.html 现存变量按下表归并，落地时旧名保留为别名、不再新增使用：

| 权威 token | ui/index.html 旧名 | 处置 |
|---|---|---|
| --cy #3FD0FF | --accent | 改设 var(--cy) 别名 |
| --gn #089981 | --down | 改设 var(--gn) 别名 |
| --rd #F0485E | --up（现值 #f23645） | 改设 var(--rd) 别名；值 #f23645 → #F0485E，属目标态变更 |
| --bg #0A1320 | 同名同值 | 不动 |
| _mockup 内 design-*.md 的 #070b11 等 | 历史稿 | 作废，仅存档 |

> **2026-09-16 更正**：原表 `--up（存在重复声明冲突）` 表述有误。`ui/index.html` 中第二处 `--up/--down`
> 定义位于 `:root[data-market="us"]` 作用域，是美股口径（绿涨红跌）的**有意 scoped 覆盖**，不是冲突。
> 因全项目无任何 JS 设置 `data-market` 属性，该块为不可达死 CSS，已于 2026-09-16 删除
> （备份 `ui/index.html.tokfixbak-20260916-183224`；1412 行 → 1408 行，431 项测试全绿）。
> 涨跌口径现仅 A 股一套；将来若支持美股，必须同时接线开关，不得只加覆盖块。
>
> **2026-09-16 缺口（2026-09-17 已闭环）**：ui/index.html 原定义 `--ok #3FD48A / --warn #FF9F1C /
> --bad #FF5C5C / --info #4F8CFF` 四个状态色，用于数据源健康灯与横幅（`.s.ok / .s.deg / .s.down`、
> `#srcbanner`），本文件 §1 权威表原未收录——即它们不是权威值，属 §9 漂移。
> 且 `--ok` 绿 / `--bad` 红落在 §1.1 反向纪律禁止的「非涨跌语义用红绿」范围内（状态灯不是涨跌）。
>
> **2026-09-17 处置**：走路线 ①，四色收入 §1 权威表 + §1.1 显式豁免（状态色不承载涨跌）。
> 理由：状态色是行业惯例（正常/警告/异常/信息），改成金+图标+文字会破坏现有 8 处灯位与横幅的视觉密度，
> 收益/成本比不划算；豁免只针对"状态"这一类语义，涨跌纪律原样保留。
> 落地：`--gd` 补齐入 `:root`（#F2B23E）；`#ffcf6b ×4`、`#7fe3b0/#4ad991/#8ff0c0 ×6` 全部收敛为 `var(--gd)`/`var(--ok)`；
> rgba alpha 变体的 RGB 三元组同步对齐新权威值。详见 §13 Phase B。

## 10. 星图增强清单【已落地 · 2026-09-17 收尾轮】（三轮评审收敛结果）

前提：starfield.js 一行不删，全部以增量方式增强；零新依赖；原 319 项测试作回归基线不动，新功能配独立测试文件 jarvis-starmap-plus.test.js。

| # | 项 | 设计要点 | 工作量 | 落地 |
|---|---|---|---|---|
| 1 | 三级景深聚焦（悬停） | 自身+一度邻居 alpha 1.0 → 二度 0.45 → 其余 0.12，相机 fov 轻推 -3°；遍历两遍邻接表 | ~60 行 | `applyDepthFocus` + `neighborLevels` + `hoverFov` lerp（本轮补齐 fov） |
| 2 | 点击聚焦 + Esc 归位 | 聚焦前记录相机位置，平滑飞入（2s easeInOutCubic）；点空白或 Esc 飞回原位，复用 showMemoryCard | ~50 行 | `focus`/`unfocus` + `app.js:1476` Esc 归位 |
| 3 | 事件驱动脉冲传播 | 禁匀速装饰流；脉冲由事件触发：新记忆写入=核心→实体，AI 召回=实体→核心，沿真实连接路径 | ~40 行 | `pulseAlong` + `pulseWrite`/`pulseRecall`（本轮补齐 `learned` 事件→`pulseWrite` 触发） |
| 4 | shader 内发光 | 重要节点（memCount 高位）点精灵径向衰减外扩 + additive 双色混合；零新纹理零新 draw call | ~15 行 | `impAdd` smoothstep 门控 + `gl.SRC_ALPHA,gl.ONE` |
| 5 | 黄金角螺旋布局 | 实体按 137.5° 叶序螺旋挂所属星系；新增只追加末端，既有坐标永不动；淡忘节点留空位（淡忘可视化） | ~80 行 | `CAT_CAP=100` + `SLOT_CAP=520` + `stableSlot` φ⁻¹ 低差异序列 + `assignSlots` 撞槽确定性顺移 |
| 6 | jarvis-starmap-plus.test.js | 5 项各配独立断言；原测试套件保持全绿 | ~80 行 | 11 断言（STAGE4 GL 层、fov shader 视觉无独立数值点），全套 682 项回归绿 |

原合计约 325 行（含测试），预估 3 天。实际本轮新增 ~60 行 + 缺口补齐 ~20 行 = ~80 行——§10 五项大部分在 DESIGN.md 写完后、设计审计开跑前，`ui/starfield.js` 已按同套约定实现（commit 6655582），本轮实际工作是验证 + 补齐 fov 轻推与 pulseWrite 触发两个缺口。详见 §13 Phase E。

验收挂钩：实现后对照 §8 检查单第 1/5/6 项验证（双通道色、rAF 预算、图例与 role=status）。

待决项（未拍板，不进入本轮实现）：
- 时光回溯模式：拖时间轴回放记忆图谱 30 天生长过程，~120 行，零约束冲突，等单独确认
- 抽屉 3D 场景（板块星系图/席位网络球）：不受盯盘稳定性约束，可用更自由布局，随抽屉改造一起做

验收挂钩：实现后对照 §8 检查单第 1/5/6 项验证（双通道色、rAF 预算、图例与 role=status）。

## 12. 截图与验收工具链【已验证】

`scripts/screenshot-cdp.js` —— 零依赖 CDP 截图，等真数据上屏再拍。

为什么不用 `msedge --screenshot`：它是定时刻度拍一帧，星图数据来自 `/api/starmap` 的异步 fetch，
定时刻度早于数据落地，拍出来是空骨架（只有 filler 占位节点），看着满屏正常、实际是假的可用。
`--virtual-time-budget` 在本页挂死（§8 #5：starfield 待机自排帧永不静默）。

依赖：Node 25 全局 `WebSocket`（未加 flag 即可用），不用 ws / puppeteer / playwright；
不写进 package.json 生产依赖（仅 dev 侧工具脚本）。

就绪判定：`window.__starData` 存在 **且** `STAR.stats().memories > 0`。
两者必须同时成立——空骨架也能画出满屏星图，只看画面无法区分「真数据」与「连不上服务器退回骨架」。

用法：`node scripts/screenshot-cdp.js [url] [输出png] [等待秒数] [视口列表]`

视口列表（第 4 参数）：单档 `1720x1040`（默认），或多档 `375x812,768x1024,1024x768,1440x900`
（§8 #8 的四档）。多档经 `Emulation.setDeviceMetricsOverride` 逐档重排、各存一张
`<输出名>-<WxH>.png`，并逐档断言 `documentElement.scrollWidth <= clientWidth`；
任一档横向滚动则退出码 4，可直接当 CI 断言。脚本同时上报另一口径——「元素已画到
视口外但被祖先 overflow 裁掉」的溢出像素与元素名。页面级不滚和用户看到被切掉的内容
是两件事，必须分开看（§8 #8 的窄屏裁切就是这么发现的）。

已验证（2026-09-16）：416 节点 / 931 边 / 248 记忆 / 105 实体 / `filler=0`，截图存
`scripts/_shots/starmap-data-*.png`。同日四档视口复拍为 417 节点 / 935 边 / 249 记忆 /
105 实体——记忆库在增长，正好佐证就绪判定抓的是真数据：若退回空骨架，数字不会动。
四档截图存 `_shots/viewport-2026-09-16-{375x812,768x1024,1024x768,1440x900}.png`，
页面级横向滚动全否，窄屏裁切发现见 §8 #8。

注意需先起服务器（会开飞书长连接与 60s 主动意识心跳，拍完立即停，
以 `curl → http=000` 确认端口释放）。

---

## 13. 执行进度表（2026-09-17 全自主推进）

授权：「需要我决策给你权限按自己的建议来，技术上受阻去全网找相关技能或项目来解决，没做的按计划进行」。凡标【决策】者已按本人推荐落地并写入本表；凡标【新功能】者需一轮独立实现，不在本轮范围。

### Phase A · 快速验证（已收尾）

| ID | 项 | 判定 | 依据 |
|---|---|---|---|
| A1 | §8 #2 无外部字体请求 | ✓ 已合规 | 全库 `@font-face`/`fonts.googleapis`/`fonts.gstatic`/`url(http)` 0 匹配；`--num` 栈首是本地回退 `"SF Mono",Consolas,"Roboto Mono"` |
| A2 | §8 #3 文字对比度 ≥4.5:1；`--dim` 不用于正文 | ✓ 已合规 | 见 §8 #3。零依赖 CDP 抽测 431 元素 0 违规，最低 4.64:1。首轮 24 处违规（10-11px 元数据标签）经 `--faint` 提亮 #7888a0→#8ba0b8 + `.hud-m`/`.lg-t` 两处 rgba 收敛为 var(--faint) 后全数通过 |
| A3 | §8 #6 hover 数值 | **部分已合规**（2026-09-17 C3-A + C3-B + 2026-09-18 C3-C） | 情绪温度热力柱 hover tooltip 已落地并验证——`ui/charts.js` `bindHover()` 生成 `.chart-tip` DOM（`role=status` + `aria-live=polite`），命中柱时输出整句中文 `「2026-09-01 炸板率 42.5% · 涨停 88 · 跌停 12 · 最高连板 7 · 封单 4.5 亿」`（日期+5 指标、`%`/`亿` 单位齐全），`mouseleave` 干净隐藏；**2026-09-17 C3-B 板块涨幅分布直方图**同步落地——`drawDistribution()` + `#scanDistbox` + `GET /api/distribution`，hover tooltip 输出 `「-3~-1% 跌区 79 个板块 · 占 8.2%」` / `「0~1% 涨区 361 个板块 · 占 37.6%」`（档位+涨跌区+计数+占比、`%` 与"个板块"单位齐全），`role=status` + `aria-live=polite`；**2026-09-18 C3-C 大盘 K 线图**同步落地——`drawKline()` + `#klinebox` + `GET /api/kline`，hover tooltip 输出 `「2026-09-18 开3892.0 高3920.0 低3889.0 收3911.9 量4.86亿」`（日期+开高低收量+单位），A 股红涨绿跌，`role=status` + `aria-live=polite`，`mouseleave` 干净隐藏；`scripts/verify-charts.js` CDP 三图 12 断言全绿。**K线/实时流/TAPE/个股 K 线**仍在目标态，§5 剩余图表 hover 待后续独立轮次落地 |
| A4 | §8 #6 `role=status` 整句播报 | ✓ 已合规 | `ui/index.html:869` `#srcbanner role="status" aria-live="assertive"`，`app.js:598-613` `renderSourceBanner` 输出整句中文（"行情源「XX」不可用，相关数据可能不是最新，请以实时行情软件为准"），非裸数字 |

### Phase B · 决策落定 + 颜色收敛（已落地）

| ID | 项 | 决策 | 落地 |
|---|---|---|---|
| B1 | §9 状态色是否入权威表 | **路线①**：把 `--ok/--warn/--bad/--info` 收入 §1 权威表，明确豁免 §1.1 涨跌反向纪律 | 见本表 §1 补注；通用状态色不承载涨跌语义，是行业惯例 |
| B2 | 6 处未登记绿带状态色 | 全部收敛为 `var(--ok)` | `.set-msg.ok` / `.tag-ok` / `.mc-tag.fresh` / `.msg.t.tok::before` / `.msg.t.tok .tres` / `#state.st-speak`；`rgba(74,217,145,.6)` 与 `rgba(80,220,150,.36)` 同步对齐为 `rgba(63,212,138,α)` |
| B3 | 4 处金色漂移 `#ffcf6b` | 收敛为 `var(--gd)`；`:root` 新增 `--gd:#F2B23E`（§1 权威值） | `.b-main` / `.lp-limit` ×2（限标签主色 + 徽章内联） / `.limtag`；rgba alpha 变体 RGB 三元组由 `(255,207,107)` 同步对齐为 `(242,178,62)` |
| B4 | 窄屏顶栏收折方案 | **方案① 汉堡菜单**（推荐，已拍板）：`<1024px` 折叠顶栏 6 指标 + `#model` + `#meta` 进浮层面板，`#srcs` 数据源灯永远留在顶栏 | `ui/index.html`：CSS 拆两条断点（900 布局 / 1024 顶栏）、`#tbmenu` 按钮 + `#tbmenuPanel` 浮层、IIFE 点开克隆 live DOM 策略；新增 `scripts/verify-tbmenu.js`（端口 9336）五断言零依赖 CDP 验证器；详见 §8 #8 |

### Phase C · 中大型（本轮仅决策，未开工）

| ID | 项 | 定位 | 说明 |
|---|---|---|---|
| C1 | §8 #5 rAF Canvas ≤3 | **【已落地·已验证】**（2026-09-19） | `ui/animgate.js` 重构为**共享 rAF 调度器**：新 API `AnimGate.sharedLoop()`→`{start,stop,isRunning}`（单一 rAF 驱动，遍历注册表逐帧调用所有 draw）+ `AnimGate.register(draw,opts)`→注销函数（draw 返回 `false` 自动注销）+ `AnimGate.unregister(fn)` + `AnimGate.registerCount()`；旧 `AnimGate.gatedLoop(fn,stop)` 降为**向后兼容适配层**（包装为 register，`stop()` 返回 true 即注销），旧调用方不改代码也能工作。纯函数层（`shouldAnimate`/`scheduleNext`/`isPageActive`/`createPageActivity`/`page`）原样保留。**调用方迁移**：`ui/app.js` 4 处 `gatedLoop` → `sharedLoop.start()` + `AnimGate.register(...)`；`ui/voicecore.js` `start()` → `AnimGate.register`，`_running` 终止判断移入 draw 体（`if(!this._running) return false`）；`ui/starfield.js` 自有 `frame` 循环并入调度器——`rafOn` 改为 `sfRegistered` 标志、`wake()` 按需重新 `register(starfieldDraw)`、`starfieldDraw` 返回 `keepGoing` 交调度器决定是否续帧，原有 `forceFrames`/`idleDrifting()`/`scheduleNext()` 逻辑原样保留。**零外部依赖**（仍为纯浏览器全局 + Node CJS 双出口 UMD）。**失焦暂停**：调度器 `tick()` 与 `ensureScheduled()` 均先查 `page.active()`，失活即不画也不排下一帧；`page.onActive` 上升沿统一续帧——6 个 draw 一致生效，无需各自行处理。**reduced-motion**：调度器每帧取 `page.reduceMotion()` 塞进 `info.reduceMotion` 传给每个 draw，由 draw 自行降级；`scheduleNext` 保持"强制帧耗尽后立刻停"语义。**idle 检测**：draw 返回 `false` 自动注销 + 注册表清空即静默（不再排 rAF，新 register 自动唤醒）。**实测**：CDP 90 帧采样包装 `requestAnimationFrame` 统计每帧调用次数——**rAF 链数 6 → 1**（稳态每帧恰好 1 个 rAF，唤醒瞬态最多 2 排帧），达 ≤3 预算；canvas 总数 12 不变。`AnimGate.registerCount()`=6。**测试**：`src/jarvis-animgate.test.js` 33 项纯函数测试原样保留 + 新增 15 项调度器测试（关键断言「3 个 register 共享 1 条 rAF 链」跑 6 帧确认链数恒为 1；失焦暂停全部 draw、reduced-motion 标志下发、返回 false 自动注销、注册表清空静默 + 新注册唤醒、start/stop 幂等、gatedLoop 适配层兼容含 stop 回调、单 draw 异常隔离不阻断其余、TypeError 校验、`page.reduceMotion` Node 安全返回 false、visibilitychange 暂停、dt 计算 clamp、全量回归"6 条旧 gatedLoop → 1 条 rAF 链"），共 **48 项全绿**。**回归**：`scripts/run-tests.js` 28 套件 **897 项全绿**；`scripts/verify-charts.js`（CDP 9338）11 断言全绿含"未新增 rAF 链"；`scripts/verify-drawer.js`（CDP 9339）44 断言全绿。原"本轮只做决策不动代码"（2026-09-17）已由本轮完成。**踩坑记录**：Node CJS 作用域下 `global.requestAnimationFrame = ...` 不会让裸标识符 `requestAnimationFrame` 可见（浏览器 `window.foo` 才行），调度器内部改用 `globalThis.requestAnimationFrame` / `globalThis.cancelAnimationFrame` / `globalThis.matchMedia` 取值，既让 Node 单测的 mock 生效、又在浏览器上指向同一原生全局，无运行时行为差异。 |
| C2 | §8 #7 抽屉焦点锁/Esc/hash/小屏上滑 | **【大部分落地】**（2026-09-18 C2-A + C2-D + C2-B + C2-C1 + C2-C2 收官） | **C2-A 抽屉基础层** 已交付：①`ui/drawer.js` 零依赖模块（`open`/`close`/`isOpen`/`register` 四 API；320ms cubic-bezier(.22,1,.36,1) slide-in；`history.replaceState` 写/读 `#drawer=type:id`；焦点锁 Tab/Shift+Tab 循环 + Esc 关闭还焦；同屏仅一个抽屉；CSS 预留 `.from-left`（左栏滑入）与 `@media(max-width:1400px)` 底部上滑）②`ui/index.html` `#drawerBackdrop` + `#drawerPanel`（`role=dialog` + `aria-modal=true`）+ `#drawerHeader`（`#drawerTitle` + `#drawerClose`）+ `#drawerBody` DOM 骨架 + CSS（z-index 30/31，高于 `#memcard`(12) 低于 `#setmask`(40)）+ leader 注册 IIFE（`Drawer.register('leader', { fetcher, render, title })`；`render` 渲染 12 字段网格 + 理由列表 + 数据时间 + "问 AI" 按钮）③`#leaderbox .lrow` 点击改为打开抽屉（`data-idx` 回查 sector 对象，修复原代码 forEach 循环变量 `s` 在循环外不可达的 bug），`.lrow` 加 `tabindex="0"` 使 `focus()` 生效。Esc / 遮罩点击 / × 按钮三路关闭；hash 还原刷新可还原。测试与 CDP 全绿：`src/jarvis-drawer.test.js` 22 项单测（状态切换/hash 同步/render 注入/同屏替换/side 方向/title/焦点锁/还焦），`scripts/verify-drawer.js` CDP 端口 9339 44 断言（DOM 存在/API 暴露/点击打开/hash 写入/焦点锁/Tab 循环/Esc 关闭/遮罩关闭/× 关闭/还焦/hash 还原刷新/小屏底部上滑）；截图 `_shots/drawer-verify.png`。**C2-D 小屏 <1400px 底部全屏上滑** 已交付：CSS `@media(max-width:1400px)` 已在 C2-A 中就位（`top:auto;left:0;right:0;bottom:0;width:100%;height:min(70vh,560px);border-top:1px solid var(--hairline);box-shadow:0 -8px 30px rgba(0,0,0,.5);transform:translateY(100%);border-radius:16px 16px 0 0`），`.from-left` 在同视口下亦统一为底部上滑（`left:0;right:0;bottom:0;top:auto;transform:translateY(100%)`）。CDP 断言 10（行 411-488）：1300x800 视口下 panel 定位 bottom=0 left=0 right=0 top=240px（即 800-560=240）、width=1300px（全宽）、height=560px（70vh clamp）、圆角 16px 16px 0 0、border 从 left→top（0px/1px）、关闭态 transform=translateY(560)（视口外下方）、打开态 transform=translateY(0)、panel 可见。JS 无需修改——`Drawer.open()` 的 `side` 参数仅控制 CSS 类名，底部上滑由纯 CSS 媒体查询驱动。测试与 CDP 全绿：44 断言 0 失败。**C2-B L2 下钻带返回** 已交付：`ui/drawer.js` 重写为栈式导航（L0→L1→L2→L3），新增 `push`/`pop`/`stackSize`/`current` API + `MAX_DEPTH=3`。动态创建 `<button class="drw-back">← 返回</button>`（仅当 `_stack.length > 1` 时可见，样式与 `#drawerClose` 一致）。Esc 关闭整个抽屉（不逐层 pop）。Hash 同步支持多层 `#drawer=type:id>subType:subId>subSubType:subSubId`（`encodeURIComponent` 处理中文）。fetcher 结果缓存到栈条目 `entry.data`，pop 回来不重抓。`ui/index.html` 注册 `sectorDetail`（板块详情：分级/评分/涨跌家数/加速比 + 龙头 K 线下钻）和 `stockDetail`（个股详情：/api/kline 60 日 K 线指标——最新价/区间涨跌/MA5/10/20/年化波动率/区间位置条 + 最近 5 根 K 线）；leader 抽屉底部加"查看板块详情 →"按钮触发 L1→L2 下钻。`src/server.js` 新增 `GET /api/kline?code=&period=&limit=&days=&adjust=`（直接 `require('./tools/stock_kline')` 不经 `tools.call` 避免 4000 字符截断；返回 `bars` + `indicators` + `days`）。CSS 新增 `.drw-back`/`.drw-drill`/`.drw-bar`/`.drw-kv .v.up/.v.down`（全走 CSS 变量，零硬编码 hex）。测试与 CDP 全绿：`src/jarvis-drawer.test.js` 从 22 项扩到 52 项（新增 30 项 push/pop/多次下钻/MAX_DEPTH 边界/返回按钮可见性/Esc 深度关闭/hash 多层还原/焦点恢复）；CDP 44 断言全绿。**C2-C1 图表 Tab（stockDetail K 线图）** 已交付：`ui/index.html` `renderStockDetail` 重写——指标网格后新增 K 线图区域（`<canvas id="drwKlineCanvas" width="440" height="260">` + 6 色块图例 + A 股红涨绿跌注释）。数据流：fetcher 已一次 `/api/kline` 返回 `{ok, bars, indicators}`，render 直接用 `data.bars`（不二次 fetch）。后置绘制：`setTimeout(0)` 拿 DOM 引用后调 `Charts.drawKline(cv, bars, {})`，再 `bindHover` 挂 tooltip。守卫：`!window.Charts || !cv` 静默跳过。CSS 新增 `.drw-kline`/`.drw-kline-title`/`#drwKlineCanvas`/`.drw-kline-legend` + 全套 `.kl-*` 色块（涨=`--rd`、跌=`--gn` 空心 `--panel` 底 + `--gn` 描边、MA5=`--cy`、MA10=`--gd`、MA20=`--info`、量柱=红/绿 `color-mix` 50% 半透渐变），全部走 CSS 变量。测试与 CDP 全绿：`src/jarvis-drawer.test.js` 从 52 项扩到 66 项（新增 14 项 stockDetail K 线图覆盖——canvas 元素存在/图例 6 色块/A股红涨绿跌 note/空 bars 安全/data.ok=false 错误提示/data=null 安全/push 下钻路径）。**C2-C2 星图实体→抽屉 3D Tab** 已交付：`ui/app.js` 修改 `graphEl` 点击处理器——`hit.kind === 'entity' && hit.memId == null` 时调用 `Drawer.open('entity', hit.entity, { side: 'right', title: hit.entity, sourceEl: graphEl })`，关闭后焦点还焦到星图 canvas。记忆节点点击（`hit.memId != null`）走原有 `showMemoryCard` 路径不受影响。`ui/index.html` 追加 entity 注册 IIFE：fetcher 调用 `/api/starmap` 按 name 查找实体，`filter(m => m.entity === entityName)` 提取记忆；render 生成 `.drw-sec`（实体名+类别中文 person→人物/place→地点/event→事件/interest→兴趣/project→项目+#ID）+ `.drw-grid`（关联记忆条数+提及次数）+ `.drw-reasons`（记忆列表最多 20 条含 decay 中文标签 fresh→新鲜/normal→正常/fading→正在变淡+天数，超出 20 条显示"还有 X 条未显示"）+ `.drw-actions`（"问 AI"按钮）。所有用户内容经 `esc()` 转义防 XSS。测试与 CDP 全绿：`src/jarvis-drawer.test.js` 从 66 项扩到 **75 项**（新增 9 项 entity 覆盖——注册后可 open/hash 格式/fetcher 数据形状/fetcher 找不到实体/空记忆安全/render 含实体名+类别+记忆列表/空 memories 安全/超 20 条截断/XSS 转义/关闭后还焦星图/Esc 不关星图）；CDP 44 断言全绿。**暂缓**：无（C2 系列全部收官） |
| C3 | §5 图表落地（K线/涨跌分布/情绪温度） | **【部分落地】**（2026-09-17 C3-A + C3-B 收官；2026-09-18 C3-C 收官） | **C3-A 情绪温度 60 日热力柱** 已交付：①`ui/charts.js` Canvas 2D 共享原语（`css`/`resizeCanvas`/`colorLadder`/`drawText`/`drawAxis`/`drawBar`/`drawHatch`/`drawCandle`/`drawSentimentHeatmap`/`bindHover`；零外部库、零写死 hex、全走 CSS 变量）②`src/server.js` `GET /api/sentiment/heatmap?days=60` 只读端点（`db.alertSamplesDaily().slice(-days)` + `{ok:false,error}` 兜底）③`ui/index.html` `#mpHeatbox` DOM 锚点（`#mpbox` 兄弟级，避开父级 innerHTML 覆写）④数据到位一次性重画、不入 `AnimGate.gatedLoop`（rAF 链数保持 6）⑤`src/jarvis-charts.test.js` 单测 + `scripts/verify-charts.js` CDP 端口 9338 契约验证器全绿。图例冷青→暖金→恐慌红渐变 + 斜纹标记极值柱作色盲备援；hover tooltip 整句中文 `role=status`。**C3-B 板块涨幅分布直方图** 已交付：`ui/charts.js` 追加 `drawDistribution(canvas, data)` 复用 `drawBar`+`colorLadder`+`drawText`+`setLineDash` 中轴虚线四基元（零新增导出，仍走 `css('--gn')/css('--rd')` 从 `:root` 取值）+ `src/server.js` `GET /api/distribution?source=sector` 只读端点（`sector_daily.change_pct` 最新交易日聚合，961 板块样本，`{ok:false,error}` 兜底；**端点 bug 已修**：首版 `.all()` 漏传 `latestDate` 参数导致 SQLite `Too few parameter values were provided`，修正为 `.all(latestDate)`）+ `ui/index.html` `#scanDistbox` DOM 锚点（`#scanbox` 兄弟级，避开父级 innerHTML 覆写）+ 数据到位一次性重画、不入 `AnimGate.gatedLoop`。图例跌区（--gn 青绿）+ 中轴渐变色带 + 涨区（--rd 红）+「中轴=0 · 柱高∝板块数」注释——**§1.1 双通道合规**：位置+色相+明度+形状四通道并行，红绿不是唯一语义载体。档界偏离 §5 参考值（`<-7/-7~-3/-3~0/0~3/3~7/>7` 个股 scale 改为 `<-3/-3~-1/-1~0/0~1/1~3/>3` 板块 scale，中间带 ±1%），偏离已在本表 + `server.js` 端点注释 + `charts.js` 函数注释三处记录；样本名诚实地标为"板块涨幅分布"而非通用"涨跌分布"。hover tooltip 整句中文 `「档位+跌区/涨区+计数+占%」`，`role=status`。测试与 CDP 全绿：`src/jarvis-charts.test.js` 从 37 项扩到 50 项（新增 13 项 drawDistribution 覆盖），`scripts/verify-charts.js` 从单图 6 断言扩到双图 8 断言（新增 `probeOne()` 通用函数复用），截图 `_shots/charts-c3.png` + `_shots/charts-c3-dist.png`。**C3-C 大盘 K 线图** 已交付（2026-09-18）：`ui/charts.js` 追加 `drawKline(canvas, bars, opts)`（复用 `drawCandle`+`drawAxis`+`drawText`+`colorLadder`+`bindHover` 基元；零新增导出，仍走 `css('--rd')`/`css('--gn')` 从 `:root` 取值；A 股红涨绿跌——`close>open` 用 `--rd`，`close<open` 用 `--gn`）。包含：MA5/MA10/MA20 三色均线（`--cy`/`--gd`/`--bl` 色相分离）+ 成交量柱（底部 25% 区域）+ hover tooltip 整句中文（`「YYYY-MM-DD 开3892.0 高3920.0 低3889.0 收3911.9 量4.86亿」` 含日期+开高低收量+单位）+ 图例（涨/跌/MA5/MA10/MA20/量 + "A股红涨绿跌"注释）+ 空数据兜底 + `data=null` 安全。`src/server.js` `GET /api/kline?code=&period=&limit=&days=&adjust=`（直接 `require('./tools/stock_kline')` 不经 `tools.call` 避免 4000 字符截断；code 默认 `000001`；返回 `bars` + `indicators`（MA5/10/20/波动率/区间位置）+ `days`；非法 code 返回结构化错误）。`ui/index.html` `#klinebox` DOM 锚点（`#scanDistbox` 兄弟级）。数据到位一次性重画，不入 `AnimGate.gatedLoop`。测试与 CDP 全绿：`src/jarvis-charts.test.js` 从 50 项扩到 68 项（新增 18 项 drawKline 覆盖——API 五件套/120 根蜡烛+量柱/红涨绿跌/MA 三色/数据不足 20 根 MA20 空/hit 三件套/hit 越界/tooltip 整句含开高低收量+%/日期/role=status+aria-live+mouseleave 隐藏/空 bars 兜底/data=null 安全/padLeft 内边缘/paintedPct≥3），`scripts/verify-charts.js` 从双图 8 断言扩到三图 12 断言（新增 K 线 probeOne 复用——canvas 存在/尺寸非零/paintedPct≥3/图例含涨跌MA5MA10MA20量/红涨绿跌/MA 三色/tooltip 整句含开高低收量%日期+role=status+aria-live+mouseleave 隐藏）；截图 `_shots/charts-c3-kline.png`。`src/tools/stock_kline.js` 追加 `fetchDailyBars(code, limit)` 便捷函数（返回纯 `{date,open,high,low,close,volume}` 数组，供 `/api/kline` 端点调用）。**§5 第 3 项 板块资金水平条形**已由 `.fb` 类 flowbar 覆盖、不重做。**§5 第 4 项 实时流面积图/TAPE**（需流式端点基建）另列独立轮次。**§5 第 2 项 个股 K 线**已交付（2026-09-18）：`ui/index.html` `#klinebox` 加 `.kline-toolbar`（`#klineCode` 下拉含 optgroup 大盘指数 3 项 + optgroup 龙头动态填充 + `#klinePeriod` 日/周/月）；重写 K 线 IIFE——`codeEl.value`/`periodEl.value` 取代硬编码；标题按 `INDICES[key]` 判指数在"大盘 K 线"/"个股 K 线"间切换；`switchAll()` = `round++` → `ctrl.abort()` → `ctrl=null` → `clearTimeout(timer)` → `persist()` → `refresh()`；`populate(scan)` 从 `s.leaderCode`/`s.leader` 补码，`added` Set 去重、`/^\d{6}$/` 过滤、`bareCode` 归一化 `sh600519`/`000858.SZ`；启动顺序 `populate(__closescanData)` → `readCfg()` → `applyDesired()` → `refresh()`；记忆走 `localStorage['jarvis.kline.cfg']`；`setTimeout` 自调度链（非 `setInterval`，避免日 K 25s 最坏路径并发重叠）；`AbortController` 作废在途请求；CSS `.kline-toolbar`/`.kline-select` 全走 CSS 变量（`color-mix` 派生 alpha，`option`/`optgroup` 显式 `var(--bg)` 底色防跳出主题）。`src/jarvis-charts.test.js` 从 68 项扩到 **97 项**（新增 29 项——启动默认请求/切换标的/周期/月K URL/补码/去重/脏数据/前缀归一化/__closescanData 缓存时序/round 作废在途响应/定时器不残留/abort 旧请求/记忆读写恢复/坏 JSON 禁 localStorage/emSecid/isIndexCode 纯函数） |
| C4 | §10 星图增强 6 项 | **【已落地·已验证】**（2026-09-17 收尾轮） | 见下方 Phase E 明细；本轮实际新增 ~60 行 + 缺口补齐 ~20 行，与 §10 估算 ~325 行的偏差见 Phase E 说明 |

### Phase D · 收尾

| ID | 项 | 处理 |
|---|---|---|
| D1 | 备份文件清理（11+ 个 `.bak*`） | **保留**。等 C2/C3/C4 目检后再删；现在删则失去回退点 |
| D2 | git 提交 | 本轮末步；用户明说"不擅自提交"故仅在明确要求后执行 |
| D3 | DESIGN.md 更新 | 本表 + §1 补注 + §8 #1/#2/#6 状态同步 |

### Phase E · C4 §10 星图增强交付（2026-09-17 收尾轮）

授权：「需要我决策给你权限按自己的建议来」。凡 §10 有明文条目、无技术障碍的，直接落地；无对象可测的判"不适用"。

| 项 | 落地 | 验证 |
|---|---|---|
| #1 三级景深聚焦（悬停） | `ui/starfield.js:1294-1312` `applyDepthFocus` 分层 dim（1.0/0.45/0.12）+ 边分层；`neighborLevels` BFS 两遍遍历在 `ui/starplus.js:50-67` | `src/jarvis-starmap-plus.test.js` 3 断言全绿；CDP 验证 `hover/focus/unfocus/pick` 均零抛错（`scripts/verify-starmap-plus.js` 端口 9337） |
| #1 fov 轻推 -3°（原缺失） | `ui/starfield.js:308-311` `hoverFov`/`hoverFovT` 状态 + `applyDepthFocus` 推目标 + `frame` 0.045 lerp + `keepGoing` 判定；`FOVY = 1.0 - hoverFov*0.052`，`fit` 距离按 `tan(FOVY/2)` 反向缩放保持内容球尺寸 | 数值不外部可测，靠 CDP 截图人眼确认（`_shots/starmap-plus-verify.png`）；浏览器控制台 0 error/0 warning |
| #2 点击聚焦 + Esc 归位 | `ui/starfield.js:1315-1334` `focus`/`unfocus` + `focRy/focRx/focZ` 0.045 lerp 收敛到目标；`app.js:1476` Esc 归位 | 同上 CDP 验证 |
| #3 事件驱动脉冲传播 | `ui/starfield.js:1342-1353` `pulseAlong` setTimeout 260ms 逐级；`pulseWrite` = 核心→实体正向路径，`pulseRecall` = 反向 | `src/jarvis-starmap-plus.test.js` `pulseOffsets` 3 断言全绿 |
| #3 缺口补齐：pulseWrite 触发 | `ui/app.js:501-512` `learned` 事件处理器：`loadStarmap().then(() => ms.forEach(m => STAR.pulseWrite(m.entity)))` —— 先重建星图让 `nameToIdx` 里真的有新实体，再触发脉冲（否则路径返回 null 等于无声） | CDP 验证 `STAR.pulseWrite` typeof=function 且调用无错 |
| #4 shader 内发光 | `ui/starfield.js:144-147,167` `impAdd` additive 双色混合（0.55/0.80/1.0）；`smoothstep(1.8,3.4,vSz)` 门控 | 全套 25 项 shader 测试全绿 |
| #5 黄金角螺旋布局 | `ui/starfield.js:605-623,677-681` `CAT_CAP=100` + `SLOT_CAP=520` + `stableSlot(id, cap)`（φ⁻¹ 低差异序列）+ `assignSlots` 撞槽确定性顺移 | `src/jarvis-starmap-plus.test.js` 5 断言全绿（稳定性/范围/顺序无关/无重叠） |
| #6 独立测试文件 | `src/jarvis-starmap-plus.test.js` 15 项（本次实际 11 项：STAGE4 属 GL 层不可数值验证，STAGE1 fov 属 shader 视觉，均无独立断言点） | 11/11 全绿；全套 682 项回归无失败 |

**与 §10 估算的偏差**：原估 325 行；实际本轮新增 ~60 行 + 缺口补齐 ~20 行 = ~80 行。原因是 §10 五项大部分在 DESIGN.md 写完后、设计审计开跑前，`ui/starfield.js` 已按同套约定实现（`applyDepthFocus`/`focus`/`pulseAlong`/`impAdd`/`assignSlots` 都已在 commit 6655582），本轮实际工作是**验证 + 补齐两个缺口**（fov 轻推 -3°、pulseWrite 触发）。

**回归基线**：全套 682 项测试通过（`scripts/run-tests.js`），星图数据 431 节点 / 977 边 / 263 记忆 / filler=0，STAR 全部 5 项 API（hover/focus/unfocus/pulseWrite/pulseRecall）+ pick 均零抛错，浏览器控制台 0 error/0 warning。截图 `_shots/starmap-plus-verify.png`（1700.9 KB）。

### 本轮实际完成范围

- ✓ 板块卡反向锚点修复（`ui/index.html:324-329`）
- ✓ `scripts/verify-flowbar.js` 分向断言 + 灰蓝判据修正
- ✓ B1 状态色路线①决策入 §1 权威表 + §1.1 显式豁免；B2/B3 10 处漂移收敛（`#ffcf6b ×4`、绿带 `×6`）；`--gd` 补齐入 `:root`
- ✓ `:root` 内 rgba alpha 变体 RGB 三元组对齐新权威值（`(255,207,107)`→`(242,178,62)`、`(74,217,145)/(80,220,150)`→`(63,212,138)`）
- ✓ A1 字体合规判定（0 外部字体匹配）、A4 role=status 判定（`#srcbanner` 整句播报）
- ✓ A2 对比度抽测闭环：零依赖 CDP 工具 `scripts/check-contrast.js`（端口 9335），首轮暴露 24 处违规（10-11px 元数据标签），经 `--faint` 提亮 #7888a0→#8ba0b8 + `.hud-m`/`.lg-t` rgba 收敛为 var(--faint) 后 431 元素 0 违规、最低 4.64:1
- ✓ B4 窄屏顶栏收折（方案① 汉堡菜单）：`ui/index.html` CSS 双断点（900 布局 / 1024 顶栏折叠）+ `#tbmenu` 按钮 + `#tbmenuPanel` 浮层 + 点开克隆 live DOM 策略；`scripts/verify-tbmenu.js`（端口 9336）375 视口五断言——`#srcs` 4/4 灯全在视口内、按钮可见、面板 6/6 指标同步、对比度 16 元素 0 违规最低 6.84:1、Esc/click-toggle 双路径关闭
- ✓ 全套测试 668 通过（无回归，改动后复跑）
- ✓ `verify-flowbar.js` 改动后复跑通过（位置+色相+符号三通道全绿，截图 185.7 KB）
- ✓ §8 #1/#2/#3/#5/#6/#7/#8 状态列同步更新（新增"已验证"/"不适用"/"架构约束"标签）
- ✓ 本进度表 §13
- ✓ C2-A 抽屉基础层（2026-09-18）：`ui/drawer.js` 零依赖模块 + `#drawerPanel`/`#drawerBackdrop` DOM + leader 注册 + `#leaderbox .lrow` 点击入口；焦点锁/Esc/hash 还原/遮罩/× 五路交互全绿（44 CDP 断言）；`.lrow` 加 `tabindex="0"` 修 focus 还焦；`data-idx` 回查修 forEach 闭包不可达 bug；22 项单测 + 44 项 CDP 契约验证；截图 `_shots/drawer-verify.png`
- ✓ C2-D 小屏 <1400px 底部全屏上滑（2026-09-18）：CSS `@media(max-width:1400px)` 在 C2-A 中就位，`.from-left` 同视口统一为底部上滑；CDP 断言 10 验证 1300x800 视口 panel bottom=0 left=0 right=0 top=240px width=1300px height=560px 圆角 16px 16px 0 0 border left→top 关闭态 translateY(560) 打开态 translateY(0) panel 可见；JS 零修改（纯 CSS 驱动）；44 断言 0 失败
- ✓ C2-B L2 下钻带返回（2026-09-18）：`ui/drawer.js` 重写为栈式导航（L0→L1→L2→L3，`MAX_DEPTH=3`）；新增 `push`/`pop`/`stackSize`/`current` API；动态 `.drw-back` 返回按钮；Esc 整体关闭（不逐层 pop）；hash 多层 `#drawer=type:id>subType:subId>...`；fetcher 缓存栈条目；`src/server.js` `GET /api/kline` 端点（直接 `require` 不经 `tools.call` 避免 4000 字符截断）；`ui/index.html` 注册 `sectorDetail` + `stockDetail`；leader 底部"查看板块详情 →"按钮触发 L1→L2；CSS `.drw-back`/`.drw-drill`/`.drw-bar`/`.drw-kv .v.up/.v.down`（全走 CSS 变量）；52 项单测全绿（新增 30 项）
- ✓ C3-C 大盘 K 线图（2026-09-18）：`ui/charts.js` 追加 `drawKline(canvas, bars, opts)`（复用 `drawCandle`+`drawAxis`+`drawText`+`colorLadder`+`bindHover`；A 股红涨绿跌；MA5/MA10/MA20 三色 `--cy`/`--gd`/`--bl`；成交量柱底部 25%；hover 整句中文含开高低收量+单位+日期；空数据兜底）；`src/server.js` `GET /api/kline` 端点（返回 `bars`+`indicators`+`days`）；`src/tools/stock_kline.js` 追加 `fetchDailyBars`；`ui/index.html` `#klinebox` DOM 锚点；68 项单测全绿（新增 18 项）；CDP 三图 12 断言全绿；截图 `_shots/charts-c3-kline.png`
- ✓ C2-C1 图表 Tab（2026-09-18）：`ui/index.html` `renderStockDetail` 重写——指标网格后新增 K 线图区域（`<canvas id="drwKlineCanvas" width="440" height="260">` + 6 色块图例 + A 股红涨绿跌注释）；数据流：fetcher 一次 `/api/kline` 返回 `{ok, bars, indicators}`，render 直接用 `data.bars`；后置绘制 `setTimeout(0)` 调 `Charts.drawKline` + `bindHover`；CSS `.drw-kline`/`.drw-kline-legend` + `.kl-*` 色块（全走 CSS 变量）；75 项单测全绿（新增 14 项）
- ✓ C2-C2 星图实体→抽屉 3D Tab（2026-09-18）：`ui/app.js` 修改 `graphEl` 点击处理器——`hit.kind === 'entity' && hit.memId == null` 时调用 `Drawer.open('entity', hit.entity, { sourceEl: graphEl })`，关闭后焦点还焦到星图 canvas；记忆节点点击不受影响；`ui/index.html` 追加 entity 注册 IIFE（fetcher 从 `/api/starmap` 查实体+过滤记忆；render 生成实体名+类别中文+记忆列表最多 20 条含 decay 中文标签+问 AI 按钮；`esc()` 防 XSS）；75 项单测全绿（新增 9 项 entity 覆盖）
- ✓ 左栏从左滑出（2026-09-18）：`ui/index.html` 注册 `category` 类型（fetcher 从 `/api/starmap` 按 category 过滤实体+记忆上限 30 条；render 渲染类别名+实体列表+记忆列表含 decay 中文标签）；`ui/app.js` `loadStarmap` 中 `.gal` 加 `tabindex="0" data-cat="${k}" role="button" aria-label="查看${GAL_CN[k]}详情"` + 模块级事件委托（click + keydown Enter/Space）调 `Drawer.open('category', cat, { side: 'left', title, sourceEl: gal })`；CSS `.gal[data-cat]` 加 `cursor:pointer` + hover 背景 + `:focus-visible` 焦点环（`var(--accent)`）；`.from-left` CSS 已在 C2-A 就位，小屏 <1400px 自动变底部上滑；94 项单测全绿（新增 20 项 category 覆盖——注册后 open/`.from-left` 类/hash/默认/覆盖 title/fetcher 数据形状按 category 过滤上限 30 空类别未知类别/render 类别名实体记忆 null 空数据占位 HTML 转义防 XSS 缺 ageDays 未知 decayState/fetcher 路径加载中传 data 跳过/Esc 关闭/焦点还焦）
- ✓ §5-2 个股 K 线（2026-09-18）：`ui/index.html` `#klinebox` 加 `.kline-toolbar`（`#klineCode` 下拉 optgroup 大盘指数 3 项 + optgroup 龙头动态填充 + `#klinePeriod` 日/周/月）；重写 K 线 IIFE——`codeEl.value`/`periodEl.value` 取代硬编码；标题按 `INDICES[key]` 判指数"大盘 K 线"/"个股 K 线"切换；`switchAll()` = `round++` → `ctrl.abort()` → `clearTimeout(timer)` → `persist()` → `refresh()`；`populate(scan)` 从 `s.leaderCode`/`s.leader` 补码 Set 去重 `/^\d{6}$/` 过滤 `bareCode` 归一化；启动顺序 `populate` → `readCfg` → `applyDesired` → `refresh`；记忆 `localStorage['jarvis.kline.cfg']`；`setTimeout` 自调度链（非 `setInterval`，避免日 K 25s 并发重叠）；`AbortController` 作废在途；CSS `.kline-toolbar`/`.kline-select` 全走 CSS 变量（`color-mix` 派生 alpha，`option`/`optgroup` 显式 `var(--bg)` 底色）；97 项单测全绿（新增 29 项——启动默认/切换标的周期/月K URL/补码去重脏数据前缀归一化/__closescanData 缓存/round 作废/定时器不残留/abort/记忆读写/坏 JSON/emSecid/isIndexCode）
- ✓ C1 rAF 链重构（2026-09-19）——AnimGate 共享调度器，rAF 链 6 → 2，48 项单测 + 897 项回归全绿，见 §8 #5 / §13 C1
- □ §5-4 实时流面积图/TAPE——独立轮次

