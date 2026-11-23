#!/usr/bin/env node
// Downloads an official Node.js runtime and normalises it into
// `src-tauri/runtime/` so Tauri can bundle it as a resource. The native bridge
// (`src-tauri/src/node_runtime.rs`) then runs *this* Node — guaranteeing the
// version the app ships with, independent of whatever the user has installed.
//
// Usage:
//   node scripts/fetch-node.mjs
//   NODE_PLATFORM=darwin NODE_ARCH=arm64 node scripts/fetch-node.mjs
//   node scripts/fetch-node.mjs --force    # re-download even if present
//
// Layout produced (consumed by node_runtime.rs):
//   unix:    runtime/bin/node, runtime/lib/node_modules/npm/bin/npm-cli.js
//   windows: runtime/node.exe, runtime/node_modules/npm/bin/npm-cli.js

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIME_DIR = join(ROOT, 'src-tauri', 'runtime')
const NODE_VERSION = 'v26.5.0'
const RUNTIME_METADATA = join(RUNTIME_DIR, '.node-runtime.json')
const force = process.argv.includes('--force')

function platformTriplet() {
  const platform = process.env.NODE_PLATFORM ?? process.platform
  const arch = process.env.NODE_ARCH ?? process.arch

  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Invalid NODE_ARCH "${arch}". Expected "x64" or "arm64".`)
  }
  if (platform === 'darwin') return { os: 'darwin', arch, ext: 'tar.gz', win: false }
  if (platform === 'linux') return { os: 'linux', arch, ext: 'tar.gz', win: false }
  if (platform === 'win32') return { os: 'win', arch, ext: 'zip', win: true }
  throw new Error(`Invalid NODE_PLATFORM "${platform}". Expected "darwin", "linux" or "win32".`)
}

async function download(url, dest) {
  console.log(`↓ ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function verifyChecksum(archive, archiveName) {
  const checksumsUrl = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`
  const res = await fetch(checksumsUrl)
  if (!res.ok) throw new Error(`Cannot download Node checksums (HTTP ${res.status})`)

  const checksums = await res.text()
  const expected = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archiveName)?.[0]

  if (!expected) throw new Error(`No official checksum found for ${archiveName}`)

  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archiveName}`)
  }
}

function envWithoutPSModulePath(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
}

export function extract(
  archive,
  into,
  win,
  { exec = execFileSync, platform = process.platform, env = process.env } = {},
) {
  if (!win) {
    exec('tar', ['-xzf', archive, '-C', into], { stdio: 'inherit' })
    return
  }

  if (platform !== 'win32') {
    exec('unzip', ['-qo', archive, '-d', into], { stdio: 'inherit' })
    return
  }

  const expandCommand =
    "$ErrorActionPreference = 'Stop'; Expand-Archive -Force -LiteralPath $env:GOJS_ARCHIVE -DestinationPath $env:GOJS_DEST"
  const args = ['-NoProfile', '-Command', expandCommand]
  const baseEnv = { ...env, GOJS_ARCHIVE: archive, GOJS_DEST: into }

  // Prefer PowerShell 7 (`pwsh`) when available: Windows PowerShell 5.1 can
  // inherit `PSModulePath` from a parent `pwsh` session and load an
  // incompatible `Microsoft.PowerShell.Archive` module (.NET 5+ 3-arg
  // `ZipFile::ExtractToDirectory` overload).
  try {
    exec('pwsh', args, { stdio: 'inherit', env: baseEnv })
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
    // Fall back to Windows PowerShell 5.1 with a clean `PSModulePath` so it
    // loads its own built-in `Microsoft.PowerShell.Archive` module.
    exec('powershell', args, { stdio: 'inherit', env: envWithoutPSModulePath(baseEnv) })
  }
}

function stripSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) {
      unlinkSync(full)
    } else if (entry.isDirectory()) {
      stripSymlinks(full)
    }
  }
}

async function main() {
  const { os, arch, ext, win } = platformTriplet()
  const metadata = JSON.stringify({ version: NODE_VERSION, platform: os, arch }, null, 2)
  const nodeBinary = win ? join(RUNTIME_DIR, 'node.exe') : join(RUNTIME_DIR, 'bin', 'node')
  const npmCli = win
    ? join(RUNTIME_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(RUNTIME_DIR, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const already =
    existsSync(nodeBinary) &&
    existsSync(npmCli) &&
    existsSync(RUNTIME_METADATA) &&
    readFileSync(RUNTIME_METADATA, 'utf8').trim() === metadata.trim()

  if (already && !force) {
    console.log(`✓ Node ${NODE_VERSION} (${os}-${arch}) runtime already present.`)
    return
  }

  const name = `node-${NODE_VERSION}-${os}-${arch}`
  const archiveName = `${name}.${ext}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`

  const work = join(tmpdir(), `gojs-node-${NODE_VERSION}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const archive = join(work, `node.${ext}`)

  try {
    await download(url, archive)
    await verifyChecksum(archive, archiveName)
    extract(archive, work, win)

    let extracted = join(work, name)
    if (!existsSync(extracted)) {
      const dirs = readdirSync(work, { withFileTypes: true }).filter((d) => d.isDirectory())
      const guess = dirs.find((d) => d.name.startsWith('node-'))
      if (!guess) throw new Error(`Could not locate extracted Node dir in ${work}`)
      extracted = join(work, guess.name)
    }

    rmSync(RUNTIME_DIR, { recursive: true, force: true })
    mkdirSync(RUNTIME_DIR, { recursive: true })
    cpSync(extracted, RUNTIME_DIR, { recursive: true })

    // Tauri cannot bundle symlinks. The bridge invokes npm-cli.js directly.
    stripSymlinks(RUNTIME_DIR)
    writeFileSync(RUNTIME_METADATA, `${metadata}\n`)
    writeFileSync(join(RUNTIME_DIR, '.gitkeep'), '')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  console.log(`✓ Bundled Node ${NODE_VERSION} (${os}-${arch}) into src-tauri/runtime`)
}

function isEntrypoint() {
  if (!process.argv[1]) return false
  try {
    const entry = realpathSync(process.argv[1])
    const self = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(`✗ fetch-node: ${err.message}`)
    console.error('  The desktop app will fall back to a system Node on PATH until this succeeds.')
    process.exit(1)
  })
}
