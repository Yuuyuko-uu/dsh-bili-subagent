/**
 * dsh-bili-subagent —— host 半端
 * ============================================================================
 * 它是什么：每天替你刷一轮 B站 的插件版。
 *   1. **插件内部起那份 Python MCP**（`vendor/bilibili-mcp/mcp_server.py`），把它的能力
 *      注册成 dsh 工具（搜 / 字幕 / 评论 / 发评论 @ 人 / 登录检查）—— 用户不用再手改 profile。
 *   2. **谷时定时器**：中午 12:00–14:00、夜间 00:30–08:30（`lib/state.mjs` 里的 `WINDOWS`），
 *      开了哪个窗口才在哪个窗口自动跑；「定量刷」的数字是**每天总量上限**。
 *   3. **跑一轮** = 起一个 `dsh --profile headless <prompt>`（跟老方案同一条路，已被验证过），
 *      把 `duty.md` 交给它，报告写进 `<家>/out/<日期>.md`。
 *   4. **设置页**（`client.js`）通过 `/api/bili-duty/*` 读写配置、看状态、扫码登录。
 *
 * 家里（`$DSH_HOME/bili-duty/`）都有什么：`config.json` / `mcp_server.py`（从 vendor 铺过来，
 * 这样凭证 `bili_credential.json` 落在家里而不是插件包里）/ `duty.md` / `out/` / `duty.log`。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因（2026-10-16 用户递来的完整报告 + 本机复现）：它们是 optional peer，
//    桌面版 profile 是 `autoInstallPeers: false` ⇒ 永远不装 ⇒ **裸 import 会让整条插件不激活** ✗。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { McpClient } from './lib/mcp.mjs'
import { verifyRecent, appendVerifyToReport } from './lib/verify.mjs'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, inWindow, inValley, dayKey } from './lib/state.mjs'
import { loginStart, loginPoll, saveCredential, renderQrPng } from './lib/login.mjs'
import { ensureUv } from './lib/uvfetch.mjs'
import { restorePythonPath, venvPythonPath } from './lib/platform-runtime.mjs'
import { createSelfUpdate } from './lib/selfupdate.mjs'
import { readWatchUnread, readAtReplies, deliverWatchBatch, createWatchTick } from './lib/watch.mjs'

export const name = 'bili-scroll'
export const inject = ['webServer', 'tools', 'settings', 'subagents', 'agents', 'llm']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`，见 dsh-settings），没有这个标记写设置时会抛
 *    "Plugin entry … has no volatile fields"。另外两个条件是：
 *    **loader entry 的 id 必须等于命名空间名**（我们 patch 里就是 `bili-scroll`）+ **本模块导出 Config**。
 */
// ⚠️ schemastery 彻底拿不到时，这里会是 undefined —— **插件照常加载**，只是设置页降级
//    （宁可少一个设置页，也不能因为一个 import 让整条插件不激活 ✗）

// ⭐ 可配置的提示词模板（设置页能改；占位符：{owner}=主人称呼、{direction}=方向、{n}=条数）
const SCAN_PROMPT_TMPL = '你去 B 站帮我转一圈，看看有什么值得看的。\n\n这次想看的：{direction}\n\n别急着下结论，按这个来：\n先搜一搜（**默认优先看近 7 天的**，按播放或最新都行），标题看着没意思的就跳过；\n⚠️ 「近 7 天」只是默认偏好，**不是硬门槛**：方向里点名了某条/某个时间的视频，就按点名的来，别拿「不在 7 天窗口内」当理由拒绝；确实要放宽，就先按点名的去找。\n有点意思的，再看看简介，判断值不值得点进去；\n觉得值得，就把它的字幕读一遍，弄清楚到底讲了什么——没字幕的就跳过；\n顺手翻翻评论区，看看大家真实怎么说。\n\n最后挑出最值得的，最多 {n} 条。每条都跟我说清楚：标题、BV号、讲了什么、为什么值得、评论区反响怎么样。\n每条再单独标一行「**档位：值得看 / 可以看 / 不值当**」（三选一，别写别的词），方便以后按档翻。\n\n⚠️ 每条第一行单独写「### BV号」，方便我统计。\n写完把报告交给我就行，不用替我发评论、也不用发私信——那些我自己来。'

// ⭐ 自动刷触发语：到点时往「目标会话」里塞给伙伴的那一句（设置页可改）
// ⭐ 定点看一条（2026-10-22）：@ 她的、或她私信转发给她的那条视频，**不是**"帮我刷/帮我挑"，
//    而是"就这一条，你去看完回来告诉我"。跟 scanPrompt 是两套，别混。
const WATCH_TMPL = '去看这一条视频：{bvid}\n\n'
  + '这是{owner}专门给我的（@ 了我、或者私信转给我），**只看这一条**，不用搜别的、也不用挑。\n'
  + '按这个来：先把它的字幕读一遍（没字幕就翻评论区、看简介），弄清楚它到底讲了什么；\n'
  + '再翻翻评论区，看大家真实在说什么。\n\n'
  + '回来就跟我说这几件：① 它讲了什么（两三句，别复述全文）② 值不值得看、为什么 ③ 评论区什么反应。\n'
  + '⚠️ 第一行写「### {bvid}」，第二行单独写「**标题**：<这条视频的标题>」，方便我统计。\n'
  + '看完把报告交给我就行 —— 发不发评论、发不发私信，我自己来。'

const TRIGGER_TMPL = '（到谷时啦，去 B 站刷一轮吧～想看什么方向你自己定，用 bili_scan 就行；刷完按设置，该发评论发评论、该发私信发私信。）'

/**
 * ⭐ 2026-10-26（主人要的）：**到点发动态派给谁、说什么**。
 * 不绑当前对话 —— 插件到点把这段派给设置里选的那个会话，那边的伙伴自己读报告、写动态、回评论。
 * 占位符：{owner}=称呼、{home}=插件家目录（报告就在 <home>/out/<日期>.md）。
 */
const DYNAMIC_TMPL = [
  '到点了，把今天刷 B站 的东西写成一条公开动态发出去。',
  '',
  '1）先看今天刷到了什么：读 `{home}/out/<今天的日期>.md`，再加上这个会话里这一轮的内容，挑出 1–3 件真值得说的。',
  '2）用 `bili_send_dynamic` 发出去：人话、具体、带 BV 号，300 字以内。别写成通稿、别排比、别用「干货满满」这类词；今天确实没有值得写的，就不发。',
  '3）顺手去今天看过的视频评论区挑 1–2 条能接上话的评论，用 `bili_reply` 带 rpid 回一句：短、像随手接话，同一个人别连着回。B站 会自己加「回复 @某某」，正文里不要手打 @。',
  '4）发完跟{owner}说一句：动态发了没、发了什么、回了谁的哪条评论。',
].join(String.fromCharCode(10))

/**
 * ⭐ 2026-10-24（主人提的）：**评论区提示也单独抽出来、可以自己改规则**。
 *
 * 起因：她连着几条公开评论全是同一个模子 ——
 *   「"抄一句原话"，这条我/这三步，比我看的任何…都…@某某」
 * 查下来不是模型笨，是原来的指令只写了「极短：只点一个最有意思的点/梗」——
 *   要"点一个点"就得先引用，要"极短"最省字的就是比较级 ⇒ 每次都走同一条路。
 *
 * 这段就是「评论内容怎么写」的规则，**设置页能改**。
 * 占位符：{owner}=主人称呼、{mention}=要 @ 的人、{quota}=这一轮最多几条、{style}=这一轮的口吻
 * 下面这些「机制性」的话不进模板（工具名、楼中楼别手打 @）——
 * 那些是必须照做的，写死了更省心。
 */
const COMMENT_TMPL = [
  '评论一句话到两句，别排比、别列点。',
  '',
  '挑一个具体的点说就行，不用总结全文，也不用面面俱到。',
  '不用非夸它，也别写成读后感 —— 像平时刷到视频随手留一句那种就对了。',
  '',
  '「比…更…」「值得记住」「干货满满」这类词太满了，一出现就像模板；上来先抄一句原话加引号也一样。',
  '这一轮可以这么起头：{style}',
  '最多 {quota} 条；末尾记得带「@{mention}」（新评论 B站 不会自己加）。',
].join('\n')

// 口吻轮盘：每次刷随机抽一种，避免每条都一个调门
const COMMENT_STYLES = [
  '像刚想到一件事，先说结论再补为啥',
  '带点自嘲，顺手提个自己的糗事',
  '只夸一处具体的，不多解释',
  '反问一句，把话头留给别人',
  '补个自己的例子（真事或假设都行）',
  '只说半句，留个钩子',
  '像跟熟人随口一提，不用力',
]

// ⭐ 投递提示的**默认模板**：设置页直接把这个当默认值填在框里（不是留空！）
//    占位符：{owner} {mention} {commentQuota} {uid}
//            {commentBlock} / {dmBlock} / {bothBlock}（这三段按设置自动填或留空）
const HINT_TMPL = [
  '这份报告是给你的内部情报。接下来**你来**决定怎么递给{owner}（用你的口吻、别把内部术语写进去）',
  '{commentBlock}',
  '{dmBlock}',
  '{bothBlock}',
  '{noneBlock}',
  '⚠️ 无论会话里讲、评论、还是私信，**都必须带 BV 号**（标题后紧跟 BV1xxxxxxx），{owner} 要靠它找原视频。',
].join('\n')

export const Config = !z ? undefined : z.object({
  /** 定量刷：每天最多挑几条 */
  perDay: z.natural().default(5).extra('volatile', true),
  /** ⭐ 两轮自动刷之间至少隔几小时（**老字段，0.7.1 起由 gapMin 取代**，读到会换算成分钟） */
  gapHours: z.natural().default(3).extra('volatile', true),
  /** ⭐ 两轮自动刷之间至少隔几分钟（5–720）。想跑得密就调小（周末狂刷） */
  gapMin: z.natural().default(180).extra('volatile', true),
  /** 自动刷时段：manual = 只手动 / valley = 只在谷时 / always = 全天都跑 */
  autoMode: z.string().default('manual').extra('volatile', true),
  /** 峰谷自动刷（**老开关，还认**：开着 = valley，关着 = manual；新的看 autoMode） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上 */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /** 自动评论 @ 使用者（默认关 —— 会拿用户的号说话，必须他自己开） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 私信投递：off=只发评论（现状）· only=只私信（完全不公开评论）· both=评论 + 私信 */
  dmMode: z.string().default('off').extra('volatile', true),
  /** ⭐ 私信发给谁的 UID（数字）。要在 dmMode 不是 off 时填 */
  dmUid: z.natural().default(0).extra('volatile', true),
  /** ⭐ 每轮最多发几条评论（每条里 @ 一次下面那个人）；**有效范围 0–20，口径见 clampPatch**（0 = 不发评论）
   *  ⚠️ 这里故意**不加 `.max(20)`**：schema 校验不过 ⇒ cordis 拒收这条 entry ⇒ **整条插件不激活** ✗
   *     （跟 schemastery 拿不到时的降级同一个道理）—— 范围一律由 clampPatch 在**写**和**读**两头钳。 */
  commentPerRound: z.natural().default(1).extra('volatile', true),
  /** ⭐ 要 @ 谁（B站 昵称）；**留空 = 不发评论** —— 评论存在的意义就是 @ 那一下 */
  mentionName: z.string().default('').extra('volatile', true),
  /** 关注关键词（空了用章程里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** Python：指向 venv 里的那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** 日报形态：full=完整（现状）· brief=每条一两行 · off=不写报告（只发评论） */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** ⭐ 派子代理刷 B 站用的 provider（默认用主人自己 API 里的，避用官方 key） */
  subProvider: z.string().default('').extra('volatile', true),
  /** ⭐ 派子代理刷 B 站用的模型 */
  subModel: z.string().default('').extra('volatile', true),
  /** 每次（每轮）最多挑几条（一次挑一条更清爽，默认 1） */
  perScan: z.natural().default(1).extra('volatile', true),
  /** ⭐ 自动刷在哪个会话触发（留空 = 自动挑最近聊过的那个会话） */
  targetSession: z.string().default('').extra('volatile', true),
  /** ⭐ 主人的称呼（提示词里所有「小鱿鱼」都跟这个走） */
  ownerName: z.string().default('你').extra('volatile', true),
  /** ⭐ 子代理的人设+流程提示词（占位符 {owner}/{direction}/{n}） */
  scanPrompt: z.string().default(SCAN_PROMPT_TMPL).extra('volatile', true),
  /** ⭐ 投递提示（发给伙伴看的那段）——空 = 用内置那套默认；可整段改，占位符见 HINT_PLACEHOLDERS */
  hintPrompt: z.string().default(HINT_TMPL).extra('volatile', true),
  /** ⭐ 自动刷触发语（到点塞进目标会话的那句）——可改，{owner}=称呼 */
  triggerPrompt: z.string().default(TRIGGER_TMPL).extra('volatile', true),
  /** ⭐ 定点看一条（@ 她 / 私信转发的）用的提示词，占位符 {bvid} {owner} */
  watchPrompt: z.string().default(WATCH_TMPL).extra('volatile', true),
  /** ⭐ 评论怎么写（规则可自己改）——占位符 {owner} {mention} {quota} {style} */
  commentPrompt: z.string().default(COMMENT_TMPL).extra('volatile', true),
  /** ⭐ 门槛：播放量低于这个数的直接不返回给子代理（0 = 不过滤） */
  minViews: z.natural().default(0).extra('volatile', true),
  /** ⭐ 门槛：发布不足这么多天的直接不返回给子代理（0 = 不过滤） */
  minAgeDays: z.natural().default(0).extra('volatile', true),
  // ⚠️ 2026-10-22 补：下面这几个字段之前**漏在 schema 外**了（inbox 那批 + 三连那批）。
  //    后果：设置页保存它们时，写 DSH 设置层会被拒（config.json 能存，但会报「写 DSH 设置失败」）。
  //    以后再加配置字段，**记得同步这里**。
  /** 收到的 @ 和回复：每轮顺手看一眼 */
  inboxOn: z.boolean().default(true).extra('volatile', true),
  /** 额外要理的人（逗号分隔 uid）；留空 = 谁都理 */
  inboxUids: z.string().default('').extra('volatile', true),
  /** 同一条只提醒一次 */
  inboxOnceOnly: z.boolean().default(true).extra('volatile', true),
  /** 没回的话最多提醒几次 */
  inboxMaxRemind: z.natural().default(2).extra('volatile', true),
  /** 一天最多回「别人」几条 */
  inboxPerDay: z.natural().default(5).extra('volatile', true),
  /** ⭐ 随叫随到：有人找我就马上告诉你（**总开关，默认关**） */
  watchOn: z.boolean().default(false).extra('volatile', true),
  /** 随叫随到 —— 私信这一路 */
  watchDm: z.boolean().default(true).extra('volatile', true),
  /** 随叫随到 —— @ 和回复这一路 */
  watchAt: z.boolean().default(true).extra('volatile', true),
  /** 随叫随到：每隔几秒问一次（有效 60–1800，读时钳） */
  watchInterval: z.natural().default(120).extra('volatile', true),
  /** 随叫随到时段：valley = 只在谷时 / always = 全天 */
  watchScope: z.string().default('valley').extra('volatile', true),
  /** 三连模式：off / like / coin / fav / like_fav / triple */
  tripleMode: z.string().default('off').extra('volatile', true),
  /** 投币枚数 1~2 */
  tripleCoin: z.natural().default(1).extra('volatile', true),
  /** 每条视频写一份笔记 */
  notesOn: z.boolean().default(true).extra('volatile', true),
  /** ⭐ 允许发公开动态（拿自己号对外发言，**默认关**） */
  dynamicOn: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 每天最多发几条公开动态（1–10；范围由 clampPatch 钳） */
  dynamicPerDay: z.natural().default(3).extra('volatile', true),
  /** ⭐ 两条动态之间至少隔几分钟（1–720；范围由 clampPatch 钳） */
  dynamicGapMin: z.natural().default(10).extra('volatile', true),
  /** ⭐ 到点自动发动态（默认关）：到点由插件把一句话派给指定会话，**不绑当前对话** */
  dynamicAutoOn: z.boolean().default(false).extra('volatile', true),
  /** ⭐ 到点时间 HH:mm（北京时间） */
  dynamicTime: z.string().default('22:00').extra('volatile', true),
  /** ⭐ 派给哪个会话；留空 = 跟「自动刷在哪个会话」同一个 */
  dynamicSession: z.string().default('').extra('volatile', true),
  /** ⭐ 派过去的那句话（占位符 {owner} {home}） */
  dynamicPrompt: z.string().default(DYNAMIC_TMPL).extra('volatile', true),
})

/**
 * ⭐ 给所有 Python 子进程统一 UTF-8。
 * 起因（2026-10-16，用户在评论区反馈）：Windows 上 Python 默认按 GBK 编解码，
 * 我们的脚本 / 内置 MCP 都会往管道里打中文与 emoji（`✅`、`—` 之类），一进管道就可能
 * 报 UnicodeDecodeError / 乱码或直接中断。**编码这种环境差异，插件该自己钉死，不该让用户碰。**
 */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

/* ⭐ 随叫随到的几个纯函数（不碰 ctx / config，单独提出来是为了能自测） */
/** 问一次的间隔：钳在 60–1800 秒，非法值回默认 120 */
export function 钳提醒间隔(v) {
  return Math.max(60, Math.min(1800, Number(v) || 120))
}
const 时刻 = (ts) => {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}
const 剪短发 = (s, n = 200) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
/** 把「有人找你」的几条拼成一句话递给伙伴（她在会话里看到的就是这段） */
export function 拼提醒文案(items) {
  const 行 = (items || []).map((x) => {
    if (x.种类) {
      const 啥 = x.种类 === 'at' ? '有人 @ 你' : (x.种类 === 'reply' ? '有人回了你的评论' : '有人找你')
      return '· ' + 啥 + '｜' + (x.谁 || '有人') + (x.bv ? '（' + x.bv + '）' : '') + '：'
        + (x.内容 || '（没文字）') + (x.ts ? '　' + 时刻(x.ts) : '')
    }
    return '· 私信｜' + (x.谁 || '有人') + '：' + (x.内容 || '（没文字）')
      + (x.bv ? '　视频 ' + x.bv : '') + (x.ts ? '　' + 时刻(x.ts) : '')
  })
  return [
    '（B站 有人找你 —— 我刚看到的）',
    '',
    ...行,
    '',
    '要不要回、要不要看，你定；我只是先把话带到。',
  ].join('\n')
}

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  // ⭐ 自己的版本号（从 package.json 读，设置页要显示它）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }
  const stateDir = stateDirOf(ctx)

  // ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在
  //    （2026-10-15：只看目录，害一位真实用户"显示就绪但其实装失败"白折腾 ✗）
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  const venvReadyNow = () => existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'bilibili_api')
  const cfgFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  mkdirSync(outDir, { recursive: true })

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[bili-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  // 宿主依赖是从哪儿取的（桌面版那次事故的排查看这里：duty.log 里会写明白）
  for (const n of hostDeps.notes) log(n)

  /**
   * ⚠️ 2026-10-14 事故（第一次挂上就炸了整个 DSH，见当天的 lesson）：
   *   `apply(ctx, config)` 传进来的那个 `config`，字段值**不保证是标量** —— 我们的 `config.pythonPath`
   *   是个**对象**、`config.keywords` 也不是数组（日志里打成 `[object Object]`）。对象是"真值"，
   *   于是 `if (!cfg.peakValley) return` 这类守卫全部失效，一路走到 `cfg.keywords.filter(...)`
   *   抛 TypeError —— 而那是在**定时器回调**里，没人接 ⇒ **整个 dsh 进程被带走** ✗✗。
   *   ⇒ 两条规矩：
   *     ① 逐字段按默认值的类型挑一遍（拿不准就用默认值），再叠自己的 `config.json`；
   *     ② **定时器回调里绝不让异常外冒**（见 tick）—— 未捕获异常会杀掉整个宿主进程。
   */
  const DEFAULTS = {
    perDay: 5, gapHours: 3, gapMin: 180, autoMode: 'manual', peakValley: false, noon: true, night: true, autoComment: false,
    dmMode: 'off', dmUid: 0,
    keywords: [], commentPerRound: 1, mentionName: '', pythonPath: 'python', reportLevel: 'full',
    subProvider: '', subModel: '',
    perScan: 1,
    targetSession: '',
    ownerName: '你',
    scanPrompt: SCAN_PROMPT_TMPL,
    hintPrompt: HINT_TMPL,
    triggerPrompt: TRIGGER_TMPL,
    watchPrompt: WATCH_TMPL,   // ⭐ 定点看一条（@ 她 / 私信转发的）用的提示词
    commentPrompt: COMMENT_TMPL, // ⭐ 评论怎么写（可改；{owner} {mention} {quota} {style}）
    minViews: 0,      // 播放量低于这个数的不给子代理看（0 = 不过滤）
    minAgeDays: 0,    // 发布不足这么多天的不给子代理看（0 = 不过滤）
    // ⭐ 收到的 @ 和回复：每轮顺手看一眼，把内容**递给伙伴本人**，回不回她自己定
    inboxOn: true,
    inboxUids: '',        // 额外要理的人（逗号分隔 uid）。留空 = 只理「私信 UID」那个号
    inboxOnceOnly: true,  // 同一条只提醒一次（= 别人最多回 1 条）
    inboxMaxRemind: 2,    // 没回的话最多提醒几次，之后不再提
    inboxPerDay: 5,       // ⭐ 一天最多回「别人」几条 —— 防刷，也防她一天耗太多
    // ⭐ 随叫随到（2026-10-24）：有人 @ 你 / 私信你，不用等下一轮刷，隔一会儿就问一次
    //    ⚠️ B站 没有推送接口，只能"定时去问一句"；默认关，谁要谁自己开
    watchOn: false,
    watchDm: true,        // 私信这一路
    watchAt: true,        // @ 和回复这一路
    watchInterval: 120,   // 每隔几秒问一次（有效 60–1800）
    watchScope: 'valley', // valley = 只在谷时问 / always = 全天
    // ⭐ 三连（2026-10-22 她要的）：给「这一轮最值得的那条」做点动作
    //    off=不动 / like=只点赞 / coin=只投币 / fav=只收藏 / like_fav=点赞+收藏 / triple=一键三连
    //    ⚠ 默认 off：别人装了不该莫名给视频点赞、更不该花人家的硬币
    tripleMode: 'off',
    tripleCoin: 1,        // 投币枚数（1 或 2）
    notesOn: true,        // 每条视频写一份笔记（reports/<BV>-<日期>.md）
    // ⭐ 发公开动态（2026-10-25 主人要的）：拿自己号在主页对外说话，**默认关** ——
    //    跟 autoComment 同一个道理，谁要谁自己开；没开时只能靠 force 单次放行
    dynamicOn: false,
    dynamicPerDay: 3,     // 每天最多几条动态（1–10）
    dynamicGapMin: 10,    // 两条之间至少隔几分钟（1–720）
    // ⭐ 到点自动发（2026-10-26）：插件到点派一件事给指定会话，不绑当前对话
    dynamicAutoOn: false,
    dynamicTime: '22:00',
    dynamicSession: '',   // 留空 = 跟 targetSession 同一个
    dynamicPrompt: DYNAMIC_TMPL,
  }
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }
  /* ── 配置从哪来：DSH 自带的「插件设置」页 > 插件自己的 config.json > 默认值 ──
   * 老代码是 `normalize(readJson(cfgFile, {}), normalize(config, DEFAULTS))` —— config.json 一刀切盖住宿主，
   * 后果：用户在 DSH 自带的插件设置页里改了值，插件照旧读 config.json 的旧值 ⇒ **静默不生效** ✗。
   * 判据用 describe() 给的 `user` 层（= 用户在原生设置页**显式设过**的键）：
   *   设过的键 ⇒ 听宿主的；没设过 ⇒ 还是 config.json 说了算（老用户零回归 ✓）。
   * 拿不到设置服务就完全退回老行为。
   */
  /* ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、bili_config 工具、**读配置**三处都走它，
   *    所以 perDay 0–50 / commentPerRound 0–20 这些数字**只有这一份**（schema 里不再写一遍）。
   *    （2026-10-16 审查修：原来只有 HTTP 路径钳制，工具路径连 perDay 都能写任意值；
   *      commentPerRound 两条路径都没钳，直接 POST 能写 9999）
   *    （2026-10-17 复查补：DSH 原生设置页那条路我们钳不到**写** —— 用户能在那儿直接填 9999 ⇒
   *      loadCfg 读回来也过一遍，写进去和读出来一个口径） */
  const clampPatch = (patch) => {
    const p = { ...patch }
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 50))
    if ('gapHours' in p) p.gapHours = Math.max(1, Math.min(Number(p.gapHours) || 3, 12))
    if ('gapMin' in p) p.gapMin = Math.max(5, Math.min(Number(p.gapMin) || 180, 720))
    if ('autoMode' in p) p.autoMode = ['manual', 'valley', 'always'].includes(String(p.autoMode)) ? String(p.autoMode) : 'manual'
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief', 'off'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('commentPerRound' in p) p.commentPerRound = Math.max(0, Math.min(Number(p.commentPerRound) || 0, 20))
    if ('minViews' in p) p.minViews = Math.max(0, Math.min(Number(p.minViews) || 0, 100000000))
    if ('minAgeDays' in p) p.minAgeDays = Math.max(0, Math.min(Number(p.minAgeDays) || 0, 365))
    if ('tripleMode' in p) p.tripleMode = ['off','like','coin','fav','like_fav','triple'].includes(String(p.tripleMode)) ? String(p.tripleMode) : 'off'
    if ('tripleCoin' in p) p.tripleCoin = Math.max(1, Math.min(Number(p.tripleCoin) || 1, 2))
    if ('notesOn' in p) p.notesOn = Boolean(p.notesOn)
    if ('dynamicOn' in p) p.dynamicOn = Boolean(p.dynamicOn)
    if ('dynamicPerDay' in p) {
      const n = Number(p.dynamicPerDay)
      p.dynamicPerDay = Number.isFinite(n) ? Math.max(1, Math.min(n, 10)) : 3
    }
    if ('dynamicGapMin' in p) {
      const n = Number(p.dynamicGapMin)
      p.dynamicGapMin = Number.isFinite(n) ? Math.max(1, Math.min(n, 720)) : 10
    }
    if ('dynamicAutoOn' in p) p.dynamicAutoOn = Boolean(p.dynamicAutoOn)
    if ('dynamicTime' in p) {
      const t = String(p.dynamicTime || '').trim()
      p.dynamicTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : '22:00'
    }
    if ('dynamicSession' in p) p.dynamicSession = String(p.dynamicSession || '').trim().slice(0, 200)
    if ('dynamicPrompt' in p) p.dynamicPrompt = String(p.dynamicPrompt || '').slice(0, 4000)
    if ('watchInterval' in p) p.watchInterval = Math.max(60, Math.min(Number(p.watchInterval) || 120, 1800))
    if ('watchScope' in p) p.watchScope = ['valley', 'always'].includes(String(p.watchScope)) ? String(p.watchScope) : 'valley'
    return p
  }

  const hostCfg = () => normalize(config, { ...DEFAULTS })       // 宿主那份（schema 校验过、默认值已填）
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  const CFG_SIG = ['perDay', 'mentionName', 'dmMode', 'autoComment']   // 靠这几个键认出"哪一行是我们"
  let settingsRow = { at: 0, row: null }
  /**
   * 我们那一行设置表单（拿不到就返回 null ⇒ 一切按 config.json 来）。
   * ⚠️ DSH 自带的「插件设置」页**不需要注册** —— 老代码那句 `ctx.settings.register(...)` 是个不存在的方法，
   *    每次都抛 TypeError、被 catch 吞掉（2026-10-17 读宿主源码 @deepseek-ai/dsh-settings 才明白）：
   *    describe() 自己扫 profile 里**带 volatile 字段**的条目列出来（lib/index.js:413-452），
   *    命名空间 ns **等于 loader 条目的 id**（我们 cordis.patch.yml 里是 `bili-scroll`，不是老注释写的 bili-duty）。
   * 另外两条同样要紧（都是读宿主源码得来的，别再想当然）：
   *    ① `apply(ctx, config)` 收到的 config 就是 fiber.config 本体，volatile 字段一改宿主**就地**改它
   *       （cordis-plugin-loader/src/config/entry.ts：`this.fiber._config = …` + `_commitVolatile()`）⇒
   *       启动时快照的 cfg 永远看不到设置页的改动，用之前得 refreshCfg()。
   *    ② describe() 每行给三层：value（生效值）/ base（继承层）/ user（用户在设置页显式设过的那层）。
   */
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row   // 挡 UI 轮询：describe() 要扫所有条目
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  /**
   * ⭐ 0.7.1 迁移：老的「峰谷自动刷」开关 → 新的三档；老的小时制间隔 → 分钟制。
   *    只在用户**没显式设过新字段**时才换算 —— 老配置不用重设，也不会盖掉新手动设的值。
   */
  const 迁移老配置 = (out, user) => {
    let raw = {}
    try { raw = readJson(cfgFile, {}) || {} } catch { raw = {} }
    const u = user || {}
    const 设过 = (k) => raw[k] !== undefined || u[k] !== undefined
    if (!设过('autoMode')) {
      const 开 = u.peakValley !== undefined ? u.peakValley
        : (raw.peakValley !== undefined ? raw.peakValley : (out.peakValley ? true : undefined))
      if (开 !== undefined) out.autoMode = 开 ? 'valley' : 'manual'
    }
    if (!设过('gapMin')) {
      const 小 = u.gapHours !== undefined ? u.gapHours : raw.gapHours
      if (小 !== undefined && Number(小) > 0) out.gapMin = Math.max(5, Math.min(Math.round(Number(小) * 60), 720))
    }
    return out
  }
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    // ⭐ 读回来统一过一遍范围：原生设置页那边我们是钳不到写的（见 clampPatch 的注释）
    if (!row) return clampPatch(迁移老配置(saved, {}))
    const user = row.user || {}
    // ⭐ 用 row.value（DSH 原生设置的「生效值」，标量可靠），别用 apply 的 config 参数（字段常是坏值/对象，一丢就回默认）
    const out = normalize(row.value, { ...DEFAULTS })
    for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]
    // ⭐ pythonPath 是插件自己管的；DSH 原生设置传来的常是坏值/默认值，config.json 也可能被重置
    //    → 取 config.json；还是默认坏值 'python'（或不存在）时，退回 stateDir 下 venv 的 python
    out.pythonPath = restorePythonPath(saved.pythonPath, join(stateDir, '.venv'), existsSync)
    // ⭐ 这几段提示词：存着空串也补成默认文案 —— 设置页里要「看得见默认」
    if (!String(out.hintPrompt || '').trim()) out.hintPrompt = HINT_TMPL
    if (!String(out.triggerPrompt || '').trim()) out.triggerPrompt = TRIGGER_TMPL
    if (!String(out.commentPrompt || '').trim()) out.commentPrompt = COMMENT_TMPL
    if (!String(out.dynamicPrompt || '').trim()) out.dynamicPrompt = DYNAMIC_TMPL
    return clampPatch(迁移老配置(out, user))
  }
  const cfg = loadCfg()
  // ⭐ 配置是"随时可能被设置页就地改掉"的东西 ⇒ 每个入口用之前重算一遍（cfg 这个对象要一直指向同一份）
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  const saveCfg = (patch) => { Object.assign(cfg, normalize(patch, cfg)); writeJson(cfgFile, cfg) }
  /**
   * ⭐ 同时写一份到宿主：不写的话会出现死结 —— 某个键一旦在原生设置页设过就由宿主说了算，
   *    插件页再改那个键就成了"改了没反应" ✗。写失败不算致命（config.json 那份还在），把话带回给用户。
   */
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) {   // revision 过期（刚有别人改过）⇒ 重取一次再写
        try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 }
      }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
  /**
   * ⭐ 落配置的**唯一入口**：插件自己那份 config.json + DSH 原生设置页那份，钳完范围一起写。
   *    （2026-10-17 复查修：`saveCfg` + `await saveCfgHost` 这对义务原来在三个调用点各抄一遍 ——
   *      漏掉任何一处，正好就是「设置页改了没反应」那个 bug 本身 ⇒ 收成一个函数。）
   */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    const host = await saveCfgHost(clean)
    return { clean, host }
  }

  ensureHomeFiles(pluginDir, stateDir, log)

  /* ─────────────── MCP（内部起那个 Python MCP） ─────────────── */

  let mcp = null
  let mcpKey = ''
  const mcpKeyNow = () => `${cfg.pythonPath}|${join(stateDir, 'mcp_server.py')}`

  const ensureMcp = async () => {
    if (mcp?.running && mcpKey === mcpKeyNow()) return mcp
    if (mcp) { mcp.stop(); mcp = null }
    const script = join(stateDir, 'mcp_server.py')
    if (!existsSync(script)) throw new Error(`家里没有 mcp_server.py（应有 ${script}）—— 装上插件后重启一次 dsh 会自动铺好`)
    mcpKey = mcpKeyNow()
    mcp = new McpClient({
      command: cfg.pythonPath || 'python',
      args: [script],
      cwd: stateDir,                     // 凭证落在家里 ✓
      // ⭐ 这个内置的 Python MCP 会往 stdout 打中文（ensure_ascii=False）；
      //    Windows 默认 GBK 的话，中文/emoji 一进管道就可能炸 ⇒ 钉死 UTF-8
      env: pyEnv(),
      log,
    })
    return mcp
  }

  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }

  const hasCredential = () => existsSync(join(stateDir, 'bili_credential.json'))

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /**
   * 工具返回值一律过一遍这里：**宿主只吃"无损 JSON"**，塞进去任何函数/循环引用/类实例都会报
   * `value is not lossless JSON`（2026-10-14 第一次挂上就撞了一次）。
   */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  /** ⭐ 0.8.5：她自己看过的视频也记一条笔记 —— 卡片墙读的就是这些文件。
   *  ⭐ 她说的是：「我分享他一个视频、让他自己看，那条也应该在刷过的视频里」。
   *  同一天同一个 BV 只写一次（幂等），所以不会和刷B站那一轮重复。 */
  async function 写看过笔记(bvid, 来源, 摘录) {
    const 号 = String(bvid || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(号)) return false
    if (!cfg.notesOn) return false
    const 笔记夹 = join(outDir, 'reports')
    const 路径 = join(笔记夹, 号 + '-' + dayKey(new Date()) + '.md')
    try { if (existsSync(路径)) return false } catch (e) {}
    try { mkdirSync(笔记夹, { recursive: true }) } catch (e) {}
    let 标题 = ''
    let 封面 = ''
    try {
      const vr = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + 号)
      const vj = await vr.json()
      封面 = String((vj && vj.data && vj.data.pic) || '')
      标题 = String((vj && vj.data && vj.data.title) || '')
    } catch (e) {}
    const 正文 = String(摘录 || '').trim().slice(0, 1500)
    try {
      writeFileSync(路径, '# ' + 号 + String.fromCharCode(10, 10)
        + '> 抓取时间：' + new Date().toISOString() + String.fromCharCode(10)
        + (标题 ? '> 标题：' + 标题.split(String.fromCharCode(10)).join(' ') + String.fromCharCode(10) : '')
        + (封面 ? '> 封面：' + 封面 + String.fromCharCode(10) : '') + String.fromCharCode(10)
        + '### ' + (标题 || ('看过的 ' + 号)) + String.fromCharCode(10)
        + (正文 ? 正文 + String.fromCharCode(10) : ''), 'utf8')
      log('记了一条「她看过的视频」：' + 号 + '（' + (来源 || '她自己看的') + '）')
      return true
    } catch (e) {
      return false
    }
  }

  /** 从工具返回里尽量抠出可读文字（字符串 / {ok,text} / JSON 串都认） */
  function 从结果取文字(结果) {
    try {
      if (typeof 结果 === 'string') {
        try {
          const j = JSON.parse(结果)
          return String((j && (j.text || j.subtitle || j.内容 || j.content)) || 结果)
        } catch (e) { return 结果 }
      }
      if (结果 && typeof 结果 === 'object') return String(结果.text || 结果.subtitle || 结果.内容 || '')
    } catch (e) {}
    return ''
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  // 派一个子代理去刷 B 站（spawn 后端 + 可选模型），返回 { ok, report|error }
  // ⭐ 子代理的会话与记录**不由本插件清理**：留着还能回看当时刷了什么，也避免误伤别的会话。
  // ⭐ 这一轮「该发但还没发」的评论：没发评论就不让发私信（模型老跳过评论，只能硬约束）
  let pendingComment = null
  // ⭐ 0.8.5：现在「她自己看的」也会记一条笔记（卡片墙读的就是这些笔记）。
  //   但刷B站那一轮里，子代理会为**每条候选**调 bili_subtitle —— 那不能全记（会把墙刷满没挑中的）。
  //   所以用一个标志：子代理在跑的这一段里，不记「看过的」。
  let 扫描中 = 0

  // ⭐ 2026-10-22「门对门」：从私信转进来的那条，看完**只私信回**，不评论、不 @、不带 BV 号。
  //    从哪条路进来就从哪条路回去 —— 两边都做一遍才是多此一举（主人 2026-10-22 定）。
  function dmReplyHint(owner) {
    const 三连 = (!cfg.tripleMode || cfg.tripleMode === 'off')
      ? '· 顺手点个赞、收藏一下（`bili_triple`，mode 用 like_fav）。'
      : ''
    return [
      '这条是' + owner + '私信转给你的。看完**私信回**她 —— 用 `bili_send_message`；**不要**发评论、**不要** @，也别去评论区（那是另一条路，别混）。',
      '· 话不用长：讲了什么、值不值得看、你自己怎么看，三句就够。**不用带 BV 号** —— 她转给你的，她知道是哪条。',
      三连,
      '· 上面这段说明别念出来，用你自己的话说。',
    ].filter((x) => x !== '').join(String.fromCharCode(10))
  }

  const scanWith = async (parent, direction, exec, bvid = '') => {
    const dir = String(direction || '').trim()
      || (Array.isArray(cfg.keywords) ? cfg.keywords.filter(Boolean).join(' ') : '')
      || '最近有什么值得看的'
    if (!parent) return { ok: false, error: '没有可用的会话' }
    if (!ctx.subagents) return { ok: false, error: '这台 DSH 没有子代理能力（缺少 subagents 服务）' }

    // 手动刷不占「每天几条」的额度（那是自动刷的账）；每次最多挑这么几条
    const perRound = Math.max(1, Number(cfg.perScan || 1))

    const owner = String(cfg.ownerName || '你')
    const level = String(cfg.reportLevel || 'full')
    const levelLine = level === 'brief'
      ? '\n\n⚠️ 报告形态：**薄** —— 每条只写一两行（标题 + BV号 + 一句值不值得），不要展开细讲。'
      : (level === 'off'
        ? '\n\n⚠️ 报告形态：**不写详细报告** —— 直接给大肥鱼一段简短的口头总结（挑中哪几条、各自一句），不用逐条展开。'
        : '')
    const 定点 = String(bvid || '').trim()
    // ⭐ 2026-10-22「门对门」：这条 BV 要是从私信转进来的，这一轮就**只私信回** ——
    //    不塞评论块、不欠评论（连带 bili_send_message 那道「先发评论」的闸也不会挡）。
    //    从哪条路进来，就从哪条路回去；两个都做才是多此一举。
    const 私信回话 = Boolean(定点) && isDmShare(定点)
    const prompt = (定点
      ? String(cfg.watchPrompt || WATCH_TMPL).split('{bvid}').join(定点)
      : String(cfg.scanPrompt || SCAN_PROMPT_TMPL))
      .split('{owner}').join(owner)
      .split('{direction}').join(dir)
      .split('{n}').join(String(perRound)) + levelLine

    let run
    扫描中 += 1
    try {
      // ⭐ 2026-10-22：原来这里写死 provider 'apii' —— 别人机器上没这个 provider，
      //    自动刷一派子代理就失败。现在**两个都填了才指定**，留空就跟当前会话用一样的。
      const 子provider = String(cfg.subProvider || '').trim()
      const 子model = String(cfg.subModel || '').trim()
      run = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: '刷B站：' + dir.slice(0, 20),
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          ...(子provider && 子model ? { agentOptions: { provider: 子provider, model: 子model } } : {}),
        },
        signal: exec?.signal || new AbortController().signal,
        delivery: 'caller',
      })
    } catch (e) {
      扫描中 = Math.max(0, 扫描中 - 1)
      return { ok: false, error: '派子代理失败：' + (e?.message ?? e) }
    }
    let result
    try {
      result = await run.result
    } catch (e) {
      try { await run.dispose() } catch {}
      扫描中 = Math.max(0, 扫描中 - 1)
      return { ok: false, error: '子代理跑失败：' + (e?.message ?? e) }
    }
    扫描中 = Math.max(0, 扫描中 - 1)
    const output = (result?.output || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    try { await run.dispose() } catch {}
    if (result?.stopReason !== 'completed') {
      return { ok: false, error: '子代理没正常跑完（' + (result?.stopReason || '未知') + '）' + (result?.diagnostic ? '：' + result.diagnostic : ''), partial: output }
    }
    // 投递提示：让大肥鱼知道接下来要不要发评论/私信（她拿报告后自己决定、自己发）
    // ⚠️ 「每轮最多发几条评论」这个设置项已经去掉（上游用来管自动评论额度，被收件箱取代）。
    //    闸只看：开着自动评论 + 填了要 @ 谁 + 不是「只私信」模式
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only') && !私信回话
    // ⚠️ 这个数现在**没有设置项了**（「每轮最多发几条评论」已从设置页去掉，额度概念被收件箱取代），
    //    但下面拼「评论块」和 {commentQuota} 占位符时还在用它 ⇒ 必须定义，否则整条 bili_scan 直接抛
    //    ReferenceError（2026-10-21 用户实测：自动评论关着时刷不起来，就是这个）
    const commentQuota = Math.max(0, Number(cfg.commentPerRound ?? 1))
    if (commentOn) pendingComment = { at: Date.now() }   // 记账：这轮欠一条评论
    const dmOn = Boolean(cfg.dmMode !== 'off' && Number(cfg.dmUid) > 0)
    // ⭐ 2026-10-24：评论「怎么写」交给可改的 commentPrompt；这里只保留**机制性**的话
    //    （用哪个工具、楼中楼别手打 @）—— 那些是必须照做的，不该被改坏
    const 口吻 = COMMENT_STYLES[Math.floor(Math.random() * COMMENT_STYLES.length)]
    const 评论内容 = (String(cfg.commentPrompt || '').trim() || COMMENT_TMPL)
      .split('{owner}').join(owner)
      .split('{mention}').join(String(cfg.mentionName || ''))
      .split('{quota}').join(String(commentQuota))
      .split('{style}').join(口吻)
    const 评论块 = '· **评论区 @（公开！除了 ' + owner + '，别人也看得到）**：这是**发**评论——必须用 `bili_reply` 工具真发一条，**不是**用 `bili_comment` 去读评论（读评论是子代理已经干过的事，跟这一步无关）。**设置里已经开着，直接调 bili_reply 就行，不用传 force**。'
      + String.fromCharCode(10) + 评论内容
      + String.fromCharCode(10) + '  · 回别人的评论（楼中楼）就别手打 @ 了，B站 会自己加「回复 @某某」。'
    const 私信块 = '· **私信（只 ' + owner + ' 一个人看）**：用 bili_send_message 发**详细版**——开头先叫一声「' + owner + '，」再往下说；标题、BV号、视频讲了啥都可以细说，给 UID ' + Number(cfg.dmUid) + '。'
    const 都要块 = '⚠️ **这两件都要做，别只做一件**：先调 `bili_reply` 把评论 @ 发了，再调 `bili_send_message` 发私信（没发评论之前，私信会被拒）。'
    const 都不要块 = '报告拿给你了，你自己看着跟' + owner + '聊。'
    // ⭐ 2026-10-21：投递提示改成「模板常驻」（设置页里显示的就是默认文案，不是留空）
    const hintTpl = String(cfg.hintPrompt || '').trim() || HINT_TMPL
    // ⭐ 私信转进来的那条：回法另写一套（只私信、不评论、不带 BV），不走上面那套模板
    const hint = (私信回话 ? dmReplyHint(owner) : hintTpl)
      .split('{owner}').join(owner)
      .split('{mention}').join(String(cfg.mentionName || ''))
      .split('{commentQuota}').join(String(commentQuota))
      .split('{uid}').join(String(Number(cfg.dmUid) || 0))
      .split('{commentBlock}').join(commentOn ? 评论块 : '')
      .split('{dmBlock}').join(dmOn ? 私信块 : '')
      .split('{bothBlock}').join(commentOn && dmOn ? 都要块 : '')
      .split('{noneBlock}').join(!commentOn && !dmOn ? 都不要块 : '')
      // 占位符留空后会剩下空行，收一下
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').filter((x) => x.trim() !== '').join('\n')
    // ⭐ 每一轮的报告都写回报告文件（设置页「看报告」能回看）；「日报写多细=不写」时跳过
    if (level !== 'off') { try { appendFileSync(reportFileOf(), '\n\n---\n\n' + output + '\n', 'utf8') } catch {} }
    // ⭐ 2026-10-22：抠出这一轮挑中的 BV —— ① 记「最值得的那条」（三连要用）
    //    ② 每条写一份笔记（reports/<BV>-<日期>.md），以后能查「这条看过没、当时怎么说的」
    try {
      const bvs = []
      for (const line of String(output).split(String.fromCharCode(10))) {
        const m = /^#{1,6}\s*(BV[0-9A-Za-z]{10})/.exec(line.trim())
        if (m && bvs.indexOf(m[1]) < 0) bvs.push(m[1])
      }
      if (bvs.length) {
        const st = readJson(dutyStateFile, {})
        st.lastTopBvid = bvs[0]
        st.lastTopAt = new Date().toISOString()
        st.lastBvs = bvs.slice(0, 20)
        writeJson(dutyStateFile, st)
        log('这一轮挑中 ' + bvs.length + ' 条，最值得的是 ' + bvs[0])
        if (cfg.notesOn) {
          const 笔记夹 = join(outDir, 'reports')
          try { mkdirSync(笔记夹, { recursive: true }) } catch (e) {}
          const 段们 = String(output).split(/^#{1,6}\s*(?=BV)/m)
          for (const 段 of 段们) {
            const m = /^(BV[0-9A-Za-z]{10})/.exec(段.trim())
            if (!m) continue
            const 路径 = join(笔记夹, m[1] + '-' + dayKey(new Date()) + '.md')
            // ⭐ 顺手取标题 + 封面（B站 公开接口，不用登录）；取不到就留空，不影响笔记
            //    2026-10-22：标题以前靠正文里有没有「**标题**：」—— 定点看一条那类报告不写，
            //    卡片就成了「(没标题)」。现在直接从接口拿真标题写进笔记头，怎么都补得上。
            let 封面 = ''
            let 标题 = ''
            try {
              const vr = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + m[1])
              const vj = await vr.json()
              封面 = String((vj && vj.data && vj.data.pic) || '')
              标题 = String((vj && vj.data && vj.data.title) || '')
            } catch (e) {}
            try {
              writeFileSync(路径, '# ' + m[1] + String.fromCharCode(10, 10)
                + '> 抓取时间：' + new Date().toISOString() + String.fromCharCode(10)
                + '> 来源：自动刷 B 站第 ' + (Number(st.count) || 0) + ' 轮' + String.fromCharCode(10)
                + (标题 ? '> 标题：' + 标题.split(String.fromCharCode(10)).join(' ') + String.fromCharCode(10) : '')
                + (封面 ? '> 封面：' + 封面 + String.fromCharCode(10) : '') + String.fromCharCode(10)
                + '### ' + 段.trim() + String.fromCharCode(10), 'utf8')
            } catch (e) {}
          }
          log('笔记写好了：' + 笔记夹 + '（' + bvs.length + ' 条）')
        }
      }
    } catch (e) { log('记笔记/记最值得那条失败（不影响这一轮）：' + (e?.message ?? e)) }

    // ⭐ 三连：设置里选了模式，宿主就把**报告里标了「值得看」的**那几条点上（2026-10-22）
    //    为什么放宿主：不靠模型想起来；而且「哪几条值得看」报告里已经写着了。
    //    范围：只点标了「值得看」的（没标就退回「这一轮挑中的全部」，最多 5 条）；
    //    ⚠️ 三连模式会花硬币（每条 1~2 枚），所以一定要有条数上限。
    let 三连结果 = ''
    try {
      if (cfg.tripleMode && cfg.tripleMode !== 'off') {
        const st2 = readJson(dutyStateFile, {})
        const 全 = Array.isArray(st2.lastBvs) ? st2.lastBvs.slice(0, 5) : []
        // 从报告里找「档位：值得看」那几段对应的 BV
        const 值得看 = []
        for (const 段 of String(output).split(/^#{1,6}\s*(?=BV)/m)) {
          const m = /^(BV[0-9A-Za-z]{10})/.exec(段.trim())
          if (!m) continue
          if (/档位[：:]\s*值得看/.test(段)) 值得看.push(m[1])
        }
        const 目标们 = (值得看.length ? 值得看 : 全).slice(0, 5)
        if (!目标们.length) {
          log('三连：这一轮没抠到 BV，跳过')
        } else {
          const 做了 = []
          for (const bv of 目标们) {
            try {
              const r = await call('bili_triple', { bvid: bv, mode: cfg.tripleMode, coin_num: Number(cfg.tripleCoin) || 1 })
              let ok = false
              try {
                const j = typeof r === 'string' ? JSON.parse(r) : r
                ok = Boolean(j && j.ok)
              } catch (e) {}
              log('三连（' + cfg.tripleMode + '）→ ' + bv + '：' + String(r).slice(0, 160))
              if (ok) 做了.push(bv)
            } catch (e) { log('三连 ' + bv + ' 失败（跳过）：' + (e?.message ?? e)) }
          }
          if (做了.length) 三连结果 = '点了 ' + 做了.length + ' 条（' + 做了.join('、') + '）'
          log('三连收工：' + (三连结果 || '一条都没成'))
        }
      }
    } catch (e) { log('三连那段出错（不影响报告）：' + (e?.message ?? e)) }

    return { ok: true, report: output, hint: 三连结果 ? (hint + String.fromCharCode(10) + '（报告里值得看的那几条，我顺手点过了：' + 三连结果 + '）') : hint }
  }

  const doScan = async (direction, exec, bvid = '') => {
    const parent = ctx.agents?.currentInitiator?.()
    if (!parent) return { ok: false, error: '没拿到发起刷 B 站的会话（要在对话里用）' }
    return scanWith(parent, direction, exec, bvid)
  }

  tool({
    name: 'bili_scan',
    description: '派一个子代理去刷 B 站：按你想看的方向搜视频、读字幕原文、把值得的挑出来，看完把内容汇报给你。\n'
      + '大肥鱼（或你）说「帮我刷下 XX 方向」就能触发；子代理模型可在设置页选。'
      + '如果只想看**某一条**（比如她 @ 你的、或私信转给你的），传 bvid —— 那就只读那一条，不搜不挑。',
    parameters: {
      direction: { type: 'string', description: '想刷什么方向 / 主题 / 关键词，一句话或几个词' },
      bvid: { type: 'string', description: '可选。给了 BV号就是「定点看这一条」（@ 我的、或私信转给我的那条）：只看它、不搜不挑' },
    },
    async execute(args, exec) {
      return doScan(args?.direction, exec, String(args?.bvid ?? '').trim())
    },
  })

  tool({
    name: 'bili_whoami',
    description: '看 B站 那边登录的是谁（凭证是否有效、昵称、mid）。第一次用要先在「刷B站」设置页里扫码登录。',
    parameters: {},
    async execute() {
      if (!hasCredential()) {
        return { ok: false, loggedIn: false, hint: '还没登录：去 dsh 设置页的「刷B站」里点「扫码登录」（凭证会存在插件自己的家目录里）' }
      }
      const r = await call('bili_check_credential', {})
      return { ok: true, ...(typeof r === 'object' ? r : { raw: r }) }
    },
  })

  tool({
    name: 'bili_search',
    description: '搜 B站 视频（可排序）。返回标题 / BV号 / 播放量 / UP / 时长 等。\n'
      + '⚠️ 刷一轮的用法：搜近 7 天的、按播放或最新都行，然后**读字幕原文**再判断（别看摘要下结论）。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词' },
      num: { type: 'number', description: '返回几条（默认 10，最大 50）' },
      order: { type: 'string', description: 'totalrank=综合（默认）/ click=播放 / pubdate=最新 / dm=弹幕' },
    },
    async execute(args) {
      refreshCfg()
      const num = Math.max(1, Math.min(Number(args.num) || 10, 50))
      const minViews = Math.max(0, Number(cfg.minViews || 0))
      const minAgeDays = Math.max(0, Number(cfg.minAgeDays || 0))
      const filtering = Boolean(minViews || minAgeDays)
      // ⭐ 有门槛时多抓几倍再筛：不然筛完可能一条不剩，子代理会以为"搜不到"
      const raw = await call('bili_search', {
        keyword: String(args.keyword ?? ''),
        num: filtering ? Math.min(50, num * 4) : num,
        order: String(args.order || 'totalrank'),
      })
      // ⭐ 硬门槛（设置页里的「最低播放量」「至少发布几天」）：在**工具层**就把垃圾滤掉，
      //    子代理根本看不到 —— 比在提示词里嘱咐它"别选低播放量的"可靠得多。
      if (!filtering) return raw
      try {
        // ⚠️ mcp.call() **已经 JSON.parse 过**了，这里拿到的是对象；再 parse 一次会抛，
        //    然后被下面的 catch 吞掉 ⇒ 门槛看起来"完全没生效"（2026-10-20 真踩到，别删这段注释）
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!obj || !Array.isArray(obj.videos)) return raw
        const nowSec = Date.now() / 1000
        const kept = []
        let dropViews = 0
        let dropAge = 0
        for (const v of obj.videos) {
          if (minViews && Number(v.play || 0) < minViews) { dropViews++; continue }
          if (minAgeDays && Number(v.pubdate || 0) > nowSec - minAgeDays * 86400) { dropAge++; continue }
          kept.push(v)
        }
        const note = []
        if (minViews) note.push('播放量 < ' + minViews + ' 的排除 ' + dropViews + ' 条')
        if (minAgeDays) note.push('发布不足 ' + minAgeDays + ' 天的排除 ' + dropAge + ' 条')
        obj.videos = kept.slice(0, num)
        obj.count = obj.videos.length
        obj.filtered = note.join('；')
        // 留一行日志：以后"门槛有没有生效"直接在 duty.log 里看得见，不用再猜
        try { log('搜索门槛生效：' + (obj.filtered || '无') + '（返回 ' + obj.count + ' 条）') } catch (e) {}
        return obj
      } catch (e) {
        // 过滤失败绝不静默：退回不过滤，但日志里必须留痕
        try { log('门槛过滤失败（已退回不过滤）：' + (e?.message ?? e)) } catch (e2) {}
        return raw
      }
    },
  })

  tool({
    name: 'bili_subtitle',
    description: '取一个视频的字幕（AI 字幕）全文。**判断内容就靠它** —— 没有字幕的，直接跳过这条。',
    parameters: { bvid: { type: 'string', description: 'BV号' } },
    async execute(args) {
      const 号 = String(args?.bvid ?? '').trim()
      const 结果 = await call('bili_subtitle', { bvid: 号 })
      // ⭐ 0.8.5：不在刷B站那一轮里 = 这是她自己看的（比如你分享给她、让她亲眼看）
      //    → 顺手记一条，卡片墙上就有它。
      try {
        if (扫描中 === 0) void 写看过笔记(号, '她自己看的（分享/点名让我看）', 从结果取文字(结果).slice(0, 800))
      } catch (e) {}
      return 结果
    },
  })

  tool({
    name: 'bili_comments',
    description: '取一个视频的热门评论（含点赞/回复数）。刷一轮时顺手翻一眼，看值不值得占用使用者一次注意力。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      num: { type: 'number', description: '取几条（默认 30）' },
    },
    async execute(args) {
      return call('bili_comments', { bvid: String(args.bvid ?? ''), num: Math.max(1, Number(args.num) || 30) })
    },
  })

  tool({
    name: 'bili_reply',
    description: '在视频下发一条评论，或回复某条评论（楼中楼）。短、干净、像人说的话。\n'
      + '⚠️ 回复别人的评论时**正文里不要手打 @** —— B站会自己加「回复 @某某」，你再加一遍就重复了。\n'
      + '🔴 **自己发新评论**（不带 rpid）：正文末尾**必须亲手带上「@要 @ 谁」** —— B站 新评论**不会**自动加 @，不写就没有。\n'
      + '⚠️ 而**回别人的评论 / 楼中楼**（带 rpid）时，正文里**不要手打 @** —— B站 会自己加「回复 @某某」。\n'
      + '✅ 设置里开着「自动评论并 @ 你」、并且填了「要 @ 谁」时，**直接调就行，不用传 force**。\n'
      + '🔴 只有设置没开时才会拒绝；那种情况下要发才传 force: true。',
    parameters: {
      bvid: { type: 'string', description: 'BV号' },
      text: { type: 'string', description: '评论正文（短、干净、纯文本 @；别写敏感词）' },
      rpid: { type: 'number', description: '要回复的评论 id（0/不填 = 发新评论）。带了 rpid 就是"回别人"，**不受自动评论那套闸限制**' },
      root: { type: 'number', description: '楼中楼才填：楼层根评论 id（回复一级评论不用填）。正文里**不要**手打 @，B站会自己加「回复 @某某」' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过"自动评论关着"的闸' },
    },
    async execute(args) {
      // dmMode==='only' 时本轮根本不该发公开评论；「每轮最多发几条评论」填 0 也一条都不发 —— 工具层一并挡掉（除非当场 force）
      // ⭐ 但**带 rpid 的回复（楼中楼）不走这套闸**：那是在回别人说的话，不是「自动发评论去 @ 谁」。
      //    （2026-10-21：不加这条的话，dmMode=only 的人永远回不了别人的评论，只能每次手带 force）
      refreshCfg()
      const 是回复 = Math.max(0, Number(args.rpid) || 0) > 0
      const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
      if (!commentOn && !args.force && !是回复) {
        return {
          ok: false,
          blocked: true,
          hint: cfg.dmMode === 'only'
            ? '现在是「只私信」模式（dmMode=only）—— 规定不发公开评论，改成用 bili_send_message 私信。确实要发时传 force: true。'
            : '要发评论得满足：开着「自动评论并 @ 你」、并填了「要 @ 谁」。或者本人当场让你发时传 force: true。',
        }
      }
      const r = await call('bili_reply', {
        bvid: String(args.bvid ?? ''),
        text: String(args.text ?? ''),
        rpid: Number(args.rpid) || 0,
        root: Math.max(0, Number(args.root) || 0),
      })
      pendingComment = null   // 发过（无论成败）就不再卡私信
      // ⭐ 回完了就把那条 @ / 回复标成已处理 —— 「同一条只提醒一次」靠这里生效
      try {
        const j = typeof r === 'string' ? JSON.parse(r) : r
        if (j && j.success) markInboxReplied(String(args.bvid ?? ''), Number(args.rpid) || 0)
      } catch (e) { /* 记账失败不影响回复本身 */ }
      return r
    },
  })

  tool({
    name: 'bili_triple',
    description: '给一个视频点赞 / 投币 / 收藏 / 一键三连。\n'
      + '不传 bvid 就是「这一轮报告里排第一的那条」（最值得的那条）。\n'
      + 'mode 不传就按设置里的「三连模式」。⚠️ 投币会**花账号里的硬币**，点过的会跳过、不重复。\n'
      + '设置里三连模式是 off 时，这个工具会拒绝（要动就先去设置里选一个）。',
    parameters: {
      bvid: { type: 'string', description: 'BV号；不填 = 这一轮最值得的那条' },
      mode: { type: 'string', description: 'like=只点赞 / coin=只投币 / fav=只收藏 / like_fav=点赞+收藏 / triple=一键三连；不填 = 按设置' },
      coinNum: { type: 'number', description: '投币枚数 1 或 2（默认按设置）' },
    },
    async execute(args) {
      let bvid = String(args?.bvid ?? '').trim()
      if (!bvid) {
        const st = readJson(dutyStateFile, {})
        bvid = String(st.lastTopBvid || '').trim()
        if (!bvid) return '还没有「这一轮挑中的视频」—— 先跑一轮 bili_scan'
      }
      const mode = String(args?.mode ?? '').trim() || String(cfg.tripleMode || 'off')
      if (mode === 'off') return '设置里的「三连模式」是关着的（off）—— 要动就先去设置里选一个'
      const coin = Math.max(1, Math.min(Number(args?.coinNum ?? cfg.tripleCoin ?? 1) || 1, 2))
      log('三连：' + bvid + ' mode=' + mode + ' coin=' + coin)
      const 结果 = await call('bili_triple', { bvid: bvid, mode: mode, coin_num: coin })
      try {
        if (扫描中 === 0) void 写看过笔记(bvid, '她点了三连（' + mode + '）', '')
      } catch (e) {}
      return 结果
    },
  })

  tool({
    name: 'bili_send_message',
    description: '给某人发 B 站私信（把这一轮刷到的好东西私信给他）。用于「只私信 / 评论+私信」模式，让大肥鱼亲自把结果私下递过去。\n'
      + '🔴 安全闸：设置里「投递方式」得不是 off、且填了私信 UID，否则拒绝（本人当场让你发时传 force: true）。\n'
      + '⚠️ 私信是写给「人」看的：干净的人话，别出现设置名/内部术语；实测 500 字符就顶，别太长。',
    parameters: {
      text: { type: 'string', description: '私信正文（干净的人话、不含内部术语，控制 500 字内）' },
      uid: { type: 'number', description: '发给谁（B站 UID 数字；不填用设置里的 dmUid）' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过安全闸' },
    },
    async execute(args) {
      refreshCfg()
      const dmOn = Boolean(cfg.dmMode !== 'off' && Number(cfg.dmUid) > 0)
      const uid = Number(args.uid) || Number(cfg.dmUid) || 0
      if (!dmOn && !args.force) {
        return { ok: false, blocked: true, hint: '私信要发得先满足：设置里「投递方式」设成只私信/都发、并填了私信 UID。或者本人当场让你发时传 force: true。' }
      }
      if (!uid) return { ok: false, blocked: true, hint: '没有收件人 UID：在设置里填「私信发给谁」，或调用时传 uid。' }
      // ⭐ 硬约束：这一轮还欠着评论就先别发私信 —— 先调 bili_reply 把评论发了
      const commentOnNow = Boolean(cfg.autoComment && cfg.mentionName && cfg.dmMode !== 'only')
      // ⭐ 这道闸**故意不看 args.force**：模型会习惯性带 force: true 把它绕过去（2026-10-19 实测 7/7 轮全带）。
      //    评论"调过就算"（成败都清 pendingComment），所以不会把它锁死。
      if (commentOnNow && pendingComment && Date.now() - pendingComment.at < 15 * 60 * 1000) {
        return { ok: false, blocked: true, hint: '这一轮还没发评论：先调 bili_reply 在视频下留一条简短评论 @ 一下（设置里已经开着，直接发、不用 force），发完再回来发私信。' }
      }
      return call('bili_send_message', { receiver_uid: uid, text: String(args.text || '') })
    },
  })

  /* ⭐ 发公开动态（2026-10-25 主人要的）：拿**自己号在主页对外说话**，比评论更显眼 ⇒
   *    默认关，设置里「允许发公开动态」开了才发；另外两道硬闸（每天几条 / 隔几分钟，
   *    按设置里的 dynamicPerDay / dynamicGapMin，1–10 与 1–720）是防模型一激动连着刷屏 ——
   *    这两道**不认 force**，跟私信那道"欠评论"的闸同一个道理。 */
  tool({
    name: 'bili_send_dynamic',
    description: '在**自己的 B站 主页**发一条公开动态（所有人都刷得到，不只是你的粉丝）。\n'
      + '拿真刷到的东西 + 你自己的看法写：具体、有 BV 号、像人说的话，别写成公告或通稿。\n'
      + '⚠️ 正文带上 BV 号，别人才找得到原视频。\n'
      + '🔴 安全闸：设置里「允许发公开动态」开着才能发；没开时**本人当场让你发**才传 force: true。\n'
      + '额度按设置里那两项来（默认一天 3 条、两条之间至少隔 10 分钟；这两道闸 force 也绕不过去）。',
    parameters: {
      text: { type: 'string', description: '动态正文（人话；可带 BV 号、[doge] 这类表情）' },
      images: { type: 'string', description: '可选：配图，本地路径或 http(s) 链接，多个用换行/逗号分隔，最多 9 张' },
      topicId: { type: 'number', description: '可选：话题 id（0 / 不填 = 不带话题）' },
      scheduleTime: { type: 'number', description: '可选：B站 定时发布的 Unix 时间戳（秒）；0 / 不填 = 立刻发' },
      force: { type: 'boolean', description: '本人当场让你发的，传 true 越过「允许发公开动态」那道闸' },
    },
    async execute(args) {
      refreshCfg()
      if (!cfg.dynamicOn && !args.force) {
        return {
          ok: false,
          blocked: true,
          hint: '发公开动态得先开「允许发公开动态」（bili_config 传 {"dynamicOn":true}，或在 DSH 的插件设置里打开）。或者本人当场让你发时传 force: true。',
        }
      }
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, blocked: true, hint: '正文不能空 —— 动态至少得有一句话。' }

      // 硬闸：每天几条 + 两条间隔几分钟，都按设置来（记在 state.json，跨轮次/跨会话都算数）
      const 每日上限 = Math.max(1, Math.min(Number(cfg.dynamicPerDay) || 3, 10))
      const 间隔分钟 = Math.max(1, Math.min(Number(cfg.dynamicGapMin) || 10, 720))
      const st = readJson(dutyStateFile, {})
      const today = dayKey()
      const 今天几条 = st.dynDay === today ? Number(st.dynCount || 0) : 0
      const 上一条在 = Number(st.dynAt || 0)
      if (今天几条 >= 每日上限)
        return { ok: false, blocked: true, hint: `今天已经发过 ${今天几条} 条动态了（上限 ${每日上限} 条）—— 够了，明天再说。额度可在设置里改。` }
      const 刚发过 = 上一条在 && Date.now() - 上一条在 < 间隔分钟 * 60 * 1000
      if (刚发过) {
        const 还差 = Math.ceil((间隔分钟 * 60 * 1000 - (Date.now() - 上一条在)) / 60000)
        return { ok: false, blocked: true, hint: `刚发过一条，还要等约 ${还差} 分钟（间隔 ${间隔分钟} 分钟）—— 别连着刷屏。` }
      }

      const imgs = String(args.images ?? '')
        .split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 9)
      log(`发动态：${text.slice(0, 40)}${imgs.length ? `（${imgs.length} 张图）` : ''}`)
      const r = await call('bili_send_dynamic', {
        text,
        images: imgs,
        topic_id: Math.max(0, Number(args.topicId) || 0),
        schedule_time: Math.max(0, Number(args.scheduleTime) || 0),
      })
      // 发成了才记账；没发成（风控/没权限）不占当天的额度。
      // ⚠️ 只写 dyn* 三个键，**别碰 `day`** —— 那是刷站额度用的，碰了会把昨天的 picked 算成今天的。
      let 成功 = false
      try { 成功 = Boolean((typeof r === 'string' ? JSON.parse(r) : r)?.success) } catch { 成功 = false }
      if (成功) {
        const cur = readJson(dutyStateFile, {})
        writeJson(dutyStateFile, { ...cur, dynDay: today, dynCount: 今天几条 + 1, dynAt: Date.now() })
      }
      return r
    },
  })

  tool({
    name: 'bili_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、登录过没有、下次窗口什么时候开。',
    parameters: {},
    async execute() {
      refreshCfg()
      const st = readJson(join(stateDir, 'state.json'), {})
      const now = new Date()
      return {
        ok: true,
        today: dayKey(now),
        // ⭐ 额度只有一个口径：**今天自动刷了几轮**（手动跑不占额度）
        autoRoundsToday: countPickedToday(now),
        autoRoundsLeft: Math.max(0, Number(cfg.perDay || 0) - countPickedToday(now)),
        videosToday: countPicks(reportFileOf(now)),   // 今天报告里真挑到几条（含手动轮的）
        perDay: cfg.perDay,
        windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, {
          label: w.label, start: w.start, end: w.end,
          switchOn: Boolean(cfg[k]),
          opening: inValley(now, w),
        }])),
        autoMode: 自动模式(),
        gapMin: Math.max(5, Number(cfg.gapMin) || 180),
        peakValley: cfg.peakValley,
        autoComment: cfg.autoComment,
        dmMode: cfg.dmMode,
        dmUid: Number(cfg.dmUid) || 0,
        loggedIn: hasCredential(),
        home: stateDir,
        report: join(outDir, `${dayKey(now)}.md`),
      }
    },
  })

  tool({
    name: 'bili_login_start',
    description: '开始 B站 扫码登录：出二维码（画成 PNG 存在插件家目录里，返回路径）和一个 key。\n'
      + '用法：拿到 PNG 后用 `present` 把它推给本人（手机 B站 → 我的 → 扫一扫），再用 `bili_login_poll` 轮询。\n'
      + '⚠️ 二维码大约 180 秒有效，出码要马上递过去；手机上确认时选「记住我」那种长期登录。',
    parameters: {},
    async execute() {
      const { key, url } = await loginStart()
      const png = await renderQrPng(cfg.pythonPath, stateDir, url)
      return {
        ok: true, key, url, png,
        hint: png ? '用 present 把这张 PNG 推给本人扫；扫完调 bili_login_poll' : '没画出 PNG：先去设置里点「建 venv 装依赖」（venv 里要有 qrcode）',
      }
    },
  })

  tool({
    name: 'bili_login_poll',
    description: '查扫码结果：waiting 还没扫 / scanned 扫了待确认 / ok 成功 / expired 过期。'
      + '成功时会自动把凭证写进插件家目录的 `bili_credential.json`（MCP 认的那四个字段）。',
    parameters: { key: { type: 'string', description: 'bili_login_start 给的那个 key' } },
    async execute(args) {
      const r = await loginPoll(String(args.key ?? ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return { ok: true, state: 'ok', file }
      }
      return { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message }
    },
  })

  tool({
    name: 'bili_setup',
    description: '给刷B站装运行环境：在插件家目录建一个**独立 venv**、装上那个 Python MCP 的依赖，装完自动把 `pythonPath` 指过去。\n'
      + '**第一次用之前跑一次**。⭐ 它**起完就返回、不等装完**（几分钟的活），进度看家目录里的 `install.log`。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'bili_config',
    description: '读 / 改「刷B站」的设置。不给 `patch` 就是读；给了就改（只认 schema 里的字段）。\n'
      + '例：`{"perDay":5,"peakValley":true,"noon":true,"night":true,"autoComment":false,"perScan":1}`；'
      + '私信投递：`{"dmMode":"only","dmUid":12345678}`（dmMode = off / only / both）；'
      + '看 @ 和回复：`{"inboxOn":true,"inboxOnceOnly":true,"inboxMaxRemind":2}`；'
      + '有人找我就马上告诉你：`{"watchOn":true,"watchDm":true,"watchAt":true,"watchInterval":120,"watchScope":"valley"}`'
      + '（watchScope = valley 只在谷时 / always 全天；watchInterval 60–1800 秒）；'
      + '允许发公开动态：`{"dynamicOn":true}`（默认关）；额度：`{"dynamicPerDay":3,"dynamicGapMin":10}`（每天几条 1–10 / 隔几分钟 1–720）。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        // ⭐ 设置页显式设过的键以宿主为准 ⇒ 必须跟着写一份，否则"改了没反应"（钳范围也在这里）
        host = (await persistCfg(args.patch)).host
      }
      return { ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(), host }
    },
  })

  /* ─────────────── 跑一轮（跟老方案同一条路：dsh --profile headless <prompt>） ─────────────── */

  const dutyStateFile = join(stateDir, 'state.json')
  const bumpState = (patch) => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day !== today) { st.day = today; st.count = 0; st.picked = 0; st.windows = {} }
    writeJson(dutyStateFile, { ...st, ...patch })
    return st
  }

  /* ⭐ 「定量刷」承诺的是**每天挑几条**（2026-10-16 审查修 H1：原来 st.count 从没自增过，
   *   tick 那道 `count >= perDay` 的闸形同虚设 ⇒ noon + night 两个窗口各跑满一轮，
   *   后一轮还会把前一轮的报告覆盖掉）。
   *   数哪儿？数**今天的报告**里那些 `### BV号` 标题行（章程写死了这个格式）。
   *   ⚠️ 为什么不数「报告里出现的所有 BV」（2026-10-17 复查修的）：报告里还会出现**没挑中**的 BV ——
   *     「因无字幕跳过 N 条」那行、评论区里别人问起的视频、"判重表读不到"的说明 —— 全算进去的话，
   *     perDay 默认 5 ⇒ 一轮里出现 5 个 BV 就把当天额度吃光 ⇒ **傍晚那轮直接不跑** ✗。
   *   ⚠️ 围栏 ``` 里的内容一律不看：那一轮没写报告时 stubReportIfMissing 会把 duty.log 尾部贴进报告，
   *     那里面的 BV 是"看过的"，不是"挑出来的"。
   *   ⚠️ 数不出来（章程那条格式没照做）就当 0 条 —— 宁可少算（顶多多跑一轮、额度也写在提示词里），
   *     也别把"提到过"算成"挑中"（那会让使用者当天再也拿不到内容）✓。 */
  const PICK_RE = /^#{2,3}[ \t]*(BV[0-9A-Za-z]{10})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  // ⭐ 额度只认「自动刷」在 state 里记的 picked，不数报告文件（手动刷写报告但不占额度）
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.picked || 0) : 0
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  // ⭐ 「复核评论」：拿判重表里最近的记录，去 B站 核一遍到底公开可见没有（发出去≠可见）
  let verifying = false
  const runVerify = async (why = 'manual') => {
    if (verifying) return { ok: false, error: '上一次复核还没跑完，等它完事' }
    verifying = true
    try {
      log(`评论复核开始（${why}）`)
      const r = await verifyRecent(stateDir, { log })
      const f = appendVerifyToReport(stateDir, r.text)
      log(`评论复核结束（${why}）：查了 ${r.checked.length} 条${f ? `，已写进 ${f}` : ''}`)
      return { ok: true, why, checked: r.checked, skipped: r.skipped, text: r.text, report: f || '' }
    } catch (e) {
      log(`评论复核失败（${why}）：${e?.message ?? e}`)
      return { ok: false, why, error: String(e?.message ?? e) }
    } finally { verifying = false }
  }

  const sessionIdOf = (session) => {
    if (!session) return ''
    for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      try { const v = session[k]; if (typeof v === 'string' && v) return v } catch {}
    }
    return ''
  }

  /* ⭐ 2026-10-23：会话 id 有两种写法（`xxx` / `session-xxx`）。
   *    只按字面比较会出「明明选的是这间，却说它没醒着」这种怪事（speak-up 用户报过同一个坑），
   *    所以比较一律先去掉前缀。 */
  const 会话键 = (v) => {
    const s = String(v == null ? '' : v).trim()
    return s.startsWith('session-') ? s.slice('session-'.length) : s
  }

  /* ⭐ 2026-10-23（反馈）：原来只认 `session-` 开头的目录名，
   *    于是别的插件自己建的会话（`bili-whale`、IM 桥的 `im-…`）在下拉里根本选不到。
   *    真正该排掉的只有「裸 UUID」那些（子代理 / 会话内容的中间目录）。 */
  const 是会话目录 = (sid) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(sid || ''))

  // ⭐ 自动刷：到点不 headless，而是往「伙伴住的会话」followup 一句，让 TA 自己开一轮去刷（占每天额度）
  //   目标会话：设置里选的优先；没选就自动挑「最近聊过、非空、非归档」的那个 —— 不写死任何人的 id
  const listDirs = (p) => {
    try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
  }

  const pickRecentSession = () => {
    try {
      const base = join(dirname(stateDir), 'storages')
      const sessRoot = join(dirname(stateDir), 'sessions')
      const cacheDir = join(base, 'session_projcache', 'sessions')
      const archived = new Set()
      try {
        for (const id of (readJson(join(base, 'workspace.json'), {})?.global?.archivedSessionIds || [])) archived.add(String(id))
      } catch {}
      let best = null
      for (const ws of listDirs(sessRoot)) {
        for (const sid of listDirs(join(sessRoot, ws))) {
          if (!是会话目录(sid)) continue
          if (archived.has(sid)) continue
          if (!existsSync(join(sessRoot, ws, sid, 'session.v4.jsonl.zstd'))) continue
          let at = 0
          let blank = false
          try {
            const meta = readJson(join(cacheDir, sid + '.json'), {})?.record?.rows?.sessionListMetadata?.val || {}
            at = Number(meta.lastPromptAt || 0)
            blank = Boolean(meta.blank)
          } catch {}
          if (blank) continue
          if (!best || at > best.at) best = { id: sid, at }
        }
      }
      return best ? best.id : ''
    } catch { return '' }
  }

  // ⭐ 最后兜底：一个可用会话都没有时，新建一个（用完就收，别一直占着）
  //
  // ⚠⚠ 2026-10-24 修（用户报错）：
  //   `本轮运行失败  agent "session-…" has no provider/model: set AgentOptions.provider and
  //    AgentOptions.model or supply both via the agent/request waterfall`
  //   真因：这里新建 agent 时**没给模型**。宿主不会替它猜，于是一开跑就失败。
  //   只有「设置里没选目标会话、又没任何聊过的会话」时才会走到这条路，所以大部分人碰不到。
  //   → 现在按三级取模型：① 设置里的子代理模型 ② 当前/最近会话正在用的模型 ③ 都没有就**不建**，
  //     并写清楚该去哪儿设，别丢给用户一句看不懂的英文。
  const 取兜底模型 = () => {
    const p = String(cfg.subProvider || '').trim()
    const m = String(cfg.subModel || '').trim()
    if (p && m) return { provider: p, model: m }
    try {
      const 参照 =
        (typeof ctx.agents?.currentInitiator === 'function' ? ctx.agents.currentInitiator() : null) ||
        ((typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []) || [])[0]
      const c = 参照?.session?.requestHeader?.()?.config
      if (c && c.provider && c.model) return { provider: c.provider, model: c.model }
    } catch { /* 拿不到就算了 */ }
    return null
  }

  const createScanSession = async () => {
    if (typeof ctx.agents?.create !== 'function') return { id: '', agent: null }
    try {
      const 模型 = 取兜底模型()
      if (!模型) {
        log('自动刷：没有可用会话，想临时建一个，但**不知道该用哪个模型**（设置里的子代理模型是空的，也没有活着的会话可参照）')
        log('   → 去设置 → 刷B站：「自动刷在哪个会话」挑一个，或者在「派子代理刷的模型」里选一个')
        return { id: '', agent: null }
      }
      const sid = 'session-' + randomUUID()
      const handle = await ctx.agents.create({
        sessionId: sid,
        meta: { cwd: stateDir },
        agentOptions: { provider: 模型.provider, model: 模型.model },
      })
      const agent = handle?.agent || null
      let done = false
      const dispose = () => {
        if (done) return
        done = true
        try { handle?.dispose?.() } catch {}
      }
      // 这一轮结束后再收（留 30 秒给收尾），另外兜一个 20 分钟上限
      try { agent?.ctx?.on?.('agent/turn-stopping', () => setTimeout(dispose, 30_000)) } catch {}
      setTimeout(dispose, 20 * 60_000)
      log('自动刷：没有可用会话，临时新建了一个（' + sid.slice(0, 20) + '…）')
      return { id: sid, agent }
    } catch (e) {
      log('自动刷：新建会话失败（' + (e?.message ?? e) + '）')
      return { id: '', agent: null }
    }
  }

  // ── 收到的 @ / 回复 ─────────────────────────────────────────────────
  //  ⭐ 设计：**宿主只负责「让她知道有人找」，回不回、怎么回是她自己的事。**
  //     不派子代理代回（那会变人机味）；不强制、不评分、不替她措辞。
  const inboxFile = join(stateDir, 'inbox.json')

  // ⭐ 返回 null = **不过滤**（谁都理）；返回 Set = 只理名单里这些人。
  //    ⚠️ 一开始是"留空就只理 dmUid"，可「别人回了我的评论」这条路的发送者**永远是别人**，
  //       拿自己的 UID 当白名单等于把整个功能锁死（2026-10-21 她实测踩到）。
  const inboxTargets = () => {
    const set = new Set()
    for (const x of String(cfg.inboxUids || '').split(/[,，\s]+/)) {
      if (/^\d+$/.test(x)) set.add(x)
    }
    return set.size ? set : null
  }

  const 收件键 = (it) => String(it.kind || 'x') + ':' + String(it.rpid || it.id || '')

  /** 只拉「@ / 回复」那两路（随叫随到也用这一份，别抄第二套） */
  async function pullAtReplies(options = {}) {
    return readAtReplies(call, { ...options, log })
  }

  async function pullInbox() {
    const items = await pullAtReplies()
    // ⭐ 第三路：私信（2026-10-22）—— 她 @ 完还能直接把视频转发给「我」，
    //    只认名单里那几个人发的（默认就是「私信 UID」那个号＝她本人）；别人发的记一条日志、不理。
    //    ⚠️ 一次分享多条要**全抽**，不能只取最近一条。
    try {
      const 名单 = []
      const 我 = Number(cfg.dmUid || 0)
      if (我 > 0) 名单.push(我)
      for (const x of String(cfg.inboxUids || '').split(/[,，\s]+/)) {
        if (/^\d+$/.test(x)) 名单.push(Number(x))
      }
      let 陌生人 = 0
      for (const uid of [...new Set(名单)]) {
        try {
          // ⚠️ 2026-10-24 修：以前只看最近 20 条 —— 自己回得多的时候，最近 20 条**全是自己发的**，
          //    对方那条转发被挤出窗口 ⇒ 收件箱永远是空的（她点「看一眼」看着就是「没用」）。
          //    现在往前翻 3 页；并且**自己发的**不算「陌生人」（那是噪音，不是别人乱发）。
          const raw = await call('bili_dm_recent', { size: 30, talker_id: uid, pages: 3 })
          const j = typeof raw === 'string' ? JSON.parse(raw) : raw
          const 我自己 = Number((j && j.me) || 0)
          for (const m of (j && j.items) || []) {
            if (Number(m.from_uid) !== uid) {
              if (Number(m.from_uid) !== 我自己) 陌生人++     // 别人发的一律不理
              continue
            }
            // ⚠️ 2026-10-24 修（她报的）：以前 `if (!bv) continue` —— **只认带视频的私信**，
            //    她单纯给 B站 那边发一句话（没有视频）就被静默丢掉，那边当然永远不回。
            //    现在纯文字私信也递；没视频就是「只说了一句话」，回法自然也不同（见 renderInbox / 触发语）。
            const bv = String(m.bv || '')
            const 话 = String(m.text || '').trim()
            if (!bv && !话) continue
            items.push({
              kind: 'dm', id: String(m.key || bv || m.ts), mid: uid,
              nickname: '你私信转发的', bvid: bv,
              content: 话.slice(0, 120),
              rpid: 0, root: 0, at: Number(m.ts) || 0,
            })
          }
        } catch (e) { log('收件箱：私信（' + uid + '）读失败 ' + (e?.message ?? e)) }
      }
      if (陌生人) log('收件箱：私信里有 ' + 陌生人 + ' 条不是名单里的人发的，没理')
    } catch (e) { log('收件箱：私信那一路出错 ' + (e?.message ?? e)) }
    return items
  }

  /** 今天已经回过「别人」几条（自己 @ 自己的不算额度） */
  function 今天回过别人几条() {
    try {
      const box = readJson(inboxFile, { seen: {} })
      const today = dayKey(new Date())
      const 自己 = Number(cfg.dmUid || 0)
      let n = 0
      for (const rec of Object.values(box.seen || {})) {
        if (!rec || !rec.replied || !rec.repliedAt) continue
        if (dayKey(new Date(Number(rec.repliedAt))) !== today) continue
        const mid = Number(rec.mid || 0)
        if (mid && mid === 自己) continue
        n++
      }
      return n
    } catch (e) { return 0 }
  }

  /**
   * 拉一遍，挑出「该让她知道的」。**只挑不记账** —— 真递出去了才记（见 commitInbox）
   * ⭐ 2026-10-24（她说的「点了没东西也要说一句，不然像按钮坏了」）：
   *    顺手把「为什么没挑出来」也数出来。只回一句「没有」，她自己分不清是 B站 真没有、
   *    还是被「同一条只提醒一次 / 每天额度」挡住了 —— 那种时候越看越像坏了。
   */
  async function pickInbox(选项 = {}) {
    // ⭐ 2026-10-25（她定的）：手动点「看一眼」= 她亲自要的 —— 不被「同一条只提醒一次」、
    //    「提醒次数到顶」、「每天最多回别人几条」这三道闸挡住；「回过了」「不在名单里」照旧跳过。
    const 手动 = Boolean(选项 && 选项.手动)
    const 统计 = { 拉到: 0, 回过: 0, 提过: 0, 次数到: 0, 额度挡: 0, 名单外: 0 }
    if (!cfg.inboxOn) return { items: [], 统计, 关了: true }
    const who = inboxTargets()   // null = 谁都理
    const box = readJson(inboxFile, { seen: {} })
    if (!box.seen || typeof box.seen !== 'object') box.seen = {}
    const out = []
    // ⭐ 一天最多回「别人」几条：自己 @ 自己的不算额度（那是必须回的）
    const 自己号 = Number(cfg.dmUid || 0)
    const 每天上限 = Math.max(0, Number(cfg.inboxPerDay ?? 5))
    let 别人余 = Math.max(0, 每天上限 - 今天回过别人几条())
    const 卡了 = []
    for (const it of await pullInbox()) {
      统计.拉到++
      if (who && !who.has(String(it.mid || ''))) { 统计.名单外++; continue }   // 填了名单 = 只理这些人；留空 = 谁都理
      const k = 收件键(it)
      const rec = box.seen[k] || { n: 0, replied: false }
      if (rec.replied) { 统计.回过++; continue }                            // 回过了就不再提
      if (!手动 && cfg.inboxOnceOnly && rec.n >= 1) { 统计.提过++; continue }   // 「同一条只提醒一次」
      if (!手动 && rec.n >= Math.max(1, Number(cfg.inboxMaxRemind || 2))) { 统计.次数到++; continue }
      const 是别人 = Number(it.mid || 0) !== 自己号
      if (是别人 && !手动) {
        if (别人余 <= 0) { 卡了.push(it); 统计.额度挡++; continue }            // 额度用完，这次不递
        别人余--
      }
      out.push(it)
    }
    if (卡了.length) {
      log('收件箱：今天回别人的额度用完了（' + 今天回过别人几条() + '/' + 每天上限 + '），'
        + 卡了.length + ' 条别人的先不递了')
    }
    return { items: out, 统计 }
  }

  /** 真的递出去了才记账 —— 没递成功就不算提醒过，下次还会提 */
  function commitInbox(items) {
    try {
      const box = readJson(inboxFile, { seen: {} })
      if (!box.seen || typeof box.seen !== 'object') box.seen = {}
      for (const it of items) {
        const k = 收件键(it)
        const rec = box.seen[k] || { n: 0, replied: false }
        rec.n = Number(rec.n || 0) + 1
        rec.lastAt = Date.now()
        rec.mid = Number(it.mid || 0)      // 谁的 —— 日额度只算「别人」
        rec.kind = String(it.kind || '')
        box.seen[k] = rec
      }
      // ⭐ 顺手剪枝：只留最近的 300 条。不然 seen 只增不减，一年后是个几万条的 JSON
      const 条目 = Object.entries(box.seen)
      if (条目.length > 300) {
        const 留 = 条目
          .sort((a, b) => Number((b[1] && b[1].lastAt) || 0) - Number((a[1] && a[1].lastAt) || 0))
          .slice(0, 300)
        box.seen = Object.fromEntries(留)
      }
      writeJson(inboxFile, box)
    } catch (e) { log('收件箱记账失败：' + (e?.message ?? e)) }
  }

  /** 她用 bili_reply 回完之后，把那个视频下待处理的都标成已回 */
  function markInboxReplied(bvid, rpid) {
    try {
      const box = readJson(inboxFile, { seen: {} })
      if (!box.seen) return
      let changed = false
      for (const k of Object.keys(box.seen)) {
        const rec = box.seen[k]
        // 同一条评论的精确匹配；没有 rpid 就按「这个视频处理过」整体放过
        if (rpid && k.endsWith(':' + String(rpid))) {
          rec.replied = true
          rec.repliedAt = Date.now()
          changed = true
        }
      }
      if (changed) writeJson(inboxFile, box)
    } catch (e) { log('收件箱记账失败：' + (e?.message ?? e)) }
  }

  /**
   * ⭐ 2026-10-22「门对门」：记住「这条 BV 是私信转进来的」，6 小时内有效。
   *    bili_scan 定点看这一条时据此关掉评论块 —— 私信进来的就只私信回。
   *    单独一个文件，别跟 inbox.json 的记账混在一起（那边是"递没递过"，这边是"哪条从哪来"）。
   */
  const dmShareFile = join(stateDir, 'dm-share.json')
  const DM_SHARE_TTL = 6 * 3600_000
  function markDmShares(items) {
    try {
      const list = (items || []).filter((it) => it && it.kind === 'dm' && it.bvid)
      if (!list.length) return
      const now = Date.now()
      const out = {}
      for (const [k, v] of Object.entries(readJson(dmShareFile, {}) || {})) {
        if (Number(v) && now - Number(v) < DM_SHARE_TTL) out[k] = Number(v)
      }
      for (const it of list) out[String(it.bvid)] = now
      writeJson(dmShareFile, out)
      log('收件箱：记下 ' + list.length + ' 条「私信转来的」，这几条这轮不发公开评论')
    } catch (e) { log('记私信来源失败（不影响）：' + (e?.message ?? e)) }
  }
  function isDmShare(bvid) {
    try {
      const t = Number((readJson(dmShareFile, {}) || {})[String(bvid || '')] || 0)
      return t > 0 && Date.now() - t < DM_SHARE_TTL
    } catch { return false }
  }

  /** 拼成一段人话（不是指令）—— 里面带 rpid / root，她用 bili_reply 回的时候要用 */
  function renderInbox(items) {
    const 自己 = Number(cfg.dmUid || 0)
    const 行 = (it) => {
      const 谁 = it.nickname || ('UID ' + it.mid)
      const 是私信 = it.kind === 'dm'
      if (是私信) {
        const 话0 = String(it.content || '').replace(/\s+/g, ' ').slice(0, 120)
        // 私信那条只说「你把这条转给我了」—— 不套「在…下面 …了你」，也不显示 rpid（私信没有）
        if (!it.bvid) {
          // ⭐ 纯文字私信（没带视频）：就一句话，照样要回，而且不用去评论区
          return '· ' + ownerName + ' 私信跟你说了一句：「' + 话0 + '」'
        }
        return '· 你私信转给我一条视频：「' + 话0 + '」' + String.fromCharCode(10) + '  ' + it.bvid
      }
      const 哪 = it.title ? '《' + it.title + '》下面' : '一个视频下面'
      const 啥 = it.kind === 'reply' ? '回了你的评论' : '@ 了你'
      const 话 = String(it.content || '').replace(/\s+/g, ' ').slice(0, 120)
      // ⚠️ 两个踩过的坑：bvid 自己就带「BV」前缀（原来写成「BV BV1xx」）；
      //    中文直接拼接会出现「下面@ 了你」（原来漏了空格）
      return '· ' + 谁 + ' 在' + 哪 + ' ' + 啥 + '：「' + 话 + '」\n  ' + it.bvid
        + '　rpid=' + (it.rpid || 0) + (it.root ? '　root=' + it.root : '')
    }
    // ⭐ 2026-10-22「门对门」：分三组，**每组各写各的回法** ——
    //    私信进来的私信回、评论区 @ 的在评论区回，不许串。
    //    （原来只有一句统一的"正文里不要手打@"，那是评论区的语法，
    //     私信那条吃到它就等于被叫去评论区回 —— 2026-10-22 主人指出）
    const ownerName = String(cfg.ownerName || '你')
    const 私信们 = items.filter((it) => it.kind === 'dm')
    const 我的 = items.filter((it) => it.kind !== 'dm' && Number(it.mid || 0) === 自己)
    const 别人 = items.filter((it) => it.kind !== 'dm' && Number(it.mid || 0) !== 自己)
    const 段 = []
    if (私信们.length) {
      const 有视频 = 私信们.some((it) => it.bvid)
      段.push((有视频
        ? '〔' + ownerName + ' 私信转给你 ' + 私信们.length + ' 条视频 —— 看完**私信回**〕'
        : '〔' + ownerName + ' 在 B站 私信里跟你说话 —— **私信回**〕')
        + String.fromCharCode(10) + 私信们.map(行).join(String.fromCharCode(10))
        + String.fromCharCode(10) + '  ↳ 回法：用 `bili_send_message` 私信回她，**不发评论、不 @**；'
        + '话里**不用带 BV 号**（她转给你的，她知道是哪条）。')
    }
    if (我的.length) {
      段.push('〔' + ownerName + ' 在评论区找你了 —— 在**评论区**回〕'
        + String.fromCharCode(10) + 我的.map(行).join(String.fromCharCode(10))
        + String.fromCharCode(10) + '  ↳ 回法：用 `bili_reply` 在评论区回（楼中楼带 root）；'
        + '正文里**不要**手打 @，B站会自己加「回复 @某某」。**不用再私信说一遍**。')
    }
    if (别人.length) {
      段.push('〔别人回了你的评论 —— 想回就回，也是在评论区回〕'
        + String.fromCharCode(10) + 别人.map(行).join(String.fromCharCode(10))
        + String.fromCharCode(10) + '  ↳ 回法同上一类：评论区回，正文别手打 @。')
    }
    return 段.join(String.fromCharCode(10) + String.fromCharCode(10))
  }

  /** 找「伙伴住的那个会话」并拿到 agent —— 自动刷、随叫随到共用这一份。
   *  找不到就返回 null，原因已经写进日志（不留一句看不懂的英文给使用者）。 */
  const 取目标会话 = async (谁 = '自动刷', 指定 = '') => {
    let target = String(指定 || cfg.targetSession || '').trim()
    if (!target) target = pickRecentSession()          // 没选 → 最近聊过的那个
    let agent = null
    if (!target) {
      const made = await createScanSession()           // 实在没有 → 临时新建
      target = made.id
      agent = made.agent
    }
    if (!target) { log(谁 + '：找不到可用的目标会话（请在设置里选一个会话）'); return null }
    if (!agent) {
      try { agent = ctx.agents?.get?.(target) } catch {}
    }
    if (!agent) agent = (ctx.agents?.list?.() || []).find((a) => 会话键(sessionIdOf(a.session)) === 会话键(target))
    if (!agent) { log(谁 + '：目标会话现在没醒着（' + target.slice(0, 20) + '…）—— 先去那儿说句话再等下一轮'); return null }
    if (typeof agent.followup !== 'function') { log(谁 + '：agent 没有 followup'); return null }
    return { target, agent }
  }

  // ⭐ 到点自动发动态（2026-10-26，主人要的）：**不绑当前对话** —— 到点插件把一句话派给
  //    设置里选的那个会话（留空 = 跟自动刷同一个），那边的伙伴自己读报告、写动态、回评论。
  //    三条约束：① 每天只派一次（state.json 的 dynTickDay 记账）② 错过超过 3 小时就不补
  //    （免得半夜或第二天早上突然发）③ 跟刷站那套完全独立，不看谷时、不看 autoMode。
  const 动态时间窗 = (now) => {
    const t = String(cfg.dynamicTime || '').trim()
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t)
    if (!m) return false
    const target = new Date(now)
    target.setHours(Number(m[1]), Number(m[2]), 0, 0)
    const diff = now.getTime() - target.getTime()
    return diff >= 0 && diff <= 3 * 60 * 60 * 1000
  }

  const triggerDynamicPost = async (why = 'auto') => {
    const 递 = await 取目标会话('到点发动态', String(cfg.dynamicSession || '').trim())
    if (!递) return false
    const { target, agent } = 递
    const ownerN = String(cfg.ownerName || '你')
    const 文案 = (String(cfg.dynamicPrompt || '').trim() || DYNAMIC_TMPL)
      .split('{owner}').join(ownerN)
      .split('{home}').join(stateDir)
    const msg = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 文案 }],
      source: { kind: 'bili-duty-dynamic' },
    }
    try {
      await agent.followup(msg)
      log('到点发动态：已派给会话 ' + target.slice(0, 20) + '…（' + why + '）')
      return true
    } catch (e) {
      log('到点发动态：派活失败 ' + (e?.message ?? e))
      return false
    }
  }

  // 定时器每跳都会调它：先记账再派，派不出去就把记账退回，下一分钟还能重试
  let 动态派活中 = false
  const 动态那一跳 = async () => {
    if (动态派活中) return
    if (!cfg.dynamicAutoOn || !cfg.dynamicOn) return
    const now = new Date()
    const today = dayKey(now)
    const st = readJson(dutyStateFile, {})
    if (st.dynTickDay === today) return
    if (!动态时间窗(now)) return
    动态派活中 = true
    try {
      writeJson(dutyStateFile, { ...st, dynTickDay: today })
      const ok = await triggerDynamicPost('auto')
      if (!ok) {
        const cur = readJson(dutyStateFile, {})
        if (cur.dynTickDay === today) {
          delete cur.dynTickDay
          writeJson(dutyStateFile, cur)
        }
      }
    } finally {
      动态派活中 = false
    }
  }

  const triggerFeiyuScan = async (why, extra, box) => {
    const 递 = await 取目标会话('自动刷')
    if (!递) return false
    const { target, agent } = 递
    const msg = {
      id: randomUUID(),
      role: 'user',
      // ⭐ 这段是设置页「自动刷触发语」，可改；留空回落到内置默认
      content: [{ type: 'text', text: (() => {
        const ownerN = String(cfg.ownerName || '你')
        const t = String(cfg.triggerPrompt || '').trim() || TRIGGER_TMPL
        const base = t.split('{owner}').join(ownerN)
        // ⭐ 2026-10-22「门对门」：这一轮如果只有私信，就别叫她去刷一整轮、也别叫她去评论 ——
        //    原来的触发语里有「该发评论发评论」，对私信那条是错的。
        const 全私信 = Array.isArray(box) && box.length > 0 && box.every((it) => it && it.kind === 'dm')
        const 有视频 = Array.isArray(box) && box.some((it) => it && it.kind === 'dm' && it.bvid)
        const 例外 = 全私信
          ? (有视频
            ? '⚠️ 这一轮只有' + ownerN + '私信转来的一条视频：**只看那一条**（`bili_scan` 传 bvid），别刷整轮；'
              + '看完**私信回她**，不要发评论、不要 @、也不要去评论区。' + String.fromCharCode(10) + String.fromCharCode(10)
            : '⚠️ 这一轮只是' + ownerN + '在 **B站 私信**里跟你说了一句话（没带视频）：'
              + '**不用刷、不用看视频、也不用去评论区**；看完**用 `bili_send_message` 私信回**她，'
              + '话里不用带 BV 号。' + String.fromCharCode(10) + String.fromCharCode(10))
          : ''
        // ⭐ 有 @ / 回复就一起递过去：一条消息里说完，别连着弹两下
        return 例外 + (extra ? base + String.fromCharCode(10) + String.fromCharCode(10) + extra : base)
      })() }],
      source: { kind: 'bili-duty-scan' },
    }
    try {
      await agent.followup(msg)
      // ⭐ 递出去了才记「这条是从私信来的」—— 没递进去就别乱关评论块
      if (Array.isArray(box) && box.some((it) => it && it.kind === 'dm')) markDmShares(box)
      log('自动刷：已触发伙伴自己刷一轮（' + why + '，会话 ' + target.slice(0, 20) + '…）')
      return true
    } catch (e) {
      log('自动刷：触发失败 ' + (e?.message ?? e))
      return false
    }
  }

  // ⭐ 自动刷时段：三档（0.7.1 起）—— manual 只手动 / valley 只在谷时 / always 全天都跑
  //    老开关 peakValley 还认（开 = valley，关 = manual），见 迁移老配置
  const 自动模式 = () => {
    const m = String(cfg.autoMode || '')
    if (m === 'manual' || m === 'valley' || m === 'always') return m
    return cfg.peakValley ? 'valley' : 'manual'
  }

  // ⭐ 谷时定时器：每 60 秒看一次，满足四件事才跑
  //    ① 自动刷不是「只手动」 ② 今天自动刷的轮数没到上限 ③ 现在落在某个谷时窗口里（全天模式不看这条）
  //    ④ 离上一轮已经隔够「两轮之间至少隔几分钟」
  //    ★ 2026-10-19 改：原来「每个窗口每天只跑一次」（windows[key] 打勾）⇒ 一天最多 3 轮，
  //      perDay 填 5 永远用不满。现在改成**窗口内按间隔轮转**，直到额度用完。
  //    ★ 2026-10-22 改：判时段不看星期的问题修了（周末整天算谷时，用 inValley）；
  //      间隔从「小时」改成「分钟」，想跑密的人能调到 5 分钟一轮。
  const tick = () => {
    try {
      refreshCfg()                    // ⭐ 定时器活得比设置页久：每一跳都重新读一遍配置
      // ⭐ 到点发动态跟刷站那条路完全独立（不看谷时、不看 autoMode），所以放在下面「只手动」早退之前
      Promise.resolve(动态那一跳()).catch((e) => log('到点发动态那一跳出错（已兜住）：' + (e?.message ?? e)))
      const 模式 = 自动模式()
      if (模式 === 'manual') return
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      const used = countPickedToday(now)
      if (used >= Number(cfg.perDay || 0)) return
      // ⭐ 两轮之间至少隔这么久（手动跑不受这个限制）
      const gapMs = Math.max(5, Number(cfg.gapMin) || 180) * 60_000
      const lastAt = Date.parse(String(st.lastRunAt || '')) || 0
      if (lastAt && now.getTime() - lastAt < gapMs) return
      // 全天模式 = 一个「永远开着」的窗口；谷时模式 = 勾了的那几个窗口
      const 候选 = 模式 === 'always'
        ? [{ k: 'always', w: null }]
        : ['noon', 'night'].filter((k) => cfg[k]).map((k) => ({ k, w: WINDOWS[k] }))
      for (const { k, w } of 候选) {
        if (w && !inValley(now, w)) continue
        const key = `${today}:${k}`
        const rounds = used + 1
        const before = { windows: st.windows || {}, count: st.count || 0, picked: st.picked || 0, lastRunAt: st.lastRunAt || null, lastWhy: st.lastWhy || null }
        bumpState({ windows: { ...(st.windows || {}), [key]: true }, count: rounds, picked: rounds, lastRunAt: now.toISOString(), lastWhy: k })
        Promise.resolve((async () => {
          let extra = ''
          let box = []
          try {
            const 收件 = await pickInbox()
            box = 收件.items
            if (box.length) {
              extra = renderInbox(box)
              log('收件箱：这一轮递过去 ' + box.length + ' 条（@ / 回复）')
            }
          } catch (e) { log('收件箱：这一轮拉取失败 ' + (e?.message ?? e)) }
          let sent = false
          try {
            sent = await triggerFeiyuScan(`window:${k}`, extra, box)
            if (sent && box.length) commitInbox(box)   // 真递出去了才记账
          } catch (e) { log('收件箱：投递异常 ' + (e?.message ?? e)) }
          return sent
        })())
          .then((ok) => {
            // ⭐ 没投出去（目标会话没醒着之类）⇒ 把额度和间隔都退回去，下个周期还能重试
            if (ok === false) {
              bumpState(before)
              log('自动刷：这一轮没投出去，额度已退回，稍后重试')
            }
          })
          .catch((e) => { log('自动刷：投递异常（已兜住）' + (e?.message ?? e)) })
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()                                    // 别因为这个定时器让进程不肯退出
    ctx.effect(() => () => clearInterval(timer), 'bili-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  // ── 随叫随到：有人找我就马上告诉你 ─────────────────────────────────
  //  ⭐ 2026-10-24：刷一轮要等谷时，中间有人 @ 你、私信你，本来得等到下一轮才知道。
  //     现在隔一会儿问一句，有新东西立刻递到伙伴手上 —— 不用等下一轮。
  //  ⚠️ B站 没有推送接口（没有 webhook、没有回调地址），所谓「立马」只能是**定时去问**：
  //     所以先问一个最小的「未读数」（一个请求、几百字节），数字变了才去读具体是谁说了什么。
  //     不能每跳都把私信列表全拉一遍 —— 那既不省流量，也更容易被风控。
  //  ⚠️ 这只是**通知**，不是代回：回不回、怎么回、要不要看视频，都是她自己的事。
  const watchFile = join(stateDir, 'watch.json')

  const 提醒间隔毫秒 = () => 钳提醒间隔(cfg.watchInterval) * 1000
  const 现在是谷时 = (now) => inValley(now, WINDOWS.noon) || inWindow(now, WINDOWS.night)

  /** 私信那一路：先看谁有未读，再只读那几个人的最近几条 */
  async function 收私信(feed) {
    const box = readJson(watchFile, { seen: {} })
    if (!box.seen || typeof box.seen !== 'object') box.seen = {}
    const raw = await call('bili_dm_sessions', { size: 10 }, { timeoutMs: 40_000 })
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!j || j.ok === false || j.error) { log('提醒：私信会话列表读不到 ' + (j?.error ?? '')); return }
    const 有新 = (j.items || []).filter((x) => Number(x.unread) > 0).slice(0, 3)
    for (const s of 有新) {
      let msgs = []
      try {
        const r2 = await call('bili_dm_recent', { size: 10, talker_id: Number(s.talker_uid) }, { timeoutMs: 40_000 })
        const j2 = typeof r2 === 'string' ? JSON.parse(r2) : r2
        if (!j2 || j2.error || j2.ok === false) throw new Error(j2?.error || '私信内容读不到')
        msgs = (j2 && j2.items) || []
      } catch (e) {
        // 一个人读不到，别把整条私信路（更别把 @ 那一路）带塌
        log('提醒：读私信内容失败（' + (s.nick || s.talker_uid) + '）' + (e?.message ?? e))
        continue
      }
      for (const m of msgs) {
        if (Number(m.from_uid) !== Number(s.talker_uid)) continue     // 只理别人发过来的
        const k = 'dm:' + String(m.key || m.ts)
        if (box.seen[k]) continue
        feed.push({
          键: k,
          谁: String(s.nick || '') || ('UID ' + s.talker_uid),
          内容: 剪短发(m.text),
          bv: String(m.bv || ''),
          ts: Number(m.ts) || 0,
        })
      }
    }
  }

  /** @ / 回复那一路：跟「每轮顺手看一眼」共用一份账（inbox.json），所以不会两边重复提 */
  async function 收提醒(feed) {
    const box = readJson(inboxFile, { seen: {} })
    if (!box.seen || typeof box.seen !== 'object') box.seen = {}
    for (const it of await pullAtReplies({ strict: true })) {
      const k = 收件键(it)
      const rec = box.seen[k]
      if (rec && Number(rec.n || 0) >= 1) continue    // 提过就不再提（这条只报一次，不像"没回再提"）
      feed.push({
        键: '',
        谁: String(it.nickname || '有人'),
        内容: 剪短发(it.content),
        bv: String(it.bvid || ''),
        ts: Number(it.at) || 0,
        种类: String(it.kind || ''),
        原始: it,
      })
    }
  }

  async function watchOnce() {
    const 要私信 = cfg.watchDm !== false
    const 要提醒 = cfg.watchAt !== false
    if (!要私信 && !要提醒) return
    const now = new Date()
    if (String(cfg.watchScope || 'valley') === 'valley' && !现在是谷时(now)) return

    // ① 先问一句最小的：未读数（B站 一个请求就给全：私信 chat / @ at / 收到的回复 recv_reply）
    const 数 = await readWatchUnread(call)
    const 有私信 = 要私信 && Number(数.chat || 0) > 0
    const 有动静 = 要提醒 && (Number(数.at || 0) > 0 || Number(数.recv_reply || 0) > 0)
    if (!有私信 && !有动静) return          // ⭐ 绝大多数时候走这条：什么都没发生，就一个数字

    // ② 有新东西才去读具体内容
    const 私信 = []
    const 提醒 = []
    if (有私信) {
      // 两条路各自兜住：一个人读不到，不该让 @ 那一路整跳不跑
      try { await 收私信(私信) } catch (e) { log('提醒：私信那一路出错 ' + (e?.message ?? e)) }
    }
    if (有动静) {
      try { await 收提醒(提醒) } catch (e) { log('提醒：@ 那一路出错 ' + (e?.message ?? e)) }
    }
    await deliverWatchBatch({
      privateMessages: 私信,
      mentions: 提醒,
      deliver: async (batch) => {
        const 递 = await 取目标会话('提醒')
        if (!递) return false
        await 递.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: 拼提醒文案(batch) }],
          source: { kind: 'bili-watch' },
        })
        return true
      },
      acknowledge: (sentPrivate, sentMentions) => {
        // 只确认实际递出的批次；超出六条的消息留待下一轮。
        if (sentPrivate.length) {
          const box = readJson(watchFile, { seen: {} })
          if (!box.seen || typeof box.seen !== 'object') box.seen = {}
          for (const x of sentPrivate) box.seen[x.键] = { ts: Date.now() }
          const 条目 = Object.entries(box.seen)
          if (条目.length > 500) {
            const 留 = 条目.sort((a, b) => Number((b[1] && b[1].ts) || 0) - Number((a[1] && a[1].ts) || 0)).slice(0, 500)
            box.seen = Object.fromEntries(留)
          }
          box.lastAt = Date.now()
          writeJson(watchFile, box)
        }
        if (sentMentions.length) commitInbox(sentMentions.map((x) => x.原始))

        log('提醒：递过去 ' + (sentPrivate.length + sentMentions.length) + ' 条')
      },
    })
  }

  const watchTick = createWatchTick({
    refresh: refreshCfg,
    enabled: () => cfg.watchOn,
    intervalMs: 提醒间隔毫秒,
    run: watchOnce,
    onError: (e) => log('提醒：这一跳出错（已兜住）' + (e?.stack ?? e)),
  })

  try {
    const wtimer = setInterval(watchTick, 15_000)
    wtimer.unref?.()
    ctx.effect(() => () => clearInterval(wtimer), 'bili-duty: 随叫随到定时器')
  } catch (e) { log(`提醒定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    // ⚠️ 超过 1MB 得**先把 Promise 收掉**再掐断：只 destroy 的话它永远不 settle，
    //    这个请求就挂在那儿（不回响应、也不释放）
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const venvPython = () => venvPythonPath(join(stateDir, '.venv'))

  /**
   * 建 venv + 装依赖 —— ⭐ **起完就返回，不等它装完**。
   *
   * 🔴 为什么必须这样（2026-10-14 事故）：第一版是 `async` 全程 await，
   *    而"建 venv + pip install"在使用者这条网络上要**几分钟** ⇒ 那个工具调用一直挂着，
   *    **整个会话僵住、连"暂停"都卡，最后只能重启 dsh** ✗。
   *    现在的做法：spawn 出去、输出追加进 `install.log`，函数立刻返回；
   *    想知道装完没 —— 读日志，或看 `bili_duty_status` 里的 `installing`。
   * 依赖走**国内镜像**（使用者那条网络 pip 直连只有 ~24KB/s ✗；uv + 清华源是几十秒 ✓）。
   */
  let installing = false
  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 写不进去就算了 */ } }

  const haveUv = async () => {
    const ok = await new Promise((resolve) => {
      try {
        const c = spawn('uv', ['--version'], { windowsHide: true, stdio: 'ignore' })
        c.on('exit', (code) => resolve(code === 0))
        c.on('error', () => resolve(false))
      } catch { resolve(false) }
    })
    return ok
  }

  /** 探一下某个命令在不在（用于"这台机器有没有 python"）—— 陌生人第一条坎就卡在这儿 */
  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })

  const spawnLogged = (cmd, args) => new Promise((resolve) => {
    appendInstall(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try { c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv() }) }
    catch (e) { appendInstall(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => appendInstall(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { appendInstall(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { appendInstall(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  // ⭐ 判重表也由**宿主**预先建好（两个原因）：
  //   ① 那一轮被沙箱关着，"新建文件"会被拒（2026-10-14 那条规矩）；
  //   ② 它读不出判重表 ⇒ 以为"没记录过" ⇒ 同一批视频反复推送（用户实测反馈 2026-10-16）。
  const seenFile = join(stateDir, 'seen.md')
  try {
    if (!existsSync(seenFile)) {
      writeFileSync(seenFile, [
        '# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）',
        '',
        '## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）',
        '',
        '| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |',
        '| --- | --- | --- | --- | --- |',
        '',
        '## 看过的视频',
        '',
      ].join('\n'), 'utf8')
    }
  } catch { /* 建不了也别拦着插件加载 */ }


  /** 找 uv：系统里的 → 插件家里下好的 → 自己下一份（给"两样都没有"的人）；主/转写两套安装共用 */
  const resolveUv = async () => {
    if (await haveUv()) return 'uv'
    // 家里已经有一份就直接用：别再喊「我先下一份」，也别每次都同步探一遍版本（10 秒超时）
    const 家里那份 = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(家里那份)) return 家里那份
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
    if (got) appendInstall('uv 已就位：' + got + '\n')
    return got
  }

  /** 跟 spawnLogged 一样，但可以写进别的日志、可以带环境变量 */
  const spawnTo = (cmd, args, { sink = appendInstall, env = null } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd: stateDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  /** 装主依赖：建 venv + bilibili_api 那套（搜索 / 字幕 / 评论 用得到） */
  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装依赖 ===\n`)
    ;(async () => {
      try {
        const reqFile = join(pluginDir, 'vendor', 'bilibili-mcp', 'requirements.txt')
        const mirror = process.env.BILI_DUTY_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple'
        const venvPy = venvPython()
        const py = String(cfg.pythonPath || 'python')
          const uvCmd = await resolveUv()   // ⭐ 系统里的 → 家里下好的 → 自己下一份
        if (!existsSync(venvPy) && !uvCmd && !(await probeCmd(py))) {
          const msg = '这台机器上没有 uv，也没有可用的 python（试过 "' + py + '"），而且我自动下 uv 也没成功'
            + '（大概是网络到不了 GitHub / PyPI 镜像）。⇒ 请手动装 uv（单个 exe：https://docs.astral.sh/uv/）'
            + '或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次「装依赖」。'
          appendInstall(msg + '\n'); log(msg); installing = false; return
        }
        if (!existsSync(venvPy)) {
          // ⭐ 2026-10-17（issue #8③）：ASR 那个环境带了 --seed，主环境却漏了 ⇒ uv 建的 venv 默认不含 pip，
          //    一旦镜像失败、回退 `python -m pip` 就是 `No module named pip` ⇒ 连补救的路都没有 ✗
          if (uvCmd) await spawnLogged(uvCmd, ['venv', '--seed', join(stateDir, '.venv')])
          if (!existsSync(venvPy) && !uvCmd) await spawnLogged(py, ['-m', 'venv', join(stateDir, '.venv')])
        }
        let code = 1
        // ⭐ 2026-10-17（issue #8②）：镜像也会整站拒绝（清华对部分 IP 回 403，而 pip 的报错写成"这个包不存在"，很误导）
        //    ⇒ 一个镜像失败就换下一个，别让用户在一个死镜像上反复撞
        const mirrors = [mirror, 'https://mirrors.ustc.edu.cn/pypi/simple', 'https://mirrors.aliyun.com/pypi/simple']
        for (let i = 0; i < mirrors.length && code !== 0; i++) {
          const m = mirrors[i]
          if (i > 0) appendInstall(`\n--- 换个镜像再试：${m} ---\n`)
          if (uvCmd) code = await spawnLogged(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', reqFile])
          if (code !== 0) code = await spawnLogged(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', reqFile])
        }
        if (code === 0 && existsSync(venvPy)) {
          await persistCfg({ pythonPath: venvPy })   // ⭐ 不然设置页里显式设过 pythonPath 的话，这里就白写了
          appendInstall(`已把 pythonPath 设为 ${venvPy}\n`)
        }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装依赖结束：exit=${code} venvReady=${existsSync(venvPy)}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖 —— 进度就显示在下面（走国内镜像，通常几十秒到一两分钟）' }
  }

  /** 「测一下」：真跑一次查询再下结论（判据落在载荷上，不看自报） */
  const checkUp = async () => {
    const out = { ok: false, steps: [] }
    if (!venvReadyNow()) { out.error = '环境还没装好（可能上次装失败了）—— 点「重装主依赖」再试一次'; return out }
    if (!hasCredential()) { out.error = '还没登录：点「扫码登录」，手机 B站 扫一下'; return out }
    try {
      const who = await call('bili_check_credential', {})
      out.who = (typeof who === 'object' ? JSON.stringify(who) : String(who)).slice(0, 140)
      out.steps.push('登录有效')
    } catch (e) { out.error = '登录检查失败：' + (e?.message ?? e); return out }
    try {
      const s = await call('bili_search', { keyword: 'DeepSeek Harness', num: 3 })
      const t = typeof s === 'string' ? s : JSON.stringify(s)
      out.sample = t.slice(0, 160)
      out.steps.push('能搜到东西')
      out.ok = t.length > 2
      if (!out.ok) out.error = '搜到了空结果'
    } catch (e) { out.error = '搜索失败：' + (e?.message ?? e) }
    return out
  }

  let updateCache = null            // { at, latest } —— 检查更新的结果缓存

  const status = () => {
    refreshCfg()
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows: WINDOWS,
      today,
      // ⭐ 额度只有一个口径：**今天自动刷了几轮**（手动跑不占额度）
      autoRoundsToday: countPickedToday(),
      autoRoundsLeft: Math.max(0, Number(cfg.perDay || 0) - countPickedToday()),
      videosToday: countPicks(reportFileOf()),   // 今天报告里真挑到几条（含手动轮的）
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: hasCredential(),
      venvReady: venvReadyNow(),
      version: myVersion(),
      installFailed: !installing && !venvReadyNow() && (() => { try { return readFileSync(installLogFile, 'utf8').length > 0 } catch { return false } })(),
      installing,
      installLog: installLogFile,
      // ⭐ 让设置页能显示"装到哪了"（陌生人原来只看到一句"后台在装" ✗）
      installTail: (() => { try { return readFileSync(installLogFile, 'utf8').slice(-1400) } catch { return '' } })(),
      report: join(outDir, `${today}.md`),
      log: logFile,
    }
  }

  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库（地址从 package.json 读）
  const 自查更新 = createSelfUpdate({ packageRoot: pluginDir, diag: log })

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/bili-duty/update') {
      const r = await 自查更新.check(url.searchParams.get('refresh') === '1')
      return sendJson(res, 200, { ok: true, ...r })
    }
    // ⭐ 封面代理（2026-10-22）：浏览器直接拉 i0.hdslb.com 会把使用者的 IP 交给图床。
    //    这里由宿主代取 —— **只放行 B站 的图床域名**，别的地址一律拒（不然就成了公开代理）。
    if (req.method === 'GET' && path === '/api/bili-duty/cover') {
      const 原 = String(url.searchParams.get('u') || '')
      const 白名单 = ['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com']
      let 目标 = null
      try {
        // ⚠️ 2026-10-22 修：B站 笔记里存的封面地址是 **http://**，原来只认 https ⇒ 全部 400、图全裂。
        //    现在 http / https 都收，但**取的时候一律强制走 https**。
        const u = new URL(原)
        if (白名单.indexOf(u.hostname) >= 0) 目标 = new URL('https://' + u.hostname + u.pathname + u.search)
      } catch (e) {}
      if (!目标) { res.writeHead(400); return res.end('bad url') }
      try {
        const r = await fetch(目标, { headers: { referer: 'https://www.bilibili.com/' } })
        if (!r.ok) { res.writeHead(502); return res.end('fetch failed ' + r.status) }
        const buf = Buffer.from(await r.arrayBuffer())
        res.writeHead(200, {
          'content-type': r.headers.get('content-type') || 'image/jpeg',
          'cache-control': 'public, max-age=86400',
          'content-length': buf.length,
        })
        return res.end(buf)
      } catch (e) {
        res.writeHead(502); return res.end('fetch error')
      }
    }
    // ⭐ 卡片墙（2026-10-22）：把 reports/<BV>-<日期>.md 读成卡片列表
    if (req.method === 'GET' && path === '/api/bili-duty/cards') {
      const 夹 = join(outDir, 'reports')
      const cards = []
      try {
        for (const f of readdirSync(夹)) {
          if (!f.endsWith('.md')) continue
          const m = /^(BV[0-9A-Za-z]{10})-(\d{4}-\d{2}-\d{2})\.md$/.exec(f)
          if (!m) continue
          let text = ''
          try { text = readFileSync(join(夹, f), 'utf8') } catch (e) {}
          // ⭐ 标题：先读笔记头那条（B站 接口给的真标题），再退回正文里的「**标题**：」；
          //    都没有就留空 —— 卡片上就不显示标题，绝不显示「(没标题)」这种占位。
          const 标题 = (/^>\s*标题：(.+)$/m.exec(text) || [])[1]
            || (/^\*\*标题\*\*[：:]\s*(.+)$/m.exec(text) || [])[1]
            || ''
          const 封面 = (/^>\s*封面：(\S+)/m.exec(text) || [])[1] || ''
          cards.push({
            bvid: m[1], date: m[2], file: f,
            title: 标题.replace(/^#+\s*/, '').trim().slice(0, 80),
            cover: 封面,
          })
        }
      } catch (e) {}
      cards.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.bvid.localeCompare(b.bvid))
      return sendJson(res, 200, { ok: true, count: cards.length, cards })
    }
    if (req.method === 'GET' && path === '/api/bili-duty/status') return sendJson(res, 200, status())

    if (req.method === 'GET' && path === '/api/bili-duty/config') {
      // ⭐ defaults 一起发：设置页「恢复默认」按钮要用（不然别人不知道默认文案是啥）
      return sendJson(res, 200, { ok: true, config: cfg, defaults: DEFAULTS, windows: WINDOWS, home: stateDir })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/config') {
      const body = await readBody(req)
      const patch = {}
      // ⭐ 白名单 = DEFAULTS 的全字段（动态）：以后加任何配置，这里自动放行，再也不会漏
      for (const k of Object.keys(DEFAULTS)) {
        if (k in body) patch[k] = body[k]
      }
      // ⭐ 范围钳制 + 两份都写（config.json / DSH 原生设置页），统一走 persistCfg —— 见文件上方
      // ⭐ 私信那两个字段的合法值（2026-10-17 摘 PR #9；其余范围钳制统一在 persistCfg 里）
      if ('dmMode' in patch) patch.dmMode = ['off', 'only', 'both'].includes(String(patch.dmMode)) ? String(patch.dmMode) : 'off'
      if ('dmUid' in patch) patch.dmUid = Math.max(0, Math.min(Number(patch.dmUid) || 0, Number.MAX_SAFE_INTEGER))
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }

    // 「现在就去看一眼 @ 和回复」——手动版，不占自动刷的额度
    if (req.method === 'POST' && path === '/api/bili-duty/inbox') {
      try {
        const 收件 = await pickInbox({ 手动: true })
        const box = 收件.items
        const 统计 = 收件.统计
        if (!box.length) {
          // ⭐ 2026-10-24（她说的）：没东西也要**明说一句**，并且说清是被哪道闸挡的 ——
          //    只回一句「没有」的时候，用户分不清是 B站 真没有，还是按钮坏了。
          const 挡的 = []
          if (统计.提过) 挡的.push(统计.提过 + ' 条已经提过一次（设置里「同一条只提醒一次」开着）')
          if (统计.回过) 挡的.push(统计.回过 + ' 条你已经回过')
          if (统计.次数到) 挡的.push(统计.次数到 + ' 条提醒次数到顶了')
          if (统计.额度挡) 挡的.push(统计.额度挡 + ' 条撞上「一天最多回别人几条」')
          if (统计.名单外) 挡的.push(统计.名单外 + ' 条不在「还要理谁」名单里')
          const 话 = 收件.关了
            ? '「收到的 @ 和回复」这个开关是关着的 —— 现在完全不看。要看得先把它打开。'
            : (统计.拉到 === 0
              ? 'B站 那边这会儿没有新的 @、回复或私信。'
              : ('没有能递的：一共拉到 ' + 统计.拉到 + ' 条，' + 挡的.join('；') + '。'))
          log('收件箱（手动）：' + 话)
          return sendJson(res, 200, { ok: true, count: 0, stats: 统计, hint: 话 })
        }
        const text = renderInbox(box)
        const sent = await triggerFeiyuScan('inbox', text, box)
        if (sent) commitInbox(box)
        log('收件箱（手动）：' + box.length + ' 条，投递' + (sent ? '成功' : '失败'))
        return sendJson(res, 200, {
          ok: true, count: box.length, sent,
          hint: sent ? '已经递到会话里了 —— 切过去看她怎么回' : '拉到了，但没投递成功（会话没醒着？）',
          preview: text,
        })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/bili-duty/run') {
      refreshCfg()
      // ⭐ 跟「自动刷」完全同一条路：往选定会话里发一句话，让伙伴自己去派子代理
      //    （不再拿"当前第一个 agent"当父会话 —— 那样子代理会跑到别的会话里去）
      // ⚠️ 2026-10-24 修（她报的）：手动跑这一轮**以前不看收件箱** ——
      //    你私信转给它的视频、别人回你的评论，都得等定时那一轮才带上，
      //    所以「现在跑一轮」永远不回复私信。现在跟定时跑一样先拉一遍。
      let extra = ''
      let box = []
      try {
        const 收件 = await pickInbox()
        box = 收件.items
        if (box.length) {
          extra = renderInbox(box)
          log('收件箱（手动那一轮）：递过去 ' + box.length + ' 条')
        }
      } catch (e) { log('收件箱：手动那一轮拉取失败 ' + (e?.message ?? e)) }
      const started = await triggerFeiyuScan('manual', extra, box)
      if (started && box.length) commitInbox(box)
      log('「现在跑一轮」：' + (started ? '已投递到会话' : '没投递成功') + (box.length ? '（带 ' + box.length + ' 条 @/回复/私信）' : ''))
      return sendJson(res, 200, started
        ? {
          ok: true, started: true, inbox: box.length,
          hint: box.length
            ? '已经在选定的会话里叫它去刷了，顺带把 ' + box.length + ' 条 @/回复/私信一起递过去了'
            : '已经在选定的会话里叫它去刷了 —— 切过去看它的回复',
        }
        : { ok: false, error: '没投递成功：先在设置里选一个会话，或确保那个会话醒着（去说句话）' })
    }

    // 列出 DSH 里已配好的 providers + models（设置页下拉选择子代理模型用）
    if (req.method === 'GET' && path === '/api/bili-duty/models') {
      const providers = []
      try {
        for (const p of (ctx.llm?.listProviders?.() || [])) {
          const item = { id: p.id, name: p.name || p.id, models: [] }
          try {
            for (const m of (await ctx.llm.listModels?.(p.id)) || []) item.models.push({ id: m.id, name: m.name || m.id })
          } catch (e) { /* 某个 provider 拉不出模型列表就算了，别整单失败 */ }
          providers.push(item)
        }
      } catch (e) { log('列模型失败：' + (e?.message ?? e)) }
      return sendJson(res, 200, { ok: true, providers })
    }

    // 列出「会话」（自动刷在哪个会话触发用）
    //   以**磁盘上真实存在的会话目录**为准（投影缓存里混着已删会话的残留，不能直接拿它列）
    //   规则：跳过空会话（从没聊过）、跳过已归档、按最近活动排序
    if (req.method === 'GET' && path === '/api/bili-duty/sessions') {
      const list = []
      try {
        const base = join(dirname(stateDir), 'storages')
        const sessRoot = join(dirname(stateDir), 'sessions')
        const cacheDir = join(base, 'session_projcache', 'sessions')
        // ⭐ 归档名单：workspace.json 的 global.archivedSessionIds
        const archived = new Set()
        try {
          const w = readJson(join(base, 'workspace.json'), {})
          for (const id of (w?.global?.archivedSessionIds || [])) archived.add(String(id))
        } catch { /* 读不到就当没有归档 */ }
        const dirs = (p) => {
          try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
        }
        const rows = []
        for (const ws of dirs(sessRoot)) {
          for (const sid of dirs(join(sessRoot, ws))) {
            if (!是会话目录(sid)) continue                       // 子代理（纯 UUID）不要
            if (!existsSync(join(sessRoot, ws, sid, 'session.v4.jsonl.zstd'))) continue   // 没有日志 = 不算真会话
            if (archived.has(sid)) continue                                 // 跳过归档
            let title = ''
            let at = 0
            let blank = false
            try {
              const r = readJson(join(cacheDir, sid + '.json'), {})?.record?.rows || {}
              title = String(r?.title?.val || '')
              const meta = r?.sessionListMetadata?.val || {}
              at = Number(meta.lastPromptAt || 0)
              blank = Boolean(meta.blank)
            } catch {}
            if (blank) continue                                             // 从没聊过的空会话不列
            rows.push({ id: sid, title: title || sid, at })
          }
        }
        rows.sort((a, b) => b.at - a.at)                                     // 最近聊过的排前面
        for (const r of rows) list.push({ id: r.id, title: r.title })
      } catch (e) { log('列会话失败：' + (e?.message ?? e)) }
      return sendJson(res, 200, { ok: true, sessions: list })
    }

    // 建 venv + 装依赖（**不等它**：几分钟的活，进度写 install.log）
    if (req.method === 'POST' && path === '/api/bili-duty/install') {
      return sendJson(res, 200, runInstall())
    }

    // ⭐ 「复核评论」：拿判重表里最近的记录，去 B站 核一遍到底公开可见没有
    //    （设置页那个按钮、以及每轮结束 90 秒后自动跑一次，都走这里）
    if (req.method === 'POST' && path === '/api/bili-duty/verify') return sendJson(res, 200, await runVerify('manual'))

    // 「看今天的报告」：把报告的文本读出来给设置页显示（浏览器不能直接开本地文件 ✗）
    if (req.method === 'GET' && path === '/api/bili-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }

    // 「打开文件夹」：浏览器开不了本地目录 ⇒ 让宿主去开（只认 out / home 两个，别的不受理）
    if (req.method === 'POST' && path === '/api/bili-duty/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      // ⭐ 三种方式依次试（PATH 不全时 explorer.exe 会找不到 ✗；spawn 的失败是**异步**的，
      //    try/catch 抓不到 ⇒ 必须挂 'error' 监听，否则会升级成未捕获异常）
      // ⭐ 顺序很重要：把**最可能真的弹出窗口**的放第一（cmd start 走 shell 的 ShellExecute ✓）
      //    并且**不要再传 windowsHide**（2026-10-15 实测：传了以后"成功"但窗口不出现 ✗）
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
        ['powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath '" + dir.replace(/'/g, "''") + "'"]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) { log('打开文件夹：用了 ' + cmd + '（没报错；窗口不一定真弹出来了）'); return sendJson(res, 200, { ok: true, opened: dir, via: cmd }) }
        lastErr = err
        log('打开文件夹失败（' + cmd + '）：' + err)
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }

    // 「测一下」：真跑一次，回答"能不能用"
    if (req.method === 'POST' && path === '/api/bili-duty/check') {
      return sendJson(res, 200, await checkUp())
    }

    // ── 扫码登录（设置页用）──
    if (req.method === 'POST' && path === '/api/bili-duty/login/start') {
      const { key, url } = await loginStart()
      const png = await renderQrPng(cfg.pythonPath, stateDir, url)
      let qr = null
      if (png) { try { qr = 'data:image/png;base64,' + readFileSync(png).toString('base64') } catch { qr = null } }
      log(`出码：${url}${qr ? '（已画成 PNG）' : '（没画出 PNG —— venv 里大概还没有 qrcode）'}`)
      return sendJson(res, 200, { ok: true, key, url, qr })
    }

    if (req.method === 'POST' && path === '/api/bili-duty/login/poll') {
      const body = await readBody(req)
      const r = await loginPoll(String(body.key || ''))
      if (r.state === 'ok') {
        const file = saveCredential(stateDir, r.credential)
        log(`登录成功，凭证已写入 ${file}`)
        return sendJson(res, 200, { ok: true, state: 'ok', file })
      }
      return sendJson(res, 200, { ok: r.state !== 'unknown', state: r.state, code: r.code, message: r.message })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-duty: /api/bili-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'bili-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，python=${cfg.pythonPath}，自动刷=${自动模式()}，间隔=${Math.max(5, Number(cfg.gapMin) || 180)} 分钟）`)
}
