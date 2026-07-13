export type SerializedConsoleValue =
  | { __type: 'Promise' | 'Function' | 'Symbol' | 'Object' | 'Unknown' | 'Circular'; __value: string }
  | { __type: 'Set'; __values: any[] }
  | { __type: 'Map'; __entries: [any, any][] }

export type SerializedConsoleArguments = { __type: 'Arguments'; __values: any[] }

export function isSerializedConsoleArguments(value: any): value is SerializedConsoleArguments {
  return value?.__type === 'Arguments' && Array.isArray(value.__values)
}

export function isSerializedConsoleValue(value: any): value is SerializedConsoleValue {
  if (!value || typeof value !== 'object' || typeof value.__type !== 'string') {
    return false
  }

  switch (value.__type) {
    case 'Promise':
    case 'Function':
    case 'Symbol':
    case 'Object':
    case 'Unknown':
    case 'Circular':
      return typeof value.__value === 'string'
    case 'Set':
      return Array.isArray(value.__values)
    case 'Map':
      return Array.isArray(value.__entries)
    default:
      return false
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function serializeConsoleValue(value: any, seen = new WeakSet<object>()): any {
  if (value instanceof Promise) {
    return { __type: 'Promise', __value: 'Promise { <pending> }' }
  }

  if (typeof value === 'function') {
    return { __type: 'Function', __value: value.toString() }
  }

  // Los symbols no son clonables por structuredClone/postMessage, así que
  // los serializamos a su representación textual (p. ej. "Symbol(foo)").
  if (typeof value === 'symbol') {
    return { __type: 'Symbol', __value: value.toString() }
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value !== 'object') {
    return value
  }

  if (seen.has(value)) {
    return { __type: 'Circular', __value: '[Circular]' }
  }

  seen.add(value)

  try {
    if (value instanceof Set) {
      return {
        __type: 'Set',
        __values: Array.from(value, (item) => serializeConsoleValue(item, seen)),
      }
    }

    if (value instanceof Map) {
      return {
        __type: 'Map',
        __entries: Array.from(value, ([key, item]) => [
          serializeConsoleValue(key, seen),
          serializeConsoleValue(item, seen),
        ]),
      }
    }

    if (value instanceof Error) {
      return {
        __type: 'Object',
        __value: value.stack || `${value.name}: ${value.message}`,
      }
    }

    if (Array.isArray(value)) {
      return value.map((item) => serializeConsoleValue(item, seen))
    }

    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, serializeConsoleValue(item, seen)]),
      )
    }

    try {
      structuredClone(value)
      return value
    } catch {
      return { __type: 'Object', __value: Object.prototype.toString.call(value) }
    }
  } catch {
    return { __type: 'Unknown', __value: '[Unable to serialize]' }
  } finally {
    seen.delete(value)
  }
}

export function serializeConsoleArguments(args: any[]): any {
  const values = args.map((value) => serializeConsoleValue(value))
  return values.length === 1 ? values[0] : { __type: 'Arguments', __values: values }
}

export function formatConsoleValueText(value: any): string {
  if (isSerializedConsoleValue(value)) {
    switch (value.__type) {
      case 'Set':
        return `Set(${value.__values.length}) { ${value.__values.map(formatConsoleValueText).join(', ')} }`
      case 'Map':
        return `Map(${value.__entries.length}) { ${value.__entries
          .map(([key, item]) => `${formatConsoleValueText(key)} => ${formatConsoleValueText(item)}`)
          .join(', ')} }`
      default:
        return value.__value
    }
  }

  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return value.toString()

  if (Array.isArray(value)) {
    return `[${value.map(formatConsoleValueText).join(', ')}]`
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }

  return String(value)
}