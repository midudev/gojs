#!/usr/bin/env node

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const args = process.argv.slice(2)
const checkOnly = args[0] === '--check'
const input = checkOnly ? args[1] : args[0]

if (!input || args.length !== (checkOnly ? 2 : 1)) {
  throw new Error('Usage: node scripts/set-version.mjs [--check] <vX.Y.Z|X.Y.Z>')
}

const match = input.match(VERSION_PATTERN)
if (!match) {
  throw new Error(`Invalid stable version "${input}". Expected vX.Y.Z or X.Y.Z.`)
}

const version = `${match[1]}.${match[2]}.${match[3]}`
const files = {
  package: join(ROOT, 'package.json'),
  cargo: join(ROOT, 'src-tauri', 'Cargo.toml'),
  cargoLock: join(ROOT, 'src-tauri', 'Cargo.lock'),
  tauri: join(ROOT, 'src-tauri', 'tauri.conf.json'),
}

function readVersions() {
  const packageJson = JSON.parse(readFileSync(files.package, 'utf8'))
  const tauriConfig = JSON.parse(readFileSync(files.tauri, 'utf8'))
  const cargoToml = readFileSync(files.cargo, 'utf8')
  const cargoLock = readFileSync(files.cargoLock, 'utf8')
  const cargoPackage = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
  const cargoLockPackage = cargoLock.match(/(?:^|\n)\[\[package\]\]\nname = "gojs"\nversion = "([^"]+)"/)

  if (!cargoPackage) throw new Error('Could not find [package].version in src-tauri/Cargo.toml')
  if (!cargoLockPackage) throw new Error('Could not find the gojs package version in src-tauri/Cargo.lock')

  return {
    package: packageJson.version,
    cargo: cargoPackage[1],
    cargoLock: cargoLockPackage[1],
    tauri: tauriConfig.version,
  }
}

function updatePackageVersion(contents, nextVersion) {
  const packageJson = JSON.parse(contents)
  packageJson.version = nextVersion
  return `${JSON.stringify(packageJson, null, 2)}\n`
}

function updateCargoVersion(contents, nextVersion) {
  const updated = contents.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${nextVersion}"`)
  if (updated === contents && readVersions().cargo !== nextVersion) {
    throw new Error('Could not update [package].version in src-tauri/Cargo.toml')
  }
  return updated
}

function updateCargoLockVersion(contents, nextVersion) {
  const updated = contents.replace(/((?:^|\n)\[\[package\]\]\nname = "gojs"\nversion = )"[^"]+"/, `$1"${nextVersion}"`)
  if (updated === contents && readVersions().cargoLock !== nextVersion) {
    throw new Error('Could not update the gojs package version in src-tauri/Cargo.lock')
  }
  return updated
}

function updateTauriVersion(contents, nextVersion) {
  const tauriConfig = JSON.parse(contents)
  tauriConfig.version = nextVersion
  return `${JSON.stringify(tauriConfig, null, 2)}\n`
}

function replaceFilesAtomically(updates) {
  const staged = []
  try {
    for (const [path, contents] of updates) {
      const temporary = `${path}.tmp-${process.pid}`
      writeFileSync(temporary, contents)
      staged.push([path, temporary])
    }
    for (const [path, temporary] of staged) renameSync(temporary, path)
  } finally {
    for (const [, temporary] of staged) rmSync(temporary, { force: true })
  }
}

if (checkOnly) {
  const versions = readVersions()
  const mismatches = Object.entries(versions).filter(([, current]) => current !== version)

  if (mismatches.length > 0) {
    const details = mismatches.map(([name, current]) => `${name}=${current}`).join(', ')
    throw new Error(`Version ${version} is not synchronized: ${details}`)
  }

  console.log(`✓ package.json, Cargo.toml, Cargo.lock and tauri.conf.json use ${version}`)
} else {
  const packageJson = readFileSync(files.package, 'utf8')
  const cargoToml = readFileSync(files.cargo, 'utf8')
  const cargoLock = readFileSync(files.cargoLock, 'utf8')
  const tauriConfig = readFileSync(files.tauri, 'utf8')

  replaceFilesAtomically([
    [files.package, updatePackageVersion(packageJson, version)],
    [files.cargo, updateCargoVersion(cargoToml, version)],
    [files.cargoLock, updateCargoLockVersion(cargoLock, version)],
    [files.tauri, updateTauriVersion(tauriConfig, version)],
  ])

  console.log(`✓ Set desktop version to ${version}`)
}
