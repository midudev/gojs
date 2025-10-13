import { INITIAL_CODE } from './consts'

type MonacoLike = any
type EditorLike = any

type Tab = {
  id: string
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

const STORAGE_TABS = 'xjs.tabs'
const STORAGE_ACTIVE = 'xjs.activeTabId'

let state: TabsState = { tabs: [], activeId: null }
let editor: EditorLike | null = null
let monaco: MonacoLike | null = null
let onTabActivated: (() => void) | null = null

const generateId = () => Math.random().toString(36).slice(2, 10)

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

function createModelForTab(t: Tab) {
  if (!monaco) return
  const uri = monaco.Uri.parse(`inmemory://models/${t.id}.js`)
  t.model = monaco.editor.createModel(t.content, 'javascript', uri)
}

function ensureAtLeastOneTab() {
  if (state.tabs.length === 0) {
    const tab: Tab = {
      id: generateId(),
      content: INITIAL_CODE,
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

  const list = document.createElement('div')
  list.className = 'tabs-list'

  state.tabs.forEach((t) => {
    const tabEl = document.createElement('button')
    tabEl.className = 'tab-item' + (t.id === state.activeId ? ' active' : '')
    tabEl.title = getTabTitle(t)

    const nameEl = document.createElement('span')
    nameEl.className = 'tab-name'
    nameEl.textContent = getTabTitle(t) + (t.isDirty ? ' •' : '')

    const closeEl = document.createElement('span')
    closeEl.className = 'tab-close'
    closeEl.textContent = '×'

    tabEl.appendChild(nameEl)
    tabEl.appendChild(closeEl)

    tabEl.addEventListener('click', () => switchTab(t.id))
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(t.id)
    })

    list.appendChild(tabEl)
  })

  const addBtn = document.createElement('button')
  addBtn.className = 'tab-add'
  addBtn.textContent = '+'
  addBtn.title = 'Nueva pestaña (Ctrl/Cmd+T)'
  addBtn.addEventListener('click', () => newTab())

  container.appendChild(list)
  container.appendChild(addBtn)
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
  saveState()
  onTabActivated?.()
}

function getTabTitle(t: Tab): string {
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

  if (state.activeId === id) {
    const next = state.tabs[index] || state.tabs[index - 1]
    state.activeId = next ? next.id : null
  }

  ensureAtLeastOneTab()
  setActiveModel()
  render()
  saveState()
  onTabActivated?.()
}

export function switchTab(id: string) {
  if (state.activeId === id) return
  state.activeId = id
  setActiveModel()
  render()
  saveState()
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
  render()
  saveState()
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

  // Crear modelos
  state.tabs.forEach((t) => createModelForTab(t))
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
      label: 'Nueva pestaña',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT],
      run: () => {
        newTab()
      },
    })

    editor.addAction({
      id: 'tabs-close',
      label: 'Cerrar pestaña',
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
