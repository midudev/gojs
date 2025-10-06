import type { PrettierSettings } from './storage'
import type { FormatRequest, FormatResponse } from './prettier-worker'

let prettierWorker: Worker | null = null

/**
 * Inicializa el worker de Prettier
 */
export function initPrettierWorker(): void {
  if (!prettierWorker) {
    prettierWorker = new Worker(new URL('./prettier-worker.ts', import.meta.url), {
      type: 'module',
    })
  }
}

/**
 * Formatea código usando Prettier
 */
export async function formatCode(code: string, settings: PrettierSettings): Promise<string> {
  if (!prettierWorker) {
    initPrettierWorker()
  }

  return new Promise((resolve, reject) => {
    if (!prettierWorker) {
      reject(new Error('Prettier worker not initialized'))
      return
    }

    const timeout = setTimeout(() => {
      reject(new Error('Format timeout'))
    }, 5000)

    prettierWorker.onmessage = (e: MessageEvent<FormatResponse>) => {
      clearTimeout(timeout)
      const { formatted, error } = e.data

      if (error) {
        console.warn('Prettier formatting error:', error)
        resolve(code) // Devolver código original si hay error
      } else {
        resolve(formatted)
      }
    }

    prettierWorker.onerror = (error) => {
      clearTimeout(timeout)
      console.error('Prettier worker error:', error)
      reject(error)
    }

    const request: FormatRequest = {
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

    prettierWorker.postMessage(request)
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
}
