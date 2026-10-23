import { describe, expect, it } from 'vitest'
import {
  appendFormattedValue,
  formatConsoleValueText,
  isSerializedConsoleArguments,
  serializeConsoleArguments,
  serializeConsoleValue,
} from './console-values'

const hasDocument = typeof document !== 'undefined'

describe('console value serialization', () => {
  it('preserves Set contents for console.log rendering', () => {
    const serialized = serializeConsoleValue(new Set([1]))

    expect(serialized).toEqual({ __type: 'Set', __values: [1] })
    expect(formatConsoleValueText(serialized)).toBe('Set(1) { 1 }')
  })

  it('keeps nested Sets readable inside arrays', () => {
    const serialized = serializeConsoleValue([new Set([1])])

    expect(formatConsoleValueText(serialized)).toBe('[Set(1) { 1 }]')
  })

  it('preserves Error details instead of serializing an empty object', () => {
    const error = new TypeError('Failed to fetch')
    error.stack = ''

    const serialized = serializeConsoleValue(error)

    expect(serialized).toEqual({ __type: 'Object', __value: 'TypeError: Failed to fetch' })
    expect(formatConsoleValueText(serialized)).toBe('TypeError: Failed to fetch')
  })

  it('serializes valid and invalid Date instances as ISO strings or Invalid Date', () => {
    const valid = new Date('2026-10-23T10:20:30.000Z')
    const invalid = new Date('invalid')

    expect(serializeConsoleValue(valid)).toEqual({
      __type: 'Object',
      __value: '2026-10-23T10:20:30.000Z',
    })
    expect(formatConsoleValueText(serializeConsoleValue(valid))).toBe('2026-10-23T10:20:30.000Z')
    expect(formatConsoleValueText(valid)).toBe('2026-10-23T10:20:30.000Z')

    expect(serializeConsoleValue(invalid)).toEqual({
      __type: 'Object',
      __value: 'Invalid Date',
    })
    expect(formatConsoleValueText(serializeConsoleValue(invalid))).toBe('Invalid Date')
    expect(formatConsoleValueText(invalid)).toBe('Invalid Date')
  })

  it('serializes RegExp instances to their literal representation', () => {
    const regex = /gojs-\d+/gi
    const serialized = serializeConsoleValue(regex)

    expect(serialized).toEqual({ __type: 'Object', __value: '/gojs-\\d+/gi' })
    expect(formatConsoleValueText(serialized)).toBe('/gojs-\\d+/gi')
    expect(formatConsoleValueText(regex)).toBe('/gojs-\\d+/gi')
  })

  it('avoids infinite recursion for circular Sets', () => {
    const circularSet = new Set<any>()
    circularSet.add(circularSet)

    expect(formatConsoleValueText(serializeConsoleValue(circularSet))).toBe('Set(1) { [Circular] }')
  })

  it('distinguishes multiple console arguments from a single array', () => {
    const multiple = serializeConsoleArguments(['label', [1, 2]])
    const singleArray = serializeConsoleArguments([[1, 2]])

    expect(isSerializedConsoleArguments(multiple)).toBe(true)
    expect(multiple).toEqual({ __type: 'Arguments', __values: ['label', [1, 2]] })
    expect(isSerializedConsoleArguments(singleArray)).toBe(false)
    expect(singleArray).toEqual([1, 2])
  })

  it.runIf(hasDocument)('renders serialized and raw Date values without infinite recursion', () => {
    const date = new Date('2026-10-23T10:20:30.000Z')

    const serializedContainer = document.createElement('div')
    appendFormattedValue(serializedContainer, serializeConsoleValue(date))
    expect(serializedContainer.textContent).toBe('2026-10-23T10:20:30.000Z')
    expect(serializedContainer.querySelector('.log-object')).not.toBeNull()

    const rawContainer = document.createElement('div')
    appendFormattedValue(rawContainer, date)
    expect(rawContainer.textContent).toBe('2026-10-23T10:20:30.000Z')
    expect(rawContainer.querySelector('.log-object')).not.toBeNull()

    const nestedContainer = document.createElement('div')
    appendFormattedValue(nestedContainer, serializeConsoleValue({ now: date, items: [date] }))
    expect(nestedContainer.textContent).toContain('2026-10-23T10:20:30.000Z')
  })

  it('serializes custom class instances, typed arrays, URLs and BigInt without leaking internal markers', () => {
    class User {
      name: string
      createdAt: Date
      tags: Set<string>
      self?: User
      constructor(name: string, createdAt: Date) {
        this.name = name
        this.createdAt = createdAt
        this.tags = new Set(['js'])
      }
    }

    const date = new Date('2026-10-23T10:20:30.000Z')
    const user = new User('midu', date)
    user.self = user

    const serializedUser = serializeConsoleValue(user)
    expect(serializedUser).toEqual({
      name: 'midu',
      createdAt: { __type: 'Object', __value: '2026-10-23T10:20:30.000Z' },
      tags: { __type: 'Set', __values: ['js'] },
      self: { __type: 'Circular', __value: '[Circular]' },
    })

    expect(formatConsoleValueText(serializeConsoleValue(new Uint8Array([1, 2, 3])))).toBe(
      'Uint8Array(3) [1, 2, 3]',
    )
    expect(formatConsoleValueText(serializeConsoleValue(new ArrayBuffer(8)))).toBe('ArrayBuffer(8)')
    expect(formatConsoleValueText(serializeConsoleValue(new URL('https://gojs.dev/play')))).toBe(
      'https://gojs.dev/play',
    )
    expect(
      formatConsoleValueText(
        serializeConsoleValue([{ date, count: 10n, set: new Set([1]) }]),
      ),
    ).toBe('[{ date: 2026-10-23T10:20:30.000Z, count: 10n, set: Set(1) { 1 } }]')
  })
})