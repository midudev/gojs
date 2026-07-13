import { describe, expect, it } from 'vitest'
import * as acorn from 'acorn'
import {
  injectNativeExpressionLogging,
  instrumentNodeCode,
  NATIVE_LOG_SENTINEL,
  parseNativeLogLine,
} from './native-console'

const parsesAsModule = (code: string) => {
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
    return true
  } catch {
    return false
  }
}

const hasNodeProcess = typeof process !== 'undefined' && Boolean(process.stdout)

describe('parseNativeLogLine', () => {
  it('devuelve null para salida en crudo (sin centinela)', () => {
    expect(parseNativeLogLine('hello world')).toBeNull()
    expect(parseNativeLogLine('')).toBeNull()
  })

  it('parsea una línea instrumentada con tipo, línea y datos', () => {
    const line = NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'warn', line: 3, data: 'oops' })
    expect(parseNativeLogLine(line)).toEqual({ type: 'warn', line: 3, data: 'oops', columns: undefined })
  })

  it('conserva columns para console.table', () => {
    const line = NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'table', line: 1, data: [{ a: 1 }], columns: ['a'] })
    expect(parseNativeLogLine(line)?.columns).toEqual(['a'])
  })

  it('acepta resultados de expresiones instrumentadas', () => {
    const line = NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'expression', line: 1, data: 4 })
    expect(parseNativeLogLine(line)).toEqual({ type: 'expression', line: 1, data: 4, columns: undefined })
  })

  it('normaliza líneas ausentes o no positivas a null', () => {
    const noLine = NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'log', data: 1 })
    const zeroLine = NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'log', line: 0, data: 1 })
    expect(parseNativeLogLine(noLine)?.line).toBeNull()
    expect(parseNativeLogLine(zeroLine)?.line).toBeNull()
  })

  it('rechaza tipos desconocidos y JSON malformado', () => {
    expect(parseNativeLogLine(NATIVE_LOG_SENTINEL + JSON.stringify({ type: 'group', data: 1 }))).toBeNull()
    expect(parseNativeLogLine(NATIVE_LOG_SENTINEL + '{not json')).toBeNull()
  })
})

describe('injectNativeExpressionLogging', () => {
  it('instrumenta expresiones sin desplazar las líneas posteriores', () => {
    const code = "2 + 2\nconsole.log('hola')"
    const output = injectNativeExpressionLogging(code)

    expect(output).toContain('console.__logExpression__((2 + 2), 1);')
    expect(output.split('\n')).toHaveLength(code.split('\n').length)
    expect(output.split('\n')[1]).toBe("console.log('hola')")
    expect(parsesAsModule(output)).toBe(true)
  })

  it('respeta la preferencia que desactiva el logging automático', () => {
    const code = '2 + 2'
    expect(injectNativeExpressionLogging(code, false)).toBe(code)
  })

  it.runIf(hasNodeProcess)('emite el valor de la expresión con su línea original al ejecutarse', () => {
    const writes: string[] = []
    const originalConsole = globalThis.console
    const originalWrite = process.stdout.write
    globalThis.console = { ...originalConsole } as Console
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      const code = instrumentNodeCode(injectNativeExpressionLogging('2 + 2'))
      new Function(code)()
    } finally {
      process.stdout.write = originalWrite
      globalThis.console = originalConsole
    }

    expect(writes.map((line) => parseNativeLogLine(line.trim()))).toContainEqual({
      type: 'expression',
      line: 1,
      data: 4,
      columns: undefined,
    })
  })
})

describe('instrumentNodeCode', () => {
  it('mantiene el código del usuario al final, tras el prelude', () => {
    const user = "console.log('hi')"
    const out = instrumentNodeCode(user)
    expect(out.endsWith(user)).toBe(true)
    expect(out.length).toBeGreaterThan(user.length)
  })

  it('produce un módulo sintácticamente válido (incluyendo imports del usuario)', () => {
    const user = "import os from 'node:os'\nconsole.log(os.platform())"
    expect(parsesAsModule(instrumentNodeCode(user))).toBe(true)
  })

  it('inyecta un OFFSET igual al número de líneas del prelude', () => {
    const user = 'console.log(1)\nconsole.log(2)'
    const out = instrumentNodeCode(user)
    // La primera línea del usuario debe empezar exactamente en la línea OFFSET+1.
    const lines = out.split('\n')
    const userStart = lines.indexOf('console.log(1)')
    // El OFFSET inyectado en el prelude debe coincidir con las líneas previas.
    const offsetMatch = out.match(/const OFFSET = (\d+);/)
    expect(offsetMatch).not.toBeNull()
    const injectedOffset = Number(offsetMatch![1])
    expect(injectedOffset).toBe(userStart)
  })

  it('el centinela empieza la línea emitida por el prelude', () => {
    // El prelude debe referenciar el mismo centinela que usa el parser.
    const out = instrumentNodeCode('')
    expect(out).toContain(JSON.stringify(NATIVE_LOG_SENTINEL))
  })
})
