#!/usr/bin/env node
/**
 * bin/qr.mjs —— 秒出 B站 扫码登录二维码（独立于 DSH 界面运行）
 * ============================================================================
 * 解决什么：走 DSH 设置页/聊天工具出码，码存在固定文件名里，容易被各层缓存成旧码，
 *          加上 PNG 有效期只有 ~3 分钟，常常"拿到的瞬间就快过期"。
 *
 * 这里一次做三件事：
 *   ① 终端里直接画出二维码（半块字符，扫屏幕就行 —— 不经过任何图片缓存）
 *   ② 同时存一张**文件名唯一**的 PNG 并调用系统看图器打开（%TEMP%\bili-qr\）
 *   ③ 持续轮询；码过期就**自动换一张新的**并重新展示，直到扫上或超时
 *
 * 用法：
 *   node bin/qr.mjs                  # 出码 + 轮询 + 过期自动换新（默认跑 15 分钟）
 *   node bin/qr.mjs --dry            # 只出一张码，不轮询（自检用）
 *   node bin/qr.mjs --once           # 只出一张码，过期就退出，不自动换
 *   node bin/qr.mjs --no-open        # 不弹系统看图器
 *   node bin/qr.mjs --no-ascii       # 终端里不画二维码
 *   node bin/qr.mjs --timeout 300    # 总共跑 300 秒
 *   node bin/qr.mjs --out D:\qrimg   # PNG 放哪儿
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginStart, loginPoll, saveCredential } from '../lib/login.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const val = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
if (has('--help') || has('-h')) {
  console.log(`用法: node bin/qr.mjs [选项]

  --dry             只出一张码就退出（自检）
  --once            码过期就退出，不自动换新
  --no-open         不自动弹出系统看图器
  --no-ascii        终端里不画二维码
  --timeout <秒>    总时长，默认 900
  --out <目录>      PNG 输出目录，默认 %TEMP%\\bili-qr`)
  process.exit(0)
}

const DRY = has('--dry')
const ONCE = has('--once')
const OPEN = !has('--no-open')
const ASCII = !has('--no-ascii')
const TOTAL_MS = Math.max(30, Number(val('--timeout', 900)) || 900) * 1000
// ⚠️ 轮询别太慢：B站 在「确认」后只会在**下一次轮询**里回一次 code=0，
//    之后同一 key 立刻变 86038；间隔太大就容易只看到「已扫码 → 已失效」。
const POLL_MS = 800

// ── 路径 ────────────────────────────────────────────────────────────────────
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(HOME, 'bili-duty')
const OUT_DIR = val('--out', join(tmpdir(), 'bili-qr'))
const PY = [
  join(STATE_DIR, '.venv', 'Scripts', 'python.exe'),
  join(STATE_DIR, '.venv', 'bin', 'python'),
].find((p) => existsSync(p)) || 'python'

const ts = () => new Date().toTimeString().slice(0, 8)
const log = (m) => console.log(`[${ts()}] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 画码：一次 Python 调用，既存 PNG 又打印 ASCII ──────────────────────────
const PY_CODE = `
import sys, qrcode
url, png, want_ascii = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
qr = qrcode.QRCode(border=1, box_size=8)
qr.add_data(url)
qr.make(fit=True)
qr.make_image().save(png)
if want_ascii:
    qr.print_ascii(invert=True)
`

function drawQr(url, png) {
  return new Promise((resolve) => {
    // ⚠️ 不接管道：沙箱（以及某些加固环境）禁止开命名管道，`pipe` 会直接 EPERM。
    //    改成「stdout/stderr 重定向到一个临时文件」，跑完再读回来。
    const logFile = join(OUT_DIR, `.qr-out-${process.pid}.txt`)
    let fd = null
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      fd = openSync(logFile, 'w')
    } catch (e) {
      return done({ ascii: '', png: null, error: `打不开临时输出文件：${e.message}` })
    }
    let child
    try {
      child = spawn(PY, ['-c', PY_CODE, url, png, ASCII ? '1' : '0'], {
        cwd: OUT_DIR,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (e) {
      try { closeSync(fd) } catch {}
      return done({ ascii: '', png: null, error: `起不了 python（${PY}）：${e.message}` })
    }
    child.on('error', (e) => {
      try { closeSync(fd) } catch {}
      done({ ascii: '', png: null, error: e.message })
    })
    child.on('exit', (code) => {
      try { closeSync(fd) } catch {}
      let out = ''
      try { out = readFileSync(logFile, 'utf8') } catch {}
      try { rmSync(logFile, { force: true }) } catch {}
      const ok = code === 0 && existsSync(png)
      // 成功时 stdout 就是二维码；失败时整个文件内容都是报错
      const err = ok ? '' : out.trim() || `python 退出码 ${code}`
      done({ ascii: ok ? out.trimEnd() : '', png: ok ? png : null, error: err })
    })
  })
}

function openImage(p) {
  try {
    const c = spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' })
    c.unref()
  } catch { /* 打不开就算了，PNG 路径已经打印出来 */ }
}

function pruneOutDir() {
  try {
    const files = readdirSync(OUT_DIR)
      .filter((f) => f.startsWith('qr-') && f.endsWith('.png'))
      .map((f) => ({ f, t: statSync(join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(5)) rmSync(join(OUT_DIR, f), { force: true })
  } catch { /* 清不掉不影响登录 */ }
}

// ── 登录后确认一下是谁（失败不致命）────────────────────────────────────────
async function whoami(cred) {
  try {
    const cookie = [
      cred.sessdata && `SESSDATA=${cred.sessdata}`,
      cred.bili_jct && `bili_jct=${cred.bili_jct}`,
      cred.buvid3 && `buvid3=${cred.buvid3}`,
      cred.dedeuserid && `DedeUserID=${cred.dedeuserid}`,
    ].filter(Boolean).join('; ')
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    })
    const j = await r.json()
    return j?.data?.isLogin ? `${j.data.uname}（UID ${j.data.mid}）` : null
  } catch {
    return null
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  if (!existsSync(STATE_DIR)) {
    console.error(`找不到插件家目录：${STATE_DIR}`)
    console.error('先把插件跑起来（设置 → 刷B站 → 装主依赖），或者设 DSH_HOME。')
    process.exit(2)
  }
  if (PY !== 'python' && !existsSync(PY)) log('警告：venv 里的 python 不在，退回 PATH 里的 python')

  const deadline = Date.now() + TOTAL_MS
  let round = 0

  while (Date.now() < deadline) {
    round += 1
    let started
    try {
      started = await loginStart()
    } catch (e) {
      console.error(`生成二维码失败：${e.message}`)
      process.exit(3)
    }

    const png = join(OUT_DIR, `qr-${started.key.slice(0, 8)}-${Date.now().toString(36)}.png`)
    const drawn = await drawQr(started.url, png)
    pruneOutDir()

    if (!drawn.png && !drawn.ascii) {
      console.error(`画二维码失败：${drawn.error || '未知原因'}`)
      console.error(`可以用这个链接在浏览器里登录：${started.url}`)
      process.exit(4)
    }

    log(`第 ${round} 张二维码已出（key ${started.key.slice(0, 8)}，约 3 分钟有效）`)
    if (ASCII && drawn.ascii) console.log('\n' + drawn.ascii + '\n')
    log(`链接：${started.url}`)
    if (drawn.png) {
      log(`PNG：${drawn.png}`)
      if (OPEN) openImage(drawn.png)
    }

    if (DRY) {
      log('--dry：只出码不轮询，退出。')
      return 0
    }

    // 轮询这张码
    let last = ''
    let scanned = false
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      const r = await loginPoll(started.key)
      if (r.state !== last) {
        last = r.state
        if (r.state === 'waiting') log('等扫码…')
        else if (r.state === 'scanned') { scanned = true; log('已扫码，等手机点「确认登录」…') }
        else if (r.state === 'expired') log(scanned ? '这张码扫过、但没等到手机点「确认」——再扫新的一张时，扫完直接点确认' : '这张码过期了')
        else if (r.state === 'ok') break
        else log(`状态：${r.state}（code ${r.code}）${r.message || ''}`)
      }
      if (r.state === 'ok') {
        const target = join(STATE_DIR, 'bili_credential.json')
        // ⚠️ 写凭证可能因为沙箱/权限失败（典型报错 EPERM）。这一步失败**不代表登录失败**，
        //    所以不能让它把进程带走，也不能不声不响地接着换码 —— 凭证先备份到可写目录。
        try {
          saveCredential(STATE_DIR, r.credential)
          log(`✅ 登录成功，凭证已写入 ${target}`)
        } catch (e) {
          log(`⚠️ 登录成功了，但凭证写不进去：${e?.message || e}`)
          const backup = join(OUT_DIR, 'bili_credential.json')
          try {
            writeFileSync(backup, JSON.stringify({
              sessdata: r.credential.sessdata ?? '',
              bili_jct: r.credential.bili_jct ?? '',
              buvid3: r.credential.buvid3 || '',
              dedeuserid: r.credential.dedeuserid ?? '',
            }, null, 2), 'utf8')
            log(`已先把凭证备份到：${backup}`)
            log(`把它复制成 ${target} 就能用（沙箱内要先拿到该目录的写权限）`)
          } catch (e2) {
            log(`备份也失败了：${e2?.message || e2}`)
          }
        }
        const who = await whoami(r.credential)
        if (who) log(`当前账号：${who}`)
        else log('（没验出昵称，不影响使用）')
        log('回 DSH 里就能直接用了 —— 不用重启也能刷。')
        return 0
      }
      if (r.state === 'expired') break
    }

    if (last === 'ok' || scanned) {
      // 扫了但没成功（极少见），别无限重来
      if (ONCE) return 1
    }
    if (ONCE) {
      log('--once：这张码没扫上，退出。')
      return 1
    }
    log('自动换一张新码…')
  }

  log(`超过 ${Math.round(TOTAL_MS / 1000)} 秒没扫上，退出。需要时再跑一次。`)
  return 1
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`出错：${e?.stack || e}`)
  process.exit(5)
})
