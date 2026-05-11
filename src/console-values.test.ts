import { describe, expect, it } from 'vitest'
import { formatConsoleValueText, serializeConsoleValue } from './console-values'

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

  it('avoids infinite recursion for circular Sets', () => {
    const circularSet = new Set<any>()
    circularSet.add(circularSet)

    expect(formatConsoleValueText(serializeConsoleValue(circularSet))).toBe('Set(1) { [Circular] }')
  })
})