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

function isSerializableObjectRecord(value: object): boolean {
  if (isPlainObject(value)) return true
  return Object.prototype.toString.call(value) === '[object Object]'
}

function formatDateValue(value: Date): string {
  return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
}

function formatArrayBufferView(value: ArrayBufferView): string {
  if (value instanceof DataView) {
    return `DataView(${value.byteLength})`
  }
  const tag = value.constructor?.name || 'TypedArray'
  const arrayLike = value as unknown as ArrayLike<number | bigint>
  const items = Array.from(arrayLike, (item) => (typeof item === 'bigint' ? `${item}n` : String(item))).join(', ')
  return `${tag}(${arrayLike.length}) [${items}]`
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

  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return value.valueOf()
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

    if (value instanceof Date) {
      return {
        __type: 'Object',
        __value: formatDateValue(value),
      }
    }

    if (value instanceof RegExp) {
      return {
        __type: 'Object',
        __value: value.toString(),
      }
    }

    if (value instanceof Error || (typeof DOMException !== 'undefined' && value instanceof DOMException)) {
      return {
        __type: 'Object',
        __value: value.stack || `${value.name}: ${value.message}`,
      }
    }

    if (typeof URL !== 'undefined' && value instanceof URL) {
      return {
        __type: 'Object',
        __value: value.toString(),
      }
    }

    if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
      const query = value.toString()
      return {
        __type: 'Object',
        __value: query ? `URLSearchParams { ${query} }` : 'URLSearchParams {}',
      }
    }

    if (value instanceof WeakMap) {
      return { __type: 'Object', __value: 'WeakMap { <items unknown> }' }
    }

    if (value instanceof WeakSet) {
      return { __type: 'Object', __value: 'WeakSet { <items unknown> }' }
    }

    if (typeof WeakRef !== 'undefined' && value instanceof WeakRef) {
      return { __type: 'Object', __value: 'WeakRef {}' }
    }

    if (value instanceof ArrayBuffer) {
      return { __type: 'Object', __value: `ArrayBuffer(${value.byteLength})` }
    }

    if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
      return { __type: 'Object', __value: `SharedArrayBuffer(${value.byteLength})` }
    }

    if (ArrayBuffer.isView(value)) {
      return { __type: 'Object', __value: formatArrayBufferView(value) }
    }

    if (Array.isArray(value)) {
      return value.map((item) => serializeConsoleValue(item, seen))
    }

    if (isSerializableObjectRecord(value)) {
      const result: Record<string, any> = {}
      for (const key of Object.keys(value)) {
        try {
          result[key] = serializeConsoleValue((value as any)[key], seen)
        } catch {
          result[key] = { __type: 'Unknown', __value: '[Unable to serialize]' }
        }
      }
      return result
    }

    return { __type: 'Object', __value: Object.prototype.toString.call(value) }
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

export function formatConsoleValueText(value: any, seen = new WeakSet<object>()): string {
  if (isSerializedConsoleValue(value)) {
    switch (value.__type) {
      case 'Set':
        return `Set(${value.__values.length}) { ${value.__values.map((item) => formatConsoleValueText(item, seen)).join(', ')} }`
      case 'Map':
        return `Map(${value.__entries.length}) { ${value.__entries
          .map(([key, item]) => `${formatConsoleValueText(key, seen)} => ${formatConsoleValueText(item, seen)}`)
          .join(', ')} }`
      default:
        return value.__value
    }
  }

  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return value.toString()
  if (typeof value === 'symbol') return value.toString()

  if (value instanceof Date) {
    return formatDateValue(value)
  }

  if (value instanceof RegExp) {
    return value.toString()
  }

  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }

  if (ArrayBuffer.isView(value)) {
    return formatArrayBufferView(value)
  }

  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      return `[${value.map((item) => formatConsoleValueText(item, seen)).join(', ')}]`
    } finally {
      seen.delete(value)
    }
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      if (isSerializableObjectRecord(value)) {
        const entries = Object.entries(value)
        if (entries.length === 0) return '{}'
        return `{ ${entries
          .map(([key, item]) => `${formatConsoleObjectKey(key)}: ${formatConsoleValueText(item, seen)}`)
          .join(', ')} }`
      }
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    } finally {
      seen.delete(value)
    }
  }

  return String(value)
}

export type ConsoleCollection = {
  entries: Array<[string, any]>
  open: string
  closed: string
  close: string
}

export function getConsoleCollection(value: any): ConsoleCollection | null {
  if (Array.isArray(value)) {
    return {
      entries: value.map((item, index) => [String(index), item]),
      open: `Array(${value.length}) [`,
      closed: `Array(${value.length}) […]`,
      close: ']',
    }
  }

  if (isSerializedConsoleValue(value)) {
    if (value.__type === 'Set') {
      return {
        entries: value.__values.map((item, index) => [String(index), item]),
        open: `Set(${value.__values.length}) {`,
        closed: `Set(${value.__values.length}) {…}`,
        close: '}',
      }
    }

    if (value.__type === 'Map') {
      return {
        entries: value.__entries.map(([key, item]) => [formatConsoleValueText(key), item]),
        open: `Map(${value.__entries.length}) {`,
        closed: `Map(${value.__entries.length}) {…}`,
        close: '}',
      }
    }

    return null
  }

  if (value === null || typeof value !== 'object') return null

  if (value instanceof Set) {
    const values = Array.from(value)
    return {
      entries: values.map((item, index) => [String(index), item]),
      open: `Set(${values.length}) {`,
      closed: `Set(${values.length}) {…}`,
      close: '}',
    }
  }

  if (value instanceof Map) {
    const entries = Array.from(value.entries())
    return {
      entries: entries.map(([key, item]) => [formatConsoleValueText(key), item]),
      open: `Map(${entries.length}) {`,
      closed: `Map(${entries.length}) {…}`,
      close: '}',
    }
  }

  if (!isSerializableObjectRecord(value)) return null

  return {
    entries: Object.entries(value),
    open: '{',
    closed: '{…}',
    close: '}',
  }
}

function formatConsoleObjectKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) || /^\d+$/.test(key) ? key : JSON.stringify(key)
}

export function createConsoleObjectTree(
  value: any,
  label?: string,
  seen = new WeakSet<object>(),
): HTMLElement {
  const collection = getConsoleCollection(value)
  if (!collection) {
    const fallback = document.createElement('span')
    appendFormattedValue(fallback, value, seen)
    return fallback
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      const circular = document.createElement('span')
      if (label !== undefined) {
        const key = document.createElement('span')
        key.className = 'log-json-key'
        key.textContent = `${formatConsoleObjectKey(label)}: `
        circular.appendChild(key)
      }
      const valueSpan = document.createElement('span')
      valueSpan.className = 'log-object'
      valueSpan.textContent = '[Circular]'
      circular.appendChild(valueSpan)
      return circular
    }
    seen.add(value)
  }

  try {
    if (collection.entries.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'log-object-empty'
      if (label !== undefined) {
        const key = document.createElement('span')
        key.className = 'log-json-key'
        key.textContent = `${formatConsoleObjectKey(label)}: `
        empty.appendChild(key)
      }
      empty.appendChild(document.createTextNode(collection.open + collection.close))
      return empty
    }

    const details = document.createElement('details')
    details.className = 'log-object-tree'
    details.open = true
    details.addEventListener('click', (event) => event.stopPropagation())

    const summary = document.createElement('summary')
    summary.className = 'log-object-summary'

    const chevron = document.createElement('span')
    chevron.className = 'log-object-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '›'
    summary.appendChild(chevron)

    if (label !== undefined) {
      const key = document.createElement('span')
      key.className = 'log-json-key'
      key.textContent = `${formatConsoleObjectKey(label)}: `
      summary.appendChild(key)
    }

    const closed = document.createElement('span')
    closed.className = 'log-object-closed'
    closed.textContent = collection.closed
    summary.appendChild(closed)

    const open = document.createElement('span')
    open.className = 'log-object-open'
    open.textContent = collection.open
    summary.appendChild(open)

    details.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'log-object-body'

    for (const [keyText, item] of collection.entries) {
      const nestedCollection = getConsoleCollection(item)
      if (nestedCollection) {
        body.appendChild(createConsoleObjectTree(item, keyText, seen))
        continue
      }

      const row = document.createElement('div')
      row.className = 'log-object-field'

      const key = document.createElement('span')
      key.className = 'log-json-key'
      key.textContent = `${formatConsoleObjectKey(keyText)}: `
      row.appendChild(key)
      appendFormattedValue(row, item, seen)
      body.appendChild(row)
    }

    const closing = document.createElement('div')
    closing.className = 'log-object-closing'
    closing.textContent = collection.close
    body.appendChild(closing)

    details.appendChild(body)
    return details
  } finally {
    if (typeof value === 'object' && value !== null) {
      seen.delete(value)
    }
  }
}

// Añadir valor formateado al contenedor con syntax highlighting
export function appendFormattedValue(
  container: HTMLElement,
  value: any,
  seen = new WeakSet<object>(),
) {
  const collection = getConsoleCollection(value)
  if (collection && !Array.isArray(value)) {
    container.appendChild(createConsoleObjectTree(value, undefined, seen))
    return
  }

  // Manejar valores serializados especiales del worker (promesas, funciones, etc.)
  if (isSerializedConsoleValue(value)) {
    const span = document.createElement('span')

    switch (value.__type) {
      case 'Promise':
        span.className = 'log-promise'
        break
      case 'Function':
        span.className = 'log-function'
        break
      case 'Set':
      case 'Map':
        span.className = 'log-array'
        break
      case 'Object':
      case 'Unknown':
      case 'Circular':
        span.className = 'log-object'
        break
      default:
        span.className = 'log-object'
    }

    span.textContent = formatConsoleValueText(value)
    container.appendChild(span)
    return
  }

  if (value === null) {
    const span = document.createElement('span')
    span.className = 'log-null'
    span.textContent = 'null'
    container.appendChild(span)
  } else if (value === undefined) {
    const span = document.createElement('span')
    span.className = 'log-undefined'
    span.textContent = 'undefined'
    container.appendChild(span)
  } else if (typeof value === 'string') {
    const span = document.createElement('span')
    span.className = 'log-string'
    span.textContent = `"${value}"`
    container.appendChild(span)
  } else if (typeof value === 'number') {
    const span = document.createElement('span')
    span.className = 'log-number'
    span.textContent = String(value)
    container.appendChild(span)
  } else if (typeof value === 'bigint') {
    const span = document.createElement('span')
    span.className = 'log-number'
    span.textContent = `${value}n`
    container.appendChild(span)
  } else if (typeof value === 'boolean') {
    const span = document.createElement('span')
    span.className = 'log-boolean'
    span.textContent = String(value)
    container.appendChild(span)
  } else if (typeof value === 'function') {
    const span = document.createElement('span')
    span.className = 'log-function'
    span.textContent = value.toString()
    container.appendChild(span)
  } else if (typeof value === 'object') {
    if (seen.has(value)) {
      const span = document.createElement('span')
      span.className = 'log-object'
      span.textContent = '[Circular]'
      container.appendChild(span)
      return
    }

    // Manejar arrays de forma especial para mostrarlos en formato compacto
    if (Array.isArray(value)) {
      seen.add(value)
      try {
        const span = document.createElement('span')
        span.className = 'log-array'
        span.textContent = '['

        value.forEach((item, index) => {
          if (index > 0) {
            span.appendChild(document.createTextNode(', '))
          }

          // Crear un span temporal para obtener el valor formateado
          const tempSpan = document.createElement('span')

          // Si el item es un objeto complejo, usar texto compacto
          if (typeof item === 'object' && item !== null && !Array.isArray(item) && !isSerializedConsoleValue(item)) {
            tempSpan.className = 'log-object'
            tempSpan.textContent = formatConsoleValueText(item)
          } else {
            appendFormattedValue(tempSpan, item, seen)
          }

          span.appendChild(tempSpan)
        })

        span.appendChild(document.createTextNode(']'))
        container.appendChild(span)
      } finally {
        seen.delete(value)
      }
    } else {
      // Objetos no planos (Date, RegExp, TypedArray, etc.) que no son colecciones desplegables
      const span = document.createElement('span')
      span.className = 'log-object'
      span.textContent = formatConsoleValueText(value)
      container.appendChild(span)
    }
  } else {
    container.appendChild(document.createTextNode(String(value)))
  }
}