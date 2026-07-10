import type { PrettierSettings } from './storage'
import type { FormatRequest, FormatResponse } from './prettier-worker'

let prettierWorker: Worker | null = null
let requestSeq = 0
const pending = new Map<
  number,
  { resolve: (value: string) => void; timeout: ReturnType<typeof setTimeout>; code: string }
>()

function resolveAllPendingWithOriginal() {
  for (const [, entry] of pending) {
    clearTimeout(entry.timeout)
    // Ante un fallo global del worker devolvemos el código original: formatear es
    // best-effort y no debe romper el flujo de ejecución.
    entry.resolve(entry.code)
  }
  pending.clear()
}

/**
 * Inicializa el worker de Prettier con un único manejador de mensajes que
 * correlaciona respuestas por requestId. Reasignar `onmessage` en cada petición
 * provocaba condiciones de carrera al formatear en paralelo.
 */
export function initPrettierWorker(): void {
  if (prettierWorker) return

  prettierWorker = new Worker(new URL('./prettier-worker.ts', import.meta.url), {
    type: 'module',
  })

  prettierWorker.onmessage = (e: MessageEvent<FormatResponse>) => {
    const { requestId, formatted, error } = e.data
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    clearTimeout(entry.timeout)

    if (error) {
      console.warn('Prettier formatting error:', error)
      entry.resolve(entry.code) // Devolver código original si hay error
    } else {
      entry.resolve(formatted)
    }
  }

  prettierWorker.onerror = (error) => {
    console.error('Prettier worker error:', error)
    resolveAllPendingWithOriginal()
    prettierWorker?.terminate()
    prettierWorker = null
  }
}

/**
 * Formatea código usando Prettier
 */
export function formatCode(code: string, settings: PrettierSettings): Promise<string> {
  if (!prettierWorker) initPrettierWorker()

  const activeWorker = prettierWorker
  if (!activeWorker) return Promise.resolve(code)

  const requestId = ++requestSeq

  return new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      resolve(code) // Timeout: devolver el código original sin romper el flujo
    }, 5000)

    pending.set(requestId, { resolve, timeout, code })

    const request: FormatRequest = {
      requestId,
      code,
      options: {
        printWidth: settings.printWidth,
        tabWidth: settings.tabWidth,
        semi: settings.semi,
        singleQuote: settings.singleQuote,
        quoteProps: settings.quoteProps,
        jsxSingleQuote: settings.jsxSingleQuote,
        trailingComma: settings.trailingComma,
        bracketSpacing: settings.bracketSpacing,
        arrowParens: settings.arrowParens,
      },
    }

    activeWorker.postMessage(request)
  })
}

/**
 * Destruye el worker de Prettier
 */
export function destroyPrettierWorker(): void {
  if (prettierWorker) {
    prettierWorker.terminate()
    prettierWorker = null
  }
  resolveAllPendingWithOriginal()
}
