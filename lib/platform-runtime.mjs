import { join } from 'node:path'

// Official assets: https://github.com/astral-sh/uv/releases/tag/0.13.5
const TARGETS = {
  win32: { x64: 'x86_64-pc-windows-msvc.zip', arm64: 'aarch64-pc-windows-msvc.zip', ia32: 'i686-pc-windows-msvc.zip' },
  darwin: { x64: 'x86_64-apple-darwin.tar.gz', arm64: 'aarch64-apple-darwin.tar.gz' },
  linux: { x64: 'x86_64-unknown-linux-gnu.tar.gz', arm64: 'aarch64-unknown-linux-gnu.tar.gz', ia32: 'i686-unknown-linux-gnu.tar.gz' },
}

export function selectUvAsset(platform, arch) {
  const targets = Object.hasOwn(TARGETS, platform) ? TARGETS[platform] : null
  const target = targets && Object.hasOwn(targets, arch) ? targets[arch] : null
  return target ? { name: `uv-${target}`, bin: platform === 'win32' ? 'uv.exe' : 'uv' } : null
}

export function venvPythonPath(root, platform = process.platform) {
  return platform === 'win32' ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python')
}

export function restorePythonPath(saved, root, exists, platform = process.platform) {
  if (saved && saved !== 'python' && exists(saved)) return saved
  const candidate = venvPythonPath(root, platform)
  return exists(candidate) ? candidate : saved
}
