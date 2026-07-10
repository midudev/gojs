// Web Worker de preparación de código.
//
// Ejecuta, fuera del hilo principal, todo el pipeline previo a la ejecución del
// código de usuario: transpilación TypeScript (Sucrase), detección de módulos
// nativos de Node, reescritura de imports a import() dinámicos, instrumentación
// de tiempos por línea e inyección de logging de expresiones. Devuelve el código
// final, el mapa de líneas y los builtins detectados en un único mensaje, de modo
// que el hilo principal no realice varios `acorn.parse` por ejecución.

import {
  transpileToJs,
  collectNodeBuiltinImports,
  transformImports,
  injectExpressionLogging,
  lineMap,
} from './console'
import { injectTimings } from './timings'

export interface PrepareRequest {
  type: 'prepare'
  requestId: number
  code: string
  lineTimings: boolean
  autoLogExpressions: boolean
}

export interface PrepareResponse {
  type: 'prepared'
  requestId: number
  code: string
  lineMap: Record<number, number>
  nodeBuiltins: string[]
}

export interface PrepareErrorResponse {
  type: 'error'
  requestId: number
  message: string
}

self.onmessage = async (e: MessageEvent<PrepareRequest>) => {
  const { requestId, code, lineTimings, autoLogExpressions } = e.data

  try {
    // 1. TypeScript -> JavaScript (type-stripping, preserva líneas)
    const jsCode = await transpileToJs(code)

    // 2. Módulos nativos de Node: si los hay, el hilo principal muestra un aviso
    //    y no ejecuta. Cortamos aquí devolviendo solo los builtins.
    const nodeBuiltins = collectNodeBuiltinImports(jsCode)
    if (nodeBuiltins.length > 0) {
      const response: PrepareResponse = {
        type: 'prepared',
        requestId,
        code: '',
        lineMap: {},
        nodeBuiltins,
      }
      self.postMessage(response)
      return
    }

    // 3. imports estáticos -> import() dinámicos
    const codeWithImports = transformImports(jsCode)

    // 4. instrumentación de tiempos (antes del logging de expresiones para que su
    //    lineMap siga siendo correcto)
    const codeWithTimings = lineTimings ? injectTimings(codeWithImports) : codeWithImports

    // 5. logging de expresiones (rellena el lineMap del módulo)
    const modifiedCode = injectExpressionLogging(codeWithTimings, { enabled: autoLogExpressions })

    const lineMapObj: Record<number, number> = {}
    lineMap.forEach((value, key) => {
      lineMapObj[key] = value
    })

    const response: PrepareResponse = {
      type: 'prepared',
      requestId,
      code: modifiedCode,
      lineMap: lineMapObj,
      nodeBuiltins: [],
    }
    self.postMessage(response)
  } catch (error) {
    const response: PrepareErrorResponse = {
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
}

// Exportar vacío para que TypeScript lo trate como módulo
export {}
