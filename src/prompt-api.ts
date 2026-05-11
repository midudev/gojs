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

type LanguageModelApi = {
  availability?: (options?: PromptApiSessionOptions) => PromptApiAvailability | Promise<PromptApiAvailability>
  capabilities?: () => unknown | Promise<unknown>
  create: (options?: PromptApiSessionOptions & {
    initialPrompts?: Array<{
      role: PromptApiRole
      content: string
    }>
  }) => Promise<ChromePromptApiSession>
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>
  }
}

const PROMPT_API_SESSION_OPTIONS: PromptApiSessionOptions = {
  expectedInputs: [{ type: 'text', languages: ['en', 'es'] }],
  expectedOutputs: [{ type: 'text', languages: ['en', 'es'] }],
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

function isAvailabilityReady(availability: unknown): boolean {
  if (availability === 'available' || availability === 'readily') {
    return true
  }

  if (typeof availability === 'object' && availability !== null && 'available' in availability) {
    const { available } = availability as { available?: unknown }
    return available === 'available' || available === 'readily'
  }

  return false
}

export async function isChromePromptApiAvailable(): Promise<boolean> {
  if (!isChromeBrowser()) return false

  const languageModel = getLanguageModelApi()
  if (!languageModel) return false

  try {
    if (languageModel.availability) {
      return isAvailabilityReady(await languageModel.availability(PROMPT_API_SESSION_OPTIONS))
    }

    if (languageModel.capabilities) {
      return isAvailabilityReady(await languageModel.capabilities())
    }
  } catch (error) {
    console.warn('Error checking Chrome Prompt API availability:', error)
  }

  return false
}

export async function createChromePromptApiSession(systemMessage: string): Promise<ChromePromptApiSession> {
  const languageModel = getLanguageModelApi()

  if (!languageModel || !(await isChromePromptApiAvailable())) {
    throw new Error('Chrome Prompt API is not available in this browser.')
  }

  return languageModel.create({
    ...PROMPT_API_SESSION_OPTIONS,
    initialPrompts: [
      {
        role: 'system',
        content: systemMessage,
      },
    ],
  })
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
