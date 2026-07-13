import * as acorn from 'acorn'

interface ExpressionInfo {
  start: number
  end: number
  line: number
}

interface InjectExpressionLoggingOptions {
  enabled?: boolean
}

// Mapa de líneas: línea en el código que se pasa a AsyncFunction -> línea en el código original.
// El desfase que añade el propio wrapper de AsyncFunction se calcula aparte en el worker
// (varía entre motores), así que aquí el mapa es 1:1 salvo por las inyecciones de expresiones.
export const lineMap = new Map<number, number>()

function mapOriginalCodeLines(code: string) {
  lineMap.clear()

  const originalLines = code.split('\n').length
  for (let i = 1; i <= originalLines; i++) {
    lineMap.set(i, i) // mapeo 1:1 (sin inyecciones)
  }
}

// CDN usado para resolver imports de paquetes npm (bare specifiers) a módulos ESM.
const ESM_CDN_BASE = 'https://esm.sh/'

// Sucrase se carga de forma diferida: solo se necesita al ejecutar y no debe
// engordar el bundle inicial.
let sucrasePromise: Promise<typeof import('sucrase')> | null = null

/**
 * Transpila TypeScript a JavaScript eliminando únicamente los tipos (sin comprobación
 * de tipos ni transformaciones de ES), de forma que el código pueda ejecutarse en el
 * worker. Preserva el número de líneas del original para no romper el mapeo entre la
 * consola y el editor. Si el código no es parseable (p. ej. a medio escribir) se
 * devuelve tal cual para que el error real lo reporte el ejecutor.
 */
export async function transpileToJs(code: string): Promise<string> {
  if (!sucrasePromise) {
    sucrasePromise = import('sucrase')
  }

  try {
    const { transform } = await sucrasePromise
    return transform(code, {
      transforms: ['typescript'],
      disableESTransforms: true, // conservar import/export ESM y sintaxis moderna intactos
    }).code
  } catch {
    return code
  }
}

/**
 * Resuelve el specifier de un import a algo que `import()` pueda cargar en el navegador.
 *
 * - URLs absolutas (`https:`, `data:`, `blob:`, `node:`…), protocolo-relativas (`//`),
 *   rutas absolutas (`/`) y relativas (`./`, `../`) se dejan intactas.
 * - Los "bare specifiers" (paquetes npm: `lodash`, `lodash/fp`, `@scope/pkg`,
 *   `zod@3`…) se mapean al CDN ESM para que el import funcione dentro del worker,
 *   que no dispone de resolución de módulos de node.
 */
export function resolveModuleSpecifier(specifier: string): string {
  const value = specifier.trim()

  if (
    value === '' ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) || // esquema: https:, data:, blob:, node:, file:…
    value.startsWith('//') || // protocolo-relativo
    value.startsWith('/') || // ruta absoluta
    value.startsWith('./') ||
    value.startsWith('../')
  ) {
    return value
  }

  // Bare specifier -> paquete npm servido como ESM desde el CDN.
  return `${ESM_CDN_BASE}${value}`
}

/**
 * Devuelve la raíz del paquete de un bare specifier:
 *   'lodash-es'        -> 'lodash-es'
 *   'lodash-es/fp'     -> 'lodash-es'
 *   '@scope/pkg/sub'   -> '@scope/pkg'
 */
function packageRootOf(specifier: string): string {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

/**
 * Extrae los "bare specifiers" (paquetes npm) importados en el código, tanto de
 * `import ... from '...'` como de `import('...')` dinámicos. Ignora URLs, rutas
 * relativas/absolutas y esquemas (node:, data:, ...).
 */
export function collectBareSpecifiers(code: string): string[] {
  let ast: any
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return []
  }

  const found = new Set<string>()

  const consider = (value: unknown) => {
    if (typeof value !== 'string') return
    if (resolveModuleSpecifier(value) === value) return // no es bare (URL/relativa/esquema)
    found.add(value)
  }

  const walk = (node: any) => {
    if (!node || typeof node.type !== 'string') return

    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) consider(node.source.value)
    } else if (
      node.type === 'ImportExpression' &&
      node.source &&
      node.source.type === 'Literal'
    ) {
      consider(node.source.value)
    }

    for (const key of Object.keys(node)) {
      const child = (node as any)[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child.type === 'string') walk(child)
    }
  }

  walk(ast)
  return [...found]
}

// Módulos nativos (core) de Node.js. No existen en el runtime de JavaScript del
// navegador: al intentar importarlos (p. ej. `node:os`), WKWebView falla al
// resolver el módulo y lo reporta como un error críptico de CORS. Los detectamos
// antes de ejecutar para mostrar un mensaje claro y sugerir cambiar a Node.js.
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

/**
 * ¿El specifier apunta a un módulo nativo de Node.js? Cualquier specifier con el
 * prefijo `node:` cuenta (es la forma canónica y no tiene sentido en el navegador),
 * así como los "bare specifiers" cuya raíz es un módulo core (`fs`, `os`, `fs/promises`…).
 */
export function isNodeBuiltinSpecifier(specifier: string): boolean {
  const value = specifier.trim()
  if (value.startsWith('node:')) return true
  return NODE_BUILTINS.has(packageRootOf(value))
}

/**
 * Extrae los imports de módulos nativos de Node.js presentes en el código
 * (tanto `import ... from '...'` como `import('...')`). Devuelve los specifiers
 * originales (p. ej. `node:os`, `fs/promises`) para poder mostrarlos al usuario.
 */
export function collectNodeBuiltinImports(code: string): string[] {
  let ast: any
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return []
  }

  const found = new Set<string>()

  const consider = (value: unknown) => {
    if (typeof value === 'string' && isNodeBuiltinSpecifier(value)) found.add(value)
  }

  const walk = (node: any) => {
    if (!node || typeof node.type !== 'string') return

    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) consider(node.source.value)
    } else if (
      node.type === 'ImportExpression' &&
      node.source &&
      node.source.type === 'Literal'
    ) {
      consider(node.source.value)
    }

    for (const key of Object.keys(node)) {
      const child = (node as any)[key]
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child.type === 'string') walk(child)
    }
  }

  walk(ast)
  return [...found]
}

const CONSOLE_CALLBACK_METHODS = new Set(['log', 'info', 'warn', 'error', 'table', 'count', 'countReset', 'time', 'timeEnd'])

/**
 * Conserva la línea de origen cuando un método de console se pasa como callback
 * (`promise.catch(console.error)`). La llamada nativa pierde el frame del código
 * de usuario; el wrapper vuelve a ejecutar el método en la misma línea.
 */
export function wrapConsoleCallbacks(code: string): string {
  let ast: any
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return code
  }

  const replacements: Array<{ start: number; end: number; method: string }> = []

  const walk = (node: any, parent: any = null) => {
    if (!node || typeof node.type !== 'string') return

    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      node.object?.type === 'Identifier' &&
      node.object.name === 'console' &&
      node.property?.type === 'Identifier' &&
      CONSOLE_CALLBACK_METHODS.has(node.property.name) &&
      !(parent?.type === 'CallExpression' && parent.callee === node)
    ) {
      replacements.push({ start: node.start, end: node.end, method: node.property.name })
    }

    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach((item) => walk(item, node))
      else if (child && typeof child.type === 'string') walk(child, node)
    }
  }

  walk(ast)

  let result = code
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    const wrapper = `(...__console_args__) => console.${replacement.method}(...__console_args__)`
    result = result.slice(0, replacement.start) + wrapper + result.slice(replacement.end)
  }

  return result
}

/**
 * Construye un import map (formato WICG) que mapea cada paquete npm importado a su
 * URL en el CDN ESM, incluyendo la entrada con barra final para resolver subrutas.
 * Este mapa alimenta al LSP de modern-monaco para dar IntelliSense y carga de tipos.
 */
export function buildImportMap(specifiers: string[]): Record<string, string> {
  const imports: Record<string, string> = {}

  for (const specifier of specifiers) {
    imports[specifier] = resolveModuleSpecifier(specifier)

    const root = packageRootOf(specifier)
    imports[`${root}/`] = `${ESM_CDN_BASE}${root}/`
  }

  return imports
}

/**
 * Reescribe las declaraciones `import` estáticas a `import()` dinámicos para que el
 * código pueda ejecutarse dentro de una AsyncFunction (que no admite import estático).
 * Permite importar módulos ESM desde CDNs como esm.sh, skypack, jsdelivr, etc.
 *
 * Preserva el número de líneas del original (rellenando con saltos de línea) para no
 * romper el mapeo de líneas de la consola.
 */
export function transformImports(code: string): string {
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

  const imports = (ast.body as any[]).filter((node) => node.type === 'ImportDeclaration')

  if (imports.length === 0) {
    return code
  }

  // Reemplazar de atrás hacia adelante para no invalidar los offsets
  imports.sort((a, b) => b.start - a.start)

  let result = code

  for (let i = 0; i < imports.length; i++) {
    const node = imports[i]
    const original = code.substring(node.start, node.end)
    // Conservar el mismo número de saltos de línea que ocupaba el import original
    const newlineCount = (original.match(/\n/g) || []).length
    const replacement = buildDynamicImport(node, imports.length - i) + '\n'.repeat(newlineCount)

    result = result.substring(0, node.start) + replacement + result.substring(node.end)
  }

  return result
}

function buildDynamicImport(node: any, idx: number): string {
  const src = JSON.stringify(resolveModuleSpecifier(node.source.value))
  const specifiers: any[] = node.specifiers || []

  // import 'modulo' (solo efectos secundarios)
  if (specifiers.length === 0) {
    return `await import(${src});`
  }

  const namespaceSpec = specifiers.find((s) => s.type === 'ImportNamespaceSpecifier')
  const destructure: string[] = []

  for (const spec of specifiers) {
    if (spec.type === 'ImportDefaultSpecifier') {
      destructure.push(`default: ${spec.local.name}`)
    } else if (spec.type === 'ImportSpecifier') {
      const imported = spec.imported.name ?? spec.imported.value
      destructure.push(imported === spec.local.name ? imported : `${JSON.stringify(imported)}: ${spec.local.name}`)
    }
  }

  // import * as ns from 'modulo'
  if (namespaceSpec && destructure.length === 0) {
    return `const ${namespaceSpec.local.name} = await import(${src});`
  }

  // import def, * as ns from 'modulo' (namespace + default/named)
  if (namespaceSpec) {
    const tmp = `__gojs_import_${idx}__`
    return `const ${tmp} = await import(${src}); const ${namespaceSpec.local.name} = ${tmp}; const { ${destructure.join(', ')} } = ${tmp};`
  }

  // import def from 'modulo' / import { a, b as c } from 'modulo'
  return `const { ${destructure.join(', ')} } = await import(${src});`
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

          // No envolver expresiones `await` sueltas: la inyección usa una IIFE
          // síncrona y `await` fuera de un contexto async provocaría un error.
          if (expr.type === 'AwaitExpression') {
            continue
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
export function injectExpressionLogging(code: string, options: InjectExpressionLoggingOptions = {}): string {
  // Limpiar el mapa
  lineMap.clear()

  if (options.enabled === false) {
    mapOriginalCodeLines(code)
    return code
  }

  const expressions = detectExpressions(code)

  if (expressions.length === 0) {
    // Sin inyecciones, mapeo 1:1
    mapOriginalCodeLines(code)
    return code
  }

  // Ordenar expresiones de mayor a menor posición para insertar de atrás hacia adelante
  expressions.sort((a, b) => b.start - a.start)

  let modifiedCode = code

  // Registrar cada inyección: en qué línea original empieza la expresión, cuántas
  // líneas añade y cuántas líneas del original abarca el span reemplazado.
  const addedByLine: Array<{ line: number; added: number; spanLines: number }> = []

  for (const expr of expressions) {
    const exprCode = code.substring(expr.start, expr.end)
    // Envolver la expresión para capturar su valor y mostrarlo
    // Quitamos el punto y coma final si existe
    const exprWithoutSemicolon = exprCode.replace(/;$/, '').trim()

    const injection = `;(function() {
      const __expr_result__ = ${exprWithoutSemicolon};
      if (__expr_result__ !== undefined) {
        console.__logExpression__(__expr_result__, ${expr.line});
      }
      return __expr_result__;
    })();`

    // La expresión puede ocupar varias líneas y se interpola dentro de la plantilla.
    // Calcular el tamaño real evita asumir que la inyección siempre ocupa 7 líneas.
    const exprSpanLines = exprCode.split('\n').length
    const added = injection.split('\n').length - exprSpanLines
    addedByLine.push({ line: expr.line, added, spanLines: exprSpanLines })

    modifiedCode = modifiedCode.substring(0, expr.start) + injection + modifiedCode.substring(expr.end)
  }

  // La plantilla de inyección coloca `;(function() {` en la misma línea donde
  // empezaba la expresión, y la PRIMERA línea de la expresión se interpola en la
  // línea siguiente (`const __expr_result__ = <expr>`). Por eso las líneas del
  // span original quedan desplazadas una línea hacia abajo dentro de la IIFE.
  const INJECTION_PREFIX_LINES = 1

  // Líneas originales absorbidas por un span reemplazado (se mapean aparte, ya que
  // no siguen el simple desfase `orig + shift` de las líneas exteriores).
  const spanLines = new Set<number>()
  for (const entry of addedByLine) {
    for (let k = 0; k < entry.spanLines; k++) spanLines.add(entry.line + k)
  }

  // Construir mapa: línea en código modificado -> línea original.
  // Una línea original L (fuera de cualquier span) se desplaza hacia abajo por
  // todas las inyecciones anteriores a ella.
  const originalLines = code.split('\n').length
  for (let orig = 1; orig <= originalLines; orig++) {
    if (spanLines.has(orig)) continue // las líneas de spans se mapean debajo
    let shift = 0
    for (const entry of addedByLine) {
      if (entry.line < orig) shift += entry.added
    }
    lineMap.set(orig + shift, orig)
  }

  // Mapear cada línea interior del span a su posición real dentro de la IIFE, de
  // forma que un log emitido en una línea intermedia de una expresión multilínea
  // auto-instrumentada apunte a su línea original y no al código inyectado.
  for (const entry of addedByLine) {
    let shiftBefore = 0
    for (const other of addedByLine) {
      if (other.line < entry.line) shiftBefore += other.added
    }
    // Línea de `;(function() {` en el código modificado.
    const base = entry.line + shiftBefore
    for (let k = 0; k < entry.spanLines; k++) {
      lineMap.set(base + INJECTION_PREFIX_LINES + k, entry.line + k)
    }
  }

  return modifiedCode
}
