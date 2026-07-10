#!/usr/bin/env node
// Downloads an official Node.js runtime and normalises it into
// `src-tauri/runtime/` so Tauri can bundle it as a resource. The native bridge
// (`src-tauri/src/node_runtime.rs`) then runs *this* Node — guaranteeing the
// version the app ships with, independent of whatever the user has installed.
//
// Usage:
//   node scripts/fetch-node.mjs            # latest Node 26.x for this platform
//   NODE_VERSION=v26.0.0 node scripts/fetch-node.mjs
//   node scripts/fetch-node.mjs --force    # re-download even if present
//
// Layout produced (consumed by node_runtime.rs):
//   unix:    runtime/bin/node, runtime/lib/node_modules/npm/bin/npm-cli.js
//   windows: runtime/node.exe, runtime/node_modules/npm/bin/npm-cli.js

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const RUNTIME_DIR = join(ROOT, 'src-tauri', 'runtime')
const WANTED_MAJOR = 'v26.'
const force = process.argv.includes('--force')

function platformTriplet() {
  const platform = process.platform // 'darwin' | 'linux' | 'win32'
  const arch = process.arch // 'x64' | 'arm64'
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported arch for Node download: ${arch}`)
  }
  if (platform === 'darwin') return { os: 'darwin', arch, ext: 'tar.gz', win: false }
  if (platform === 'linux') return { os: 'linux', arch, ext: 'tar.gz', win: false }
  if (platform === 'win32') return { os: 'win', arch, ext: 'zip', win: true }
  throw new Error(`Unsupported platform for Node download: ${platform}`)
}

async function resolveVersion() {
  if (process.env.NODE_VERSION) return process.env.NODE_VERSION
  const res = await fetch('https://nodejs.org/dist/index.json')
  if (!res.ok) throw new Error(`Cannot list Node versions (HTTP ${res.status})`)
  const all = await res.json()
  const match = all.find((r) => r.version.startsWith(WANTED_MAJOR))
  if (!match) {
    throw new Error(
      `No Node ${WANTED_MAJOR}x release found upstream yet. ` +
        `Pin one explicitly with NODE_VERSION=vXX.Y.Z (e.g. the latest LTS) to bundle now.`,
    )
  }
  return match.version
}

async function download(url, dest) {
  console.log(`↓ ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dest, buf)
}

function extract(archive, into, win) {
  if (win) {
    // PowerShell is present on every supported Windows host.
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${into}'`], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', into], { stdio: 'inherit' })
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
  const already = existsSync(join(RUNTIME_DIR, 'bin', 'node')) || existsSync(join(RUNTIME_DIR, 'node.exe'))
  if (already && !force) {
    console.log('✓ Bundled Node runtime already present. Use --force to re-download.')
    return
  }

  const { os, arch, ext, win } = platformTriplet()
  const version = await resolveVersion()
  const name = `node-${version}-${os}-${arch}`
  const url = `https://nodejs.org/dist/${version}/${name}.${ext}`

  const work = join(tmpdir(), `gojs-node-${version}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const archive = join(work, `node.${ext}`)

  await download(url, archive)
  extract(archive, work, win)

  const extracted = join(work, name)
  if (!existsSync(extracted)) {
    // Some archives extract under a slightly different root; find it.
    const dirs = readdirSync(work, { withFileTypes: true }).filter((d) => d.isDirectory())
    const guess = dirs.find((d) => d.name.startsWith('node-'))
    if (!guess) throw new Error(`Could not locate extracted Node dir in ${work}`)
  }

  // Replace the runtime dir but keep the .gitkeep placeholder.
  rmSync(RUNTIME_DIR, { recursive: true, force: true })
  mkdirSync(RUNTIME_DIR, { recursive: true })
  cpSync(extracted, RUNTIME_DIR, { recursive: true })

  // Strip symlinks (npm/npx/corepack shims). Tauri's resource bundler can't
  // resolve them, and the native bridge invokes npm via `node npm-cli.js`
  // directly, so they are dead weight anyway.
  stripSymlinks(RUNTIME_DIR)

  rmSync(work, { recursive: true, force: true })
  console.log(`✓ Bundled Node ${version} (${os}-${arch}) into src-tauri/runtime`)
}

main().catch((err) => {
  console.error(`✗ fetch-node: ${err.message}`)
  console.error('  The desktop app will fall back to a system Node on PATH until this succeeds.')
  process.exit(1)
})
