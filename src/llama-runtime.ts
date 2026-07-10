// Bridge to the native llama.cpp AI backend exposed by the Tauri backend
// (`src-tauri/src/llama_runtime.rs`). On the web this module is inert: WebLLM +
// WebGPU handle inference there. On the desktop the webview has no WebGPU, so the
// app downloads a llama.cpp server + a GGUF model and runs inference natively —
// this is the frontend half of that bridge.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './native-runtime'

export interface LlamaModelInfo {
  id: string
  name: string
  params: string
  size_bytes: number
  installed: boolean
  is_default: boolean
}

export interface LlamaInfo {
  binary_installed: boolean
  running_model_id: string | null
  models: LlamaModelInfo[]
  default_model_id: string
}

export interface LlamaProgress {
  /** 'binary' | 'model' | 'starting' | 'ready' */
  phase: 'binary' | 'model' | 'starting' | 'ready'
  model_id: string
  downloaded: number
  total: number
  message: string
}

interface LlamaTokenEvent {
  id: string
  token: string
}

/** Snapshot of the native backend: what is installed and what is running. */
export async function getLlamaInfo(): Promise<LlamaInfo | null> {
  if (!isTauri()) return null
  return invoke<LlamaInfo>('llama_info').catch((error) => {
    console.warn('[llama-runtime] llama_info failed:', error)
    return null
  })
}

/**
 * Ensure everything needed to answer is ready: the llama.cpp server binary, the
 * model weights, and a running server for `modelId` (or the default). Downloads
 * happen under the hood; subscribe with `onLlamaProgress` to show a progress
 * bar. Idempotent — cheap when the right server already runs.
 */
export async function prepareLlama(modelId?: string): Promise<void> {
  return invoke<void>('llama_prepare', { modelId: modelId ?? null })
}

/**
 * Subscribe to download / startup progress. Returns an unsubscribe function.
 * No-op on the web.
 */
export async function onLlamaProgress(handler: (progress: LlamaProgress) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<LlamaProgress>('llama://progress', (event) => handler(event.payload))
}

/**
 * Generate a chat completion natively, streaming tokens through `onToken`.
 * `messages` is the OpenAI-style array ({ role, content }). Resolves with the
 * full assistant reply.
 */
export async function generateLlama(
  messages: Array<{ role: string; content: string }>,
  onToken?: (token: string) => void,
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const requestId = crypto.randomUUID()

  let unlisten: (() => void) | null = null
  if (onToken) {
    unlisten = await listen<LlamaTokenEvent>('llama://token', (event) => {
      if (event.payload.id === requestId) onToken(event.payload.token)
    })
  }

  try {
    return await invoke<string>('llama_generate', {
      requestId,
      messages,
      temperature: options?.temperature ?? null,
      maxTokens: options?.maxTokens ?? null,
    })
  } finally {
    unlisten?.()
  }
}

/** Stop the running server and cancel any in-flight generation. */
export async function stopLlama(): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('llama_stop').catch(() => false)
}

/** Delete a model's weights from disk. */
export async function uninstallLlamaModel(modelId: string): Promise<void> {
  return invoke<void>('llama_uninstall', { modelId })
}
