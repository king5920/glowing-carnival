# JARVIS

一个跑在本机的私人 AI 管家。有记忆、会主动开口、能自己找事做。

```
http://127.0.0.1:3800
```

不是聊天机器人套壳。它的区别在三点：

- **记得住** —— 对话里的事实自动抽取入库，按情绪与新鲜度分段衰减，会自然淡忘也会因重提而加固
- **闲不住** —— 五轴内在状态驱动，你久不说话它会自己去盯大盘、扫会话、翻出你忘掉的事
- **动得了** —— 24 个工具（行情 / 资金流 / 新闻 / 量化桥 / 笔记读写），边界由代码而非提示词保证

---

## 一条硬约束

**生产依赖只允许 `better-sqlite3` 一个。**

这条约束贯穿全项目，且真的守住了。它带来的直接后果：

| 需求 | 常规做法 | 本项目做法 |
|---|---|---|
| 飞书长连接 | `ws` 库 | 手写 WebSocket 帧编解码 |
| 语音合成 / 识别 | `edge-tts` / 云 API | PowerShell 调 Windows 内置 `System.Speech` |
| GBK 解码（腾讯行情） | `iconv-lite` | Node 原生 `TextDecoder('gbk')` |
| HTTP 客户端 | `axios` | `node:https` + 自建 Keep-Alive Agent |

`npm run check-env` 会在每次自检时验证这条约束。想加依赖前，先确认真的无法用 Node 原生能力替代。

---

## 跑起来

### 1. 环境要求

**Node ≥ 25.x（ABI 141）** —— 这不是洁癖，是硬要求。

`better-sqlite3` 是原生编译模块，与 Node 的 ABI 死绑。用错版本时报错长这样：

```
Error: The module 'better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 141. This version of Node.js
requires NODE_MODULE_VERSION 127.
```

它**看起来像代码 bug，实际是环境问题**。曾因此误判过 8 个"测试失败"。

要么用 Node 25.x，要么 `npm run rebuild` 就地重编。

### 2. 配置

```bash
cp .env.example .env                     # 填 ARK_API_KEY
cp .feishu.example.json .feishu.json     # 只用网页端可跳过
```

`.env` 两个易错点（都已实测确认）：

- 端点必须是 `/api/plan/v3`，写成 `/api/v3` 会 401
- 模型名是 `ark-code-latest`，不是 `doubao-*` 系列

### 3. 自检 → 启动

```bash
npm run check-env    # 8 项：Node ABI / 原生模块 / 依赖洁癖 / 配置 / 密钥未入库
npm start            # → http://127.0.0.1:3800
npm test             # 6 套测试，319 项
```

`check-env` 失败时会直接给出可执行的修法，不用去猜。

---

## 目录地图

```
src/
  server.js          HTTP + SSE 服务，23 个路由
  brain.js           唯一一条思考链（见下）
  llm.js             火山方舟 Agent Plan 接入

  ── 记忆 ──
  db.js              SQLite 存储层（FTS5 中文单字切分 + 合并留痕）
  memory.js          抽取与混合检索（分段衰减算法）

  ── 意识 ──
  jiwen.js           上游引擎，MIT，一字未改（便于合并上游修复）
  jarvis-persona.js  五轴语义重映射：管家 ≠ 恋爱陪伴
  mind.js            单例 + 持久化 + 60s 心跳 + SSE 广播
  patrol.js          主动意识触发时真正执行的后台任务

  ── 出口 ──
  feishu.js          飞书长连接（手写 WebSocket）
  voice.js           TTS + ASR（PowerShell 调 System.Speech）
  mic_ring.js        常驻音频环形缓冲
  whisper_sidecar.js faster-whisper 可选旁路（提升中文 STT 准确率）

  tools/             24 个工具 + registry 注册表
ui/                  星图 / 对话 / 取数三件套
scripts/             check-env（环境自检）· run-tests（测试总跑器）
sandbox/             贾维斯的写入区（边界由代码保证，不入库）
_mockup/             形象设计稿源码（PNG 大图不入库）
STATUS.md            Phase 0-18 开发全记录 —— 本项目最高价值文件
```

### 思考链只有一条

`brain.js` 是刻意抽出来的。原因：网页和飞书两个入口如果各写一份思考流程，
逻辑必然漂移 —— 改了网页忘了飞书。

```
用户输入
  → 检索记忆
  → 组装上下文（含五轴状态注入的语气提示）
  → 工具调用循环（最多 5 轮）
  → 抽取新记忆
  → 回复
```

出口差异用 `onEvent` 回调解耦，两个入口共用同一条链。

---

## 工具清单（24 个）

| 类别 | 工具 |
|---|---|
| 行情 | `get_stock_quote` `get_stock_kline` `get_market_overview` `get_fund_flow` |
| 资讯 | `get_market_news` `get_stock_news` |
| 量化 | `quant_capabilities` `run_quant_command` `read_quant_report` |
| 沙箱 | `sandbox_list` `read` `write` `append` `delete` |
| 笔记 | `obsidian_overview` `list` `read` `write_note` `append` `write_weekly_to_obsidian` |
| 运维 | `check_source_health` `diagnose_source` `tidy_memory` `generate_weekly_report` |

**数据源策略**：腾讯 `qt.gtimg.cn` 为主源（实测 10/10 成功），东财为备用。
东财 `push2` 曾被按 IP 时间窗封禁，`socket hang up` 看着像限流实际是 TCP 层拉黑 ——
解药是切 `push2delay` 镜像域名，不是加更多限流。

**沙箱边界由代码保证**，三道防线（路径归一化 + 符号链接实地校验 + 配额），
15 种攻击手法全部拦截。故意不提供删目录、重命名到沙箱外、执行命令。

---

## 主要接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/chat` | 对话主入口 |
| GET | `/api/history` `/api/search` | 历史与检索 |
| GET | `/api/starmap` `/api/memory/:id` `/api/merges` | 记忆星图与合并留痕 |
| GET | `/api/mind` `/api/mind/state` | 五轴状态（SSE） |
| GET/POST | `/api/patrol` `/api/patrol/run` | 巡视状态 / 立即执行 |
| GET | `/api/health/sources` `/api/health/diagnose` | 数据源健康灯 |
| GET | `/api/voice/probe` `speak` `listen` `stt` | 语音能力 |
| POST | `/api/voice/mic` | 开关麦克风 |
| GET | `/api/status` | 服务总览 |

---

## 已知限制（不隐瞒）

**语音链路当前不可用。** 根因在硬件驱动层，代码侧已无解：

华为 `HWVE` / `HiVA` / `Hain` 三层音频特效 APO 插在麦克风采集链上，吞掉了所有输入。
实测只有 22050Hz 采样率能通过数据（且是真静音），其他采样率全返回满幅垃圾（`peak=32641`）。
控制该行为的注册表键归 SYSTEM 所有，管理员权限也改不了。

**需要你手动操作**：设置 → 系统 → 声音 → 麦克风属性 → 关闭"音频增强"。

其余遗留见 `STATUS.md` 顶部。

---

## 关于 STATUS.md

2600+ 行，倒序记录 Phase 0-18。它不是 changelog，而是**实测数据库**。

里面有三类内容在别处找不到：

1. **自我推翻** —— Phase 18 开头直接写"Phase 16 我说的结论因果搞反了"
2. **实测数据反直觉** —— 以为 VAD 太慢想调快，实测发现是太快，把中文停顿切断了
3. **测试设计教训** —— 断言 `alt === null` 把合法的镜像域名也禁了，测试该锁意图不锁值

一条反复出现的原则：**假的可用比明确不可用更危险**。
假备用源、假健康绿灯、被吞掉的异常、静默截断的周报，都是同一类病。

改动前先读相关 Phase，能省掉重踩一遍坑的时间。

---

## 致谢

- [jiwen](https://github.com/) —— 主动意识引擎，MIT，`src/jiwen.js` 原样引入
- MemoryConstellations —— 记忆衰减算法思路，MIT，本项目自行实现
