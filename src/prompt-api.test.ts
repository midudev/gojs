import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChromePromptApiSession, isServiceNotRunningError } from './prompt-api'

type FakeSession = {
  prompt: (input: string) => Promise<string>
  destroy: () => void
}

function createFakeSession(): FakeSession {
  return {
    prompt: async (input: string) => `echo:${input}`,
    destroy: () => {},
  }
}

// El detector de navegador usa `navigator.userAgentData.brands`. En el runner
// (HeadlessChrome) esa detección falla, así que la forzamos a un Chrome válido
// para poder ejercitar la lógica de readiness/reintentos.
let originalUserAgentDataDescriptor: PropertyDescriptor | undefined

function stubChromeNavigator() {
  originalUserAgentDataDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgentData')
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    get: () => ({
      brands: [
        { brand: 'Chromium', version: '140' },
        { brand: 'Google Chrome', version: '140' },
      ],
    }),
  })
}

function restoreNavigator() {
  if (originalUserAgentDataDescriptor) {
    Object.defineProperty(navigator, 'userAgentData', originalUserAgentDataDescriptor)
  } else {
    delete (navigator as { userAgentData?: unknown }).userAgentData
  }
  originalUserAgentDataDescriptor = undefined
}

afterEach(() => {
  restoreNavigator()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isServiceNotRunningError', () => {
  it('matches the "service is not running" message case-insensitively', () => {
    expect(
      isServiceNotRunningError(new Error('Unable to create a text session because the service is not running')),
    ).toBe(true)
    expect(isServiceNotRunningError(new Error('some other failure'))).toBe(false)
    expect(isServiceNotRunningError('the SERVICE IS NOT RUNNING')).toBe(true)
  })
})

describe('createChromePromptApiSession', () => {
  it('retries create() when the on-device service is not running yet', async () => {
    const session = createFakeSession()
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Unable to create a text session because the service is not running'),
      )
      .mockResolvedValueOnce(session)

    const availability = vi.fn().mockResolvedValue('available')

    stubChromeNavigator()
    vi.stubGlobal('LanguageModel', { availability, create })

    const result = await createChromePromptApiSession('system prompt', {
      // Delays diminutos para que el reintento no ralentice la suite.
      retryDelaysMs: [1, 1, 1, 1],
      readiness: { pollIntervalMs: 1, timeoutMs: 1_000 },
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(result).toBe(session)
    await expect(result.prompt('hi')).resolves.toBe('echo:hi')
  })

  it('waits while availability reports "downloading" and then resolves once available', async () => {
    const session = createFakeSession()
    const availability = vi
      .fn()
      .mockResolvedValueOnce('downloading')
      .mockResolvedValueOnce('downloading')
      .mockResolvedValueOnce('available')

    const create = vi.fn().mockResolvedValue(session)
    const onStatus = vi.fn()

    stubChromeNavigator()
    vi.stubGlobal('LanguageModel', { availability, create })

    const result = await createChromePromptApiSession('system prompt', {
      retryDelaysMs: [1, 1, 1, 1],
      readiness: { pollIntervalMs: 1, timeoutMs: 1_000 },
      onStatus,
    })

    expect(availability).toHaveBeenCalledTimes(3)
    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toBe(session)
    expect(onStatus).toHaveBeenCalled()
  })
})
