import {
  AGENT_DEMO_FINAL_CODE,
  AGENT_DEMO_INITIAL_CODE,
  INITIAL_CODE,
  SHOWCASE_CODE,
  SHOWCASE_INITIAL_CODE,
} from './consts'
import { clearHistory } from './history'

type MonacoLike = any
type EditorLike = any
type EditorLanguage = 'typescript' | 'javascript'

type Tab = {
  id: string
  name?: string // Nombre personalizado de la pestaña
  content: string
  language?: EditorLanguage
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
const IS_LANDING_EMBED = EMBED_MODE === 'landing' || EMBED_MODE === 'showcase' || EMBED_MODE === 'agent-demo'
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

export function getOpenTabSnapshots(): Array<{
  id: string
  path: string
  content: string
  updatedAt: number
}> {
  return state.tabs.map((tab) => ({
    id: tab.id,
    path: getTabTitle(tab),
    content: tab.model?.getValue?.() ?? tab.content,
    updatedAt: tab.updatedAt,
  }))
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

function getTabLanguage(tab: Tab): EditorLanguage {
  return tab.language === 'javascript' ? 'javascript' : 'typescript'
}

function createModelForTab(t: Tab) {
  if (!monaco) return
  const language = getTabLanguage(t)
  const uri = monaco.Uri.parse(`inmemory://models/${t.id}.${language === 'javascript' ? 'js' : 'ts'}`)
  t.model = monaco.editor.createModel(t.content, language, uri)
}

function ensureAtLeastOneTab() {
  if (state.tabs.length === 0) {
    const showcaseCode = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? SHOWCASE_CODE
      : SHOWCASE_INITIAL_CODE
    const agentDemoCode = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? AGENT_DEMO_FINAL_CODE
      : AGENT_DEMO_INITIAL_CODE
    const tab: Tab = {
      id: generateId(),
      content: EMBED_MODE === 'showcase' ? showcaseCode : EMBED_MODE === 'agent-demo' ? agentDemoCode : INITIAL_CODE,
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
  list.setAttribute('role', 'tablist')
  list.setAttribute('aria-label', 'Open files')

  const focusTab = (id: string) => {
    requestAnimationFrame(() => {
      container.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus()
    })
  }

  const activateTab = (id: string) => {
    switchTab(id)
    focusTab(id)
  }

  state.tabs.forEach((t, index) => {
    const isActive = t.id === state.activeId
    const tabEl = document.createElement('div')
    tabEl.className = 'tab-item' + (t.id === state.activeId ? ' active' : '')
    tabEl.dataset.tabId = t.id
    tabEl.dataset.language = getTabLanguage(t)
    tabEl.title = getTabTitle(t)
    tabEl.setAttribute('role', 'tab')
    tabEl.setAttribute('aria-label', getTabTitle(t))
    tabEl.setAttribute('aria-selected', String(isActive))
    tabEl.tabIndex = isActive ? 0 : -1

    const nameEl = document.createElement('span')
    nameEl.className = 'tab-name'
    nameEl.textContent = getTabTitle(t)

    const closeEl = document.createElement('button')
    closeEl.type = 'button'
    closeEl.className = 'tab-close'
    closeEl.setAttribute('aria-label', `Close ${getTabTitle(t)}`)
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

    tabEl.addEventListener('click', () => activateTab(t.id))
    tabEl.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      closeTab(t.id)
    })
    tabEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        activateTab(t.id)
        return
      }

      let targetIndex = index
      if (event.key === 'ArrowRight') targetIndex = (index + 1) % state.tabs.length
      else if (event.key === 'ArrowLeft') targetIndex = (index - 1 + state.tabs.length) % state.tabs.length
      else if (event.key === 'Home') targetIndex = 0
      else if (event.key === 'End') targetIndex = state.tabs.length - 1
      else return

      event.preventDefault()
      const target = state.tabs[targetIndex]
      if (target) activateTab(target.id)
    })
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
  syncLanguageSelector()
}

export function setActiveTabLanguage(language: EditorLanguage) {
  if (!editor || !monaco) return
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  if (!active || getTabLanguage(active) === language) return
  // Conservar el modelo mantiene el texto, el cursor y el historial de deshacer.
  // El adaptador del worker sincroniza este modo con el analizador de sintaxis.
  if (active.model) monaco.editor.setModelLanguage(active.model, language)
  active.language = language
  setActiveModel()
  render()
  flushSaveState()
}

export function newTab() {
  // New tabs keep the language of the tab the user is working in.
  const active = state.tabs.find((t) => t.id === state.activeId)
  const tab: Tab = {
    id: generateId(),
    content: '',
    language: active ? getTabLanguage(active) : 'typescript',
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

  // Si no, usar primera línea del código (comportamiento por defecto), sin los
  // marcadores de comentario: `// fizzbuzz` se muestra como `fizzbuzz`.
  const text = t.model ? t.model.getValue() : t.content
  const firstLine = (text.split('\n')[0] || '')
    .trim()
    .replace(/^(?:\/\/+|\/\*+|\*+)\s*/, '')
    .replace(/\s*\*\/$/, '')
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

let tabsRestored = false

function restoreTabs() {
  if (tabsRestored) return
  tabsRestored = true

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

/**
 * Restaura pestañas desde localStorage (o el código por defecto) y devuelve el
 * modelo de la pestaña activa. Debe usarse al crear el editor para que el
 * primer frame ya muestre el contenido guardado y no un flash de INITIAL_CODE.
 */
export function createActiveTabModel(monacoInstance: MonacoLike) {
  monaco = monacoInstance
  restoreTabs()
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (!active) {
    throw new Error('No active tab available while bootstrapping the editor')
  }
  if (!active.model) createModelForTab(active)
  return active.model
}

function syncLanguageSelector() {
  const selector = document.querySelector<HTMLButtonElement>('#status-language')
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  if (!selector || !active) return
  const language = getTabLanguage(active)
  selector.textContent = language === 'javascript' ? 'JavaScript' : 'TypeScript'
  selector.setAttribute('aria-label', `Editor language: ${selector.textContent}`)
  document.querySelectorAll<HTMLElement>('#status-language-menu [data-language]').forEach((option) => {
    option.setAttribute('aria-checked', String(option.dataset.language === language))
  })
}

function initLanguageSelector() {
  const trigger = document.querySelector<HTMLButtonElement>('#status-language')
  const menu = document.querySelector<HTMLElement>('#status-language-menu')
  if (!trigger || !menu) return
  const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-language]'))

  const closeMenu = () => {
    menu.hidePopover()
    trigger.focus()
  }

  const positionMenu = () => {
    const bounds = trigger.getBoundingClientRect()
    menu.style.right = `${window.innerWidth - bounds.right}px`
    menu.style.bottom = `${window.innerHeight - bounds.top + 4}px`
    menu.style.minWidth = `${bounds.width}px`
  }
  menu.addEventListener('beforetoggle', (event) => {
    const open = (event as ToggleEvent).newState === 'open'
    trigger.setAttribute('aria-expanded', String(open))
    if (open) positionMenu()
  })
  menu.addEventListener('toggle', () => {
    if (menu.matches(':popover-open') && !menu.contains(document.activeElement)) {
      options.find((option) => option.getAttribute('aria-checked') === 'true')?.focus()
    }
  })
  options.forEach((option) => {
    option.addEventListener('click', () => {
      const language = option.dataset.language
      if (language === 'typescript' || language === 'javascript') setActiveTabLanguage(language)
      closeMenu()
    })
  })
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      menu.showPopover()
    }
  })
  menu.addEventListener('keydown', (event) => {
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    let next = index
    if (event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else if (event.key === 'Escape' || event.key === 'Tab') {
      closeMenu()
      if (event.key === 'Escape') event.preventDefault()
      return
    } else return
    event.preventDefault()
    options[next]?.focus()
  })
  window.addEventListener('resize', () => {
    if (menu.matches(':popover-open')) positionMenu()
  })

  // The trigger ships disabled: `popovertarget` would otherwise open the menu
  // natively before these listeners exist, unpositioned in the top-left corner.
  trigger.disabled = false
}

export function initTabs(editorInstance: EditorLike, monacoInstance: MonacoLike, onActivated?: () => void) {
  editor = editorInstance
  monaco = monacoInstance
  onTabActivated = onActivated ?? null

  // Si createActiveTabModel ya corrió, restoreTabs es un no-op y reutilizamos
  // el mismo modelo que ya tiene el editor (sin flash de contenido).
  restoreTabs()
  render()
  setActiveModel()
  // Ejecutar callback inicial para sincronizar salida con la pestaña activa
  onTabActivated?.()

  initLanguageSelector()

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
