import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectUvAsset, venvPythonPath, restorePythonPath } from '../lib/platform-runtime.mjs'
import { ensureUv, uvRuns } from '../lib/uvfetch.mjs'

const assets = [
  ['win32', 'x64', 'x86_64-pc-windows-msvc.zip'],
  ['win32', 'arm64', 'aarch64-pc-windows-msvc.zip'],
  ['win32', 'ia32', 'i686-pc-windows-msvc.zip'],
  ['darwin', 'x64', 'x86_64-apple-darwin.tar.gz'],
  ['darwin', 'arm64', 'aarch64-apple-darwin.tar.gz'],
  ['linux', 'x64', 'x86_64-unknown-linux-gnu.tar.gz'],
  ['linux', 'arm64', 'aarch64-unknown-linux-gnu.tar.gz'],
  ['linux', 'ia32', 'i686-unknown-linux-gnu.tar.gz'],
]
for (const [platform, arch, name] of assets) {
  test(`official asset ${platform}/${arch}`, () => {
    assert.deepEqual(selectUvAsset(platform, arch), { name: `uv-${name}`, bin: platform === 'win32' ? 'uv.exe' : 'uv' })
  })
}
test('unsupported platforms do not fall back to Linux', async () => {
  for (const [platform, arch] of [['freebsd', 'x64'], ['linux', 'arm'], ['darwin', 'ia32'], ['toString', 'x64'], ['linux', 'constructor']]) {
    assert.equal(selectUvAsset(platform, arch), null)
    assert.equal(await ensureUv({ dir: 'unused' }, { platform, arch, fetch: () => assert.fail('network') }), null)
  }
})
for (const platform of ['win32', 'linux', 'darwin']) {
  test(`restore venv on ${platform}`, () => {
    const root = join('synthetic home', '.venv')
    const expected = platform === 'win32' ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python')
    assert.equal(venvPythonPath(root, platform), expected)
    for (const saved of [undefined, '', 'python', '/missing/python']) {
      assert.equal(restorePythonPath(saved, root, (p) => p === expected, platform), expected)
    }
    assert.equal(restorePythonPath('/custom/python', root, () => true, platform), '/custom/python')
    assert.equal(restorePythonPath('python', root, () => false, platform), 'python')
  })
}
test('version probe rejects exit, signal, errors and exceptions; bounds subprocess', () => {
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('timeout') }]) {
    assert.equal(uvRuns('synthetic', () => result), false)
  }
  assert.equal(uvRuns('synthetic', () => { throw Error('spawn') }), false)
  assert.equal(uvRuns('synthetic', (cmd, args, options) => {
    assert.equal(cmd, 'synthetic'); assert.deepEqual(args, ['--version'])
    assert.equal(options.timeout, 10000); assert.equal(options.shell, undefined)
    return { status: 0 }
  }), true)
})

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-platform-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
test('valid cached uv is probed and avoids downloads', () => fixture(async (dir) => {
  const target = join(dir, 'uv'); writeFileSync(target, 'cached')
  let probes = 0
  assert.equal(await ensureUv({ dir }, { platform: 'linux', arch: 'arm64', run: () => { probes++; return { status: 0 } }, fetch: () => assert.fail('network') }), target)
  assert.equal(probes, 1)
}))
test('invalid cached uv does not report ready when all downloads fail', () => fixture(async (dir) => {
  writeFileSync(join(dir, 'uv'), 'invalid'); const logs = []
  assert.equal(await ensureUv({ dir, log: (s) => logs.push(s) }, { platform: 'linux', arch: 'arm64', run: () => ({ status: 1 }), fetch: async () => ({ ok: false, status: 503 }) }), null)
  assert.equal(logs.some((s) => s.includes('uv 已就位')), false)
  assert.equal(readFileSync(join(dir, 'uv'), 'utf8'), 'invalid')
}))

function downloads({ failCandidate = false, failInstalled = false } = {}) {
  const urls = [], probes = [], extracted = []
  return {
    urls, probes, extracted,
    deps: {
      platform: 'linux', arch: 'arm64',
      fetch: async (url) => { urls.push(url); return url.endsWith('.sha256') ? { ok: false } : new Response('synthetic archive') },
      extract: (name, archive, into) => {
        assert.equal(existsSync(join(into, name)), false, 'each extraction must be fresh')
        const hit = join(into, name); writeFileSync(hit, 'synthetic executable'); extracted.push(hit); return hit
      },
      run: (cmd) => { probes.push(cmd); return { status: failCandidate || (failInstalled && !cmd.includes('unpack')) ? 1 : 0 } },
    },
  }
}
for (const [platform, arch, name] of assets) {
  test(`simulated installation ${platform}/${arch}`, () => fixture(async (dir) => {
    const d = downloads(); d.deps.platform = platform; d.deps.arch = arch
    const fetchArchive = d.deps.fetch
    d.deps.fetch = async (url) => url.endsWith('/pypi/uv/json') ? { json: async () => ({ urls: [] }) } : fetchArchive(url)
    assert.equal(await ensureUv({ dir }, d.deps), join(dir, platform === 'win32' ? 'uv.exe' : 'uv'))
    assert.ok(d.urls[0].endsWith(`uv-${name}`))
  }))
}
test('downloaded uv checks candidate and installed executable', () => fixture(async (dir) => {
  const d = downloads(); const target = join(dir, 'uv')
  assert.equal(await ensureUv({ dir }, d.deps), target)
  assert.deepEqual(d.probes, [d.extracted[0], target])
  assert.ok(d.urls[0].endsWith('uv-aarch64-unknown-linux-gnu.tar.gz'))
  assert.equal(existsSync(join(dir, '_tmp')), false)
}))
test('failed candidate never replaces cache and each source is isolated', () => fixture(async (dir) => {
  const d = downloads({ failCandidate: true }); const logs = []
  assert.equal(await ensureUv({ dir, log: (s) => logs.push(s) }, d.deps), null)
  assert.equal(d.extracted.length, 3)
  assert.equal(existsSync(join(dir, 'uv')), false)
  assert.equal(logs.some((s) => s.includes('uv 已就位')), false)
}))
test('failed installed executable is not accepted', () => fixture(async (dir) => {
  const d = downloads({ failInstalled: true }); const logs = []
  assert.equal(await ensureUv({ dir, log: (s) => logs.push(s) }, d.deps), null)
  assert.equal(d.probes.length, 6)
  assert.equal(logs.some((s) => s.includes('uv 已就位')), false)
}))
test('production configuration and installer use the tested helpers', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /out\.pythonPath = restorePythonPath\(saved\.pythonPath, join\(stateDir, '\.venv'\), existsSync\)/)
  assert.match(source, /const venvPython = \(\) => venvPythonPath\(join\(stateDir, '\.venv'\)\)/)
  assert.doesNotMatch(source, /if \(existsSync\(bundled\)\) return bundled/)
})
