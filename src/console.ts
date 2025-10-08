import * as acorn from 'acorn'

interface ExpressionInfo {
  start: number
  end: number
  line: number
}

/**
 * Detecta expresiones en el código que deberían evaluarse y mostrarse en la consola
 * @param code El código JavaScript a analizar
 * @returns Array de expresiones con su ubicación
 */
export function detectExpressions(code: string): ExpressionInfo[] {
  const expressions: ExpressionInfo[] = []

  try {
    // Parsear el código con acorn
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    }) as any

    // Recorrer el AST para encontrar expresiones
    if (ast.body) {
      for (const node of ast.body) {
        if (node.type === 'ExpressionStatement') {
          const expr = node.expression

          // Verificar que no sea una asignación
          if (expr.type === 'AssignmentExpression') {
            continue // Ignorar asignaciones
          }

          // Verificar que no sea solo un identificador
          if (expr.type === 'Identifier') {
            continue // Ignorar identificadores sueltos
          }

          // Verificar que no sea un console.log o similar
          if (
            expr.type === 'CallExpression' &&
            expr.callee.type === 'MemberExpression' &&
            expr.callee.object.name === 'console'
          ) {
            continue // Ignorar llamadas a console
          }

          // Es una expresión que queremos evaluar
          expressions.push({
            start: node.start,
            end: node.end,
            line: node.loc.start.line,
          })
        }
      }
    }
  } catch (error) {
    // Si hay error de sintaxis, lo ignoramos silenciosamente
    // porque el código puede estar siendo editado
  }

  return expressions
}

/**
 * Inyecta código para capturar y mostrar expresiones en la consola
 * @param code El código JavaScript original
 * @returns El código modificado con las inyecciones
 */
export function injectExpressionLogging(code: string): string {
  const expressions = detectExpressions(code)

  if (expressions.length === 0) {
    return code
  }

  // Ordenar expresiones de mayor a menor posición para insertar de atrás hacia adelante
  expressions.sort((a, b) => b.start - a.start)

  let modifiedCode = code

  for (const expr of expressions) {
    const exprCode = code.substring(expr.start, expr.end)
    // Envolver la expresión para capturar su valor y mostrarlo
    // Quitamos el punto y coma final si existe
    const exprWithoutSemicolon = exprCode.replace(/;$/, '').trim()
    const injection = `(function() {
      const __expr_result__ = ${exprWithoutSemicolon};
      if (__expr_result__ !== undefined) {
        console.__logExpression__(__expr_result__, ${expr.line});
      }
      return __expr_result__;
    })();`

    modifiedCode = modifiedCode.substring(0, expr.start) + injection + modifiedCode.substring(expr.end)
  }

  return modifiedCode
}
