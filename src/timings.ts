import * as acorn from 'acorn'

/**
 * Instrumenta el código para medir cuánto tarda en ejecutarse cada statement de
 * nivel superior (top-level). Antes de cada statement inserta una llamada
 * `console.__time__(línea)` que registra `performance.now()` en el worker, y una
 * marca centinela `console.__time__(0)` al final. El worker calcula la duración de
 * cada statement como la diferencia entre marcas consecutivas.
 *
 * IMPORTANTE: las inserciones se hacen SIN añadir saltos de línea (en la misma línea
 * en la que empieza el statement), de modo que no alteran el conteo de líneas ni el
 * `lineMap` que construye después `injectExpressionLogging`.
 *
 * La medición es por statement de nivel superior: una línea con un `for`/`await`
 * refleja su tiempo total de pared (igual que hace Chrome DevTools), no el de cada
 * iteración interna.
 */
export function injectTimings(code: string): string {
  let ast: any
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    })
  } catch {
    // Código con errores de sintaxis (probablemente en edición): lo dejamos tal cual
    return code
  }

  const body = (ast.body as any[]) ?? []
  if (body.length === 0) return code

  // Insertar `import` estáticos NO se pueden preceder por una expresión, pero para
  // cuando llega aquí ya han sido reescritos a `import()` dinámicos por transformImports.
  const insertions: Array<{ pos: number; text: string }> = []

  for (const node of body) {
    const line = node.loc.start.line
    insertions.push({ pos: node.start, text: `console.__time__(${line});` })
  }

  // Marca final para poder medir la duración del último statement.
  // El `;` inicial es imprescindible: si el último statement no termina en punto y
  // coma (p. ej. `console.log('hola')` sin `;`), pegar la marca directamente daría
  // `console.log('hola')console.__time__(0)`, que es un error de sintaxis. Con el `;`
  // queda `console.log('hola');console.__time__(0);`, válido en cualquier caso y sin
  // añadir saltos de línea (no altera el conteo de líneas ni el lineMap).
  const last = body[body.length - 1]
  insertions.push({ pos: last.end, text: `;console.__time__(0);` })

  // Aplicar de atrás hacia adelante para no invalidar los offsets.
  insertions.sort((a, b) => b.pos - a.pos)

  let result = code
  for (const { pos, text } of insertions) {
    result = result.substring(0, pos) + text + result.substring(pos)
  }

  return result
}
