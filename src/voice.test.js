'use strict';
/**
 * 语音链路校验（离线，不碰麦克风）
 *
 * 为什么要有这个文件：
 * 语音是本项目最容易「假装可用」的一环，已经踩过三次：
 *   ① MCI 返回满幅假数据 → 推出两个完全错误的结论
 *   ② faster-whisper 没装 → 静默回落 System.Speech，conf 0.002 当成"能用"
 *   ③ 模型下载中断留 0 字节 model.bin → 报"已缓存"然后加载时炸
 * 三次的共同点：**链路每一环都"有响应"，只是响应是假的。**
 *
 * 所以这套测试盯的不是"功能跑通"，而是**假可用的入口是否被堵住**：
 * 默认档位是不是实测过的、清洗规则会不会吃掉真实内容、
 * 损坏缓存会不会被当成就绪。
 *
 * 不依赖麦克风、不依赖 Python、不联网 —— 纯静态与纯函数校验，
 * 这样它才能进 CI 每次都跑。
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
const A = (c, m) => { if (!c) throw new Error(m); };

/* ══ 只取「可执行代码」行，剥掉注释 ══
 *
 * 为什么必须有这个：静态扫描规则连注释一起扫会报假失败，
 * 已经踩过两次 ——
 *   ① 查"是否写死 500MB"，扫到注释里陈述事实的「small 约 500MB」
 *   ② 查"是否靠中文报错文本判断"，扫到注释里引用的「另一个进程正在使用该文件」
 * 两次都是**注释在解释为什么不该那么写，反而被判成犯了那个错**。
 *
 * 注释里出现某个字符串通常是在记录教训，是有价值的信息；
 * 只有出现在可执行代码里才是 bug。测试自己也会说谎，得防。 */
function codeOnly(src) {
  return src.split('\n')
    .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
}

const whisper = require('./whisper_sidecar.js');
const rec = require('./mic_record.js');
const REC_SRC = fs.readFileSync(path.join(__dirname, 'mic_record.js'), 'utf8');
const WH_SRC = fs.readFileSync(path.join(__dirname, 'whisper_sidecar.js'), 'utf8');

console.log('\n─────── 语音链路 ───────\n');

/* ══════════════ 一、转写结果清洗 ══════════════
 *
 * 清洗是**会改动用户内容**的操作，风险不对称：
 * 漏掉一个垃圾字符只是难看，吃掉一个真实字词会让指令解析错。
 * 所以正例（该删）和反例（不许动）都必须锁死。 */

const C = s => whisper.cleanTranscript(s).text;

test('清洗：删掉短音频末尾的幻觉字符（实测 100% 复现）', () => {
  /* base 模型对极短音频稳定吐幻觉尾巴，实测 4/4 次完全一致：
   *   "截图" → "截图Ｇ跌"（conf 0.641，明显低于正常 0.89+） */
  A(C('截图Ｇ跌') === '截图', '"截图Ｇ跌" 应清成 "截图"，得到 ' + C('截图Ｇ跌'));
  A(C('搜索一下今天的新闻\uFFFD') === '搜索一下今天的新闻',
    'U+FFFD 替换字符必须删除');
});

test('清洗：尾部标点规范化，但保留语气标点', () => {
  A(C('播放音乐；。') === '播放音乐。', '标点堆叠应收成一个句号');
  A(C('截图；') === '截图。', '句尾分号在中文无意义，应换成句号');
  A(C('查一下上证指数：') === '查一下上证指数。', '句尾冒号应换成句号');
  /* ？和！携带语气信息，进指令解析时有用 —— 删了是信息损失 */
  A(C('现在几点了？') === '现在几点了？', '问号必须保留（疑问语气是有效信号）');
  A(C('真的吗！') === '真的吗！', '感叹号必须保留');
});

test('清洗：绝不误伤真实内容里的英文缩写', () => {
  /* 幻觉尾巴规则只吃**全角**字母，因为真实内容里的
   * A股 / ETF / GDP 都是半角。规则若放宽到半角，
   * "帮我看一下A股" 会被削成 "帮我看一下" —— 比不清洗糟得多。 */
  A(C('帮我看一下A股') === '帮我看一下A股', 'A股 被误删了');
  A(C('看一下ETF持仓') === '看一下ETF持仓', 'ETF 被误删了');
  A(C('看一下沪深300的涨跌。') === '看一下沪深300的涨跌。', '数字内容被改动了');
});

test('清洗：只剩标点视为空（不能返回一个句号当识别结果）', () => {
  A(C('。。。') === '', '纯标点应视为空识别');
  A(C('；') === '', '孤立标点应视为空识别');
  A(C('') === '', '空输入应返回空');
});

test('清洗：改动过就要留 raw，让人能查是不是清错了', () => {
  /* 清洗是黑盒操作。如果不暴露原文，出问题时无法判断
   * 是"模型识别错"还是"清洗吃错了" —— 排查方向会跑偏。 */
  A(/raw:\s*cleaned\.changed/.test(WH_SRC),
    'transcribe 返回值应在清洗改动内容时附带 raw 原文');
});

/* ══════════════ 二、模型档位与「假可用」守卫 ══════════════ */

test('默认档位是 base（实测的甜点，不是拍脑袋的 small）', () => {
  /* 实测（20 核 CPU / int8 / beam=1 / 中位数）：
   *   tiny  0.3-0.7s  但听错专有名词（"假维斯"/"确然正常"）→ 不可用
   *   base  1.0-1.2s  全对                                → 甜点
   *   small 3.2-5.0s  全对，慢 4.5 倍                      → 过度付费
   * 曾默认 small 且注释声称"实时率 0.3-0.5x"，那是推测值。 */
  A(whisper.MODEL_SIZE === 'base',
    '默认档位应为 base，当前为 ' + whisper.MODEL_SIZE);
});

test('模型体积表覆盖所有可选档位（别再报错的下载预期）', () => {
  /* 旧代码写死"small=500MB，其它=1.5GB"，
   * 选 base 时会告诉用户要下 1.5GB —— 145MB 的东西。 */
  for (const k of ['tiny', 'base', 'small']) {
    A(typeof whisper.MODEL_MB[k] === 'number', k + ' 档缺少体积信息');
  }
  A(whisper.MODEL_MB.base < whisper.MODEL_MB.small, '体积表数值关系不对');
  /* 只查**可执行代码**里的写死体积，不查注释 ——
   * 注释里写"small 约 500MB"是在陈述事实，是有价值的信息；
   * 模板字符串里写死才是 bug。第一版规则连注释一起扫，
   * 报了个假失败 —— 测试自己也会说谎。 */
  A(!/(500MB|1\.5GB)/.test(codeOnly(WH_SRC)),
    '可执行代码中仍有写死的模型体积，应改用 MODEL_MB[MODEL_SIZE]');
});

test('0 字节 model.bin 不能被当成「已就绪」', () => {
  /* 实测两种下载失败都留 0 字节 model.bin：
   *   Xet CAS 401 / 沙箱拦截落盘（SHFileOperationW 0x2）
   * 只判断目录或文件存在 → 报"已缓存" → 加载时炸。
   * 这正是「假的可用比明确不可用更危险」。 */
  A(/size\s*<\s*1024\s*\*\s*1024/.test(WH_SRC),
    '模型就绪判断必须校验 model.bin 大小，不能只看文件存在');
  A(/modelBroken/.test(WH_SRC), '应能识别并报告损坏的缓存');
});

test('HF 缓存目录名必须精确匹配，不能用 includes', () => {
  /* includes('whisper-base') 会误命中 whisper-base.en，
   * 于是拿英文模型跑中文识别 —— 又一个"看起来能用"。 */
  A(!/includes\(`whisper-\$\{MODEL_SIZE\}`\)/.test(WH_SRC),
    '仍在用 includes 匹配模型目录名，会误命中 .en 变体');
  A(/models--Systran--faster-whisper-\$\{MODEL_SIZE\}/.test(WH_SRC),
    '应使用完整仓库目录名精确匹配');
});

test('必须禁用 Xet 传输（镜像站不支持，会 401）', () => {
  /* hf-mirror 不支持 Xet CAS 协议，实测返回
   * 401 Unauthorized 且留下 0 字节文件。 */
  A(/HF_HUB_DISABLE_XET/.test(WH_SRC),
    'worker 环境变量应设 HF_HUB_DISABLE_XET=1');
});

test('提示词必须同时覆盖操作类与行情类词汇', () => {
  /* 提示词是**先验分布**不是词表。只给股票词，
   * 操作命令会被带偏 —— 实测"打开浏览器"→"打开流软器"。
   * 补入操作词后 logprob 从 -0.317 升到 -0.092。 */
  const p = whisper.INITIAL_PROMPT;
  A(/浏览器/.test(p), '提示词缺操作类词汇，"浏览器"会被听成"流软器"');
  A(/截图|播放/.test(p), '提示词应含常用操作动词');
  A(/沪深|上证/.test(p), '提示词缺具体指数名，"沪深"会被听成"互生"');
  A(/贾维斯/.test(p), '提示词必须含唤醒词，否则听成"假为师"');
  /* 224 token 预算，中文约 1 字 1 token，留足音频上下文空间 */
  A(p.length < 180, '提示词过长（' + p.length + ' 字），会挤占音频上下文预算');
});

test('本地模型目录兜底存在（hub 下载在部分环境必失败）', () => {
  A(typeof whisper.localModelPath === 'function', '应提供 localModelPath');
  A(typeof whisper.LOCAL_MODEL_DIR === 'string', '应暴露本地模型目录常量');
  /* 本地路径要真的传进 WhisperModel，而不是只做个探测摆设。
   * 多档位后按 size 取本地目录：localModelPath(size) || size。 */
  A(/localModelPath\(size\)\s*\|\|\s*size/.test(WH_SRC)
    || /localModelPath\(\)\s*\|\|\s*MODEL_SIZE/.test(WH_SRC),
    '本地模型路径应优先传给 WhisperModel，否则兜底无效');
});

test('新增失败模式都有人话解释（报错难懂等于没报错）', () => {
  for (const [pat, why] of [
    ['model\\.bin is incomplete', '损坏缓存'],
    ['xethub|CAS Client Error', 'Xet 401'],
    ['SHFileOperationW', '写入被拒'],
  ]) {
    A(new RegExp(pat).test(WH_SRC), '缺少「' + why + '」的错误翻译');
  }
});

/* ══════════════ 三、录音端设备层 ══════════════ */

test('必须用 waveIn，绝不能出现 MCI 录音调用', () => {
  /* 这是本项目最贵的一课：同一时刻同一麦克风
   *   MCI    → peak=32641（满幅，看着信号很强）
   *   waveIn → peak=1（真实静音）
   * 基于 MCI 读数推出过"麦克风输出削波垃圾"和
   * "华为 APO 吞音频"两个完全错误的结论。 */
  A(/waveInOpen/.test(REC_SRC), '录音必须走 waveInOpen');
  A(!/mciSendString\s*\(/.test(REC_SRC), '出现了 MCI 录音调用，它在本机返回假数据');
});

test('设备层四件套都已导出（能列、能探、能选、能清缓存）', () => {
  for (const f of ['listDevices', 'probeDevice', 'pickBestDevice', 'resetDeviceCache']) {
    A(typeof rec[f] === 'function', '缺少导出：' + f);
  }
});

test('设备号不再写死 WAVE_MAPPER', () => {
  /* 原本 devId 硬编码 0xFFFFFFFF，等于"永远用系统默认输入"，
   * 有多个麦克风时无法选到干净的那个，也无法排查是哪个设备的问题。 */
  A(/if\s*\(dev\s*>=\s*0\)\s*devId\s*=/.test(REC_SRC),
    'Rec() 应支持显式设备号，而非固定 WAVE_MAPPER');
});

test('设备解析三种语义都成立：auto / default / 显式编号', () => {
  /* default 必须映射到 -1（WAVE_MAPPER）而不是设备 0 ——
   * 这两个在多设备机器上是不同的东西。 */
  A(rec.resolveDevice('default').index === -1, 'default 应解析为 WAVE_MAPPER(-1)');
  A(rec.resolveDevice(1).index === 1, '显式编号应原样传递');
  A(typeof rec.resolveDevice('auto').index === 'number', 'auto 应返回一个设备号');
});

test('探测结果带健康分级，不只给一个裸数字', () => {
  /* 只报 peak 没用 —— 32641 可能是满幅削波（坏），
   * 也可能是正常大声说话（好）。必须结合 clip/zero 比例分级，
   * 否则调用方还是要自己猜数字含义。 */
  A(/health/.test(REC_SRC), '探测结果应含 health 分级字段');
  for (const h of ['dead', 'clip', 'quiet']) {
    A(new RegExp("'" + h + "'").test(REC_SRC), '缺少 health 分级：' + h);
  }
});

test('设备名解码走 GBK，不能直接当 UTF-8 读', () => {
  /* waveInGetDevCapsA 返回 ANSI 字符串，
   * 中文设备名（"本机麦克风"）按 UTF-8 解会变乱码。
   * 用内置 TextDecoder('gbk') 解决，不引依赖。 */
  A(/TextDecoder\(['"]gbk['"]\)/.test(REC_SRC), '设备名应用 GBK 解码');
});

test('语音起始阈值按底噪自适应，不写死', () => {
  /* 写死 500 的后果：华为 USB 耳机底噪 rms 只有 7~15，
   * 说话峰值 186~429 全部低于 500 → sawSpeech=false → 音频被丢弃。
   * 而这个失败**长得像麦克风坏了**（录音成功、有 peak、判定静音），
   * 排查会跑到驱动/APO 上去 —— Phase 18 就是这么误判的。 */
  A(typeof rec.autoThreshold === 'function', '应提供 autoThreshold');
  A(rec.autoThreshold({ rms: 15 }) === 120, '低底噪设备阈值应按 rms×8 计算');
  A(!/threshold\s*=\s*Math\.max\(Number\(opts\.threshold\)\s*\|\|\s*500/.test(REC_SRC),
    '阈值仍写死 500，低增益麦克风会永远判定为静音');
});

test('阈值有上下限保护（探测期间说话会高估底噪）', () => {
  /* 下限：极静环境 rms≈2，×8=16，风扇声都能触发误录 */
  A(rec.autoThreshold({ rms: 2 }) === 60, '阈值下限应为 60');
  /* 上限：实测探测到 rms=776（正好在说话），×8=6208 比说话峰值还高，
   * 结果永远判定静音 —— 自适应把自己坑了，必须夹住。 */
  A(rec.autoThreshold({ rms: 776 }) === 1200, '阈值上限应为 1200，防止自伤');
  /* 未探测的设备（default / 显式编号）要有折中默认值，不能是 NaN */
  A(rec.autoThreshold({}) === 200, '无底噪信息时应返回折中值 200');
  A(rec.autoThreshold(null) === 200, 'null 入参不能崩');
});

test('录音结果回报实际阈值（否则无法诊断静音误判）', () => {
  /* 只报 sawSpeech=false 而不报用了什么阈值，
   * 用户无法判断是"真没说话"还是"阈值设太高"。 */
  A(/threshold,/.test(REC_SRC), '录音返回值应包含实际使用的 threshold');
});

/* ══════════════ 五、采集子进程生命周期 ══════════════
 *
 * 这一组盯的是 2026-09-09 实测出的连环故障：
 *   stop() 发射后不管 → 调用方一 exit 就留下孤儿
 *   → 孤儿持有 ringmic.exe 文件锁
 *   → 下次 ensureExe() 重编译报 CS0016
 *   → 语音功能凭空失效，重启客户端也没用（exe 在临时目录，锁还在）
 *
 * 这类故障最恶劣的地方是**上一次运行的残留把这一次堵死**，
 * 而报错信息（GBK 乱码的 CS0016）完全指不到真正原因。 */

const ring = require('./mic_ring.js');
const RING_SRC = fs.readFileSync(path.join(__dirname, 'mic_ring.js'), 'utf8');
const VOICE_SRC = fs.readFileSync(path.join(__dirname, 'voice.js'), 'utf8');

test('stop() 返回 Promise（调用方必须能等到子进程真死）', () => {
  /* 老版本是同步返回 + setTimeout 兜底 kill。
   * 调用方紧接着 process.exit() 时 timer 永不触发 → 孤儿。 */
  A(/stop\(\)\s*\{[\s\S]{0,400}?return new Promise/.test(RING_SRC),
    'RingBuffer.stop() 必须返回 Promise，否则无法保证子进程已退出');
  A(!/setTimeout\(\(\)\s*=>\s*\{\s*try\s*\{\s*p\.kill\(\)/.test(RING_SRC)
    || /STOP_GRACE_MS/.test(RING_SRC),
    'kill 的延时必须是命名常量，便于说明为什么是这个值');
});

test('stop() 有硬超时兜底（绝不把调用方吊死）', () => {
  A(typeof ring.STOP_GRACE_MS === 'number' && ring.STOP_GRACE_MS > 0,
    '应导出优雅退出等待时长');
  A(typeof ring.STOP_HARD_MS === 'number'
    && ring.STOP_HARD_MS > ring.STOP_GRACE_MS,
    '硬超时必须大于优雅超时，否则强杀还没执行就 resolve 了');
  /* 关掉 stdin 也要做 —— C# 侧靠 Console.In.ReadLine() 感知退出，
   * 只写 quit 不关流，管道异常时它会一直阻塞。 */
  A(/stdin\.end\(\)/.test(RING_SRC), '应同时关闭 stdin（EOF 也能触发子进程退出）');
});

test('编译失败能从孤儿锁定中自愈（CS0016）', () => {
  /* 只报错不自愈的话，用户唯一的出路是手动开任务管理器杀进程 ——
   * 而他根本不知道有个叫 ringmic.exe 的东西。 */
  A(typeof ring.killOrphans === 'function', '应提供 killOrphans');
  A(/CS0016/.test(RING_SRC), '应识别 CS0016（输出文件被占用）这个具体错误码');
  A(/killOrphans\(\)/.test(RING_SRC), 'CS0016 时应尝试清理残留进程后重编译');
  /* 匹配错误码而非中文文本 —— csc 的中文报错是 GBK，
   * 用 utf8 解码后全是乱码，中文关键词一律匹配不到。
   * 注意只扫可执行代码：注释里引用那句中文是在解释为什么不能用它。 */
  A(!/另一个进程正在使用/.test(codeOnly(RING_SRC)),
    '不能靠匹配中文报错文本（csc 输出是 GBK，解码后乱码）');
});

test('killOrphans 不主动乱杀（只在编译失败时兜底）', () => {
  /* 平时就杀 ringmic.exe 会干掉正在正常服务的采集实例。 */
  const calls = (RING_SRC.match(/killOrphans\(\)/g) || []).length;
  A(calls <= 2, 'killOrphans 调用点过多，可能会误杀正常服务的采集进程');
});

test('监听器 stop 先等子进程退出，再清理临时文件', () => {
  /* 老代码同步 stop() 后立刻 cleanup(0)，
   * 此时子进程还活着、还可能在写 WAV。 */
  A(/async stop\(\)/.test(VOICE_SRC), 'Listener.stop() 应为 async');
  const m = /async stop\(\)[\s\S]{0,700}?\n  \}/.exec(VOICE_SRC);
  A(m, '找不到 Listener.stop() 实现');
  const body = m[0];
  A(body.indexOf('await r.stop()') >= 0, '应 await 环形缓冲停止');
  A(body.indexOf('await r.stop()') < body.indexOf('cleanup('),
    '清理临时文件必须排在子进程确实退出之后');
});

test('server 侧调用 async stop 时挂了 catch（否则未处理 rejection 打挂进程）', () => {
  const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const m = /listener\s*&&\s*this\.listener\.stop\(\)[\s\S]{0,240}/.exec(SRV);
  A(m, '找不到 server 侧的 stop 调用');
  A(/\.catch\(/.test(m[0]), 'async stop 的 Promise 必须 catch');
});

/* ══════════════ 六、电平判据（识别返回空的唯一可定位证据） ══════════════
 *
 * 2026-09-09 实测的一次连环误判：
 * 麦克风采到 peak=2924、VAD 报「检测到语音」，whisper 稳定返回空。
 * 依次错查了三个方向：
 *   × 数字增益放大 20 倍 → 依然空（放大不改变信噪比，增益不创造信息）
 *   × 关掉 VAD          → 依然空
 *   × 怀疑模型损坏      → 同模型识别 TTS 文件 conf 0.93 完全正常
 * 真因只有 rms 看得出来：
 *   TTS 直录 rms=2301 (-23 dBFS) ✓   麦克风 rms=51 (-56 dBFS) ✗
 * peak 反映瞬时最大值（一次咳嗽就能拉高），rms 才是模型实际听到的能量。 */

const CHECK_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'voice-check.js'), 'utf8');

test('验收脚本报告 rms dBFS，而不是只报 peak', () => {
  A(/dbfs/i.test(CHECK_SRC), '必须计算并输出 rms dBFS');
  A(/20 \* Math\.log10/.test(CHECK_SRC), '应按 20·log10(rms/32767) 换算 dBFS');
  A(/DBFS_WEAK/.test(CHECK_SRC), '应有明确的电平过低判据阈值');
});

test('电平过低时明确指向采集端，并否掉"数字放大"这条错路', () => {
  /* 不写清楚的话，下一次（包括我自己）还会去放大音频、去查模型。 */
  A(/信噪比/.test(CHECK_SRC), '应说明数字放大无效的原因（信噪比不变）');
  A(/不是模型问题/.test(CHECK_SRC), '应明确排除模型方向，避免重复误查');
});

test('识别为空时给出分支诊断（电平不足 vs VAD 吞短音）', () => {
  A(/if \(!tr\.text\)/.test(CHECK_SRC), '应对空结果单独给出诊断');
  A(/vad:false|vad: false/.test(CHECK_SRC),
    '电平正常却为空时应提示短音频要关 VAD');
});

/* ══════════════ 七、edge-tts 降级链与播放路由 ══════════════
 *
 * 2026-09-10 落地多女声：edge-tts 神经语音为主，SAPI Huihui 兜底。
 * 这一节盯的是「降级链真的存在」和「每个引擎都带能区分的标记」——
 * 两个引擎返回同样结构（file/bytes/ms/engine/mime），
 * 只有 engine/mime 不一样。没有这些标记，播放端会把 mp3 当 wav 发。
 *
 * server 侧只做静态扫描：真起服务做集成测试会占端口、碰麦克风，
 * 不适合进 CI；路由参数的非空性已由 npm start 冒烟脚本验证。 */

test('降级链：edge-tts 是主引擎，失败必须自动落 SAPI', () => {
  A(/await ttsEdge\.synthesize/.test(VOICE_SRC), '主引擎必须调用 ttsEdge.synthesize');
  A(/catch \(e\)\s*\{/.test(VOICE_SRC), '主引擎失败必须有 catch');
  A(/sapiSynthesize\(rate, spoken, key\)/.test(VOICE_SRC),
    'catch 里必须落回 SAPI 兜底，否则断网时就是一声不吭');
});

test('降级链：两个引擎的产物标记必须可区分（engine/mime）', () => {
  A(/engine:\s*'edge-tts'/.test(VOICE_SRC), 'edge 路径缺 engine 标记');
  A(/mime:\s*'audio\/mpeg'/.test(VOICE_SRC), 'edge 路径缺 mime（播放端靠它选类型）');
  A(/engine:\s*'sapi'/.test(VOICE_SRC), 'SAPI 路径缺 engine 标记');
  A(/mime:\s*'audio\/wav'/.test(VOICE_SRC), 'SAPI 路径缺 mime');
});

test('降级链：缓存 key 必须含音色（换声音不能串音）', () => {
  /* 缓存 key 是 `${rate}:${vId}:${spoken}`。如果不含音色，
   * 切到晓伊后读到的是晓晓的缓存音频 —— "换声音"就变成了假切换。 */
  const m = /\$\{rate\}:\$\{vId\}:\$\{spoken\}/.test(VOICE_SRC);
  A(m, '缓存 key 应为 rate:vId:spoken 三段式');
});

test('降级链：音色参数每次合成都归一化，不能信任调用方', () => {
  A(/ttsEdge\.normalizeVoice\(voice\)\s*\|\|\s*currentVoice/.test(VOICE_SRC),
    '合成时应先归一化 voice 参数，非法值落回当前音色');
});

test('播放路由：/api/voice/speak 转发 voice 参数并自适应 MIME', () => {
  const SRV = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  A(/const voiceId = q\.get\('voice'\)/.test(SRV), '路由应读取 voice 查询参数');
  A(/voice\.synthesize\(text, rate, voiceId\)/.test(SRV),
    '路由应把 voiceId 传给 synthesize');
  A(/r\.mime \|\| 'audio\/wav'/.test(SRV),
    'Content-Type 应按引擎 mime 自适应（mp3 发 mpeg 头）');
  A(/X-TTS-Engine/.test(SRV),
    '响应头应带 X-TTS-Engine，便于前端/调试区分引擎');
});

test('窄带救命通道：窗口内低置信指令也要 whisper 复核（修"能唤醒却下不了令"）', () => {
  /* 2026-09-11 真机 bug：网页点麦能被唤醒（唤醒词走 whisper 救活），
   * 但接着说指令永远"没听清"——因为 whisper 兜底只在 !inConvo() 触发。
   * 锁死：低置信分支必须按 inConvo() 分流到 command/wake 两条复核。 */
  const code = codeOnly(VOICE_SRC);
  A(/_tryWhisperCommand\s*\(/.test(code), '缺少窗口内指令复核 _tryWhisperCommand');
  const branch = /if\s*\(this\.inConvo\(\)\)\s*\{[\s\S]*?_tryWhisperCommand[\s\S]*?\}\s*else\s*\{[\s\S]*?_tryWhisperWake/.exec(code);
  A(!!branch, '低置信分支必须按 inConvo() 分流到 command / wake 复核');
});

/* ══════════════ 数字 / 符号口语化 ══════════════
 *
 * 真机 bug（2026-09-22）：用户报「不会报小数点或百分数，播报数字很多错误」。
 * 根因 cleanForSpeech 原不处理数字符号。这里用金融播报高频句式锁死转换结果。
 * 锁的是"读法意图"（符号必须变中文、数字不丢位），不是逐字全文。
 */
const voiceMod = require('./voice.js');
const N = s => voiceMod.numbersForSpeech(s);

test('百分数：4.37% / 全角％ / 负百分号', () => {
  A(N('4.37%') === '百分之4点37', N('4.37%'));
  A(N('涨幅 12.5％') === '涨幅 百分之12点5', N('涨幅 12.5％'));
  A(N('-3.5%') === '负百分之3点5', N('-3.5%'));
});

test('小数点：仅"数字.数字"转点，不吃句末英文句点', () => {
  A(N('36.5') === '36点5', N('36.5'));
  A(N('Done. 1.5 done.') === 'Done. 1点5 done.', N('Done. 1.5 done.'));
});

test('千分位逗号剥离', () => {
  A(N('1,234,567') === '1234567', N('1,234,567'));
  A(N('1,234.5') === '1234点5', N('1,234.5'));
});

test('日期与时间先于正负号处理', () => {
  A(N('2026-09-12') === '2026年9月12日', N('2026-09-12'));
  A(N('14:30') === '14点30分', N('14:30'));
  A(N('09:05:30') === '9点05分30秒', N('09:05:30'));
});

test('货币 / 温度 / 区间', () => {
  A(N('¥13.5') === '13点5元', N('¥13.5'));
  A(N('$1,200') === '1200美元', N('$1,200'));
  A(N('36.5℃') === '36点5摄氏度', N('36.5℃'));
  A(N('10~20') === '10至20', N('10~20'));
});

test('正负号不误伤普通范围横线', () => {
  A(N('-15') === '负15', N('-15'));
  A(N('1-5名') === '1-5名', N('1-5名'));   // 横线两侧非"句首+数字"，保持
  A(N('涨幅-3.5%') === '涨幅负百分之3点5', N('涨幅-3.5%'));  // 中文后负号也要转
});

test('cleanForSpeech 端到端：符号中文化但中文与数字不丢', () => {
  const out = voiceMod.cleanForSpeech('茅台涨 **4.37%**，成交 1,234.5万元，温度 36.5℃');
  A(out.includes('百分之4点37'), out);
  A(out.includes('1234点5万元'), out);
  A(out.includes('36点5摄氏度'), out);
  A(out.includes('茅台涨'), out);
});

console.log('\n───────────────────────────────────');
console.log('  通过: ' + pass + '  |  失败: ' + fail);
console.log('───────────────────────────────────\n');
process.exit(fail ? 1 : 0);
