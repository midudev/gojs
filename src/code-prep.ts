import type { PrepareRequest, PrepareResponse, PrepareErrorResponse } from './code-prep-worker'

export interface PreparedCode {
  code: string
  lineMap: Record<number, number>
  nodeBuiltins: string[]
}

// Worker singleton de preparación de código. A diferencia del executor (que se
// recrea en cada ejecución para aislar callbacks), este worker es puro (sin
// estado entre peticiones) y puede reutilizarse. Correlacionamos peticiones y
// respuestas con un requestId para no cruzar resultados de ejecuciones solapadas.
let worker: Worker | null = null
let requestSeq = 0
const pending = new Map<number, { resolve: (value: PreparedCode) => void; reject: (error: Error) => void }>()

function rejectAllPending(error: Error) {
  for (const [, entry] of pending) entry.reject(error)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./code-prep-worker.ts', import.meta.url), {
    type: 'module',
  })

  worker.onmessage = (e: MessageEvent<PrepareResponse | PrepareErrorResponse>) => {
    const message = e.data
    const entry = pending.get(message.requestId)
    if (!entry) return
    pending.delete(message.requestId)

    if (message.type === 'error') {
      entry.reject(new Error(message.message))
    } else {
      entry.resolve({
        code: message.code,
        lineMap: message.lineMap,
        nodeBuiltins: message.nodeBuiltins,
      })
    }
  }

  worker.onerror = () => {
    // Fallo del worker: rechazamos lo pendiente y lo recreamos en la próxima
    // petición para no quedar en un estado inservible.
    rejectAllPending(new Error('Code preparation worker error'))
    worker?.terminate()
    worker = null
  }

  return worker
}

/**
 * Prepara el código para su ejecución en el executor worker (transpila, reescribe
 * imports, instrumenta tiempos/expresiones y calcula el lineMap) sin bloquear el
 * hilo principal. Si el código importa módulos nativos de Node, `nodeBuiltins`
 * los lista y `code` viene vacío.
 */
export function prepareCode(input: {
  code: string
  lineTimings: boolean
  autoLogExpressions: boolean
}): Promise<PreparedCode> {
  const activeWorker = ensureWorker()
  const requestId = ++requestSeq

  return new Promise<PreparedCode>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    const request: PrepareRequest = {
      type: 'prepare',
      requestId,
      code: input.code,
      lineTimings: input.lineTimings,
      autoLogExpressions: input.autoLogExpressions,
    }
    activeWorker.postMessage(request)
  })
}

/** Destruye el worker de preparación (p. ej. al cerrar la app). */
export function destroyCodePrepWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  rejectAllPending(new Error('Code preparation worker destroyed'))
}
