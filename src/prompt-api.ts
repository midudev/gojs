type PromptApiRole = 'system' | 'user' | 'assistant'
type PromptApiAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable'
type PromptApiLanguage = 'en' | 'es' | 'ja'
type PromptApiTextExpectation = {
  type: 'text'
  languages: PromptApiLanguage[]
}

type PromptApiSessionOptions = {
  expectedInputs?: PromptApiTextExpectation[]
  expectedOutputs?: PromptApiTextExpectation[]
}

export type ChromePromptApiSession = {
  prompt(input: string): Promise<string>
  promptStreaming?: (input: string) => AsyncIterable<unknown> | ReadableStream<unknown>
  destroy?: () => void
}

type PromptApiDownloadProgressEvent = {
  loaded: number
}

type PromptApiCreateMonitor = {
  addEventListener: (type: 'downloadprogress', listener: (event: PromptApiDownloadProgressEvent) => void) => void
}

type LanguageModelApi = {
  availability?: (options?: PromptApiSessionOptions) => PromptApiAvailability | Promise<PromptApiAvailability>
  capabilities?: () => unknown | Promise<unknown>
  create: (options?: PromptApiSessionOptions & {
    initialPrompts?: Array<{
      role: PromptApiRole
      content: string
    }>
    monitor?: (monitor: PromptApiCreateMonitor) => void
  }) => Promise<ChromePromptApiSession>
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>
  }
}

/**
 * Options accepted by {@link createChromePromptApiSession}. `onDownloadProgress`
 * and `onStatus` are the public, forward-facing callbacks; the remaining fields
 * are internal knobs that let tests shrink the polling/backoff delays so the
 * suite stays fast (in production the defaults below are used).
 */
export type CreateChromePromptApiSessionOptions = {
  onDownloadProgress?: (loaded: number) => void
  onStatus?: (message: string) => void
  /** Delays (ms) between retries when the on-device service is not running yet. */
  retryDelaysMs?: number[]
  /** Overrides for the readiness polling loop. */
  readiness?: {
    timeoutMs?: number
    pollIntervalMs?: number
  }
}

export type WaitForChromePromptApiReadyConfig = {
  timeoutMs?: number
  pollIntervalMs?: number
  onStatus?: (message: string) => void
}

const PROMPT_API_SESSION_OPTIONS: PromptApiSessionOptions = {
  expectedInputs: [{ type: 'text', languages: ['en', 'es'] }],
  expectedOutputs: [{ type: 'text', languages: ['en', 'es'] }],
}

// Chrome puede tardar unos segundos en arrancar el servicio on-device incluso
// con el modelo ya descargado. Reintentamos `create()` con backoff creciente
// (5 intentos: uno inicial + 4 reintentos) para absorber ese arranque.
const DEFAULT_CREATE_RETRY_DELAYS_MS = [250, 1000, 2000, 4000]
const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const DEFAULT_READINESS_POLL_INTERVAL_MS = 1_000

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `true` cuando el error corresponde a "the service is not running": el modelo
 * está descargado pero el proceso on-device todavía no ha arrancado. Es
 * transitorio, así que merece la pena reintentar.
 */
export function isServiceNotRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /service is not running/i.test(message)
}

function isChromeBrowser(): boolean {
  const navigatorWithBrands = navigator as NavigatorWithUserAgentData
  const brands = navigatorWithBrands.userAgentData?.brands

  if (brands?.length) {
    if (brands.some(({ brand }) => /\b(?:Edge|Opera)\b/i.test(brand))) {
      return false
    }

    return brands.some(({ brand }) => brand === 'Google Chrome' || brand === 'Chromium')
  }

  return /\b(?:Chrome|Chromium|CriOS)\//.test(navigator.userAgent) && !/\b(?:Edg|OPR|Opera)\//.test(navigator.userAgent)
}

function getLanguageModelApi(): LanguageModelApi | null {
  const globalScope = globalThis as typeof globalThis & {
    LanguageModel?: LanguageModelApi
  }

  return globalScope.LanguageModel ?? null
}

/** Estado de disponibilidad ya normalizado a un string conocido. */
function normalizeAvailability(availability: unknown): string {
  if (typeof availability === 'string') {
    return availability
  }

  if (typeof availability === 'object' && availability !== null && 'available' in availability) {
    const { available } = availability as { available?: unknown }
    return typeof available === 'string' ? available : ''
  }

  return ''
}

function isAvailabilityReady(availability: unknown): boolean {
  const status = normalizeAvailability(availability)
  return status === 'available' || status === 'readily'
}

/**
 * Devuelve el estado crudo de `LanguageModel.availability(...)` (p. ej.
 * 'available', 'downloadable', 'downloading', 'unavailable') o `null` si la API
 * no expone `availability`.
 */
export async function getChromePromptApiAvailability(): Promise<unknown> {
  const languageModel = getLanguageModelApi()
  if (!languageModel?.availability) return null

  return languageModel.availability(PROMPT_API_SESSION_OPTIONS)
}

export async function isChromePromptApiAvailable(): Promise<boolean> {
  if (!isChromeBrowser()) return false

  const languageModel = getLanguageModelApi()
  if (!languageModel) return false

  try {
    if (languageModel.availability) {
      return isAvailabilityReady(await getChromePromptApiAvailability())
    }

    if (languageModel.capabilities) {
      return isAvailabilityReady(await languageModel.capabilities())
    }
  } catch (error) {
    console.warn('Error checking Chrome Prompt API availability:', error)
  }

  return false
}

/**
 * Hace polling de `availability()` hasta que el modelo está listo:
 * - 'available'/'readily' → continúa (resuelve).
 * - 'downloadable'/'downloading' → espera y reintenta (avisando por `onStatus`).
 * - 'unavailable' → lanza un error descriptivo.
 * - timeout (~90s) → lanza un error de timeout.
 */
export async function waitForChromePromptApiReady(
  options: PromptApiSessionOptions = PROMPT_API_SESSION_OPTIONS,
  config: WaitForChromePromptApiReadyConfig = {},
): Promise<void> {
  const languageModel = getLanguageModelApi()
  if (!languageModel?.availability) {
    // Sin `availability` no podemos hacer polling: dejamos que `create()` decida.
    return
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  let lastStatusMessage: string | null = null
  const notifyStatus = (message: string) => {
    if (message === lastStatusMessage) return
    lastStatusMessage = message
    config.onStatus?.(message)
  }

  while (true) {
    const status = normalizeAvailability(await languageModel.availability(options))

    if (status === 'available' || status === 'readily') {
      return
    }

    if (status === 'unavailable') {
      throw new Error('Chrome Prompt API is not available on this device.')
    }

    if (status === 'downloadable' || status === 'downloading') {
      notifyStatus('Downloading Chrome’s on-device AI model…')
    }

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Chrome’s on-device AI model to become ready.')
    }

    await sleep(pollIntervalMs)
  }
}

export async function createChromePromptApiSession(
  systemMessage: string,
  options?: CreateChromePromptApiSessionOptions,
): Promise<ChromePromptApiSession> {
  const languageModel = getLanguageModelApi()

  if (!languageModel || !isChromeBrowser()) {
    throw new Error('Chrome Prompt API is not available in this browser.')
  }

  await waitForChromePromptApiReady(PROMPT_API_SESSION_OPTIONS, {
    timeoutMs: options?.readiness?.timeoutMs,
    pollIntervalMs: options?.readiness?.pollIntervalMs,
    onStatus: options?.onStatus,
  })

  const retryDelays = options?.retryDelaysMs ?? DEFAULT_CREATE_RETRY_DELAYS_MS
  let lastError: unknown

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await languageModel.create({
        ...PROMPT_API_SESSION_OPTIONS,
        initialPrompts: [
          {
            role: 'system',
            content: systemMessage,
          },
        ],
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            options?.onDownloadProgress?.(event.loaded)
          })
        },
      })
    } catch (error) {
      lastError = error

      // Solo reintentamos el arranque transitorio del servicio; el resto se propaga.
      if (!isServiceNotRunningError(error)) {
        throw error
      }

      if (attempt >= retryDelays.length) {
        break
      }

      options?.onStatus?.('Chrome’s on-device AI service is starting…')
      await sleep(retryDelays[attempt])
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to create a Chrome Prompt API session because the service is not running.')
}

async function* toAsyncIterable(stream: AsyncIterable<unknown> | ReadableStream<unknown>): AsyncIterable<unknown> {
  if (Symbol.asyncIterator in Object(stream)) {
    yield* stream as AsyncIterable<unknown>
    return
  }

  const reader = (stream as ReadableStream<unknown>).getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* streamChromePromptApiResponse(
  session: ChromePromptApiSession,
  prompt: string,
): AsyncIterable<string> {
  if (!session.promptStreaming) {
    yield await session.prompt(prompt)
    return
  }

  let previousText = ''

  for await (const chunk of toAsyncIterable(session.promptStreaming(prompt))) {
    const text = String(chunk ?? '')
    if (!text) continue

    const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text
    previousText = text.startsWith(previousText) ? text : previousText + text

    if (delta) {
      yield delta
    }
  }
}
