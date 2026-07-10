/**
 * Historial de versiones por documento (pestaña).
 *
 * Guarda instantáneas del contenido de cada pestaña para poder revisarlas y
 * restaurarlas más tarde. Es un módulo de lógica pura (sin dependencias de UI)
 * respaldado por localStorage, para poder testearlo de forma aislada.
 */

export type HistorySource = 'run' | 'manual' | 'auto'

export interface HistoryEntry {
  id: string
  content: string
  createdAt: number
  source: HistorySource
  label?: string
}

/**
 * Clasificación de una versión respecto a la anterior:
 * - `initial`: es la más antigua, no tiene versión previa con la que comparar.
 * - `unchanged`: su contenido coincide con el de la versión anterior.
 * - `delta`: introduce cambios respecto a la versión anterior.
 */
export type DiffKind = 'initial' | 'unchanged' | 'delta'

export interface HistoryView {
  entry: HistoryEntry
  /** Contenido de la versión anterior (más antigua), o null si es la inicial. */
  previousContent: string | null
  diffKind: DiffKind
}

// Todas las versiones viven bajo una única clave: { [tabId]: HistoryEntry[] }.
// Cada lista se guarda de la más nueva a la más antigua.
const STORAGE_KEY = 'xjs.history'

// Límite de versiones por pestaña para no saturar localStorage. Al superarlo se
// descartan las más antiguas.
export const MAX_VERSIONS = 50

type HistoryMap = Record<string, HistoryEntry[]>

const generateId = () => Math.random().toString(36).slice(2, 10)

function readMap(): HistoryMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as HistoryMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: HistoryMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Si nos quedamos sin espacio, no rompemos la app: simplemente no persistimos.
  }
}

/**
 * Registra una nueva versión para la pestaña indicada. Devuelve la entrada
 * creada, o `null` si el contenido está vacío o es idéntico a la última versión
 * (evita ruido al guardar snapshots repetidos).
 */
export function recordVersion(
  tabId: string,
  content: string,
  opts: { source?: HistorySource; label?: string } = {},
): HistoryEntry | null {
  if (!tabId) return null
  if (!content.trim()) return null

  const map = readMap()
  const list = map[tabId] ?? []

  // No duplicar si el contenido es igual al de la versión más reciente.
  if (list.length > 0 && list[0].content === content) return null

  const entry: HistoryEntry = {
    id: generateId(),
    content,
    createdAt: Date.now(),
    source: opts.source ?? 'auto',
    ...(opts.label ? { label: opts.label } : {}),
  }

  map[tabId] = [entry, ...list].slice(0, MAX_VERSIONS)
  writeMap(map)
  return entry
}

/** Devuelve las versiones de una pestaña, de la más nueva a la más antigua. */
export function getHistory(tabId: string): HistoryEntry[] {
  return readMap()[tabId] ?? []
}

/**
 * Devuelve el contenido de la versión anterior (más antigua) a la del índice
 * dado, o `null` si es la última de la lista (la más antigua, sin previa).
 *
 * La lista se asume ordenada de la más nueva a la más antigua, así que la
 * versión "anterior" en el tiempo está en `index + 1`.
 */
export function getPreviousContent(entries: HistoryEntry[], index: number): string | null {
  const previous = entries[index + 1]
  return previous ? previous.content : null
}

/**
 * Empareja cada versión (lista newest-first) con su anterior en el tiempo para
 * poder mostrar un diff versión-a-versión. La versión más antigua no tiene
 * previa (`initial`); el resto será `unchanged` si su contenido coincide con el
 * anterior, o `delta` si hay cambios.
 */
export function buildHistoryViews(entries: HistoryEntry[]): HistoryView[] {
  return entries.map((entry, index) => {
    const previousContent = getPreviousContent(entries, index)
    const diffKind: DiffKind =
      previousContent === null ? 'initial' : previousContent === entry.content ? 'unchanged' : 'delta'
    return { entry, previousContent, diffKind }
  })
}

/** Busca una versión concreta por id. */
export function getEntry(tabId: string, versionId: string): HistoryEntry | null {
  return getHistory(tabId).find((entry) => entry.id === versionId) ?? null
}

/** Elimina una versión concreta. Devuelve `true` si existía. */
export function deleteEntry(tabId: string, versionId: string): boolean {
  const map = readMap()
  const list = map[tabId]
  if (!list) return false

  const next = list.filter((entry) => entry.id !== versionId)
  if (next.length === list.length) return false

  if (next.length === 0) delete map[tabId]
  else map[tabId] = next
  writeMap(map)
  return true
}

/** Renombra (o borra la etiqueta de) una versión. */
export function renameEntry(tabId: string, versionId: string, label: string): boolean {
  const map = readMap()
  const list = map[tabId]
  if (!list) return false

  const entry = list.find((item) => item.id === versionId)
  if (!entry) return false

  const trimmed = label.trim()
  if (trimmed) entry.label = trimmed
  else delete entry.label
  writeMap(map)
  return true
}

/** Borra todo el historial de una pestaña (p. ej. al cerrarla). */
export function clearHistory(tabId: string): void {
  const map = readMap()
  if (!(tabId in map)) return
  delete map[tabId]
  writeMap(map)
}

/**
 * Descarta el historial de pestañas que ya no existen, para evitar fugas en
 * localStorage cuando se cierran documentos.
 */
export function pruneHistory(existingTabIds: Iterable<string>): void {
  const keep = new Set(existingTabIds)
  const map = readMap()
  let changed = false
  for (const tabId of Object.keys(map)) {
    if (!keep.has(tabId)) {
      delete map[tabId]
      changed = true
    }
  }
  if (changed) writeMap(map)
}
