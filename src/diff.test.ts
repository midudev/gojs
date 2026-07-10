import { describe, expect, it } from 'vitest'
import { computeLineDiff } from './diff'

describe('computeLineDiff', () => {
  it('counts added and removed lines', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nB\nc\nd')
    expect(diff.removed).toBe(1) // b
    expect(diff.added).toBe(2) // B, d
  })

  it('reports no changes for identical code', () => {
    const diff = computeLineDiff('a\nb', 'a\nb')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })

  it('marks every line as added when starting from empty', () => {
    const diff = computeLineDiff('', 'a\nb\nc')
    expect(diff.added).toBe(3)
    expect(diff.removed).toBe(0)
    expect(diff.lines.every((line) => line.type === 'add')).toBe(true)
  })

  it('tracks old and new line numbers', () => {
    const diff = computeLineDiff('a\nb', 'a\nc')
    const del = diff.lines.find((line) => line.type === 'del')
    const add = diff.lines.find((line) => line.type === 'add')
    expect(del?.oldLine).toBe(2)
    expect(add?.newLine).toBe(2)
  })
})
