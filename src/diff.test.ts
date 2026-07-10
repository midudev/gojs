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

  it('handles a localized edit in a large file efficiently', () => {
    const size = 20000
    const base = Array.from({ length: size }, (_, i) => `line ${i}`)
    const oldCode = base.join('\n')
    const modified = base.slice()
    modified[size / 2] = 'CHANGED'
    const newCode = modified.join('\n')

    const start = performance.now()
    const diff = computeLineDiff(oldCode, newCode)
    const elapsed = performance.now() - start

    // Solo cambia una línea: 1 borrada + 1 añadida.
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
    // El resto es contexto; el total conserva todas las líneas.
    const ctx = diff.lines.filter((line) => line.type === 'ctx').length
    expect(ctx).toBe(size - 1)
    // Con recorte de prefijo/sufijo esto debe ser prácticamente instantáneo; la
    // versión cuadrática con tabla completa habría reservado ~400M celdas.
    expect(elapsed).toBeLessThan(1000)
  })

  it('produces a valid LCS diff on a fully divergent middle', () => {
    const oldCode = ['header', 'a', 'b', 'c', 'd', 'footer'].join('\n')
    const newCode = ['header', 'w', 'x', 'y', 'z', 'footer'].join('\n')
    const diff = computeLineDiff(oldCode, newCode)

    expect(diff.removed).toBe(4)
    expect(diff.added).toBe(4)
    // Prefijo y sufijo comunes se conservan como contexto.
    const ctxText = diff.lines.filter((l) => l.type === 'ctx').map((l) => l.text)
    expect(ctxText).toEqual(['header', 'footer'])
  })
})
