// Web Worker para ejecutar código de usuario con timeout
// Este worker ejecuta código en un hilo separado para evitar congelar la UI

import { serializeConsoleValue } from './console-values'

interface ExecuteMessage {
  type: 'execute'
  code: string
  lineMap: Record<number, number> // Mapeo de líneas: modificado -> original
}

interface LogMessage {
  type: 'log' | 'info' | 'warn' | 'error' | 'time' | 'table' | 'count' | 'expression'
  lineNumber: number | null
  data?: any
  columns?: string[]
}

interface CompleteMessage {
  type: 'complete'
}

interface ErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

// Objeto para rastrear timers y counters
const timers: Map<string, number> = new Map()
const counters: Map<string, number> = new Map()

// Mapa de líneas actual (se actualiza con cada ejecución)
let currentLineMap: Record<number, number> = {}

// Crear console personalizado que envía mensajes al hilo principal
const customConsole = {
  log: (...args: any[]) => {
    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    // Serializar los argumentos para evitar errores de clonación
    const serializedArgs = args.map((arg) => serializeConsoleValue(arg))
    const message: LogMessage = {
      type: 'log',
      lineNumber,
      data: serializedArgs.length === 1 ? serializedArgs[0] : serializedArgs,
    }
    self.postMessage(message)
  },
  info: (...args: any[]) => {
    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    const serializedArgs = args.map((arg) => serializeConsoleValue(arg))
    const message: LogMessage = {
      type: 'info',
      lineNumber,
      data: serializedArgs.length === 1 ? serializedArgs[0] : serializedArgs,
    }
    self.postMessage(message)
  },
  warn: (...args: any[]) => {
    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    const serializedArgs = args.map((arg) => serializeConsoleValue(arg))
    const message: LogMessage = {
      type: 'warn',
      lineNumber,
      data: serializedArgs.length === 1 ? serializedArgs[0] : serializedArgs,
    }
    self.postMessage(message)
  },
  error: (...args: any[]) => {
    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    const serializedArgs = args.map((arg) => serializeConsoleValue(arg))
    const message: LogMessage = {
      type: 'error',
      lineNumber,
      data: serializedArgs.length === 1 ? serializedArgs[0] : serializedArgs,
    }
    self.postMessage(message)
  },
  time: (label: string = 'default') => {
    timers.set(label, performance.now())
  },
  timeEnd: (label: string = 'default') => {
    const startTime = timers.get(label)
    if (startTime === undefined) {
      const message: LogMessage = {
        type: 'warn',
        lineNumber: null,
        data: `Timer '${label}' does not exist`,
      }
      self.postMessage(message)
      return
    }
    const duration = performance.now() - startTime
    timers.delete(label)

    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    const message: LogMessage = {
      type: 'time',
      lineNumber,
      data: `${label}: ${duration.toFixed(3)}ms`,
    }
    self.postMessage(message)
  },
  table: (data: any, columns?: string[]) => {
    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    // Serializar el data para evitar errores de clonación
    const serializedData = serializeConsoleValue(data)
    const message: LogMessage = {
      type: 'table',
      lineNumber,
      data: serializedData,
      columns,
    }
    self.postMessage(message)
  },
  count: (label: string = 'default') => {
    const currentCount = counters.get(label) || 0
    const newCount = currentCount + 1
    counters.set(label, newCount)

    const stack = new Error().stack || ''
    const lineNumber = extractLineNumber(stack)
    const message: LogMessage = {
      type: 'count',
      lineNumber,
      data: `${label}: ${newCount}`,
    }
    self.postMessage(message)
  },
  countReset: (label: string = 'default') => {
    counters.delete(label)
  },
  __logExpression__: (value: any, lineNumber: number) => {
    // Serializar el valor para evitar errores de clonación (promesas, funciones, etc.)
    const serializedValue = serializeConsoleValue(value)
    const message: LogMessage = {
      type: 'expression',
      lineNumber,
      data: serializedValue,
    }
    self.postMessage(message)
  },
}

// Extrae el número de línea "crudo" (dentro de la función anónima) del stack trace.
// Funciona tanto para Chrome (<anonymous>:L:C) como para Firefox (eval:L:C).
function extractRawLineNumber(stack: string): number | null {
  const lines = stack.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const chromeMatch = line.match(/<anonymous>:(\d+):\d+\)?$/)
    const firefoxMatch = line.match(/(?:eval|Function):(\d+):\d+/)

    const match = chromeMatch || firefoxMatch

    if (match && i > 0) {
      return Number(match[1])
    }
  }

  return null
}

// El wrapper de AsyncFunction añade un número fijo de líneas antes del cuerpo del
// usuario, y ese número varía según el motor (V8 añade 2, otros pueden diferir).
// Lo calibramos en tiempo de ejecución con una sonda cuya llamada está en la línea 1.
function detectWrapperOffset(): number {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const probe = new AsyncFunction('__mark', '__mark()')
    let probeLine: number | null = null
    probe(() => {
      probeLine = extractRawLineNumber(new Error().stack || '')
    })
    if (probeLine != null) {
      // La llamada a __mark() está en la línea 1 del cuerpo, así que el offset es probeLine - 1
      return probeLine - 1
    }
  } catch {
    // Ignorar y usar el fallback
  }
  return 2
}

const WRAPPER_OFFSET = detectWrapperOffset()

// Función para extraer número de línea del stack trace (mapeado a la línea original)
function extractLineNumber(stack: string): number | null {
  const rawLineNum = extractRawLineNumber(stack)
  if (rawLineNum == null) return null

  // Descontar el desfase del wrapper para obtener la línea dentro del código del usuario
  const modLine = rawLineNum - WRAPPER_OFFSET

  // Usar el lineMap para mapear de vuelta a la línea original (contempla inyecciones)
  const mappedLine = currentLineMap[modLine]
  if (mappedLine) {
    return mappedLine > 0 ? mappedLine : null
  }

  return modLine > 0 ? modLine : null
}

// Manejar mensajes del hilo principal
self.onmessage = async (e: MessageEvent<ExecuteMessage>) => {
  if (e.data.type === 'execute') {
    const { code, lineMap } = e.data

    // Actualizar el lineMap para esta ejecución
    currentLineMap = lineMap || {}

    // Limpiar timers y counters
    timers.clear()
    counters.clear()

    try {
      // Ejecutar código en un contexto aislado con console personalizado
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('console', code)

      // Ejecutar y esperar promesas
      await Promise.resolve(fn(customConsole))

      // Enviar mensaje de completado
      const message: CompleteMessage = {
        type: 'complete',
      }
      self.postMessage(message)
    } catch (error: any) {
      // Enviar error al hilo principal
      const message: ErrorMessage = {
        type: 'error',
        message: error.message || String(error),
        stack: error.stack,
      }
      self.postMessage(message)
    }
  }
}

// Exportar vacío para que TypeScript lo trate como módulo
export {}
