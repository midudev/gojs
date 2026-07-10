// Bridge to the native Node.js runtime exposed by the Tauri backend
// (`src-tauri/src/node_runtime.rs`). On the web this whole module is inert:
// `isNativeRuntimeAvailable()` returns false and nothing here is called.
//
// The desktop app can execute the editor's code against a *real* Node.js 26
// process — with real `npm install`, the full stdlib and native modules — which
// gives GoJS a complete local development runtime. Dependencies the user adds
// from Settings live in a per-user workspace and are importable from their code.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface NodeInfo {
  available: boolean
  version: string | null
  npm_version: string | null
  source: 'bundled' | 'system' | null
  node_path: string | null
  workspace: string
}

export interface RunResult {
  stdout: string
  stderr: string
  exit_code: number | null
  duration_ms: number
  timed_out: boolean
}

export interface Dependency {
  name: string
  /** Range as declared in package.json (e.g. `^1.2.0`). */
  wanted: string | null
  /** Version actually present in node_modules. */
  installed: string | null
}

export interface OutputChunk {
  channel: 'stdout' | 'stderr'
  line: string
  /**
   * Generation of the native run that produced this line. Monotonic per run;
   * `0` for npm/dependency output, which is never gated. The frontend uses it
   * to drop output leaking from an older run's dying process.
   */
  run: number
}

/**
 * True when running inside the Tauri desktop shell, where the native bridge
 * exists. Tauri v2 injects an internal IPC object on the window; we feature
 * detect it so the same bundle keeps working in a plain browser.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

// Cache the probe: the runtime doesn't appear/disappear during a session.
let cachedInfo: NodeInfo | null = null
let infoProbe: Promise<NodeInfo | null> | null = null

/** Query the native runtime once, returning null on the web or if unavailable. */
export async function getNodeInfo(force = false): Promise<NodeInfo | null> {
  if (!isTauri()) return null
  if (!force && cachedInfo) return cachedInfo
  if (!force && infoProbe) return infoProbe
  infoProbe = invoke<NodeInfo>('node_info')
    .then((info) => {
      cachedInfo = info
      return info
    })
    .catch((err) => {
      console.warn('[native-runtime] node_info failed:', err)
      return null
    })
    .finally(() => {
      infoProbe = null
    })
  return infoProbe
}

/** Whether native Node execution can actually run right now. */
export async function isNativeRuntimeAvailable(): Promise<boolean> {
  const info = await getNodeInfo()
  return !!info?.available
}

/**
 * Subscribe to live stdout/stderr lines emitted while code or npm runs.
 * Returns an unsubscribe function. No-op (returns a noop) on the web.
 */
export async function onNativeOutput(handler: (chunk: OutputChunk) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  return listen<OutputChunk>('node://output', (event) => handler(event.payload))
}

/**
 * Execute `code` with the native runtime. `language` is 'js' or 'ts'.
 * `timeoutMs` caps the run so an infinite loop can't freeze the app — the
 * backend SIGKILLs the process (and its children) when the deadline passes.
 */
export async function runNative(
  code: string,
  language: 'js' | 'ts' = 'js',
  timeoutMs?: number,
): Promise<RunResult> {
  return invoke<RunResult>('node_run', { code, language, timeoutMs: timeoutMs ?? null })
}

/** Stop the currently running native execution. Returns true if one was running. */
export async function stopNative(): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('node_stop').catch(() => false)
}

// --- dependency management -------------------------------------------------

export async function listDependencies(): Promise<Dependency[]> {
  if (!isTauri()) return []
  return invoke<Dependency[]>('deps_list')
}

export async function addDependency(name: string, version?: string): Promise<RunResult> {
  return invoke<RunResult>('deps_add', { name, version: version ?? null })
}

export async function removeDependency(name: string): Promise<RunResult> {
  return invoke<RunResult>('deps_remove', { name })
}

export async function updateDependency(name: string, version: string): Promise<RunResult> {
  return invoke<RunResult>('deps_update', { name, version })
}

export async function revealWorkspace(): Promise<string> {
  return invoke<string>('workspace_reveal')
}
