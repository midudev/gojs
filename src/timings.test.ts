import { describe, expect, it } from 'vitest'
import * as acorn from 'acorn'
import { injectTimings } from './timings'

const parses = (code: string) => {
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
    return true
  } catch {
    return false
  }
}

describe('injectTimings', () => {
  it('marca cada statement de nivel superior sin alterar el conteo de líneas', () => {
    const code = "console.log('a');\nconsole.log('b');\nconsole.log('c');"

    const timed = injectTimings(code)

    expect(timed).toContain('console.__time__(1);')
    expect(timed).toContain('console.__time__(2);')
    expect(timed).toContain('console.__time__(3);')
    // Marca centinela final para cerrar la duración del último statement.
    expect(timed).toContain('console.__time__(0);')
    // No se añaden saltos de línea: el lineMap y los números de línea siguen siendo válidos.
    expect(timed.split('\n').length).toBe(code.split('\n').length)
    expect(parses(timed)).toBe(true)
  })

  it('sigue generando código válido cuando el último statement no termina en punto y coma', () => {
    // Caso del bug: sin el `;` inicial del centinela quedaría
    // `console.log('hola')console.__time__(0)`, que es un error de sintaxis.
    const code = "console.log('a');\nconsole.log('b');\nconsole.log('hola')"

    const timed = injectTimings(code)

    expect(timed).toContain("console.log('hola');console.__time__(0);")
    expect(parses(timed)).toBe(true)
    // El número de líneas no cambia, así que la línea del log se mapea correctamente.
    expect(timed.split('\n').length).toBe(code.split('\n').length)
  })

  it('deja el código intacto si tiene errores de sintaxis (en edición)', () => {
    const code = "console.log('a'"

    expect(injectTimings(code)).toBe(code)
  })

  it('no toca código vacío', () => {
    expect(injectTimings('')).toBe('')
  })
})
