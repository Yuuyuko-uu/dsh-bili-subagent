// Optional CI integration check. Downloads only official, version-pinned uv assets;
// it does not install Python, start DSH, or contact Bilibili.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectUvAsset } from '../lib/platform-runtime.mjs'
import { extractArchive } from '../lib/uvfetch.mjs'

const version = '0.13.5'
const asset = selectUvAsset(process.platform, process.arch)
assert.ok(asset, `Unsupported uv integration runner: ${process.platform}/${process.arch}`)
const base = `https://github.com/astral-sh/uv/releases/download/${version}/${asset.name}`
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok, `Download failed: HTTP ${response.status} (${url})`)
  return Buffer.from(await response.arrayBuffer())
}

const dir = mkdtempSync(join(tmpdir(), 'bili-official-uv-'))
try {
  // Fail closed: no proxy, mirror, missing-checksum fallback, or latest release.
  const checksum = (await download(`${base}.sha256`)).toString('utf8').trim()
  const expected = /^([a-f0-9]{64})(?:\s+\*?[^\r\n]+)?$/i.exec(checksum)?.[1]?.toLowerCase()
  assert.ok(expected, 'Official checksum is missing or malformed')
  const bytes = await download(base)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Official SHA-256 mismatch')
  const archive = join(dir, asset.name)
  writeFileSync(archive, bytes)
  const executable = extractArchive(asset.bin, archive, dir)
  assert.ok(executable, 'Could not extract official uv executable')
  if (process.platform !== 'win32') chmodSync(executable, 0o755)
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `uv --version failed: ${result.stderr}`)
  assert.match(result.stdout.trim(), /^uv 0\.13\.5(?:\s|$)/)
  console.log(`${process.platform}/${process.arch}: official SHA-256 verified; ${result.stdout.trim()}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
