import type { MLCEngine } from '@mlc-ai/web-llm'
import {
  CHATBOT_APP_CONFIG,
  CHROME_PROMPT_API_MODEL_ID,
  DEFAULT_CHATBOT_MODEL_ID,
  isChromePromptApiModelId,
  isFimCapableModelId,
  isValidChatModelId,
} from './ai-models'
import {
  createChromePromptApiSession,
  isChromePromptApiAvailable,
  streamChromePromptApiResponse,
  type ChromePromptApiSession,
} from './prompt-api'
import { isTauri } from './native-runtime'
import {
  generateLlama,
  completeLlama,
  getLlamaInfo,
  onLlamaProgress,
  prepareLlama,
  stopLlama,
  uninstallLlamaModel,
  type LlamaProgress,
} from './llama-runtime'
import {
  invalidateWebLlmModelInstallation,
  isWebLlmModelInstalled,
  setWebLlmModelInstallation,
} from './webllm-model-cache'

// Estado del chatbot
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatbotState {
  isInitializing: boolean
  isReady: boolean
  error: string | null
  loadProgress: number
  downloadSpeedBytesPerSecond: number | null
  downloadedBytes?: number | null
  downloadTotalBytes?: number | null
  currentModelId: string | null
  /**
   * Human-readable, step-by-step description of what the loader is doing right
   * now (e.g. "Downloading llama.cpp runtime…", "Loading model into memory…").
   * Only the native (desktop) backend fills this in; on the web it stays null and
   * the UI falls back to a generic "Downloading model… X%" message.
   */
  loadStatusMessage?: string | null
}

export interface GenerationOptions {
  temperature?: number
  maxTokens?: number
}

export interface InlineCompletionRequest {
  prefix: string
  suffix: string
  maxTokens: number
  temperature?: number
  stop: string[]
  seed: number
  candidateCount?: number
  signal?: AbortSignal
}

export interface InlineCompletionCandidate {
  text: string
  finishReason: string | null
}

const MEGABYTE_IN_BYTES = 1024 * 1024
const FETCHED_MEGABYTES_PATTERN = /(\d+(?:\.\d+)?)\s*MB\s+fetched/i

type IDBFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>
}

type OriginPrivateFileSystemDirectoryHandle = {
  entries: () => AsyncIterable<[string, unknown]>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
}

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<OriginPrivateFileSystemDirectoryHandle>
}

function deleteIndexedDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Could not delete IndexedDB database "${name}" because it is blocked.`))
  })
}

async function deleteAllCacheStorage(): Promise<number> {
  if (!('caches' in window)) return 0

  const cacheNames = await caches.keys()
  const cacheResults = await Promise.allSettled(cacheNames.map((cacheName) => caches.delete(cacheName)))
  const failedDeletion = cacheResults.find((result) => result.status === 'rejected')

  if (failedDeletion?.status === 'rejected') {
    throw failedDeletion.reason
  }

  return cacheNames.length
}

async function deleteAllIndexedDatabases(): Promise<number> {
  const indexedDbWithDatabases = indexedDB as IDBFactoryWithDatabases
  if (!indexedDbWithDatabases.databases) return 0

  const databases = await indexedDbWithDatabases.databases()
  const databaseNames = databases.map((database) => database.name).filter((name): name is string => Boolean(name))
  const deletionResults = await Promise.allSettled(databaseNames.map((name) => deleteIndexedDatabase(name)))
  const failedDeletion = deletionResults.find((result) => result.status === 'rejected')

  if (failedDeletion?.status === 'rejected') {
    throw failedDeletion.reason
  }

  return databaseNames.length
}

async function deleteOriginPrivateFileSystem(): Promise<number> {
  const storageWithDirectory = navigator.storage as StorageManagerWithDirectory | undefined
  if (!storageWithDirectory?.getDirectory) return 0

  const root = await storageWithDirectory.getDirectory()
  let deletedEntries = 0

  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true })
    deletedEntries += 1
  }

  return deletedEntries
}

/** Compact human-readable byte size, e.g. 734003200 → "700 MB", 1610612736 → "1.5 GB". */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const megabytes = bytes / MEGABYTE_IN_BYTES
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`
}

function getFetchedBytesFromProgressText(text: string): number | null {
  const match = text.match(FETCHED_MEGABYTES_PATTERN)
  if (!match) return null

  const fetchedMegabytes = Number.parseFloat(match[1])
  if (!Number.isFinite(fetchedMegabytes)) return null

  return fetchedMegabytes * MEGABYTE_IN_BYTES
}

// Mensaje del sistema con instrucciones sobre el formato
const SYSTEM_MESSAGE = `You are the built-in AI assistant for a JavaScript and TypeScript playground.

Your job is to help the user understand, debug, refactor, and improve the code currently open in the editor. Be practical, specific, and grounded in the exact code and console output you receive.

Context you may receive:
1. Current code: the full JavaScript or TypeScript snippet from the editor.
2. Console output: values produced by the last execution.
3. User question: what the user wants to know or change.

Console output format:
- Each output entry may include a source line, for example: "value (L12)".
- The line marker means that the value was produced by that source line.
- Use those line markers to connect behavior with the exact statements that produced it.
- If output is missing, stale, truncated, or not enough to prove a claim, say so clearly.

Response style:
- Match the user's language. If the user writes Spanish, answer in Spanish.
- Be concise, but do not skip the useful reasoning.
- Start with the most likely answer or fix, then explain why.
- Prefer concrete examples over generic advice.
- Use Markdown and fenced code blocks when showing code.
- When showing a fix, provide the smallest useful code change unless the user asks for a larger rewrite.
- If there are multiple possible interpretations, state the assumption you are using.

Debugging rules:
- Do not invent code, files, dependencies, runtime behavior, or console output that was not provided.
- Do not claim you executed code. You can only reason from the code and output given to you.
- If there is an exception or unexpected output, identify the likely line, cause, and minimal fix.
- Explain async behavior, promises, event loop timing, closures, scopes, mutation, equality, coercion, prototypes, modules, DOM APIs, and TypeScript types when they are relevant.
- When a bug depends on browser behavior, mention the relevant browser API or constraint.

Code review rules:
- Focus on correctness, readability, runtime behavior, edge cases, and developer ergonomics.
- Call out risky patterns such as hidden mutation, accidental globals, confusing coercion, unhandled promises, broad try/catch blocks, fragile DOM selectors, and unsafe HTML injection.
- Do not over-engineer. Prefer simple, idiomatic JavaScript and TypeScript.

Teaching rules:
- Help the user build intuition, especially when explaining surprising JavaScript behavior.
- If the user asks "why", explain the mental model first, then the fix.
- If the user asks "how can I", give a direct implementation path.

Example:
If the code is:
\`\`\`javascript
const x = 4
console.log(x)
const y = 10
console.log(y)
\`\`\`

And the console output is:
\`\`\`
4 (L2)
10 (L4)
\`\`\`

You should be able to say that line 2 logs the value of x and line 4 logs the value of y, then answer the user's question using that mapping.`

class Chatbot {
  private engine: MLCEngine | null = null
  private promptApiSession: ChromePromptApiSession | null = null
  private state: ChatbotState = {
    isInitializing: false,
    isReady: false,
    error: null,
    loadProgress: 0,
    downloadSpeedBytesPerSecond: null,
    downloadedBytes: null,
    downloadTotalBytes: null,
    currentModelId: null,
  }
  private onStateChange: ((state: ChatbotState) => void) | null = null
  private conversationHistory: ChatMessage[] = []
  private loadToken = 0
  // Carga en curso, para que dos llamadas concurrentes al mismo modelo (p. ej. la
  // precarga en segundo plano y el envío del usuario) compartan la misma promesa
  // en lugar de que la segunda retorne un estado transitorio "no listo".
  private inFlightLoad: Promise<void> | null = null
  private inFlightLoadKey: string | null = null

  // On the desktop (Tauri) the webview has no WebGPU, so WebLLM cannot run.
  // Instead we route inference through a native llama.cpp server managed by the
  // Rust backend (see `llama-runtime.ts`). Everything else — the state machine,
  // progress UI, agent loop — stays identical.
  private readonly native = isTauri()
  private nativeProgressUnlisten: (() => void) | null = null
  private inlineController: AbortController | null = null

  // Establecer listener para cambios de estado
  public setStateChangeListener(callback: (state: ChatbotState) => void) {
    this.onStateChange = callback
  }

  // Notificar cambios de estado
  private notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state })
    }
  }

  private resetConversationHistory() {
    this.conversationHistory = [
      {
        role: 'system',
        content: SYSTEM_MESSAGE,
      },
    ]
  }

  private normalizeModelId(modelId?: string): string {
    if (isChromePromptApiModelId(modelId)) {
      return CHROME_PROMPT_API_MODEL_ID
    }

    if (modelId && isValidChatModelId(modelId)) {
      return modelId
    }

    return DEFAULT_CHATBOT_MODEL_ID
  }

  private getInitializationErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '')

    if (message.includes('Cache.add() encountered a network error')) {
      return 'The model download failed while storing files in the browser. Check your connection and try a smaller model.'
    }

    if (/quota|storage|disk/i.test(message)) {
      return 'The browser does not have enough free storage for this model. Free up site storage or try a smaller model.'
    }

    if (/service is not running/i.test(message)) {
      return 'Chrome’s on-device AI service is still starting. Please try again in a few seconds.'
    }

    return message || 'Error initializing the model'
  }

  private destroyPromptApiSession() {
    this.promptApiSession?.destroy?.()
    this.promptApiSession = null
  }

  private async unloadWebLlmEngine() {
    if (!this.engine) return

    await this.engine.unload()
    this.engine = null
  }

  private async loadChromePromptApiModel(forceReload: boolean): Promise<void> {
    const targetModelId = CHROME_PROMPT_API_MODEL_ID

    if (this.state.isInitializing && this.state.currentModelId === targetModelId) {
      return
    }

    if (!forceReload && this.state.isReady && this.state.currentModelId === targetModelId) {
      return
    }

    const loadToken = ++this.loadToken

    this.state.isInitializing = true
    this.state.isReady = false
    this.state.error = null
    this.state.loadProgress = 0
    this.state.downloadSpeedBytesPerSecond = null
    this.state.downloadedBytes = null
    this.state.downloadTotalBytes = null
    this.state.currentModelId = targetModelId
    this.notifyStateChange()

    try {
      await this.unloadWebLlmEngine()
      this.destroyPromptApiSession()

      const session = await createChromePromptApiSession(SYSTEM_MESSAGE, {
        onDownloadProgress: (loaded) => {
          if (loadToken !== this.loadToken) return

          // `loaded` llega como fracción (0-1) del progreso de descarga del modelo.
          this.state.loadProgress = Math.min(99, Math.round(loaded * 100))
          this.notifyStateChange()
        },
        onStatus: (statusMessage) => {
          if (loadToken !== this.loadToken) return

          this.state.loadStatusMessage = statusMessage
          this.notifyStateChange()
        },
      })

      if (loadToken !== this.loadToken) {
        session.destroy?.()
        return
      }

      this.promptApiSession = session
      this.resetConversationHistory()

      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.state.downloadSpeedBytesPerSecond = null
      this.state.downloadedBytes = null
      this.state.downloadTotalBytes = null
      this.state.loadStatusMessage = null
      this.state.currentModelId = targetModelId
      this.notifyStateChange()
    } catch (error: any) {
      if (loadToken !== this.loadToken) return

      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = this.getInitializationErrorMessage(error)
      this.state.downloadSpeedBytesPerSecond = null
      this.state.downloadedBytes = null
      this.state.downloadTotalBytes = null
      this.state.loadStatusMessage = null
      this.notifyStateChange()
      console.error('Error initializing Chrome Prompt API:', error)
    }
  }

  // Inicializar el modelo
  public async initialize(modelId?: string): Promise<void> {
    await this.loadModel(modelId)
  }

  public async loadModel(modelId?: string, forceReload = false): Promise<void> {
    // Clave efectiva del modelo (nativo usa ids de llama.cpp sin normalizar).
    const loadKey = this.native ? modelId ?? '' : this.normalizeModelId(modelId)

    // Si ya hay una carga en curso para el mismo modelo, reutilizamos su promesa:
    // quien llame esperará al resultado real (listo o error) en vez de leer un
    // estado intermedio y creer erróneamente que la carga ha fallado.
    if (!forceReload && this.inFlightLoad && this.inFlightLoadKey === loadKey) {
      return this.inFlightLoad
    }

    const load = this.performLoad(modelId, forceReload)
    this.inFlightLoad = load
    this.inFlightLoadKey = loadKey

    try {
      await load
    } finally {
      if (this.inFlightLoad === load) {
        this.inFlightLoad = null
        this.inFlightLoadKey = null
      }
    }
  }

  private async performLoad(modelId?: string, forceReload = false): Promise<void> {
    // En nativo NO normalizamos: los ids son de llama.cpp (p. ej. "qwen2.5-coder-1.5b"),
    // no de WebLLM, y normalizeModelId los descartaría al default de WebLLM.
    if (this.native) {
      await this.loadNativeModel(modelId, forceReload)
      return
    }

    const targetModelId = this.normalizeModelId(modelId)

    if (isChromePromptApiModelId(targetModelId)) {
      await this.loadChromePromptApiModel(forceReload)
      return
    }

    if (this.state.isInitializing && this.state.currentModelId === targetModelId) {
      return
    }

    if (!forceReload && this.state.isReady && this.state.currentModelId === targetModelId) {
      return
    }

    const loadToken = ++this.loadToken

    this.state.isInitializing = true
    this.state.isReady = false
    this.state.error = null
    this.state.loadProgress = 0
    this.state.downloadSpeedBytesPerSecond = null
    this.state.downloadedBytes = null
    this.state.downloadTotalBytes = null
    this.state.currentModelId = targetModelId
    this.notifyStateChange()

    try {
      this.destroyPromptApiSession()

      // Variable para simular progreso cuando el callback devuelve 0
      let simulatedProgress = 0
      let lastDownloadSample: { bytes: number; timeElapsedMs: number } | null = null
      let currentDownloadSpeedBytesPerSecond: number | null = null

      const initProgressCallback = (report: any) => {
        if (loadToken !== this.loadToken) return

        // El progreso viene como decimal (0-1), convertir a porcentaje (0-100)
        const reportedProgress = (report.progress ?? 0) * 100
        const fetchedBytes = getFetchedBytesFromProgressText(report.text ?? '')
        const reportTimeElapsedMs =
          typeof report.timeElapsed === 'number' && Number.isFinite(report.timeElapsed)
            ? report.timeElapsed * 1000
            : performance.now()

        if (fetchedBytes === null) {
          lastDownloadSample = null
          currentDownloadSpeedBytesPerSecond = null
          this.state.downloadSpeedBytesPerSecond = null
          this.state.downloadedBytes = null
          this.state.downloadTotalBytes = null
        } else {
          if (
            lastDownloadSample &&
            fetchedBytes > lastDownloadSample.bytes &&
            reportTimeElapsedMs > lastDownloadSample.timeElapsedMs
          ) {
            currentDownloadSpeedBytesPerSecond =
              ((fetchedBytes - lastDownloadSample.bytes) / (reportTimeElapsedMs - lastDownloadSample.timeElapsedMs)) *
              1000
          } else if (!lastDownloadSample && fetchedBytes > 0 && reportTimeElapsedMs > 0) {
            currentDownloadSpeedBytesPerSecond = (fetchedBytes / reportTimeElapsedMs) * 1000
          }

          if (!lastDownloadSample || fetchedBytes >= lastDownloadSample.bytes) {
            lastDownloadSample = {
              bytes: fetchedBytes,
              timeElapsedMs: reportTimeElapsedMs,
            }
          }

          this.state.downloadSpeedBytesPerSecond = currentDownloadSpeedBytesPerSecond
          this.state.downloadedBytes = fetchedBytes
          this.state.downloadTotalBytes =
            reportedProgress > 0 && reportedProgress < 100 ? fetchedBytes / (reportedProgress / 100) : fetchedBytes
        }

        // Si el progreso reportado es 0, simular un pequeño avance
        if (reportedProgress === 0) {
          simulatedProgress = Math.min(simulatedProgress + 0.5, 95)
          this.state.loadProgress = simulatedProgress
        }
        // Si el progreso reportado es menor que el simulado, ignorar (no retroceder)
        else if (reportedProgress < simulatedProgress) {
          // Mantener el progreso simulado actual, pero notificar velocidad y tamaño.
        }
        // Si el progreso reportado es mayor, usarlo y actualizar la simulación
        else {
          simulatedProgress = reportedProgress
          this.state.loadProgress = reportedProgress
        }

        this.notifyStateChange()
      }

      if (this.engine) {
        this.engine.setAppConfig(CHATBOT_APP_CONFIG)
        this.engine.setInitProgressCallback(initProgressCallback)
        await this.engine.reload(targetModelId)
      } else {
        // Cargar el runtime de WebLLM (pesado: motor + wasm) solo ahora, al crear
        // de verdad un motor, en vez de en el arranque de la app.
        const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
        // Crear el motor con el modelo específico
        const engine = await CreateMLCEngine(targetModelId, {
          appConfig: CHATBOT_APP_CONFIG,
          initProgressCallback,
        })

        if (loadToken !== this.loadToken) {
          await engine.unload().catch((unloadError) => {
            console.warn('Error unloading stale chatbot engine:', unloadError)
          })
          return
        }

        this.engine = engine
      }

      if (loadToken !== this.loadToken) return

      setWebLlmModelInstallation(targetModelId, true)
      this.resetConversationHistory()

      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.state.downloadSpeedBytesPerSecond = null
      this.state.downloadedBytes = null
      this.state.downloadTotalBytes = null
      this.state.currentModelId = targetModelId
      this.notifyStateChange()
    } catch (error: any) {
      if (loadToken !== this.loadToken) return

      // A failed initialization may still have completed the download before
      // failing for another reason (for example, insufficient GPU memory).
      // Re-check IndexedDB the next time instead of retaining a stale result.
      invalidateWebLlmModelInstallation(targetModelId)
      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = this.getInitializationErrorMessage(error)
      this.state.downloadSpeedBytesPerSecond = null
      this.state.downloadedBytes = null
      this.state.downloadTotalBytes = null
      this.notifyStateChange()
      console.error('Error initializing chatbot:', error)
    }
  }

  // --- native llama.cpp backend (desktop) ----------------------------------

  /**
   * Load the native backend: download the llama.cpp server + a GGUF model (if
   * missing) and start the local server. Drives the same state machine as the
   * WebLLM path so the progress UI works unchanged. The desktop always uses the
   * native default model; the WebLLM `modelId` from the selector is only kept as
   * `currentModelId` so callers' readiness checks stay consistent.
   */
  private async loadNativeModel(modelId: string | undefined, forceReload: boolean): Promise<void> {
    // `undefined` (o cualquier id no nativo) → deja que el backend use su default.
    const targetModelId = modelId ?? ''
    if (this.state.isInitializing && this.state.currentModelId === targetModelId) return
    if (!forceReload && this.state.isReady && this.state.currentModelId === targetModelId) return

    const loadToken = ++this.loadToken
    this.state.isInitializing = true
    this.state.isReady = false
    this.state.error = null
    this.state.loadProgress = 0
    this.state.downloadSpeedBytesPerSecond = null
    this.state.downloadedBytes = null
    this.state.downloadTotalBytes = null
    this.state.currentModelId = targetModelId
    this.state.loadStatusMessage = 'Checking local AI setup…'
    this.notifyStateChange()

    await this.subscribeNativeProgress(loadToken)

    try {
      await prepareLlama(targetModelId || undefined)
      if (loadToken !== this.loadToken) return

      this.resetConversationHistory()
      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.state.downloadSpeedBytesPerSecond = null
      this.state.loadStatusMessage = null
      this.notifyStateChange()
    } catch (error: any) {
      if (loadToken !== this.loadToken) return

      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = error?.message ? String(error.message) : String(error || 'Error initializing the model')
      this.state.downloadSpeedBytesPerSecond = null
      this.state.loadStatusMessage = null
      this.notifyStateChange()
      console.error('Error initializing native llama model:', error)
    } finally {
      this.teardownNativeProgress()
    }
  }

  /** Mirror native download/startup progress into the chatbot state. */
  private async subscribeNativeProgress(loadToken: number): Promise<void> {
    this.teardownNativeProgress()
    let lastSample: { bytes: number; timeMs: number } | null = null

    this.nativeProgressUnlisten = await onLlamaProgress((progress: LlamaProgress) => {
      if (loadToken !== this.loadToken) return

      if (progress.phase === 'model' && progress.total > 0) {
        const pct = Math.min(99, (progress.downloaded / progress.total) * 100)
        this.state.loadProgress = pct
        this.state.downloadedBytes = progress.downloaded
        this.state.downloadTotalBytes = progress.total
        const now = performance.now()
        if (lastSample && progress.downloaded > lastSample.bytes && now > lastSample.timeMs) {
          this.state.downloadSpeedBytesPerSecond =
            ((progress.downloaded - lastSample.bytes) / (now - lastSample.timeMs)) * 1000
        }
        lastSample = { bytes: progress.downloaded, timeMs: now }
        // Granular, self-explanatory line: progress + remaining size + speed.
        const remaining = formatBytes(Math.max(0, progress.total - progress.downloaded))
        const speed = this.state.downloadSpeedBytesPerSecond
          ? ` · ${formatBytes(this.state.downloadSpeedBytesPerSecond)}/s`
          : ''
        this.state.loadStatusMessage = `Downloading AI model… ${Math.round(pct)}% · ${remaining} left${speed}`
      } else if (progress.phase === 'starting') {
        this.state.loadProgress = Math.max(this.state.loadProgress, 99)
        this.state.downloadSpeedBytesPerSecond = null
        this.state.downloadedBytes = null
        this.state.downloadTotalBytes = null
        this.state.loadStatusMessage = progress.message || 'Starting the local model server…'
      } else if (progress.phase === 'ready') {
        this.state.loadProgress = 100
        this.state.downloadSpeedBytesPerSecond = null
        this.state.downloadedBytes = null
        this.state.downloadTotalBytes = null
        this.state.loadStatusMessage = 'Model ready'
      } else {
        // 'binary' phase: the llama.cpp runtime (download/extract). Size is
        // usually unknown, so keep the bar indeterminate and lean on the message.
        this.state.downloadSpeedBytesPerSecond = null
        this.state.downloadedBytes = null
        this.state.downloadTotalBytes = null
        this.state.loadStatusMessage = progress.message || 'Setting up the llama.cpp runtime…'
      }

      this.notifyStateChange()
    })
  }

  private teardownNativeProgress(): void {
    this.nativeProgressUnlisten?.()
    this.nativeProgressUnlisten = null
  }

  private async generateNative(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    options?: GenerationOptions,
  ): Promise<string> {
    if (!this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }
    return generateLlama(messages, onChunk, {
      temperature: options?.temperature ?? 0.3,
      maxTokens: options?.maxTokens ?? 2048,
    })
  }

  public async cancelInlineCompletion(): Promise<void> {
    const controller = this.inlineController
    if (!controller) return

    this.inlineController = null
    controller.abort()
    if (!this.native && this.engine) {
      await Promise.resolve(this.engine.interruptGenerate()).catch(() => {})
    }
  }

  public async completeInline(request: InlineCompletionRequest): Promise<InlineCompletionCandidate[]> {
    if (!this.state.isReady) {
      throw new Error('The agent model must be ready before inline completion.')
    }

    await this.cancelInlineCompletion()
    const controller = new AbortController()
    this.inlineController = controller
    const relayAbort = () => {
      controller.abort()
      if (!this.native && this.engine) {
        void Promise.resolve(this.engine.interruptGenerate()).catch(() => {})
      }
    }
    request.signal?.addEventListener('abort', relayAbort, { once: true })

    try {
      if (this.native) {
        const text = await completeLlama(request.prefix, request.suffix, {
          maxTokens: request.maxTokens,
          temperature: request.temperature ?? 0,
          stop: request.stop,
          seed: request.seed,
          signal: controller.signal,
        })
        return [{ text, finishReason: controller.signal.aborted ? 'cancelled' : 'stop' }]
      }

      const readablePrefix = request.prefix
        .replace(/<\|repo_name\|>/g, 'Repository: ')
        .replace(/<\|file_sep\|>/g, '\n\nFile: ')
        .replace(/\u200b/g, '')
      const instructPrompt = `Code before cursor:\n<prefix>\n${readablePrefix}\n</prefix>\n\nCode after cursor:\n<suffix>\n${request.suffix.replace(/\u200b/g, '')}\n</suffix>`

      if (isChromePromptApiModelId(this.state.currentModelId)) {
        const session = await createChromePromptApiSession(
          'You are an inline code completion engine. Return only the exact code to insert at the cursor, without Markdown or explanations.',
        )
        const destroySession = () => session.destroy?.()
        controller.signal.addEventListener('abort', destroySession, { once: true })
        try {
          let text = ''
          for await (const chunk of streamChromePromptApiResponse(session, instructPrompt)) {
            if (controller.signal.aborted) {
              throw new DOMException('Inline completion cancelled', 'AbortError')
            }
            text += chunk
          }
          return [{ text, finishReason: 'stop' }]
        } finally {
          controller.signal.removeEventListener('abort', destroySession)
          session.destroy?.()
        }
      }

      if (!this.engine) throw new Error('The agent model engine is not ready.')

      if (!isFimCapableModelId(this.state.currentModelId)) {
        const response = await this.engine.chat.completions.create({
          messages: [
            {
              role: 'system',
              content:
                'You are an inline code completion engine. Return only the exact code to insert at the cursor, without Markdown or explanations.',
            },
            {
              role: 'user',
              content: instructPrompt,
            },
          ],
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens,
          n: request.candidateCount ?? 1,
          stream: false,
        })
        if (controller.signal.aborted) {
          throw new DOMException('Inline completion cancelled', 'AbortError')
        }
        return response.choices.map((choice) => ({
          text: choice.message.content ?? '',
          finishReason: choice.finish_reason,
        }))
      }

      const response = await this.engine.completions.create({
        prompt: `<|fim_prefix|>${request.prefix}<|fim_suffix|>${request.suffix}<|fim_middle|>`,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens,
        repetition_penalty: 1,
        seed: request.seed,
        n: request.candidateCount ?? 1,
        stop: request.stop.slice(0, 4),
        stream: false,
      })
      if (controller.signal.aborted) {
        throw new DOMException('Inline completion cancelled', 'AbortError')
      }
      return response.choices.map((choice) => ({
        text: choice.text,
        finishReason: choice.finish_reason,
      }))
    } finally {
      request.signal?.removeEventListener('abort', relayAbort)
      if (this.inlineController === controller) this.inlineController = null
    }
  }

  // Enviar un mensaje y obtener respuesta
  public async sendMessage(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    await this.cancelInlineCompletion()
    if (isChromePromptApiModelId(this.state.currentModelId)) {
      return this.sendPromptApiMessage(userMessage, onChunk)
    }

    if (!this.engine || !this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    // Añadir mensaje del usuario al historial
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    })

    try {
      let fullResponse = ''

      // Generar respuesta con streaming
      const chunks = await this.engine.chat.completions.create({
        messages: this.conversationHistory,
        temperature: 0.7,
        max_tokens: 1024,
        stream: true,
      })

      for await (const chunk of chunks) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          fullResponse += content
          if (onChunk) {
            onChunk(content)
          }
        }
      }

      // Añadir respuesta del asistente al historial
      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
      })

      return fullResponse
    } catch (error: any) {
      console.error('Error sending message:', error)
      throw new Error(error.message || 'Error al enviar el mensaje')
    }
  }

  private async sendPromptApiMessage(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (!this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    })

    try {
      if (!this.promptApiSession) {
        this.promptApiSession = await createChromePromptApiSession(SYSTEM_MESSAGE)
      }

      let fullResponse = ''

      for await (const chunk of streamChromePromptApiResponse(this.promptApiSession, userMessage)) {
        fullResponse += chunk
        onChunk?.(chunk)
      }

      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
      })

      return fullResponse
    } catch (error: any) {
      console.error('Error sending message with Chrome Prompt API:', error)
      throw new Error(error.message || 'Error al enviar el mensaje')
    }
  }

  /**
   * Genera una respuesta a partir de una lista de mensajes arbitraria (con su
   * propio system prompt), SIN tocar el historial de chat ni el system prompt por
   * defecto. Es la primitiva de bajo nivel que usa el agente de código para poder
   * dar sus propias instrucciones y hacer varios turnos de razonamiento.
   */
  public async generate(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
    options?: GenerationOptions,
  ): Promise<string> {
    await this.cancelInlineCompletion()
    if (this.native) {
      return this.generateNative(messages, onChunk, options)
    }

    if (isChromePromptApiModelId(this.state.currentModelId)) {
      return this.generateWithPromptApi(messages, onChunk)
    }

    if (!this.engine || !this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    let fullResponse = ''

    const chunks = await this.engine.chat.completions.create({
      messages,
      // Temperatura baja: queremos respuestas deterministas y acciones precisas.
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 2048,
      stream: true,
    })

    for await (const chunk of chunks) {
      const content = chunk.choices[0]?.delta?.content || ''
      if (content) {
        fullResponse += content
        onChunk?.(content)
      }
    }

    return fullResponse
  }

  // Genera una respuesta con la Chrome Prompt API usando una sesión efímera con el
  // system prompt indicado (el primer mensaje 'system' de la lista).
  private async generateWithPromptApi(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (!this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n')

    const session = await createChromePromptApiSession(systemMessage)

    try {
      let fullResponse = ''
      for await (const chunk of streamChromePromptApiResponse(session, conversation)) {
        fullResponse += chunk
        onChunk?.(chunk)
      }
      return fullResponse
    } finally {
      session.destroy?.()
    }
  }

  // Limpiar el historial de conversación
  public clearHistory() {
    this.resetConversationHistory()

    if (isChromePromptApiModelId(this.state.currentModelId)) {
      this.destroyPromptApiSession()
    }
  }

  public async isModelInstalled(modelId: string): Promise<boolean> {
    if (this.native) {
      const info = await getLlamaInfo()
      if (!info) return false
      const target =
        info.models.find((model) => model.id === modelId) ??
        info.models.find((model) => model.id === info.default_model_id)
      return Boolean(info.binary_installed && target?.installed)
    }

    if (isChromePromptApiModelId(modelId)) {
      return isChromePromptApiAvailable()
    }

    return isWebLlmModelInstalled(this.normalizeModelId(modelId), CHATBOT_APP_CONFIG)
  }

  public async uninstallModel(modelId: string): Promise<void> {
    if (this.native) {
      this.loadToken += 1
      const info = await getLlamaInfo()
      await stopLlama()
      if (info) {
        await uninstallLlamaModel(info.default_model_id).catch(() => {})
      }
      this.resetConversationHistory()
      this.state = {
        isInitializing: false,
        isReady: false,
        error: null,
        loadProgress: 0,
        downloadSpeedBytesPerSecond: null,
        currentModelId: this.normalizeModelId(modelId),
      }
      this.notifyStateChange()
      return
    }

    const targetModelId = this.normalizeModelId(modelId)
    const isCurrentModel = this.state.currentModelId === targetModelId

    if (isChromePromptApiModelId(targetModelId)) {
      if (isCurrentModel) {
        this.loadToken += 1
        this.destroyPromptApiSession()
        this.resetConversationHistory()
        this.state = {
          isInitializing: false,
          isReady: false,
          error: null,
          loadProgress: 0,
          downloadSpeedBytesPerSecond: null,
          currentModelId: targetModelId,
        }
        this.notifyStateChange()
      }

      return
    }

    if (isCurrentModel) {
      this.loadToken += 1
      this.resetConversationHistory()
      this.state = {
        isInitializing: false,
        isReady: false,
        error: null,
        loadProgress: 0,
        downloadSpeedBytesPerSecond: null,
        currentModelId: targetModelId,
      }
      this.notifyStateChange()
    }

    if (this.engine && isCurrentModel) {
      await this.engine.unload()
      this.engine = null
    }

    const { deleteModelAllInfoInCache } = await import('@mlc-ai/web-llm')
    await deleteModelAllInfoInCache(targetModelId, CHATBOT_APP_CONFIG)
    setWebLlmModelInstallation(targetModelId, false)

    if (isCurrentModel) {
      this.notifyStateChange()
    }
  }

  public async clearLocalAiData(): Promise<{ deletedCaches: number; deletedDatabases: number; deletedFiles: number }> {
    if (this.native) {
      this.loadToken += 1
      await stopLlama()
      const info = await getLlamaInfo()
      const installed = info?.models.filter((model) => model.installed) ?? []
      for (const model of installed) {
        await uninstallLlamaModel(model.id).catch(() => {})
      }
      this.resetConversationHistory()
      this.state = {
        isInitializing: false,
        isReady: false,
        error: null,
        loadProgress: 0,
        downloadSpeedBytesPerSecond: null,
        currentModelId: null,
      }
      this.notifyStateChange()
      return { deletedCaches: 0, deletedDatabases: 0, deletedFiles: installed.length }
    }

    this.loadToken += 1
    await this.unloadWebLlmEngine()
    this.destroyPromptApiSession()
    this.resetConversationHistory()

    this.state = {
      isInitializing: false,
      isReady: false,
      error: null,
      loadProgress: 0,
      downloadSpeedBytesPerSecond: null,
      currentModelId: null,
    }
    this.notifyStateChange()

    const [deletedCaches, deletedDatabases, deletedFiles] = await Promise.all([
      deleteAllCacheStorage(),
      deleteAllIndexedDatabases(),
      deleteOriginPrivateFileSystem(),
    ])
    invalidateWebLlmModelInstallation()

    return { deletedCaches, deletedDatabases, deletedFiles }
  }

  // Obtener el estado actual
  public getState(): ChatbotState {
    return { ...this.state }
  }

  // Destruir la instancia del chatbot
  public async destroy() {
    this.loadToken += 1

    if (this.native) {
      this.teardownNativeProgress()
      await stopLlama().catch(() => {})
    }

    if (this.engine) {
      await this.engine.unload()

      // @mlc-ai/web-llm no tiene un método destroy explícito
      // pero podemos limpiar nuestras referencias
      this.engine = null
    }

    this.destroyPromptApiSession()
    this.conversationHistory = []
    this.state = {
      isInitializing: false,
      isReady: false,
      error: null,
      loadProgress: 0,
      downloadSpeedBytesPerSecond: null,
      currentModelId: null,
    }
    this.notifyStateChange()
  }
}

// Exportar instancia singleton
export const chatbot = new Chatbot()
