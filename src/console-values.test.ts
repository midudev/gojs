import { describe, expect, it } from 'vitest'
import {
  formatConsoleValueText,
  isSerializedConsoleArguments,
  serializeConsoleArguments,
  serializeConsoleValue,
} from './console-values'

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
})