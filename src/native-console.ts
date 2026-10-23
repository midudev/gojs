import { detectExpressions } from './console'

// Instrumentación de consola para el runtime nativo de Node.js.
//
// El backend ejecuta el código del usuario como un proceso Node real y nos
// devuelve stdout/stderr en crudo. Eso hace que TODO llegue como texto plano:
// sin distinguir log/info/warn/error/table/count y sin número de línea. En el
// worker del navegador sí distinguimos el tipo y la línea porque interceptamos
// `console.*` con un stack trace.
//
// Para lograr lo mismo en Node inyectamos un prelude que sobreescribe `console`
// y emite, por stdout, una línea estructurada por cada llamada:
//
//     <SENTINEL>{"type":"warn","line":3,"data":[...]}
//
// El frontend (`parseNativeLogLine`) reconoce esas líneas y las pinta con el
// tipo correcto y enlazadas a su línea del editor. Las líneas que NO empiezan
// por el centinela (p. ej. stdout de un proceso hijo o errores nativos por
// stderr) se siguen mostrando como salida en crudo.

// Marca única e improbable en salida normal. El `\0` inicial evita colisión
// con cualquier texto legible que el usuario pudiera imprimir.
export const NATIVE_LOG_SENTINEL = '\0__GOJS_LOG__\0'

export type NativeLogType = 'log' | 'info' | 'warn' | 'error' | 'time' | 'count' | 'table' | 'expression'

export interface ParsedNativeLog {
  type: NativeLogType
  line: number | null
  data: unknown
  columns?: string[]
}

const VALID_TYPES = new Set<NativeLogType>(['log', 'info', 'warn', 'error', 'time', 'count', 'table', 'expression'])

// Las líneas del prelude. Se prependen al código del usuario, así que su número
// (OFFSET) es lo que descontamos del stack para recuperar la línea del editor.
// Mantener cada sentencia en su propia línea es intencional: el recuento de
// líneas debe ser estable y predecible.
const PRELUDE_LINES: string[] = [
  ';(() => {',
  '  const S = __SENTINEL__;',
  '  const OFFSET = __OFFSET__;',
  '  const P = globalThis.process;',
  '  if (!P || !P.stdout) return;',
  '  const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());',
  '  const emit = (o) => { try { P.stdout.write(S + JSON.stringify(o) + "\\n"); } catch (e) {} };',
  '  const frameLine = (f) => {',
  '    let s = f;',
  '    if (s.charAt(s.length - 1) === ")") s = s.slice(0, -1);',
  '    const c2 = s.lastIndexOf(":");',
  '    if (c2 < 1) return null;',
  '    const c1 = s.lastIndexOf(":", c2 - 1);',
  '    if (c1 < 0) return null;',
  '    const n = Number(s.slice(c1 + 1, c2));',
  '    return Number.isFinite(n) ? n : null;',
  '  };',
  '  const lineOf = () => {',
  '    const frames = (new Error().stack || "").split("\\n");',
  '    for (let i = 0; i < frames.length; i++) {',
  '      if (frames[i].indexOf(".gojs-run.") === -1) continue;',
  '      const raw = frameLine(frames[i]);',
  '      if (raw == null) continue;',
  '      const ln = raw - OFFSET;',
  '      if (ln > 0) return ln;',
  '    }',
  '    return null;',
  '  };',
  '  const ser = (v, seen) => {',
  '    if (v === null || v === undefined) return v;',
  '    const t = typeof v;',
  '    if (t === "function") return { __type: "Function", __value: v.toString() };',
  '    if (t === "symbol") return { __type: "Symbol", __value: v.toString() };',
  '    if (t === "bigint") return { __type: "Object", __value: v.toString() + "n" };',
  '    if (t !== "object") return v;',
  '    if (typeof Promise !== "undefined" && v instanceof Promise) return { __type: "Promise", __value: "Promise { <pending> }" };',
  '    if (seen.has(v)) return { __type: "Circular", __value: "[Circular]" };',
  '    seen.add(v);',
  '    try {',
  '      if (v instanceof Set) return { __type: "Set", __values: Array.from(v, (x) => ser(x, seen)) };',
  '      if (v instanceof Map) return { __type: "Map", __entries: Array.from(v, (e) => [ser(e[0], seen), ser(e[1], seen)]) };',
  '      if (Array.isArray(v)) return v.map((x) => ser(x, seen));',
  '      if (v instanceof Date) return { __type: "Object", __value: Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString() };',
  '      if (v instanceof Error) return { __type: "Object", __value: v.stack || (v.name + ": " + v.message) };',
  '      if (v instanceof RegExp) return { __type: "Object", __value: v.toString() };',
  '      const o = {};',
  '      for (const k of Object.keys(v)) o[k] = ser(v[k], seen);',
  '      return o;',
  '    } catch (e) {',
  '      return { __type: "Unknown", __value: "[Unable to serialize]" };',
  '    } finally {',
  '      seen.delete(v);',
  '    }',
  '  };',
  '  const toData = (args) => { const s = args.map((a) => ser(a, new WeakSet())); return s.length === 1 ? s[0] : s; };',
  '  const byType = (type) => function () { emit({ type: type, line: lineOf(), data: toData(Array.prototype.slice.call(arguments)) }); };',
  '  const c = globalThis.console || {};',
  '  c.log = byType("log");',
  '  c.info = byType("info");',
  '  c.warn = byType("warn");',
  '  c.error = byType("error");',
  '  c.debug = byType("log");',
  '  c.trace = byType("log");',
  '  c.__logExpression__ = (value, line) => { if (value !== undefined) emit({ type: "expression", line: line, data: ser(value, new WeakSet()) }); return value; };',
  '  c.dir = (v) => emit({ type: "log", line: lineOf(), data: ser(v, new WeakSet()) });',
  '  c.table = (data, columns) => emit({ type: "table", line: lineOf(), data: ser(data, new WeakSet()), columns: Array.isArray(columns) ? columns : undefined });',
  '  const timers = new Map();',
  '  c.time = (label) => { timers.set(label === undefined ? "default" : label, now()); };',
  '  c.timeEnd = (label) => {',
  '    const key = label === undefined ? "default" : label;',
  '    const start = timers.get(key);',
  '    if (start === undefined) { emit({ type: "warn", line: lineOf(), data: "Timer \'" + key + "\' does not exist" }); return; }',
  '    timers.delete(key);',
  '    emit({ type: "time", line: lineOf(), data: key + ": " + (now() - start).toFixed(3) + "ms" });',
  '  };',
  '  const counters = new Map();',
  '  c.count = (label) => { const key = label === undefined ? "default" : label; const n = (counters.get(key) || 0) + 1; counters.set(key, n); emit({ type: "count", line: lineOf(), data: key + ": " + n }); };',
  '  c.countReset = (label) => { counters.delete(label === undefined ? "default" : label); };',
  '  globalThis.console = c;',
  '})();',
]

/**
 * Envuelve expresiones de nivel superior sin añadir saltos de línea. Así los
 * stacks de Node siguen apuntando a las líneas originales del editor.
 */
export function injectNativeExpressionLogging(code: string, enabled = true): string {
  if (!enabled) return code

  const expressions = detectExpressions(code).toSorted((a, b) => b.start - a.start)
  let instrumented = code

  for (const expression of expressions) {
    const source = code.slice(expression.start, expression.end).replace(/;$/, '').trim()
    const replacement = `console.__logExpression__((${source}), ${expression.line});`
    instrumented = instrumented.slice(0, expression.start) + replacement + instrumented.slice(expression.end)
  }

  return instrumented
}

/**
 * Prepende el prelude de instrumentación al código del usuario. El número de
 * líneas del prelude (OFFSET) se inyecta para que el cálculo de la línea a
 * partir del stack sea correcto sin importar el formato del bundle.
 */
export function instrumentNodeCode(userCode: string): string {
  const offset = PRELUDE_LINES.length
  const prelude =
    PRELUDE_LINES.join('\n')
      .replace('__SENTINEL__', JSON.stringify(NATIVE_LOG_SENTINEL))
      .replace('__OFFSET__', String(offset)) + '\n'
  return prelude + userCode
}

/**
 * Interpreta una línea de salida nativa. Devuelve el log estructurado si la
 * línea proviene de nuestra instrumentación, o `null` si es salida en crudo.
 */
export function parseNativeLogLine(line: string): ParsedNativeLog | null {
  if (!line.startsWith(NATIVE_LOG_SENTINEL)) return null
  try {
    const payload = JSON.parse(line.slice(NATIVE_LOG_SENTINEL.length))
    if (!payload || typeof payload.type !== 'string' || !VALID_TYPES.has(payload.type)) return null
    return {
      type: payload.type,
      line: typeof payload.line === 'number' && payload.line > 0 ? payload.line : null,
      data: payload.data,
      columns: Array.isArray(payload.columns) ? payload.columns : undefined,
    }
  } catch {
    return null
  }
}
