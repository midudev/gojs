import { INITIAL_CODE, SHOWCASE_CODE, SHOWCASE_INITIAL_CODE } from './consts'
import { clearHistory } from './history'

type MonacoLike = any
type EditorLike = any

type Tab = {
  id: string
  name?: string // Nombre personalizado de la pestaña
  content: string
  isDirty: boolean
  createdAt: number
  updatedAt: number
  model?: any
}

type TabsState = {
  tabs: Tab[]
  activeId: string | null
}

const EMBED_MODE = new URLSearchParams(window.location.search).get('embed')
const IS_LANDING_EMBED = EMBED_MODE === 'landing' || EMBED_MODE === 'showcase'
const STORAGE_TABS = IS_LANDING_EMBED ? `xjs.tabs.${EMBED_MODE}.v1` : 'xjs.tabs'
const STORAGE_ACTIVE = IS_LANDING_EMBED ? `xjs.activeTabId.${EMBED_MODE}.v1` : 'xjs.activeTabId'

export let state: TabsState = { tabs: [], activeId: null }
let editor: EditorLike | null = null
let monaco: MonacoLike | null = null
let onTabActivated: (() => void) | null = null

const generateId = () => Math.random().toString(36).slice(2, 10)

/** Id de la pestaña activa (o null si no hay ninguna). */
export function getActiveTabId(): string | null {
  return state.activeId
}

/** Nombre visible de la pestaña activa (para etiquetar versiones). */
export function getActiveTabTitle(): string {
  const active = state.tabs.find((t) => t.id === state.activeId)
  return active ? getTabTitle(active) : 'untitled'
}

function loadState(): TabsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_TABS)
    const activeId = localStorage.getItem(STORAGE_ACTIVE)
    if (!raw) return null
    const tabs = JSON.parse(raw) as Tab[]
    return { tabs, activeId }
  } catch {
    return null
  }
}

function saveState() {
  try {
    const serializableTabs = state.tabs.map(({ model, ...t }) => t)
    localStorage.setItem(STORAGE_TABS, JSON.stringify(serializableTabs))
    localStorage.setItem(STORAGE_ACTIVE, state.activeId ?? '')
  } catch {}
}

// Persistir es costoso (JSON.stringify de todas las pestañas) y no hace falta
// hacerlo en cada tecla: lo agrupamos con un debounce. Las acciones estructurales
// (crear/cerrar/cambiar/renombrar pestaña) fuerzan un flush inmediato.
const SAVE_DEBOUNCE_MS = 500
let saveTimer: number | null = null

function scheduleSaveState() {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveState()
  }, SAVE_DEBOUNCE_MS)
}

function flushSaveState() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveState()
}

/** Fuerza la persistencia pendiente (p. ej. al cerrar la app). */
export function flushTabsState() {
  flushSaveState()
}

function createModelForTab(t: Tab) {
  if (!monaco) return
  const uri = monaco.Uri.parse(`inmemory://models/${t.id}.ts`)
  t.model = monaco.editor.createModel(t.content, 'typescript', uri)
}

function ensureAtLeastOneTab() {
  if (state.tabs.length === 0) {
    const showcaseCode = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? SHOWCASE_CODE
      : SHOWCASE_INITIAL_CODE
    const tab: Tab = {
      id: generateId(),
      content: EMBED_MODE === 'showcase' ? showcaseCode : INITIAL_CODE,
      isDirty: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    state.tabs.push(tab)
    state.activeId = tab.id
  }
}

function render() {
  const container = document.querySelector('.tabs-container') as HTMLElement | null
  if (!container) return

  container.innerHTML = ''
  container.hidden = false

  const list = document.createElement('div')
  list.className = 'tabs-list'

  state.tabs.forEach((t) => {
    const tabEl = document.createElement('button')
    tabEl.className = 'tab-item' + (t.id === state.activeId ? ' active' : '')
    tabEl.dataset.tabId = t.id
    tabEl.title = getTabTitle(t)

    const nameEl = document.createElement('span')
    nameEl.className = 'tab-name'
    nameEl.textContent = getTabTitle(t)

    const closeEl = document.createElement('button')
    closeEl.className = 'tab-close'
    closeEl.setAttribute('aria-label', 'Close tab')
    closeEl.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-x">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M18 6l-12 12" />
        <path d="M6 6l12 12" />
      </svg>
    `

    tabEl.appendChild(nameEl)
    // Añadir botón de cierre siempre para conservar área de click uniforme
    tabEl.appendChild(closeEl)

    tabEl.addEventListener('click', () => switchTab(t.id))
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(t.id)
    })

    // Doble clic en el nombre para editar
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      startEditingTabName(t, nameEl)
    })

    list.appendChild(tabEl)
  })

  const addBtn = document.createElement('button')
  addBtn.className = 'tab-add'
  addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-plus"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 5l0 14" /><path d="M5 12l14 0" /></svg>`
  addBtn.title = 'New tab (Ctrl/Cmd+T)'
  addBtn.addEventListener('click', () => newTab())

  container.appendChild(list)
  container.appendChild(addBtn)
}

function startEditingTabName(tab: Tab, nameEl: HTMLSpanElement) {
  const currentName = nameEl.textContent || ''

  // Crear input para editar
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'tab-name-input'
  input.value = tab.name || ''
  input.placeholder = 'Tab name'

  // Reemplazar el span con el input
  nameEl.style.display = 'none'
  nameEl.parentElement?.insertBefore(input, nameEl)

  // Enfocar y seleccionar todo el texto
  input.focus()
  input.select()

  const finishEditing = (save: boolean) => {
    if (save && input.value.trim()) {
      // Guardar el nuevo nombre
      tab.name = input.value.trim()
      tab.updatedAt = Date.now()
      flushSaveState()
    } else if (save && !input.value.trim()) {
      // Si se vacía, eliminar el nombre personalizado
      delete tab.name
      tab.updatedAt = Date.now()
      flushSaveState()
    }

    // Volver a renderizar
    render()
  }

  // Guardar con Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finishEditing(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finishEditing(false)
    }
  })

  // Guardar al perder foco
  input.addEventListener('blur', () => {
    finishEditing(true)
  })

  // Prevenir que el clic en el input cambie de pestaña
  input.addEventListener('click', (e) => {
    e.stopPropagation()
  })
}

function setActiveModel() {
  if (!editor || !monaco) return
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (!active) return
  if (!active.model) createModelForTab(active)
  if (active.model) editor.setModel(active.model)
}

export function newTab() {
  const tab: Tab = {
    id: generateId(),
    content: '',
    isDirty: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  state.tabs.push(tab)
  state.activeId = tab.id
  createModelForTab(tab)
  setActiveModel()
  render()
  flushSaveState()
  onTabActivated?.()
}

function getTabTitle(t: Tab): string {
  // Si tiene nombre personalizado, usarlo
  if (t.name) {
    const max = 24
    return t.name.length > max ? t.name.slice(0, max - 1) + '…' : t.name
  }

  // Si no, usar primera línea del código (comportamiento por defecto)
  const text = t.model ? t.model.getValue() : t.content
  const firstLine = (text.split('\n')[0] || '').trim()
  if (!firstLine) return 'untitled'
  const max = 24
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine
}

export function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index === -1) return

  const [removed] = state.tabs.splice(index, 1)
  if (removed?.model) removed.model.dispose?.()
  // Al cerrar un documento su historial deja de tener sentido: lo descartamos
  // para no acumular versiones huérfanas en localStorage.
  clearHistory(id)

  if (state.activeId === id) {
    const next = state.tabs[index] || state.tabs[index - 1]
    state.activeId = next ? next.id : null
  }

  ensureAtLeastOneTab()
  setActiveModel()
  render()
  flushSaveState()
  onTabActivated?.()
}

export function switchTab(id: string) {
  if (state.activeId === id) return
  state.activeId = id
  setActiveModel()
  render()
  flushSaveState()
  onTabActivated?.()
}

export function updateActiveTabFromEditor() {
  if (!editor) return
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (!active || !active.model) return
  const text = active.model.getValue()
  active.content = text
  active.isDirty = true
  active.updatedAt = Date.now()
  // Actualizar solo el título de la pestaña activa (no reconstruir toda la barra)
  // y persistir con debounce para no bloquear el hilo en cada pulsación.
  updateActiveTabTitle(active)
  scheduleSaveState()
}

// Refresca in situ el texto del título de la pestaña activa cuando deriva de la
// primera línea del código. Evita el `render()` completo (innerHTML + relisten)
// en cada tecla.
function updateActiveTabTitle(tab: Tab) {
  if (tab.name) return // nombre personalizado: no depende del contenido
  const container = document.querySelector('.tabs-container')
  const nameEl = container?.querySelector(`[data-tab-id="${tab.id}"] .tab-name`) as HTMLElement | null
  if (!nameEl) return
  const title = getTabTitle(tab)
  if (nameEl.textContent !== title) {
    nameEl.textContent = title
    const button = nameEl.closest('.tab-item') as HTMLElement | null
    if (button) button.title = title
  }
}

function restoreTabs() {
  const loaded = loadState()
  if (loaded && Array.isArray(loaded.tabs) && loaded.tabs.length > 0) {
    state.tabs = loaded.tabs.map((t) => ({ ...t, model: undefined }))
    state.activeId =
      loaded.activeId && loaded.tabs.some((t) => t.id === loaded.activeId) ? loaded.activeId : loaded.tabs[0].id
  } else {
    ensureAtLeastOneTab()
  }

  // Crear el modelo solo para la pestaña activa. El resto se materializa de forma
  // perezosa al activarse (setActiveModel), evitando construir N modelos Monaco
  // (y su carga de tipos/LSP) en el arranque.
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (active) createModelForTab(active)
}

export function initTabs(editorInstance: EditorLike, monacoInstance: MonacoLike, onActivated?: () => void) {
  editor = editorInstance
  monaco = monacoInstance
  onTabActivated = onActivated ?? null

  restoreTabs()
  render()
  setActiveModel()
  // Ejecutar callback inicial para sincronizar salida con la pestaña activa
  onTabActivated?.()

  // Atajos a nivel de editor (solo cuando tiene foco)
  if (editor && monaco) {
    editor.addAction({
      id: 'tabs-new',
      label: 'New tab',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT],
      run: () => {
        newTab()
      },
    })

    editor.addAction({
      id: 'tabs-close',
      label: 'Close tab',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW],
      run: () => {
        if (state.activeId) closeTab(state.activeId)
      },
    })
  }

  // Escuchar cambios del editor para marcar dirty y persistir
  if (editor && editor.onDidChangeModelContent) {
    editor.onDidChangeModelContent(() => {
      updateActiveTabFromEditor()
    })
  }
}
