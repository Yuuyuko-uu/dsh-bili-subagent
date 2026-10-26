import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const source = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bili-selfcheck-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugin = join(root, 'plugin with spaces')
  mkdirSync(plugin)
  // Copy only public source files needed by apply(); never copy runtime data or credentials.
  for (const name of ['package.json', 'selfcheck.mjs', 'index.js', 'client.js', 'lib', 'prompts', 'vendor']) {
    cpSync(join(source, name), join(plugin, name), { recursive: true })
  }
  const temporary = join(root, 'temporary')
  mkdirSync(temporary)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|comspec|pathext|windir|lang|lc_all)$/i.test(key))),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    HOME: root, USERPROFILE: root, APPDATA: root,
    DSH_HOME: join(root, 'synthetic home'), DSH_HOST_MODULES: join(root, 'absent-host-modules'),
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'absent-npmrc'),
    npm_config_globalconfig: join(root, 'absent-global-npmrc'), npm_config_update_notifier: 'false',
    NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1',
  }
  return { root, plugin, temporary, env }
}

function run(args, f, cwd = f.plugin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s })
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s })
    const timer = setTimeout(() => { child.kill(); reject(new Error('selfcheck exceeded 20 seconds')) }, 20_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function successful(result) {
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /✓ host 半端 OK/)
  assert.match(result.stdout, /✓ client 半端 OK/)
}

test('plain Node entry runs without a custom loader from another working directory', async (t) => {
  const f = fixture(t)
  assert.equal(existsSync(join(f.plugin, 'tools/register.mjs')), false)
  successful(await run([join(f.plugin, 'selfcheck.mjs')], f, f.root))
  assert.deepEqual(readdirSync(f.temporary), [])
})

test('npm exposes a runnable offline selfcheck entry', async (t) => {
  const f = fixture(t)
  assert.ok(existsSync(npmCli), `npm CLI missing at ${npmCli}`)
  successful(await run([npmCli, 'run', 'selfcheck', '--offline'], f))
  assert.deepEqual(readdirSync(f.temporary), [])
})

test('two real concurrent selfchecks own separate homes and clean up only their own data', async (t) => {
  const f = fixture(t)
  const barrier = join(f.root, 'barrier')
  mkdirSync(barrier)
  const hook = join(f.root, 'barrier.mjs')
  // Pause both processes immediately after stateDirOf() creates its home. This proves
  // both actual apply() calls overlap, without relying on sleep-based timing guesses.
  writeFileSync(hook, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
const original = fs.mkdirSync
let arrived = false
fs.mkdirSync = function(path, ...args) {
  const result = original.call(this, path, ...args)
  if (!arrived && basename(String(path)) === 'bili-duty') {
    arrived = true
    fs.writeFileSync(join(${JSON.stringify(barrier)}, process.pid + '.json'), JSON.stringify({ home: dirname(String(path)) }))
    const deadline = Date.now() + 10000
    while (fs.readdirSync(${JSON.stringify(barrier)}).length < 2) {
      if (Date.now() > deadline) throw new Error('concurrency barrier timed out')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return result
}
syncBuiltinESMExports()
`)
  const results = await Promise.all([
    run(['--import', pathToFileURL(hook).href, join(f.plugin, 'selfcheck.mjs')], f),
    run(['--import', pathToFileURL(hook).href, join(f.plugin, 'selfcheck.mjs')], f),
  ])
  for (const result of results) successful(result)
  const homes = readdirSync(barrier).map((file) => JSON.parse(readFileSync(join(barrier, file), 'utf8')).home)
  assert.equal(homes.length, 2, 'both processes reached apply()')
  assert.equal(new Set(homes).size, 2, 'concurrent selfchecks must not share a mutable home')
  for (const home of homes) assert.equal(existsSync(home), false, `home not cleaned: ${home}`)
  assert.deepEqual(readdirSync(f.temporary), [])
})

test('a failed host check returns nonzero and removes its synthetic home', async (t) => {
  const f = fixture(t)
  // Replace source only inside this newly created fixture, never in the real plugin.
  writeFileSync(join(f.plugin, 'index.js'), 'export function apply() { throw new Error("synthetic host failure") }\n')
  const result = await run([join(f.plugin, 'selfcheck.mjs')], f)
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /synthetic host failure/)
  assert.deepEqual(readdirSync(f.temporary), [], 'failed checks must also clean up')
})

test('selfcheck preserves an existing legacy temporary directory', async (t) => {
  const f = fixture(t)
  const legacy = join(f.temporary, 'dsh-bili-scroll-selfcheck')
  mkdirSync(legacy)
  const sentinel = join(legacy, 'synthetic-other-run.txt')
  writeFileSync(sentinel, 'belongs to another run')
  successful(await run([join(f.plugin, 'selfcheck.mjs')], f))
  assert.equal(readFileSync(sentinel, 'utf8'), 'belongs to another run')
  assert.deepEqual(readdirSync(f.temporary), ['dsh-bili-scroll-selfcheck'])
})
