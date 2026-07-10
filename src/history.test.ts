import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildHistoryViews,
  clearHistory,
  deleteEntry,
  getEntry,
  getHistory,
  getPreviousContent,
  MAX_VERSIONS,
  pruneHistory,
  recordVersion,
  renameEntry,
  type HistoryEntry,
} from './history'

const makeEntry = (id: string, content: string): HistoryEntry => ({
  id,
  content,
  createdAt: 0,
  source: 'auto',
})

beforeEach(() => {
  localStorage.clear()
})

describe('recordVersion', () => {
  it('guarda una versión y la devuelve como más reciente', () => {
    const entry = recordVersion('tab-1', 'console.log(1)', { source: 'run' })
    expect(entry).not.toBeNull()
    expect(entry!.source).toBe('run')

    const history = getHistory('tab-1')
    expect(history).toHaveLength(1)
    expect(history[0].content).toBe('console.log(1)')
  })

  it('coloca las versiones más nuevas primero', () => {
    recordVersion('tab-1', 'v1')
    recordVersion('tab-1', 'v2')
    recordVersion('tab-1', 'v3')

    expect(getHistory('tab-1').map((entry) => entry.content)).toEqual(['v3', 'v2', 'v1'])
  })

  it('ignora contenido vacío o solo espacios', () => {
    expect(recordVersion('tab-1', '')).toBeNull()
    expect(recordVersion('tab-1', '   \n  ')).toBeNull()
    expect(getHistory('tab-1')).toHaveLength(0)
  })

  it('deduplica si el contenido es igual a la última versión', () => {
    recordVersion('tab-1', 'same')
    const dup = recordVersion('tab-1', 'same')
    expect(dup).toBeNull()
    expect(getHistory('tab-1')).toHaveLength(1)
  })

  it('permite volver a guardar un contenido si dejó de ser el más reciente', () => {
    recordVersion('tab-1', 'a')
    recordVersion('tab-1', 'b')
    expect(recordVersion('tab-1', 'a')).not.toBeNull()
    expect(getHistory('tab-1').map((e) => e.content)).toEqual(['a', 'b', 'a'])
  })

  it('mantiene historiales separados por pestaña', () => {
    recordVersion('tab-1', 'uno')
    recordVersion('tab-2', 'dos')
    expect(getHistory('tab-1')).toHaveLength(1)
    expect(getHistory('tab-2')).toHaveLength(1)
    expect(getHistory('tab-2')[0].content).toBe('dos')
  })

  it('recorta al máximo de versiones descartando las más antiguas', () => {
    for (let i = 0; i < MAX_VERSIONS + 10; i++) {
      recordVersion('tab-1', `v${i}`)
    }
    const history = getHistory('tab-1')
    expect(history).toHaveLength(MAX_VERSIONS)
    expect(history[0].content).toBe(`v${MAX_VERSIONS + 9}`)
    expect(history.at(-1)!.content).toBe('v10')
  })
})

describe('getEntry / deleteEntry', () => {
  it('recupera y elimina una versión por id', () => {
    const a = recordVersion('tab-1', 'a')!
    const b = recordVersion('tab-1', 'b')!

    expect(getEntry('tab-1', a.id)!.content).toBe('a')
    expect(deleteEntry('tab-1', a.id)).toBe(true)
    expect(getEntry('tab-1', a.id)).toBeNull()
    expect(getHistory('tab-1').map((e) => e.id)).toEqual([b.id])
  })

  it('devuelve false al borrar una versión inexistente', () => {
    expect(deleteEntry('tab-1', 'nope')).toBe(false)
  })
})

describe('renameEntry', () => {
  it('asigna y limpia la etiqueta', () => {
    const entry = recordVersion('tab-1', 'a')!
    expect(renameEntry('tab-1', entry.id, '  Checkpoint  ')).toBe(true)
    expect(getEntry('tab-1', entry.id)!.label).toBe('Checkpoint')

    renameEntry('tab-1', entry.id, '   ')
    expect(getEntry('tab-1', entry.id)!.label).toBeUndefined()
  })
})

describe('getPreviousContent', () => {
  it('devuelve el contenido de la versión anterior en el tiempo (index + 1)', () => {
    const entries = [makeEntry('c', 'v3'), makeEntry('b', 'v2'), makeEntry('a', 'v1')]
    expect(getPreviousContent(entries, 0)).toBe('v2')
    expect(getPreviousContent(entries, 1)).toBe('v1')
  })

  it('devuelve null para la versión más antigua (último índice)', () => {
    const entries = [makeEntry('b', 'v2'), makeEntry('a', 'v1')]
    expect(getPreviousContent(entries, 1)).toBeNull()
  })

  it('devuelve null si el índice está fuera de rango', () => {
    const entries = [makeEntry('a', 'v1')]
    expect(getPreviousContent(entries, 0)).toBeNull()
    expect(getPreviousContent(entries, 5)).toBeNull()
  })
})

describe('buildHistoryViews', () => {
  it('marca la versión más antigua como initial (sin previa)', () => {
    const entries = [makeEntry('b', 'v2'), makeEntry('a', 'v1')]
    const views = buildHistoryViews(entries)
    expect(views).toHaveLength(2)
    expect(views[1].diffKind).toBe('initial')
    expect(views[1].previousContent).toBeNull()
  })

  it('marca delta cuando el contenido cambia respecto al anterior', () => {
    const entries = [makeEntry('b', 'v2'), makeEntry('a', 'v1')]
    const views = buildHistoryViews(entries)
    expect(views[0].diffKind).toBe('delta')
    expect(views[0].previousContent).toBe('v1')
  })

  it('marca unchanged cuando coincide con el anterior', () => {
    const entries = [makeEntry('c', 'same'), makeEntry('b', 'same'), makeEntry('a', 'v1')]
    const views = buildHistoryViews(entries)
    expect(views[0].diffKind).toBe('unchanged')
    expect(views[1].diffKind).toBe('delta')
    expect(views[2].diffKind).toBe('initial')
  })

  it('devuelve una lista vacía sin versiones', () => {
    expect(buildHistoryViews([])).toEqual([])
  })
})

describe('clearHistory / pruneHistory', () => {
  it('borra el historial de una pestaña', () => {
    recordVersion('tab-1', 'a')
    clearHistory('tab-1')
    expect(getHistory('tab-1')).toHaveLength(0)
  })

  it('descarta historiales de pestañas que ya no existen', () => {
    recordVersion('tab-1', 'a')
    recordVersion('tab-2', 'b')
    recordVersion('tab-3', 'c')

    pruneHistory(['tab-1', 'tab-3'])

    expect(getHistory('tab-1')).toHaveLength(1)
    expect(getHistory('tab-2')).toHaveLength(0)
    expect(getHistory('tab-3')).toHaveLength(1)
  })
})
