import './style.css'
import './fonts.css'

import { init } from 'modern-monaco'
import {
  AUTO_MODEL_ID,
  AVAILABLE_CHAT_MODELS,
  CHROME_PROMPT_API_MODEL_ID,
  getChatModelDisplayName,
  getChatModelLabel,
  getChatModelPresentation,
  getChatModelRecord,
  getChromePromptApiModelLabel,
  isAutoModelId,
  isChromePromptApiModelId,
  resolveAutoModelId,
} from './ai-models'
import { INITIAL_CODE } from './consts'
import {
  AVAILABLE_THEMES,
  loadSettings,
  updateSetting,
  calculateLineHeight,
  type LayoutOrientation,
  type RenderWhitespace,
  type Theme,
} from './storage'
import { formatCode, destroyPrettierWorker } from './prettier'
import {
  transpileToJs,
  collectBareSpecifiers,
  buildImportMap,
} from './console'
import { prepareCode, destroyCodePrepWorker } from './code-prep'
import {
  formatConsoleValueText,
  isSerializedConsoleArguments,
  isSerializedConsoleValue,
} from './console-values'
import { initHeaderPopovers } from './popovers'
import { initTabs, getActiveTabId, getActiveTabTitle, flushTabsState } from './tabs'
import {
  recordVersion,
  getHistory,
  deleteEntry,
  buildHistoryViews,
  type HistoryEntry,
  type HistorySource,
  type HistoryView,
} from './history'
import { computeLineDiff, type DiffLine } from './diff'
import { $, $$ } from './dom'
import { chatbot, ChatbotState } from './chatbot'
import './keyboard-events'
import './resize-panels'
import { createRoot, type Root } from 'react-dom/client'
import { ChatResponse } from './ChatResponse'
import React from 'react'
import { runAgent, type AgentBridge, type AgentEditInfo, type AgentRunResult } from './agent/agent'
import {
  dequeueChatMessage,
  enqueueChatMessage,
  prioritizeQueuedMessage,
  removeQueuedMessage,
  takeQueuedMessageForEdit,
  type ChatQueueItem,
  type ChatQueueSelection,
} from './chat-queue'
import { isChromePromptApiAvailable } from './prompt-api'
import {
  isTauri,
  getNodeInfo,
  isNativeRuntimeAvailable,
  runNative,
  stopNative,
  onNativeOutput,
  listDependencies,
  addDependency,
  removeDependency,
  updateDependency,
  revealWorkspace,
  type Dependency,
  type NodeInfo,
} from './native-runtime'
import { instrumentNodeCode, parseNativeLogLine } from './native-console'
import { getLlamaInfo, type LlamaInfo, type LlamaModelInfo } from './llama-runtime'
import { NODE_TYPES_FILES, NODE_TYPES_VERSION } from './node-types.generated'
import type { Runtime } from './storage'
// @ts-ignore
import ExecutorWorker from './executor-worker?worker'

type ThemeTokenRule = {
  scope?: string | string[]
  settings?: {
    foreground?: string
    fontStyle?: string
  }
}

type EditorThemeData = {
  name?: string
  base?: string
  type?: 'light' | 'dark'
  colors?: Record<string, string>
  tokenColors?: ThemeTokenRule[]
  semanticHighlighting?: boolean
}

type PanelOrientation = LayoutOrientation

type ResizePanelsElement = HTMLElement & {
  getOrientation?: () => string
  requestLayoutUpdate?: () => void
}

type StorageEstimateWithDetails = StorageEstimate & {
  usageDetails?: Record<string, number>
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 767.98px)'

// Estado de la aplicación
let editor: any = null
let monaco: any = null
let autoRunEnabled = true
let debounceTimer: number | null = null
let currentDecorations: any[] = [] // Para guardar las decoraciones activas

// Duraciones de la última ejecución: línea original -> milisegundos.
// Se pintan en el gutter, justo antes del número de línea (ver getLineNumbersOption).
let lineTimings: Map<number, number> | null = null

// Solo mostramos tiempos "relevantes": por debajo de este umbral (statements triviales
// que rondan 0ms) no se pinta nada, para no llenar el gutter de ruido.
const MIN_VISIBLE_MS = 1

// Formatea una duración en un texto corto para el gutter (ej: "0ms", "4.1ms", "1.23s").
function formatDuration(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ¿Hay al menos un tiempo por encima del umbral que se vaya a pintar? Solo entonces
// merece la pena ensanchar el margen; si no, dejaría un hueco vacío a la izquierda
// del número de línea (p. ej. con statements triviales que rondan 0ms).
function hasVisibleTimings(): boolean {
  if (!lineTimings) return false
  for (const ms of lineTimings.values()) {
    if (ms >= MIN_VISIBLE_MS) return true
  }
  return false
}

// Ancho del margen de números de línea. Solo se reserva espacio extra para la columna
// de tiempos cuando de verdad hay algún tiempo visible que mostrar; en caso contrario
// se usa el ancho normal.
//
// El texto de la pastilla nunca pasa de 5 caracteres ("9.8ms", "999ms", "1.23s"), así
// que basta con un par de caracteres extra sobre los dígitos del número para que quepan
// la pastilla y el número sin dejar un hueco grande a la izquierda. Crece con ficheros
// largos (más dígitos) para no solaparse con números de 3+ cifras.
function lineNumbersMinChars(): number {
  if (!(currentSettings.lineTimings && currentSettings.lineNumbers && hasVisibleTimings())) return 5
  const digits = String(editor?.getModel()?.getLineCount() ?? 1).length
  return Math.max(7, digits + 5)
}

let timingGutterEl: HTMLDivElement | null = null
// Contenedor interior con las pastillas posicionadas en coordenadas de CONTENIDO
// (no de viewport). Al hacer scroll solo trasladamos este contenedor, sin recrear
// ni remedir nada.
let timingGutterContentEl: HTMLDivElement | null = null

function ensureTimingGutter(): HTMLDivElement | null {
  if (timingGutterEl && timingGutterEl.isConnected) return timingGutterEl
  const panel = document.querySelector('.editor-panel') as HTMLElement | null
  if (!panel) return null
  const el = document.createElement('div')
  el.className = 'timing-gutter'
  const content = document.createElement('div')
  content.className = 'timing-gutter__content'
  el.appendChild(content)
  panel.appendChild(el)
  timingGutterEl = el
  timingGutterContentEl = content
  return el
}

let timingRenderScheduled = false
function scheduleTimingRender() {
  if (timingRenderScheduled) return
  timingRenderScheduled = true
  requestAnimationFrame(() => {
    timingRenderScheduled = false
    renderTimingGutter()
  })
}

// Ruta ligera para el scroll: no remide geometría ni recrea etiquetas, solo
// desplaza el contenido ya construido. Es lo que se ejecuta en cada frame de scroll.
let timingScrollScheduled = false
function scheduleTimingScroll() {
  if (timingScrollScheduled) return
  timingScrollScheduled = true
  requestAnimationFrame(() => {
    timingScrollScheduled = false
    syncTimingScroll()
  })
}

function syncTimingScroll() {
  if (!editor || !timingGutterContentEl) return
  if (timingGutterEl && timingGutterEl.style.display === 'none') return
  timingGutterContentEl.style.transform = `translateY(${-editor.getScrollTop()}px)`
}

function renderTimingGutter() {
  if (!editor) return
  const gutter = ensureTimingGutter()
  if (!gutter || !timingGutterContentEl) return

  const content = timingGutterContentEl
  content.textContent = ''

  const show = !!lineTimings && currentSettings.lineTimings && currentSettings.lineNumbers
  if (!show) {
    gutter.style.display = 'none'
    return
  }

  const panel = document.querySelector('.editor-panel') as HTMLElement | null
  const editorEl = document.getElementById('editor') as HTMLElement | null
  const margin = editorEl?.querySelector('.margin') as HTMLElement | null
  if (!panel || !editorEl || !margin) {
    gutter.style.display = 'none'
    return
  }

  const panelRect = panel.getBoundingClientRect()
  const edRect = editorEl.getBoundingClientRect()
  const marginRect = margin.getBoundingClientRect()

  // El overlay debe cubrir SOLO la columna de números de línea, no todo el margen
  // (que incluye el área de decoraciones/folding a la derecha). Si usáramos el ancho
  // completo del margen, la etiqueta de tiempo (alineada a la derecha con un hueco fijo
  // para el número) se solaparía con el propio número. Medimos la columna real desde el
  // DOM; si no está disponible, caemos al margen completo.
  const lineNumberEl = editorEl.querySelector('.line-numbers') as HTMLElement | null
  const numbersRect = lineNumberEl ? lineNumberEl.getBoundingClientRect() : marginRect

  gutter.style.display = 'block'
  gutter.style.top = `${edRect.top - panelRect.top}px`
  gutter.style.left = `${numbersRect.left - panelRect.left}px`
  gutter.style.width = `${numbersRect.width}px`
  gutter.style.height = `${edRect.height}px`

  const model = editor.getModel()
  const lineCount = model ? model.getLineCount() : 0
  const lineHeight = lineCount >= 2 ? editor.getTopForLineNumber(2) - editor.getTopForLineNumber(1) : 19

  // Reserva a la derecha de cada pastilla para dejar sitio al número (alineado a la
  // derecha). Escala con los dígitos del número: así la pastilla queda pegada al número
  // sin solaparse, tanto en ficheros de pocas líneas como de cientos.
  const numberDigits = String(Math.max(lineCount, 1)).length
  gutter.style.setProperty('--timing-reserve', `${8 + numberDigits * 8}px`)

  // Construir todas las etiquetas una sola vez en coordenadas de contenido (sin
  // restar scrollTop). El desplazamiento se aplica luego con un transform en el
  // contenedor, de modo que el scroll no vuelva a tocar estos nodos.
  const fragment = document.createDocumentFragment()
  for (const [line, ms] of lineTimings!) {
    if (ms < MIN_VISIBLE_MS || line < 1 || line > lineCount) continue
    const top = editor.getTopForLineNumber(line)

    const label = document.createElement('div')
    label.className = 'timing-gutter__label'
    label.style.top = `${top}px`
    label.style.height = `${lineHeight}px`

    const pill = document.createElement('span')
    pill.className = 'timing-gutter__pill'
    pill.textContent = formatDuration(ms)
    label.appendChild(pill)

    fragment.appendChild(label)
  }
  content.appendChild(fragment)

  // Colocar el contenido según el scroll actual.
  content.style.transform = `translateY(${-editor.getScrollTop()}px)`
}


// Reaplica la opción de números de línea (pasa una función nueva para forzar el
// re-render del gutter en Monaco).
function refreshLineNumbers() {
  editor?.updateOptions({
    lineNumbers: currentSettings.lineNumbers ? 'on' : 'off',
    lineNumbersMinChars: lineNumbersMinChars(),
  })
  scheduleTimingRender()
}

// Descarta los tiempos medidos (p.ej. al editar, porque las líneas cambian).
function clearLineTimings() {
  if (lineTimings === null) return
  lineTimings = null
  refreshLineNumbers()
}

// Publica la altura de línea del editor como variable CSS para que la consola pueda
// pintar cada log con exactamente la misma altura que una línea de código (así los
// logs quedan alineados 1:1 con las líneas que los generan).
function getEditorFontFamilyStack(fontFamily = currentSettings.fontFamily): string {
  return `"${fontFamily}", Menlo, Monaco, "Courier New", monospace`
}

function applyEditorLineHeightVar(fontSize: number) {
  const lineHeight = calculateLineHeight(fontSize)
  document.documentElement.style.setProperty('--editor-line-height', `${lineHeight}px`)
  document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`)
  document.documentElement.style.setProperty('--editor-font-family', getEditorFontFamilyStack())
}
let currentThemeData: EditorThemeData | null = null

// Web Worker para ejecución de código con timeout
let executorWorker: Worker | null = null
let executionTimeoutId: number | null = null // Timer del hilo principal para timeout
// Generación de ejecución en el navegador. La preparación de código es asíncrona
// (worker), así que una ejecución puede quedar obsoleta si otra arranca mientras
// tanto. Comparamos este contador para descartar resultados de ejecuciones viejas.
let browserRunSeq = 0

// Roots de React creados para respuestas del asistente. Los guardamos para poder
// desmontarlos al limpiar la conversación o cerrar la app; si no, React retiene el
// árbol montado (y sus efectos/recursos) indefinidamente.
const chatResponseRoots = new Set<Root>()

function unmountChatResponseRoots() {
  for (const root of chatResponseRoots) {
    try {
      root.unmount()
    } catch {}
  }
  chatResponseRoots.clear()
}
const EXECUTION_TIMEOUT = 2000 // 2 segundos de timeout por defecto
// Timeout del runtime nativo de Node. Más holgado que el del navegador porque
// el código nativo hace tareas legítimamente lentas (fetch, I/O, etc.), pero
// acotado para que un bucle infinito no congele la app.
const NATIVE_EXECUTION_TIMEOUT = 10000
let teardownStarted = false

// Guardar la última ejecución para evitar ejecuciones innecesarias
let lastExecutionSignature: string = ''

// Serialización de ejecuciones nativas. El auto-run puede lanzar una nueva
// ejecución antes de que la anterior termine; sin esto, el listener de la
// ejecución vieja seguiría escribiendo en la salida (logs duplicados). Cada
// `runCodeNative` reclama un `runId`; solo el más reciente puede pintar.
let nativeRunSeq = 0
// Mayor generación de proceso nativo vista en la salida. Descarta líneas que
// lleguen de un proceso anterior que aún se está muriendo.
let latestNativeRunGen = 0

let currentSettings = loadSettings()
let chromePromptApiModelAvailable = false
let chromePromptApiAvailabilityChecked = false

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getChatModelDisplayNameById(modelId: string | null): string {
  if (!modelId) return 'AI model'

  if (isChromePromptApiModelId(modelId)) {
    return getChatModelDisplayName(CHROME_PROMPT_API_MODEL_ID)
  }

  const model = getChatModelRecord(modelId)
  return model ? getChatModelDisplayName(model) : modelId
}

function isPanelOrientation(value: string | null | undefined): value is PanelOrientation {
  return value === 'horizontal' || value === 'vertical'
}

function getPanelOrientation(resizePanelsElement: ResizePanelsElement): PanelOrientation {
  const orientation = resizePanelsElement.getOrientation?.() ?? resizePanelsElement.getAttribute('orientation')
  return isPanelOrientation(orientation) ? orientation : 'horizontal'
}

function formatStorageBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const fractionDigits = unitIndex >= 3 ? 2 : unitIndex === 0 ? 0 : 1
  return `${value.toFixed(fractionDigits)} ${BYTE_UNITS[unitIndex]}`
}

async function refreshChromePromptApiModelAvailability() {
  if (chromePromptApiAvailabilityChecked) return

  chromePromptApiModelAvailable = await isChromePromptApiAvailable()
  chromePromptApiAvailabilityChecked = true
}

function enableChromePromptApiAssistantIfAvailable() {
  if (!chromePromptApiModelAvailable) return

  if (!isChromePromptApiModelId(currentSettings.aiModelId)) {
    currentSettings = updateSetting(currentSettings, 'aiModelId', CHROME_PROMPT_API_MODEL_ID)
  }

  if (!currentSettings.aiEnabled) {
    currentSettings = updateSetting(currentSettings, 'aiEnabled', true)
  }
}

function getVisibleChatModelId(modelId: string): string {
  if (isAutoModelId(modelId)) {
    return resolveModelChoice(modelId)
  }

  if (isChromePromptApiModelId(modelId) && !chromePromptApiModelAvailable) {
    return AVAILABLE_CHAT_MODELS[0]?.model_id ?? modelId
  }

  return modelId
}

// --- Catálogo de modelos nativos (llama.cpp), solo escritorio --------------
// En la app de escritorio no hay WebGPU: el asistente corre con llama.cpp. El
// selector del composer muestra estos modelos representados de forma visual —
// solo lo que ocupan y su nivel de inteligencia, sin el nombre técnico.

// Debe coincidir con DEFAULT_MODEL_ID en `src-tauri/src/llama_runtime.rs`. Se usa
// como fallback concreto mientras el catálogo real aún no ha llegado del backend.
const NATIVE_DEFAULT_MODEL_ID = 'qwen2.5-coder-1.5b'

let nativeLlamaInfo: LlamaInfo | null = null

async function ensureNativeLlamaInfo(force = false): Promise<LlamaInfo | null> {
  if (!isTauri()) return null
  if (nativeLlamaInfo && !force) return nativeLlamaInfo
  nativeLlamaInfo = await getLlamaInfo()
  return nativeLlamaInfo
}

function nativeModels(): LlamaModelInfo[] {
  return nativeLlamaInfo?.models ?? []
}

function nativeDefaultModelId(): string {
  return (
    nativeLlamaInfo?.default_model_id ??
    nativeModels().find((model) => model.is_default)?.id ??
    NATIVE_DEFAULT_MODEL_ID
  )
}

function isNativeModelId(id: string): boolean {
  return nativeModels().some((model) => model.id === id)
}

// Mapea cualquier elección (incluida "auto" o un id viejo de WebLLM) a un id de
// modelo nativo concreto, para que las comprobaciones de "ya cargado" cuadren.
function resolveNativeChoice(choice: string): string {
  return isNativeModelId(choice) ? choice : nativeDefaultModelId()
}

// Nivel de inteligencia 1–3 a partir del número de parámetros. El catálogo es
// 0.5B / 1.5B / 3B, así que se mapea limpio a un medidor de 3 puntos y a un
// nombre de "tier" que es la etiqueta principal del selector.
function nativeIntelligence(model: LlamaModelInfo): { level: number; name: string } {
  const billions = Number.parseFloat(model.params)
  if (!Number.isFinite(billions) || billions < 1) return { level: 1, name: 'Small' }
  if (billions < 3) return { level: 2, name: 'Medium' }
  return { level: 3, name: 'Smarter' }
}

function intelligenceDotsHtml(level: number, maximum = 3): string {
  return Array.from({ length: maximum }, (_, index) => index + 1)
    .map((index) => `<i class="chatbot-iq-dot${index <= level ? ' on' : ''}"></i>`)
    .join('')
}

function downloadedModelIconHtml(): string {
  return `
    <span class="chatbot-model-downloaded" role="img" aria-label="Downloaded" title="Downloaded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="m8.5 12 2.25 2.25L15.5 9.5"></path>
      </svg>
    </span>`
}

// Tamaño limpio para el selector: MB sin decimales, GB con uno ("940 MB", "1.9 GB").
function formatModelSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`
  return `${(megabytes / 1024).toFixed(1)} GB`
}

// HTML compacto de una opción/etiqueta: nombre (tier) + medidor + tamaño.
function nativeModelVisualHtml(model: LlamaModelInfo): string {
  const iq = nativeIntelligence(model)
  return (
    `<span class="chatbot-model-tier">${escapeHtml(iq.name)}</span>` +
    `<span class="chatbot-iq" role="img" aria-label="${escapeHtml(iq.name)}" title="${escapeHtml(iq.name)}">${intelligenceDotsHtml(iq.level)}</span>` +
    `<span class="chatbot-model-size">${escapeHtml(formatModelSize(model.size_bytes))}</span>`
  )
}

// En web ocultamos los nombres técnicos del catálogo y usamos la misma
// representación del escritorio: nivel de capacidad, medidor y memoria necesaria.
function webModelVisualHtml(model: (typeof AVAILABLE_CHAT_MODELS)[number]): string {
  const presentation = getChatModelPresentation(model)
  const reasoningLabel = `Reasoning level ${presentation.level} of 4`
  return (
    `<span class="chatbot-model-tier">${escapeHtml(presentation.name)}</span>` +
    `<span class="chatbot-iq" role="img" aria-label="${reasoningLabel}" title="${reasoningLabel}">${intelligenceDotsHtml(presentation.level, 4)}</span>` +
    `<span class="chatbot-model-size">${escapeHtml(presentation.size)}</span>`
  )
}

// El modelo del sistema (Chrome Prompt API) es Gemini Nano: viene integrado en el
// navegador, no ocupa descarga propia (0 GB) y, si lo detectamos, ya está listo.
const PROMPT_API_REASONING_LEVEL = 4

function webPromptApiVisualHtml(): string {
  const reasoningLabel = `Reasoning level ${PROMPT_API_REASONING_LEVEL} of 4`
  return (
    `<span class="chatbot-model-tier">Gemini</span>` +
    `<span class="chatbot-iq" role="img" aria-label="${reasoningLabel}" title="${reasoningLabel}">${intelligenceDotsHtml(PROMPT_API_REASONING_LEVEL, 4)}</span>` +
    `<span class="chatbot-model-size">0 GB</span>`
  )
}

// Resuelve la elección del usuario (que puede ser "auto") a un modelo concreto.
function resolveModelChoice(choice: string): string {
  if (isTauri()) return resolveNativeChoice(choice)
  if (isAutoModelId(choice)) {
    return resolveAutoModelId(chromePromptApiModelAvailable)
  }
  return choice
}

// Etiqueta corta para el selector del composer (estilo Cursor).
function getModelChoiceShortLabel(choice: string): string {
  if (isAutoModelId(choice)) return 'Auto'
  if (isChromePromptApiModelId(choice)) return 'Gemini'
  const record = getChatModelRecord(choice)
  return record ? getChatModelDisplayName(record) : 'Auto'
}

// Marca el panel como vacío (composer arriba) o con conversación (composer abajo).
function updateChatEmptyState() {
  const panel = $('#chatbot-panel') as HTMLElement | null
  const messages = $('#chatbot-messages') as HTMLElement | null
  if (!panel || !messages) return
  const hasConversation = !!messages.querySelector('.chatbot-message, .agent-run')
  panel.classList.toggle('is-empty', !hasConversation)
}

// ---------------------------------------------------------------------------
// Selección del editor como contexto del agente (chip en el composer)
// ---------------------------------------------------------------------------
let pendingSelection: ChatQueueSelection | null = null

function getActiveTabLabel(): string {
  const activeTab = document.querySelector('.tab-item.active') as HTMLElement | null
  const label = activeTab?.getAttribute('title')?.trim() || activeTab?.textContent?.trim()
  return label && label.length ? label : 'code'
}

function renderSelectionChip() {
  const container = $('#chatbot-context') as HTMLElement | null
  if (!container) return

  if (!pendingSelection) {
    container.hidden = true
    container.innerHTML = ''
    return
  }

  const { label, startLine, endLine } = pendingSelection
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
  container.hidden = false
  container.innerHTML = `
    <span class="chatbot-context-chip">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 5l0 14"/><path d="M18 13l-6 6"/><path d="M6 13l6 6"/></svg>
      <span class="chatbot-context-name">${escapeHtml(label)}</span>
      <span class="chatbot-context-range">(${range})</span>
      <button class="chatbot-context-remove" type="button" title="Remove context" aria-label="Remove context">×</button>
    </span>`

  container.querySelector('.chatbot-context-remove')?.addEventListener('click', (event) => {
    event.stopPropagation()
    pendingSelection = null
    renderSelectionChip()
  })
}

// Captura la selección actual y limpia el chip para que cada turno conserve su contexto.
function takePendingSelection(): ChatQueueSelection | null {
  if (!pendingSelection) return null
  const selection = pendingSelection
  pendingSelection = null
  renderSelectionChip()
  return selection
}

function formatSelectionContext(selection: ChatQueueSelection): string {
  const { text, startLine, endLine, label } = selection
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
  return `The user selected this code from ${label} (${range}):\n\`\`\`\n${text}\n\`\`\``
}

// Escucha la selección del editor y actualiza el chip de contexto.
function setupSelectionContext() {
  if (!editor) return
  editor.onDidChangeCursorSelection(() => {
    const selection = editor.getSelection?.()
    if (!selection || selection.isEmpty?.()) {
      // Navegar con el cursor (sin selección) no debe tocar el DOM salvo que
      // hubiera un chip que limpiar.
      if (pendingSelection === null) return
      pendingSelection = null
      renderSelectionChip()
      return
    }
    const model = editor.getModel?.()
    const text = model?.getValueInRange(selection) ?? ''
    if (!text.trim()) return

    const startLine = selection.startLineNumber
    const endLine = selection.endLineNumber
    // Si el rango y el texto no cambian, evitamos reconstruir el chip.
    if (
      pendingSelection &&
      pendingSelection.startLine === startLine &&
      pendingSelection.endLine === endLine &&
      pendingSelection.text === text
    ) {
      return
    }

    pendingSelection = {
      text,
      startLine,
      endLine,
      label: getActiveTabLabel(),
    }
    renderSelectionChip()
  })
}

// Elección de modelo del usuario en el composer (puede ser "auto"), independiente
// del modelo concreto que finalmente se carga. Se persiste aparte para no depender
// de storage.ts.
const MODEL_CHOICE_STORAGE_KEY = 'gojs-model-choice'
let userModelChoice: string = (() => {
  try {
    return localStorage.getItem(MODEL_CHOICE_STORAGE_KEY) || AUTO_MODEL_ID
  } catch {
    return AUTO_MODEL_ID
  }
})()

function setUserModelChoice(choice: string) {
  userModelChoice = choice
  try {
    localStorage.setItem(MODEL_CHOICE_STORAGE_KEY, choice)
  } catch {
    /* almacenamiento no disponible */
  }
}

// Mientras un envío espera a que el modelo cargue, este callback recibe el progreso
// para mostrarlo en el mensaje ("Preparing model…", "Downloading model… 42%") en vez
// de una pantalla de carga. Es null cuando la carga es en segundo plano (silenciosa).
let modelLoadStatusUpdater: ((text: string) => void) | null = null

// Traduce el estado de carga a una línea paso a paso para el usuario. El backend
// nativo (llama.cpp) rellena `loadStatusMessage` con el paso concreto en curso
// ("Downloading llama.cpp runtime…", "Loading model into memory…", etc.); en la web
// no hay ese detalle, así que caemos al porcentaje de descarga de WebLLM.
function describeModelLoadStatus(state: ChatbotState): string {
  if (state.loadStatusMessage) return state.loadStatusMessage
  const pct = Math.round(state.loadProgress)
  if (pct <= 0) return 'Preparing model…'

  const details = [`Downloading model… ${pct}%`]
  const downloadedBytes = state.downloadedBytes
  const totalBytes = state.downloadTotalBytes

  if (
    typeof downloadedBytes === 'number' &&
    typeof totalBytes === 'number' &&
    Number.isFinite(downloadedBytes) &&
    Number.isFinite(totalBytes) &&
    totalBytes > downloadedBytes
  ) {
    details.push(`${formatDownloadAmount(totalBytes - downloadedBytes)} left`)
  }

  const speed = formatDownloadSpeed(state.downloadSpeedBytesPerSecond)
  if (speed) details.push(speed)

  return details.join(' · ')
}

// true mientras el agente está procesando un mensaje (evita reentradas / doble envío).
let agentBusy = false
let chatQueue: ChatQueueItem[] = []
let queuedMessageSequence = 0
let chatQueueCollapsed = false

// Refleja la elección actual en la etiqueta del selector del composer.
function updateComposerModelLabel() {
  const label = $('#chatbot-model-label') as HTMLElement | null
  if (!label) return

  if (isTauri()) {
    const model = nativeModels().find((candidate) => candidate.id === resolveNativeChoice(userModelChoice))
    if (model) {
      label.classList.add('chatbot-model-label--native')
      label.innerHTML = nativeModelVisualHtml(model)
    } else {
      label.textContent = 'Local model'
    }
    return
  }

  label.classList.remove('chatbot-model-label--native', 'chatbot-model-label--visual')

  if (isChromePromptApiModelId(userModelChoice) && chromePromptApiModelAvailable) {
    label.classList.add('chatbot-model-label--visual')
    label.innerHTML = webPromptApiVisualHtml()
    return
  }

  if (!isAutoModelId(userModelChoice) && !isChromePromptApiModelId(userModelChoice)) {
    const model = getChatModelRecord(userModelChoice)
    if (model) {
      label.classList.add('chatbot-model-label--visual')
      label.innerHTML = webModelVisualHtml(model)
      return
    }
  }

  label.textContent = getModelChoiceShortLabel(userModelChoice)
}

// Asegura que el modelo elegido (resuelto) esté cargado; devuelve true si quedó listo.
async function ensureModelLoadedForChoice(): Promise<boolean> {
  const target = resolveModelChoice(userModelChoice)
  const state = chatbot.getState()

  if (state.isReady && state.currentModelId === target) return true

  try {
    await loadChatbotModel(target)
    return chatbot.getState().isReady
  } catch (error) {
    console.error('Error loading model:', error)
    return false
  }
}

// Construye y cablea el selector de modelo del composer (dropdown estilo Cursor).
function setupComposerModelSelector() {
  const trigger = $('#chatbot-model-trigger') as HTMLButtonElement | null
  const menu = $('#chatbot-model-menu') as HTMLElement | null
  if (!trigger || !menu) return

  let menuRenderVersion = 0

  const closeMenu = () => {
    menuRenderVersion += 1
    menu.hidden = true
    menu.removeAttribute('aria-busy')
    trigger.setAttribute('aria-expanded', 'false')
  }

  const renderNativeOptions = () => {
    const selected = resolveNativeChoice(userModelChoice)
    menu.classList.add('chatbot-model-menu--native')
    menu.classList.remove('chatbot-model-menu--visual')
    menu.innerHTML = nativeModels()
      .map((model) => {
        const iq = nativeIntelligence(model)
        const state = model.installed ? 'downloaded' : `downloads ${formatModelSize(model.size_bytes)} on first use`
        return `
      <button type="button" class="chatbot-model-option chatbot-model-option--native${model.id === selected ? ' selected' : ''}" data-model-id="${escapeHtml(model.id)}" role="option" title="${escapeHtml(iq.name)} · ${escapeHtml(state)}">
        ${nativeModelVisualHtml(model)}
        ${model.installed ? downloadedModelIconHtml() : ''}
      </button>`
      })
      .join('')
  }

  const renderWebOptions = (installedModels: ReadonlySet<string> = new Set()) => {
    menu.classList.add('chatbot-model-menu--visual')
    menu.classList.remove('chatbot-model-menu--native')
    const automaticOptions = [
      {
        id: AUTO_MODEL_ID,
        name: 'Auto',
        meta: 'Best fit for this device',
      },
    ]

    const automaticOptionsHtml = automaticOptions
      .map(
        (choice) => `
      <button type="button" class="chatbot-model-option chatbot-model-option--automatic${choice.id === userModelChoice ? ' selected' : ''}" data-model-id="${escapeHtml(choice.id)}" role="option">
        <span class="chatbot-model-option-copy">
          <span class="chatbot-model-option-name">${escapeHtml(choice.name)}</span>
          <span class="chatbot-model-option-meta">${escapeHtml(choice.meta)}</span>
        </span>
      </button>`,
      )
      .join('')

    // Gemini (Prompt API) encabeza la lista visual: es el más rápido de tener
    // listo (0 GB, integrado) y solo aparece cuando lo detectamos disponible, en
    // cuyo caso ya está listo, así que siempre lleva la marca de descargado.
    const promptApiOptionHtml = chromePromptApiModelAvailable
      ? `
      <button type="button" class="chatbot-model-option chatbot-model-option--visual${userModelChoice === CHROME_PROMPT_API_MODEL_ID ? ' selected' : ''}" data-model-id="${escapeHtml(CHROME_PROMPT_API_MODEL_ID)}" role="option" title="Gemini · 0 GB · Built in">
        ${webPromptApiVisualHtml()}
        ${downloadedModelIconHtml()}
      </button>`
      : ''

    const downloadableOptionsHtml = AVAILABLE_CHAT_MODELS.map((model) => {
      const selected = model.model_id === userModelChoice
      const presentation = getChatModelPresentation(model)
      const installed = installedModels.has(model.model_id)
      const title = `${presentation.name} · ${presentation.size}${installed ? ' · Downloaded' : ''}`
      return `
      <button type="button" class="chatbot-model-option chatbot-model-option--visual${selected ? ' selected' : ''}" data-model-id="${escapeHtml(model.model_id)}" role="option" title="${escapeHtml(title)}">
        ${webModelVisualHtml(model)}
        ${installed ? downloadedModelIconHtml() : ''}
      </button>`
    }).join('')

    menu.innerHTML = `${automaticOptionsHtml}<div class="chatbot-model-divider" role="separator"></div>${promptApiOptionHtml}${downloadableOptionsHtml}`
  }

  const updateWebInstalledState = (installedModels: ReadonlySet<string>) => {
    menu.querySelectorAll<HTMLElement>('.chatbot-model-option--visual').forEach((option) => {
      const modelId = option.dataset.modelId
      if (!modelId) return

      const model = getChatModelRecord(modelId)
      if (!model) return

      const installed = installedModels.has(modelId)
      const presentation = getChatModelPresentation(model)
      option.title = `${presentation.name} · ${presentation.size}${installed ? ' · Downloaded' : ''}`

      const downloadedIcon = option.querySelector('.chatbot-model-downloaded')
      if (installed && !downloadedIcon) {
        option.insertAdjacentHTML('beforeend', downloadedModelIconHtml())
      } else if (!installed) {
        downloadedIcon?.remove()
      }
    })
  }

  const buildOptions = async (renderVersion: number) => {
    menu.setAttribute('aria-busy', 'true')

    // Escritorio: mostramos el catálogo cacheado al instante y lo refrescamos
    // en segundo plano. En el primer arranque dejamos feedback visible.
    if (isTauri()) {
      if (nativeModels().length > 0) {
        renderNativeOptions()
      } else {
        menu.classList.add('chatbot-model-menu--native')
        menu.classList.remove('chatbot-model-menu--visual')
        menu.innerHTML = '<div class="chatbot-model-menu-status" role="status">Loading models…</div>'
      }

      try {
        await ensureNativeLlamaInfo(true)
        if (renderVersion !== menuRenderVersion) return
        renderNativeOptions()
      } catch (error) {
        if (renderVersion !== menuRenderVersion) return
        console.error('Error loading native model list:', error)
        if (!menu.querySelector('.chatbot-model-option')) {
          menu.innerHTML =
            '<div class="chatbot-model-menu-status chatbot-model-menu-status--error" role="alert">Could not load models. Close and try again.</div>'
        }
      } finally {
        if (renderVersion === menuRenderVersion) menu.removeAttribute('aria-busy')
      }
      return
    }

    // Web: las opciones no dependen de IndexedDB, así que se muestran antes de
    // comprobar cuáles están descargadas.
    renderWebOptions()

    const installedModels = new Set(
      (
        await Promise.all(
          AVAILABLE_CHAT_MODELS.map(async (model) => ({
            id: model.model_id,
            installed: await chatbot.isModelInstalled(model.model_id).catch(() => false),
          })),
        )
      )
        .filter((model) => model.installed)
        .map((model) => model.id),
    )

    if (renderVersion !== menuRenderVersion) return
    updateWebInstalledState(installedModels)
    menu.removeAttribute('aria-busy')
  }

  const openMenu = () => {
    const renderVersion = ++menuRenderVersion
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')

    void buildOptions(renderVersion).catch((error) => {
      if (renderVersion !== menuRenderVersion) return
      console.error('Error building model selector:', error)
      menu.removeAttribute('aria-busy')
      if (!menu.querySelector('.chatbot-model-option')) {
        menu.innerHTML =
          '<div class="chatbot-model-menu-status chatbot-model-menu-status--error" role="alert">Could not load models. Close and try again.</div>'
      }
    })
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    if (menu.hidden) {
      openMenu()
    } else {
      closeMenu()
    }
  })

  menu.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest('.chatbot-model-option') as HTMLElement | null
    if (!option) return
    const id = option.dataset.modelId
    if (!id) return

    setUserModelChoice(id)
    updateComposerModelLabel()
    closeMenu()

    // Si el modelo resuelto ya está disponible (system) o instalado, cárgalo ya.
    void (async () => {
      const target = resolveModelChoice(id)
      const installed = await chatbot.isModelInstalled(target).catch(() => false)
      if (isChromePromptApiModelId(target) || installed) {
        await ensureModelLoadedForChoice()
      }
    })()
  })

  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && event.target !== trigger) {
      closeMenu()
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu()
  })

  updateComposerModelLabel()

  // Escritorio: en cuanto llega el catálogo nativo, fijamos una elección concreta
  // (si la guardada era "auto" o un id viejo de WebLLM) y repintamos la etiqueta.
  if (isTauri()) {
    void ensureNativeLlamaInfo().then(() => {
      if (!isNativeModelId(userModelChoice)) setUserModelChoice(nativeDefaultModelId())
      updateComposerModelLabel()
    })
  }
}

function getChatModelOptionsHtml(selectedModelId: string): string {
  const optionsHtml = AVAILABLE_CHAT_MODELS.map((model) => {
    const selected = model.model_id === selectedModelId ? ' selected' : ''
    return `<option value="${escapeHtml(model.model_id)}"${selected}>${escapeHtml(getChatModelLabel(model))}</option>`
  }).join('')

  if (!chromePromptApiModelAvailable) {
    return optionsHtml
  }

  const selected = isChromePromptApiModelId(selectedModelId) ? ' selected' : ''
  return `<option value="${CHROME_PROMPT_API_MODEL_ID}"${selected}>${escapeHtml(getChromePromptApiModelLabel())}</option>${optionsHtml}`
}

function getChatModelMetaText(modelId: string): string {
  if (isChromePromptApiModelId(modelId)) {
    return 'Uses Chrome Prompt API with the browser system model. No WebLLM download is needed.'
  }

  const model = getChatModelRecord(modelId)

  if (!model) return 'Model unavailable.'

  const metaParts = []

  if (typeof model.vram_required_MB === 'number') {
    metaParts.push(`Approx. VRAM: ${(model.vram_required_MB / 1024).toFixed(1)} GB`)
  }

  if (model.low_resource_required) {
    metaParts.push('Low-resource friendly')
  }

  return metaParts.join(' · ') || 'Downloads locally in the browser when loaded.'
}

function shouldAutoLoadChatModel(modelId: string): boolean {
  return !isChromePromptApiModelId(modelId)
}

async function loadChatbotModel(modelId: string) {
  currentSettings = updateSetting(currentSettings, 'aiModelId', modelId)

  const state = chatbot.getState()
  const forceReload = state.isReady && state.currentModelId === modelId
  await chatbot.loadModel(modelId, forceReload)
}

async function refreshChatbotModelPickerStatus() {
  const select = $('#chatbot-model-select') as HTMLSelectElement | null
  const status = $('#chatbot-model-status') as HTMLElement | null
  const loadButton = $('#chatbot-model-load') as HTMLButtonElement | null

  if (!select || !status || !loadButton) return

  const modelId = select.value
  const modelName = getChatModelDisplayNameById(modelId)
  const isSystemModel = isChromePromptApiModelId(modelId)
  const chatbotState = chatbot.getState()
  const isSelectedLoading = chatbotState.currentModelId === modelId && chatbotState.isInitializing
  const isSelectedReady = chatbotState.currentModelId === modelId && chatbotState.isReady
  const isInstalled = await chatbot.isModelInstalled(modelId).catch(() => false)

  if (isSelectedLoading) {
    status.textContent = `Loading ${modelName}...`
  } else if (isSelectedReady) {
    status.textContent = `${modelName} is loaded and ready.`
  } else if (isSystemModel && isInstalled) {
    status.textContent = `${modelName} is available in Chrome. No model download is needed.`
  } else if (isInstalled) {
    status.textContent = `${modelName} is already installed in this browser and will load automatically.`
  } else {
    status.textContent = `No model is loaded yet. Choose one to start the assistant. ${getChatModelMetaText(modelId)}`
  }

  select.disabled = chatbotState.isInitializing
  loadButton.disabled = chatbotState.isInitializing
  loadButton.textContent = isSelectedLoading
    ? 'Loading...'
    : isSystemModel
      ? 'Use system model'
      : isInstalled || isSelectedReady
        ? 'Load model'
        : 'Download and load'
}

function renderChatbotModelPickerUI(errorMessage?: string) {
  const chatbotMessages = $('#chatbot-messages') as HTMLElement | null
  const chatbotClear = $('#chatbot-clear') as HTMLButtonElement | null

  if (!chatbotMessages) return

  if (chatbotClear) {
    chatbotClear.hidden = true
  }

  chatbotMessages.innerHTML = `
    <div class="chatbot-model-picker" id="chatbot-model-picker">
      ${errorMessage ? `<div class="chatbot-error-message">${escapeHtml(errorMessage)}</div>` : ''}
      <div class="chatbot-model-picker-header">
        <div class="chatbot-message-role">AI Assistant</div>
        <h3>Choose a model</h3>
        <p>No AI model is running yet. Pick one to start the assistant.</p>
      </div>
      <label for="chatbot-model-select">Model</label>
      <select id="chatbot-model-select">${getChatModelOptionsHtml(getVisibleChatModelId(currentSettings.aiModelId))}</select>
      <div id="chatbot-model-status" class="chatbot-model-status"></div>
      <button id="chatbot-model-load" type="button" class="chatbot-model-load-button">Load model</button>
    </div>
  `

  const select = $('#chatbot-model-select') as HTMLSelectElement | null
  const loadButton = $('#chatbot-model-load') as HTMLButtonElement | null

  if (!select || !loadButton) return

  select.addEventListener('change', () => {
    currentSettings = updateSetting(currentSettings, 'aiModelId', select.value)

    const settingsSelect = $('#setting-ai-model') as HTMLSelectElement | null
    if (settingsSelect) {
      settingsSelect.value = select.value
      settingsSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }

    void (async () => {
      await refreshChatbotModelPickerStatus()

      const isInstalled = await chatbot.isModelInstalled(select.value).catch(() => false)
      if (isInstalled && shouldAutoLoadChatModel(select.value) && !chatbot.getState().isInitializing) {
        await loadChatbotModel(select.value)
      }
    })()
  })

  loadButton.addEventListener('click', async () => {
    const modelId = select.value || currentSettings.aiModelId
    currentSettings = updateSetting(currentSettings, 'aiModelId', modelId)

    const settingsSelect = $('#setting-ai-model') as HTMLSelectElement | null
    if (settingsSelect) {
      settingsSelect.value = modelId
      settingsSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }

    await loadChatbotModel(modelId)
  })

  void refreshChatbotModelPickerStatus()
}

function formatDownloadSpeed(bytesPerSecond: number | null): string {
  if (!bytesPerSecond || bytesPerSecond <= 0 || !Number.isFinite(bytesPerSecond)) {
    return ''
  }

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let speed = bytesPerSecond
  let unitIndex = 0

  while (speed >= 1024 && unitIndex < units.length - 1) {
    speed /= 1024
    unitIndex += 1
  }

  const decimals = unitIndex === 0 || speed >= 10 ? 0 : 1

  return `${speed.toFixed(decimals)} ${units[unitIndex]}`
}

function formatDownloadAmount(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
  if (megabytes >= 10) return `${Math.round(megabytes)} MB`
  return `${megabytes.toFixed(1)} MB`
}

function renderChatbotLoadingUI(
  progress = 0,
  modelId?: string | null,
  downloadSpeedBytesPerSecond: number | null = null,
) {
  const chatbotMessages = $('#chatbot-messages') as HTMLElement | null
  const chatbotClear = $('#chatbot-clear') as HTMLButtonElement | null

  if (!chatbotMessages) return

  if (chatbotClear) {
    chatbotClear.hidden = true
  }

  const modelName = getChatModelDisplayNameById(modelId ?? chatbot.getState().currentModelId)
  const downloadSpeedText = formatDownloadSpeed(downloadSpeedBytesPerSecond)

  chatbotMessages.innerHTML = `
    <div class="chatbot-loading-message" id="chatbot-loading">
      <div class="loading-spinner" aria-hidden="true"></div>
      <div class="loading-copy">
        <span class="loading-title">Loading ${modelName}...</span>
      </div>
      <div class="loading-progress-panel">
        <div class="loading-progress">
          <div class="loading-progress-bar" id="loading-progress-bar" style="width: ${progress}%"></div>
        </div>
        <div class="loading-progress-meta">
          <div class="loading-progress-text" id="loading-progress-text">${Math.round(progress)}%</div>
          <div class="loading-download-speed" id="loading-download-speed"${
            downloadSpeedText ? '' : ' hidden'
          }>${downloadSpeedText}</div>
        </div>
      </div>
    </div>
  `
}

// Reúne el código de todas las pestañas persistidas para sembrar el import map del LSP
// en el arranque (así los imports ya presentes obtienen tipos sin recargar).
function collectPersistedCode(): string {
  const parts = [INITIAL_CODE]
  try {
    const raw = localStorage.getItem('xjs.tabs')
    if (raw) {
      const tabs = JSON.parse(raw)
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          if (tab && typeof tab.content === 'string') parts.push(tab.content)
        }
      }
    }
  } catch {}
  return parts.join('\n')
}

// Temas cargados (se conservan para poder re-configurar el LSP sin recargarlos).
let loadedMonacoThemes: any[] = []

// Tipos de Node.js para el autocompletado (globals como `process`, `Buffer`,
// `__dirname` y los módulos `node:*`). modern-monaco carga cada URL de
// `compilerOptions.types` como un fichero del programa, pero NO sigue las
// `/// <reference path=... />` de esos ficheros. El `index.d.ts` de @types/node
// es casi solo referencias, así que hay que enumerar index + todas sus
// referencias (donde viven las declaraciones `declare module "node:os"`, etc.).
// La lista se genera desde el paquete instalado con `pnpm types:node`.
//
// Servimos esos .d.ts desde el propio bundle (mismo origen) en vez de hacer ~90
// peticiones cross-origin a esm.sh: Vite emite cada fichero como asset y nos da su
// URL local, lo que además funciona offline y es cacheable. Si por lo que sea un
// fichero no resuelve localmente, caemos a esm.sh para no perder autocompletado.
const NODE_TYPES_ASSET_URLS = import.meta.glob('/node_modules/@types/node/**/*.d.ts', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const NODE_TYPES_URLS = NODE_TYPES_FILES.map((file) => {
  const localUrl = NODE_TYPES_ASSET_URLS[`/node_modules/@types/node/${file}`]
  return localUrl ?? `https://esm.sh/@types/node@${NODE_TYPES_VERSION}/${file}`
})

// Construye las opciones de `init()` con el import map derivado de los paquetes dados.
function buildMonacoInitOptions(specifiers: string[]) {
  return {
    defaultTheme: currentSettings.theme,
    themes: loadedMonacoThemes,
    lsp: {
      typescript: {
        importMap: {
          imports: buildImportMap(specifiers),
          scopes: {},
        },
        compilerOptions: {
          target: 99, // ES2022
          module: 99, // ESNext
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          // Tipos de Node.js (autocomplete de `process`, `fs`, `node:*`, etc.).
          // modern-monaco los descarga y añade al programa del LSP.
          types: NODE_TYPES_URLS,
          strict: true,
          // En un playground el `catch (error)` casual no debería marcar error: dejamos
          // la variable como `any` en vez de `unknown`.
          useUnknownInCatchVariables: false,
          esModuleInterop: true,
          skipLibCheck: true,
          moduleResolution: 100, // Bundler (resuelve import maps / CDN esm.sh)
          allowJs: true,
          checkJs: true,
          jsx: 2, // React
          noEmit: true,
        },
      },
    },
  }
}

// Inicializar editor
async function initEditor() {
  const editorElement = $('#editor')!
  // Solo cargamos el tema ACTIVO en el arranque. Los demás se registran bajo
  // demanda al seleccionarlos (changeTheme → defineTheme), así evitamos 8
  // fetch + parse de JSON en el hilo principal durante el inicio.
  loadedMonacoThemes = [await loadThemeData(currentSettings.theme)]

  // Sembrar el import map del LSP con los paquetes ya importados en las pestañas.
  const seedSpecifiers = collectBareSpecifiers(collectPersistedCode())

  // Inicializar Monaco con configuración manual
  monaco = await init(buildMonacoInitOptions(seedSpecifiers))

  // modern-monaco 0.4 incluye `< >` como par coloreable en JS/TS. Eso hace que
  // cada `>` de `=>` y de una comparación se marque como cierre inesperado,
  // separando la ligadura y pintándola en rojo. Conservamos el coloreado útil
  // de (), [] y {}, pero excluimos los ángulos antes de activar el lenguaje.
  for (const languageId of ['javascript', 'typescript']) {
    const languageConfig = monaco.languageConfigurations?.[languageId]
    if (languageConfig?.colorizedBracketPairs) {
      languageConfig.colorizedBracketPairs = languageConfig.colorizedBracketPairs.filter(
        ([open, close]: [string, string]) => open !== '<' || close !== '>',
      )
    }
  }

  // Crear instancia del editor
  applyEditorLineHeightVar(currentSettings.fontSize)

  // Usar un modelo con URI `.ts` para que el LSP de TypeScript lo type-chequee y
  // cargue tipos de los imports. El modelo por defecto de `create({ value })` usa una
  // URI sin extensión que el LSP no reconoce (los modelos de las pestañas ya son `.ts`).
  const initialModel = monaco.editor.createModel(
    INITIAL_CODE,
    'typescript',
    monaco.Uri.parse('inmemory://models/__initial.ts'),
  )

  editor = monaco.editor.create(editorElement, {
    model: initialModel,
    theme: currentSettings.theme,
    fontFamily: getEditorFontFamilyStack(),
    fontSize: currentSettings.fontSize,
    lineHeight: calculateLineHeight(currentSettings.fontSize),
    minimap: {
      enabled: currentSettings.minimap,
    },
    lineNumbers: currentSettings.lineNumbers ? 'on' : 'off',
    lineNumbersMinChars: lineNumbersMinChars(),
    wordWrap: currentSettings.wordWrap ? 'on' : 'off',
    fontLigatures: currentSettings.fontLigatures,
    stickyScroll: {
      enabled: currentSettings.stickyScroll,
    },
    guides: {
      indentation: currentSettings.indentGuides,
      highlightActiveIndentation: currentSettings.indentGuides,
    },
    renderWhitespace: currentSettings.renderWhitespace,
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
    },
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    formatOnPaste: currentSettings.formatOnPaste,
    formatOnType: currentSettings.formatOnType,
    autoClosingBrackets: 'always',
    autoClosingQuotes: 'always',
    autoIndent: 'full',
    bracketPairColorization: {
      enabled: true,
    },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    padding: {
      top: 16,
      bottom: 16,
    },
    readOnly: false, // Asegurar que sea editable
    domReadOnly: false,
  })

  // Registrar comando para formatear
  editor.addAction({
    id: 'format-document',
    label: 'Formatear Documento',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
    run: async () => {
      await formatEditorCode()
    },
  })

  // Registrar comando para ejecutar código
  editor.addAction({
    id: 'run-code',
    label: 'Ejecutar Código',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => {
      runCode()
    },
  })

  setupEditorEvents()
  setupSelectionContext()

  // Aplicar el tema inicial con la misma ruta que los cambios en settings.
  await changeTheme(currentSettings.theme)

  // Inicializar sistema de pestañas (tabs) y re-ejecutar al activar
  initTabs(editor, monaco, () => {
    // Re-ejecutar el código de la pestaña activa para refrescar la salida
    runCode()
  })

  // initTabs asigna el modelo de la pestaña activa al editor, dejando el modelo
  // inicial huérfano. Lo liberamos para no retener un modelo (+ su trabajo de LSP)
  // que ya no está en uso.
  if (editor.getModel?.() !== initialModel) {
    initialModel.dispose()
  }

  // Inicializar el modal de historial de versiones
  initHistoryModal()
}

// Sincronizar el color de fondo del editor con la consola y header
function syncEditorBackground() {
  if (!editor) return

  try {
    // Obtener el elemento DOM del editor
    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) return

    // Obtener el color de fondo computado
    const computedStyle = window.getComputedStyle(editorDomNode)
    const backgroundColor = computedStyle.backgroundColor

    // Establecer el color como variable CSS en el root
    // Esto actualiza automáticamente el header, la consola y las tablas
    document.documentElement.style.setProperty('--editor-background', backgroundColor)
  } catch (error) {
    console.error('Error al sincronizar el fondo del editor:', error)
  }
}

// Sincronizar colores del tema para syntax highlighting en logs
function syncThemeColors() {
  if (!editor) return

  try {
    // Obtener el elemento DOM del editor
    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) return

    // Buscar elementos con los tokens de Monaco para extraer sus colores
    const getEditorTokenColor = (selector: string): string | null => {
      // Crear un elemento temporal con el token de Monaco
      const tempElement = document.createElement('span')
      tempElement.className = selector
      tempElement.style.position = 'absolute'
      tempElement.style.visibility = 'hidden'
      editorDomNode.appendChild(tempElement)

      const color = window.getComputedStyle(tempElement).color
      editorDomNode.removeChild(tempElement)

      return color || null
    }

    const scoreScopeMatch = (scope: string, candidate: string) => {
      const selectors = scope
        .split(',')
        .flatMap((part) => part.trim().split(/\s+/))
        .filter(Boolean)

      let bestScore = -1

      for (const selector of selectors) {
        if (selector === candidate) {
          bestScore = Math.max(bestScore, 4)
          continue
        }

        if (selector.startsWith(`${candidate}.`)) {
          bestScore = Math.max(bestScore, 3)
          continue
        }

        if (candidate.startsWith(`${selector}.`)) {
          bestScore = Math.max(bestScore, 2)
        }
      }

      return bestScore
    }

    const getThemeTokenColor = (candidates: string[], fallback: string): string => {
      const tokenColors = currentThemeData?.tokenColors || []
      let bestMatch: { color: string; score: number } | null = null

      for (const candidate of candidates) {
        for (const rule of tokenColors) {
          const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope ? [rule.scope] : []
          const score = scopes.reduce((best, scope) => Math.max(best, scoreScopeMatch(scope, candidate)), -1)

          if (score >= 0) {
            const foreground = rule.settings?.foreground
            if (foreground && (!bestMatch || score > bestMatch.score)) {
              bestMatch = { color: foreground, score }
            }
          }
        }
      }

      return bestMatch?.color || fallback
    }

    const themeColors = currentThemeData?.colors || {}
    const editorForeground = themeColors['editor.foreground'] || window.getComputedStyle(editorDomNode).color
    const consoleSecondaryColor =
      themeColors['descriptionForeground'] ||
      themeColors['editorLineNumber.foreground'] ||
      themeColors.foreground ||
      editorForeground
    const lineNumberColor =
      themeColors['editorLineNumber.foreground'] || consoleSecondaryColor || getEditorTokenColor('mtk1')

    // Mapear tokens de Monaco a variables CSS
    const stringColor = getThemeTokenColor(['string'], getEditorTokenColor('mtk12') || '#ce9178')
    const numberColor = getThemeTokenColor(['constant.numeric', 'constant'], getEditorTokenColor('mtk9') || '#b5cea8')
    const keywordColor = getThemeTokenColor(['keyword', 'storage'], getEditorTokenColor('mtk9') || '#569cd6')
    const commentColor = getThemeTokenColor(['comment'], getEditorTokenColor('mtk3') || '#6a9955')
    const functionColor = getThemeTokenColor(
      ['entity.name.function', 'support.function', 'support'],
      getEditorTokenColor('mtk12') || '#dcdcaa',
    )
    const booleanColor = getThemeTokenColor(
      ['constant.language.boolean', 'constant.language', 'keyword'],
      getEditorTokenColor('mtk9') || '#569cd6',
    )
    const propertyColor = getThemeTokenColor(
      ['meta.property-name', 'support.type.property-name', 'variable.object.property', 'support'],
      functionColor,
    )
    const mtk14Color = getEditorTokenColor('mtk14') || '#4fc3f7' // mtk14 token color for chatbot

    // Establecer variables CSS
    document.documentElement.style.setProperty('--console-text-primary', editorForeground || '#e4e4e4')
    document.documentElement.style.setProperty('--console-text-secondary', consoleSecondaryColor || '#a0a0a0')
    document.documentElement.style.setProperty('--editor-line-number-foreground', lineNumberColor || '#858585')
    document.documentElement.style.setProperty('--theme-string', stringColor)
    document.documentElement.style.setProperty('--theme-number', numberColor)
    document.documentElement.style.setProperty('--theme-keyword', keywordColor)
    document.documentElement.style.setProperty('--theme-comment', commentColor)
    document.documentElement.style.setProperty('--theme-function', functionColor)
    document.documentElement.style.setProperty('--theme-boolean', booleanColor)
    document.documentElement.style.setProperty('--theme-property', propertyColor)
    document.documentElement.style.setProperty('--theme-mtk14', mtk14Color)
  } catch (error) {
    console.error('Error al sincronizar colores del tema:', error)
  }
}

type UiThemeColors = {
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  border: string
  textPrimary: string
  textSecondary: string
  accent: string
  accentHover: string
  success: string
  error: string
  warning: string
}

const UI_THEME_FALLBACKS: Record<'dark' | 'light', UiThemeColors> = {
  dark: {
    bgPrimary: '#1e1e1e',
    bgSecondary: '#252525',
    bgTertiary: '#2d2d2d',
    border: '#3e3e3e',
    textPrimary: '#e4e4e4',
    textSecondary: '#a0a0a0',
    accent: '#4fc3f7',
    accentHover: '#29b6f6',
    success: '#66bb6a',
    error: '#ef5350',
    warning: '#ffa726',
  },
  light: {
    bgPrimary: '#ffffff',
    bgSecondary: '#f8f8f8',
    bgTertiary: '#f1f1f1',
    border: '#d6d6d6',
    textPrimary: '#24292f',
    textSecondary: '#57606a',
    accent: '#0969da',
    accentHover: '#0550ae',
    success: '#1a7f37',
    error: '#cf222e',
    warning: '#9a6700',
  },
}

function getThemeType(themeData: EditorThemeData): 'dark' | 'light' {
  if (themeData.type === 'light' || themeData.base === 'vs') return 'light'
  return 'dark'
}

function getThemeColor(colors: Record<string, string>, candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    const color = colors[candidate]
    if (color) return color
  }

  return fallback
}

function isFullyTransparentHex(color: string): boolean {
  return /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(color) && color.endsWith('00')
}

function getVisibleThemeColor(colors: Record<string, string>, candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    const color = colors[candidate]
    if (color && !isFullyTransparentHex(color)) return color
  }

  return fallback
}

function expandShortHexColor(color: string): string {
  return color
    .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3')
    .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3$4$4')
}

function normalizeMonacoTokenColor(color?: string): string | undefined {
  return color ? expandShortHexColor(color).replace(/^#/, '') : undefined
}

function normalizeMonacoThemeColors(colors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, expandShortHexColor(color)]))
}

function applyThemeUiColors(themeName: Theme, themeData: EditorThemeData) {
  const themeType = getThemeType(themeData)
  const fallback = UI_THEME_FALLBACKS[themeType]
  const colors = themeData.colors ?? {}
  const accent = getVisibleThemeColor(
    colors,
    ['button.background', 'textLink.foreground', 'activityBarBadge.background', 'focusBorder'],
    fallback.accent,
  )

  const root = document.documentElement
  root.dataset.theme = themeName
  root.dataset.themeType = themeType
  root.style.setProperty('color-scheme', themeType)
  root.style.setProperty('--editor-background', getThemeColor(colors, ['editor.background'], fallback.bgPrimary))
  root.style.setProperty('--color-bg-primary', getThemeColor(colors, ['editor.background'], fallback.bgPrimary))
  root.style.setProperty(
    '--color-bg-secondary',
    getThemeColor(
      colors,
      ['sideBar.background', 'panel.background', 'editorWidget.background', 'menu.background'],
      fallback.bgSecondary,
    ),
  )
  root.style.setProperty(
    '--color-bg-tertiary',
    getThemeColor(colors, ['input.background', 'dropdown.background', 'quickInput.background'], fallback.bgTertiary),
  )
  root.style.setProperty(
    '--color-border',
    getThemeColor(
      colors,
      ['input.border', 'dropdown.border', 'sideBar.border', 'panel.border', 'editorWidget.border', 'contrastBorder'],
      fallback.border,
    ),
  )
  root.style.setProperty(
    '--color-text-primary',
    getThemeColor(colors, ['foreground', 'editor.foreground'], fallback.textPrimary),
  )
  root.style.setProperty(
    '--color-text-secondary',
    getThemeColor(
      colors,
      ['descriptionForeground', 'editorLineNumber.foreground', 'disabledForeground'],
      fallback.textSecondary,
    ),
  )
  root.style.setProperty('--color-accent', accent)
  root.style.setProperty(
    '--color-accent-hover',
    getThemeColor(colors, ['button.hoverBackground', 'textLink.activeForeground'], fallback.accentHover),
  )
  root.style.setProperty(
    '--color-success',
    getThemeColor(colors, ['terminal.ansiGreen', 'charts.green'], fallback.success),
  )
  root.style.setProperty(
    '--color-error',
    getThemeColor(colors, ['errorForeground', 'terminal.ansiRed'], fallback.error),
  )
  root.style.setProperty(
    '--color-warning',
    getThemeColor(colors, ['terminal.ansiYellow', 'charts.yellow'], fallback.warning),
  )
  root.style.setProperty(
    '--color-info',
    getThemeColor(colors, ['terminal.ansiBlue', 'charts.blue', 'textLink.foreground'], '#4fc3f7'),
  )

  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', accent)
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

// Mapa de imports estáticos de temas
const themeImports: Record<Theme, () => Promise<any>> = {
  'vitesse-dark': () => import('tm-themes/themes/vitesse-dark.json'),
  'vitesse-light': () => import('tm-themes/themes/vitesse-light.json'),
  'github-dark': () => import('tm-themes/themes/github-dark.json'),
  'github-light': () => import('tm-themes/themes/github-light.json'),
  dracula: () => import('tm-themes/themes/dracula.json'),
  monokai: () => import('tm-themes/themes/monokai.json'),
  nord: () => import('tm-themes/themes/nord.json'),
  'tokyo-night': () => import('tm-themes/themes/tokyo-night.json'),
  'one-dark-pro': () => import('tm-themes/themes/one-dark-pro.json'),
}

function isAvailableTheme(themeName: string): themeName is Theme {
  return themeName in themeImports
}

async function loadThemeData(themeName: Theme): Promise<EditorThemeData & { name: string }> {
  const themeLoader = themeImports[themeName]
  const themeModule = await themeLoader()
  return (themeModule.default || themeModule) as EditorThemeData & { name: string }
}

function buildMonacoTheme(themeName: Theme, themeData: EditorThemeData) {
  const base =
    themeData.base === 'vs' || themeData.base === 'vs-dark'
      ? themeData.base
      : themeData.type === 'light'
        ? 'vs'
        : 'vs-dark'

  const rules = (themeData.tokenColors ?? []).flatMap((rule: ThemeTokenRule) => {
    const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope ? [rule.scope] : []

    return scopes.map((scope) => ({
      token: scope,
      foreground: normalizeMonacoTokenColor(rule.settings?.foreground),
      fontStyle: rule.settings?.fontStyle ?? '',
    }))
  })

  return {
    name: themeData.name ?? themeName,
    base,
    inherit: true,
    colors: normalizeMonacoThemeColors(themeData.colors ?? {}),
    rules,
    semanticHighlighting: themeData.semanticHighlighting,
  }
}

let themeChangeRequestId = 0

// Cargar y aplicar un tema dinámicamente desde tm-themes
async function changeTheme(themeName: Theme): Promise<boolean> {
  if (!editor || !monaco) {
    console.error('Editor not initialized', { editor: !!editor, monaco: !!monaco })
    return false
  }

  const requestId = ++themeChangeRequestId

  try {
    console.log('Loading theme:', themeName)

    // Cargar el tema desde el mapa de imports
    const themeLoader = themeImports[themeName]
    if (!themeLoader) {
      throw new Error(`Theme "${themeName}" not found in theme imports`)
    }

    const themeData = await loadThemeData(themeName)
    if (requestId !== themeChangeRequestId) return false

    currentThemeData = themeData
    applyThemeUiColors(themeName, themeData)

    const monacoTheme = buildMonacoTheme(themeName, themeData)

    // Definir el tema en Monaco
    if (monaco.editor && monaco.editor.defineTheme) {
      monaco.editor.defineTheme(themeName, monacoTheme)
    } else {
      console.error('monaco.editor.defineTheme not available')
      return false
    }

    // Aplicar el tema
    if (monaco.editor && monaco.editor.setTheme) {
      monaco.editor.setTheme(themeName)
      editor.updateOptions({ theme: themeName })
    } else {
      console.error('monaco.editor.setTheme not available')
      return false
    }

    // Forzar actualización
    editor.layout()

    // Sincronizar background
    await waitForNextPaint()
    if (requestId !== themeChangeRequestId) return false

    syncEditorBackground()

    // Sincronizar colores del tema para syntax highlighting
    syncThemeColors()

    console.log('Theme applied successfully:', themeName)
    return true
  } catch (error) {
    console.error('Error loading/applying theme:', error, themeName)
    return false
  }
}

// Mientras aplicamos un formateo programático (executeEdits), el cambio de
// contenido resultante no debe disparar otra ejecución automática: la propia
// ejecución que pidió el formateo ya continúa después.
let isFormatting = false

// Configurar eventos del editor
function setupEditorEvents() {
  // Escuchar cambios en el contenido del editor para ejecución automática
  if (editor) {
    editor.onDidChangeModelContent(() => {
      // Los tiempos medidos dejan de ser válidos al cambiar el código (se desplazan
      // las líneas), así que los descartamos hasta la próxima ejecución.
      clearLineTimings()

      if (isFormatting) return
      if (!autoRunEnabled) return

      // Limpiar el timer anterior
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
      }

      // Crear nuevo timer para ejecutar después del delay
      debounceTimer = window.setTimeout(() => {
        runCode()
      }, currentSettings.debounceDelay)
    })

    // Mantener la columna de tiempos alineada con el editor. El scroll solo
    // traslada el contenedor (ruta ligera); el cambio de layout (redimensionar,
    // plegar código, etc.) sí re-mide y reconstruye.
    editor.onDidScrollChange(() => scheduleTimingScroll())
    editor.onDidLayoutChange(() => scheduleTimingRender())
  }
}

// Formatear código del editor con Prettier
async function formatEditorCode() {
  if (!editor) return

  try {
    const model = editor.getModel?.()
    const code = editor.getValue()
    const formatted = await formatCode(code, currentSettings.prettier).catch(() => code)

    if (formatted === code || !model) return

    // Guardar posición del cursor
    const position = editor.getPosition()

    // Reemplazar el contenido con executeEdits (en vez de setValue): conserva la
    // pila de undo y genera un único cambio, sin recrear el modelo. El flag evita
    // que este cambio programe una ejecución automática duplicada.
    isFormatting = true
    try {
      editor.executeEdits('format', [
        { range: model.getFullModelRange(), text: formatted, forceMoveMarkers: true },
      ])
      editor.pushUndoStop?.()
    } finally {
      isFormatting = false
    }

    // Restaurar posición del cursor (aproximada)
    if (position) {
      editor.setPosition(position)
    }
  } catch (error) {
    console.error('Error formatting code:', error)
  }
}

// Inicializar o reiniciar el worker
function initExecutorWorker() {
  // Limpiar timeout anterior si existe
  if (executionTimeoutId !== null) {
    clearTimeout(executionTimeoutId)
    executionTimeoutId = null
  }

  // Terminar worker anterior si existe
  if (executorWorker) {
    executorWorker.terminate()
  }

  // Crear nuevo worker
  executorWorker = new ExecutorWorker()
}

function teardownApp() {
  if (teardownStarted) return
  teardownStarted = true

  if (executionTimeoutId !== null) {
    clearTimeout(executionTimeoutId)
    executionTimeoutId = null
  }

  // Persistir cualquier cambio de pestaña pendiente (guardado con debounce).
  flushTabsState()

  unmountChatResponseRoots()
  executorWorker?.terminate()
  executorWorker = null
  destroyPrettierWorker()
  destroyCodePrepWorker()
  void chatbot.destroy()

  editor?.dispose?.()
  editor = null
}

// Espera a que la salida (#output) se estabilice tras lanzar una ejecución.
// El worker envía los logs de forma asíncrona, así que consideramos "terminado"
// cuando el HTML de la salida no cambia durante varios sondeos seguidos.
function waitForOutputStable(outputElement: HTMLElement, maxWaitMs = EXECUTION_TIMEOUT + 1500): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    let previous = outputElement.innerHTML
    let stableCount = 0

    const tick = () => {
      const current = outputElement.innerHTML
      if (current === previous) {
        stableCount += 1
      } else {
        stableCount = 0
        previous = current
      }

      if (stableCount >= 3 || performance.now() - start > maxWaitMs) {
        resolve()
        return
      }

      setTimeout(tick, 120)
    }

    setTimeout(tick, 120)
  })
}

// Lee la salida de la consola del DOM en el formato "contenido (Lx)", igual que
// hace el chat, y detecta si hubo errores.
function scrapeConsoleOutput(outputElement: HTMLElement): AgentRunResult {
  const lines: string[] = []
  outputElement.querySelectorAll('.log-entry').forEach((entry) => {
    const contentEl = entry.querySelector('.log-content')
    const lineNumberEl = entry.querySelector('.log-line-number')
    const type = entry.classList.contains('error') ? 'error' : entry.classList.contains('warn') ? 'warn' : 'log'
    const content = contentEl?.textContent?.trim() ?? entry.textContent?.trim() ?? ''
    if (!content) return
    const sourceLine = (lineNumberEl as HTMLElement | null)?.dataset.lineNumber
    const lineNumber = sourceLine ? `L${sourceLine}` : ''
    const prefix = type === 'error' ? 'ERROR: ' : type === 'warn' ? 'WARN: ' : ''
    lines.push(lineNumber ? `${prefix}${content} (${lineNumber})` : `${prefix}${content}`)
  })

  // Solo es un fallo de ejecución un error SIN número de línea (excepción no capturada
  // o timeout). Las llamadas a console.error/console.warn del usuario llevan número de
  // línea y son salida normal del programa, no un error que el agente deba "arreglar".
  const hasError = [...outputElement.querySelectorAll('.log-entry.error')].some(
    (entry) => !entry.querySelector('.log-line-number'),
  )
  return { output: lines.join('\n'), hasError }
}

// Ejecuta el código actual y devuelve la salida de consola. La usa el agente.
async function runCodeAndCollect(): Promise<AgentRunResult> {
  const outputElement = $('#output') as HTMLElement | null
  if (!outputElement) return { output: '', hasError: false }

  await runCode()
  await waitForOutputStable(outputElement)
  return scrapeConsoleOutput(outputElement)
}

// ─── Historial de versiones ────────────────────────────────────────────────

// Intervalo mínimo entre snapshots automáticos de una misma pestaña. Evita
// generar decenas de versiones mientras se escribe con el auto-run activo.
const MIN_SNAPSHOT_INTERVAL = 15_000
let lastSnapshotAt = 0
let lastSnapshotTabId: string | null = null

/**
 * Guarda una versión del código actual. Los snapshots automáticos (`run`,
 * `auto`) se limitan por tiempo; los manuales (`manual`) se guardan siempre.
 */
function maybeSnapshot(code: string, source: HistorySource) {
  const tabId = getActiveTabId()
  if (!tabId) return

  const now = Date.now()
  const isManual = source === 'manual'
  const throttled = lastSnapshotTabId === tabId && now - lastSnapshotAt < MIN_SNAPSHOT_INTERVAL
  if (!isManual && throttled) return

  const entry = recordVersion(tabId, code, { source })
  if (!entry) return

  lastSnapshotAt = now
  lastSnapshotTabId = tabId
  refreshHistoryIfOpen()
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const sec = Math.round(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

const HISTORY_SOURCE_LABEL: Record<HistorySource, string> = {
  run: 'run',
  manual: 'saved',
  auto: 'auto',
}

function restoreVersion(entry: HistoryEntry) {
  if (!editor) return
  const tabId = getActiveTabId()
  // Antes de sobrescribir, guardamos el estado actual como versión para que la
  // restauración sea reversible.
  if (tabId) recordVersion(tabId, editor.getValue(), { source: 'manual' })

  editor.setValue(entry.content)
  editor.focus()
  refreshHistoryList()
  if (autoRunEnabled) runCode()
}

function refreshHistoryIfOpen() {
  const modal = document.getElementById('history-modal')
  if (modal && modal.style.display === 'flex') refreshHistoryList()
}

// Idioma actual del editor, para colorear el diff con Monaco.
function getEditorDiffLanguage(): 'javascript' | 'typescript' {
  return editor?.getModel?.()?.getLanguageId?.() === 'javascript' ? 'javascript' : 'typescript'
}

// Nº máximo de líneas que se muestran en el preview del diff (igual que la
// tarjeta del agente) para no bloquear con archivos enormes.
const HISTORY_DIFF_PREVIEW_LINES = 80

// Por encima de este tamaño no calculamos el diff de forma anticipada para las
// stats de la cabecera (evita bloquear al abrir el modal con archivos enormes);
// el diff completo se calcula solo al expandir esa tarjeta.
const HISTORY_DIFF_EAGER_CHARS = 60_000

/**
 * Pinta las líneas de un diff dentro de `container` reutilizando las clases del
 * diff del agente. En modo `showAll` (versión inicial) muestra todas las líneas;
 * en caso contrario muestra solo las líneas cambiadas con una línea de contexto.
 */
function renderHistoryDiffLines(container: HTMLElement, lines: DiffLine[], showAll: boolean): void {
  let indexes: number[]
  let hiddenCount: number

  if (showAll) {
    indexes = lines.map((_, index) => index).slice(0, HISTORY_DIFF_PREVIEW_LINES)
    hiddenCount = Math.max(0, lines.length - indexes.length)
  } else {
    const changedIndexes = lines.flatMap((line, index) => (line.type === 'ctx' ? [] : [index]))
    const previewIndexes = new Set<number>()
    for (const index of changedIndexes) {
      for (let context = Math.max(0, index - 1); context <= Math.min(lines.length - 1, index + 1); context++) {
        previewIndexes.add(context)
      }
    }
    const sorted = [...previewIndexes].sort((a, b) => a - b)
    indexes = sorted.slice(0, HISTORY_DIFF_PREVIEW_LINES)
    hiddenCount = previewIndexes.size - indexes.length
  }

  // Empezamos en -1 para que la primera fila renderizada nunca muestre un
  // separador de hueco (solo aparece cuando de verdad se saltan líneas).
  let previousIndex = -1
  container.innerHTML =
    indexes
      .map((index) => {
        const line = lines[index]
        const cls = line.type === 'ctx' ? 'ctx' : line.type
        const num = line.type === 'del' ? line.oldLine : line.newLine
        const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''
        const separator = index > previousIndex + 1 ? '<div class="diff-separator" aria-hidden="true">···</div>' : ''
        previousIndex = index
        return `${separator}<div class="diff-row ${cls}"><span class="diff-num">${num ?? ''}</span><span class="diff-sign">${sign}</span><span class="diff-code" data-diff-index="${index}">${escapeHtml(line.text) || ' '}</span></div>`
      })
      .join('') + (hiddenCount > 0 ? `<div class="diff-more">… ${hiddenCount} more lines</div>` : '')
}

// Colorea (lazy, con Monaco) las líneas ya pintadas del diff del historial.
async function colorizeHistoryDiff(container: HTMLElement, lines: DiffLine[], language: string): Promise<void> {
  const codeElements = container.querySelectorAll<HTMLElement>('.diff-code[data-diff-index]')
  await Promise.all(
    [...codeElements].map(async (codeElement) => {
      const index = Number(codeElement.dataset.diffIndex)
      const line = lines[index]
      if (!line || !monaco?.editor?.colorize) return
      const highlighted = await monaco.editor.colorize(line.text || ' ', language, {})
      if (codeElement.isConnected) codeElement.innerHTML = highlighted
    }),
  )
}

function renderHistoryCard(view: HistoryView, tabId: string, isCurrent: boolean): HTMLElement {
  const { entry, previousContent, diffKind } = view
  const language = getEditorDiffLanguage()

  const item = document.createElement('div')
  item.className = 'history-item collapsed'
  item.setAttribute('role', 'listitem')
  if (isCurrent) item.classList.add('is-current')
  if (diffKind === 'unchanged') item.classList.add('is-unchanged')

  // Diff calculado de forma anticipada para las stats (+N −M), salvo que el
  // contenido sea muy grande: en ese caso se difiere al expandir.
  const isDelta = diffKind === 'delta' && previousContent !== null
  const tooBigForEager =
    isDelta && (previousContent!.length + entry.content.length) > HISTORY_DIFF_EAGER_CHARS
  const eagerDiff = isDelta && !tooBigForEager ? computeLineDiff(previousContent!, entry.content) : null

  const expandable = diffKind !== 'unchanged'

  // ── Cabecera clicable ──────────────────────────────────────────────────
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'history-item-head'
  head.setAttribute('aria-expanded', 'false')
  head.title = new Date(entry.createdAt).toLocaleString()

  const badge = `<span class="history-badge history-badge-${entry.source}">${HISTORY_SOURCE_LABEL[entry.source]}</span>`
  const time = `<span class="history-time">${escapeHtml(formatRelativeTime(entry.createdAt))}</span>`
  const label = entry.label ? `<span class="history-label">${escapeHtml(entry.label)}</span>` : ''

  let stats: string
  if (diffKind === 'initial') {
    stats = '<span class="history-stat-initial">Initial version</span>'
  } else if (diffKind === 'unchanged') {
    stats = '<span class="history-stat-muted">No changes</span>'
  } else if (eagerDiff) {
    stats = [
      eagerDiff.added > 0 ? `<span class="diff-add">+${eagerDiff.added}</span>` : '',
      eagerDiff.removed > 0 ? `<span class="diff-del">−${eagerDiff.removed}</span>` : '',
    ].join('') || '<span class="history-stat-muted">No changes</span>'
  } else {
    stats = '<span class="history-stat-muted">Modified</span>'
  }

  const currentTag = isCurrent ? '<span class="history-current-tag">current</span>' : ''
  const chevron = expandable
    ? '<svg class="history-item-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6 9l6 6l6 -6"/></svg>'
    : ''

  head.innerHTML = `${badge}${time}${label}<span class="history-item-stats">${stats}${currentTag}</span>${chevron}`

  // ── Cuerpo con el diff (lazy) ──────────────────────────────────────────
  let diffEl: HTMLElement | null = null
  let diffBuilt = false

  if (expandable) {
    diffEl = document.createElement('div')
    diffEl.className = 'history-item-diff'

    const directionLabel = document.createElement('div')
    directionLabel.className = 'history-diff-direction'
    directionLabel.textContent = diffKind === 'initial' ? 'Initial version' : 'Changes from previous version'

    const diffBody = document.createElement('div')
    diffBody.className = 'history-diff-body agent-card-diff'

    diffEl.appendChild(directionLabel)
    diffEl.appendChild(diffBody)

    const buildDiff = () => {
      if (diffBuilt) return
      diffBuilt = true
      if (diffKind === 'initial') {
        const lines: DiffLine[] = entry.content.split('\n').map((text, index) => ({
          type: 'ctx',
          text,
          oldLine: index + 1,
          newLine: index + 1,
        }))
        renderHistoryDiffLines(diffBody, lines, true)
        void colorizeHistoryDiff(diffBody, lines, language)
      } else {
        const diff = eagerDiff ?? computeLineDiff(previousContent ?? '', entry.content)
        renderHistoryDiffLines(diffBody, diff.lines, false)
        void colorizeHistoryDiff(diffBody, diff.lines, language)
      }
    }

    head.addEventListener('click', () => {
      const collapsed = item.classList.toggle('collapsed')
      head.setAttribute('aria-expanded', String(!collapsed))
      if (!collapsed) buildDiff()
    })
  }

  // ── Acciones explícitas (Restore / Delete) ─────────────────────────────
  const actions = document.createElement('div')
  actions.className = 'history-item-actions'

  const restoreBtn = document.createElement('button')
  restoreBtn.type = 'button'
  restoreBtn.className = 'history-item-btn'
  restoreBtn.textContent = 'Restore'
  restoreBtn.disabled = isCurrent
  restoreBtn.addEventListener('click', () => restoreVersion(entry))

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'history-item-btn history-item-btn-danger'
  deleteBtn.textContent = 'Delete'
  deleteBtn.addEventListener('click', () => {
    deleteEntry(tabId, entry.id)
    refreshHistoryList()
  })

  actions.appendChild(restoreBtn)
  actions.appendChild(deleteBtn)

  item.appendChild(head)
  if (diffEl) item.appendChild(diffEl)
  item.appendChild(actions)
  return item
}

function refreshHistoryList() {
  const listEl = document.getElementById('history-list')
  const emptyEl = document.getElementById('history-empty')
  const subtitleEl = document.getElementById('history-subtitle')
  if (!listEl) return

  const tabId = getActiveTabId()
  const entries = tabId ? getHistory(tabId) : []

  if (subtitleEl) {
    const title = getActiveTabTitle()
    subtitleEl.textContent = entries.length
      ? `${entries.length} version${entries.length === 1 ? '' : 's'} · ${title}`
      : title
  }

  listEl.innerHTML = ''
  if (emptyEl) emptyEl.hidden = entries.length > 0

  if (!tabId || entries.length === 0) return

  const currentCode = editor?.getValue() ?? ''
  const views = buildHistoryViews(entries)

  const fragment = document.createDocumentFragment()
  for (const view of views) {
    const isCurrent = view.entry.content === currentCode
    fragment.appendChild(renderHistoryCard(view, tabId, isCurrent))
  }
  listEl.appendChild(fragment)
}

function initHistoryModal() {
  const historyButton = document.getElementById('history-button')
  const historyModal = document.getElementById('history-modal')
  const closeHistory = document.getElementById('close-history')
  const saveButton = document.getElementById('history-save')
  const overlay = historyModal?.querySelector('.modal-overlay')
  if (!historyButton || !historyModal) return

  let trigger: HTMLElement | null = null

  const open = () => {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : historyButton
    refreshHistoryList()
    historyModal.style.display = 'flex'
    historyModal.classList.add('is-open')
    historyModal.setAttribute('aria-hidden', 'false')
    closeHistory?.focus()
  }

  const close = () => {
    historyModal.classList.remove('is-open')
    historyModal.style.display = 'none'
    historyModal.setAttribute('aria-hidden', 'true')
    trigger?.focus()
  }

  historyButton.addEventListener('click', open)
  closeHistory?.addEventListener('click', close)
  overlay?.addEventListener('click', close)

  saveButton?.addEventListener('click', () => {
    if (!editor) return
    const tabId = getActiveTabId()
    if (!tabId) return
    const entry = recordVersion(tabId, editor.getValue(), { source: 'manual' })
    if (entry) {
      lastSnapshotAt = Date.now()
      lastSnapshotTabId = tabId
    }
    refreshHistoryList()
  })

  const getFocusableModalElements = () =>
    Array.from(
      historyModal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]') && element.offsetParent !== null)

  document.addEventListener('keydown', (e) => {
    if (historyModal.style.display !== 'flex') return

    if (e.key === 'Escape') {
      close()
      return
    }

    if (e.key === 'Tab') {
      const focusableElements = getFocusableModalElements()
      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      if (!firstElement || !lastElement) {
        e.preventDefault()
        return
      }

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement.focus()
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement.focus()
      }
    }
  })
}

const LOG_TYPE_ICON_PATHS: Record<string, string> = {
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5h.01"/>',
  warn: '<path d="M8 2.5 14 13H2L8 2.5Z"/><path d="M8 6v3M8 11.5h.01"/>',
  error: '<circle cx="8" cy="8" r="6"/><path d="m6 6 4 4m0-4-4 4"/>',
  time: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  count: '<path d="M6 2.5 4.5 13.5m7-11L10 13.5M2.5 6h11M2 10h11"/>',
  notice: '<path d="M3 2.5h10v11H3z"/><path d="m5.5 6 1.5 1.5L5.5 9M8.5 9h2"/>',
  timeout: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8M8 11.5h.01"/>',
}

function createLogTypeIcon(type: string, label = type): HTMLSpanElement | null {
  const paths = LOG_TYPE_ICON_PATHS[type]
  if (!paths) return null

  const icon = document.createElement('span')
  icon.className = 'log-type-icon'
  icon.dataset.type = type
  icon.setAttribute('role', 'img')
  icon.setAttribute('aria-label', label)
  icon.title = label
  icon.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${paths}</svg>`
  return icon
}

// Muestra un aviso claro cuando el código en modo JavaScript importa módulos
// nativos de Node.js (que no existen en el sandbox del navegador). En desktop,
// ofrece un botón para cambiar al runtime de Node.js con un solo clic.
async function showNodeBuiltinNotice(outputElement: Element, specifiers: string[]) {
  const canUseNode = isTauri() && (await isNativeRuntimeAvailable())

  const entry = document.createElement('div')
  entry.className = 'log-entry notice'

  const typeIcon = createLogTypeIcon('notice', 'Node.js')
  if (typeIcon) entry.appendChild(typeIcon)

  const content = document.createElement('span')
  content.className = 'log-content'

  const modules = specifiers.map((s) => `“${s}”`).join(', ')
  const isPlural = specifiers.length > 1
  content.append(
    document.createTextNode(
      `${modules} ${isPlural ? "are Node.js built-in modules and aren't" : "is a Node.js built-in module and isn't"} available in the browser's JavaScript runtime. `,
    ),
  )
  content.append(
    document.createTextNode(
      canUseNode
        ? 'Switch to the Node.js runtime to run this code.'
        : 'Open GoJS as a desktop app and use the Node.js runtime to run this code.',
    ),
  )

  entry.appendChild(content)

  if (canUseNode) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'log-notice-action'
    button.textContent = 'Switch to Node.js'
    button.addEventListener('click', () => {
      setRuntime('node', { explicit: true })
    })
    entry.appendChild(button)
  }

  outputElement.appendChild(entry)
}

// Ejecutar código
async function runCode() {
  if (!editor) return

  // Marca esta ejecución. Si otra arranca durante un await, la actual se descarta.
  const runId = ++browserRunSeq

  // Si auto-format está activado, formatear antes de ejecutar
  if (currentSettings.prettier.autoFormat) {
    await formatEditorCode()
    if (runId !== browserRunSeq) return
  }

  const code = editor.getValue()
  const executionSignature = `${currentSettings.autoLogExpressions ? 'expressions:on' : 'expressions:off'}\n${code}`

  // Verificar si el código es el mismo que se ejecutó anteriormente
  if (executionSignature === lastExecutionSignature) {
    return
  }

  // El código ha cambiado respecto a la última ejecución: buen momento para
  // guardar una versión en el historial (con throttle para no saturar durante
  // el auto-run mientras se escribe).
  maybeSnapshot(code, 'run')

  const outputElement = $('#output')!

  // Interacciones (hover/click) delegadas una sola vez en #output, en vez de
  // añadir tres listeners por cada línea de log.
  setupOutputInteractions(outputElement)

  // Limpiar salida anterior
  outputElement.innerHTML = ''

  // Los logs de una ejecución pueden llegar en ráfagas (bucles). En vez de insertar
  // un nodo por mensaje (un reflow cada vez), los acumulamos y los volcamos juntos
  // con un DocumentFragment una vez por frame.
  const pendingLogNodes: HTMLElement[] = []
  let logFlushScheduled = false

  const flushLogs = () => {
    logFlushScheduled = false
    // Ejecución superada: descartar nodos pendientes sin tocar el DOM.
    if (runId !== browserRunSeq) {
      pendingLogNodes.length = 0
      return
    }
    if (pendingLogNodes.length === 0) return
    const fragment = document.createDocumentFragment()
    for (const node of pendingLogNodes) fragment.appendChild(node)
    pendingLogNodes.length = 0
    outputElement.appendChild(fragment)
  }

  const scheduleLogFlush = () => {
    if (logFlushScheduled) return
    logFlushScheduled = true
    requestAnimationFrame(flushLogs)
  }

  const addLog = (
    type: 'log' | 'info' | 'warn' | 'error' | 'time' | 'table' | 'count' | 'expression' | 'timeout',
    lineNumber: number | null,
    data?: any,
    columns?: string[],
  ) => {
    const entry = document.createElement('div')
    entry.className = `log-entry ${type}`

    const gutter = document.createElement('span')
    gutter.className = 'log-gutter'

    // LOG y TABLE no necesitan icono; el resto se identifica en el gutter.
    if (type !== 'expression' && type !== 'log' && type !== 'table') {
      const typeIcon = createLogTypeIcon(type)
      if (typeIcon) gutter.appendChild(typeIcon)
    }

    // Si es una tabla, renderizar de forma especial
    if (type === 'table' && data !== undefined) {
      const tableElement = createTableElement(data, columns)
      entry.appendChild(tableElement)
    } else {
      const contentSpan = document.createElement('div')
      contentSpan.className = 'log-content'

      // Formatear el contenido con syntax highlighting
      if (isSerializedConsoleArguments(data)) {
        contentSpan.classList.add('log-content--arguments')
        data.__values.forEach((argument) => {
          const row = document.createElement('div')
          row.className = 'log-argument'
          appendFormattedValue(row, argument)
          contentSpan.appendChild(row)
        })
      } else {
        appendFormattedValue(contentSpan, data)
      }

      entry.appendChild(contentSpan)
    }

    // Agregar número de línea si está disponible
    if (lineNumber !== null) {
      const lineSpan = document.createElement('span')
      lineSpan.className = 'log-line-number'
      lineSpan.textContent = String(lineNumber)
      lineSpan.dataset.lineNumber = String(lineNumber)
      lineSpan.setAttribute('aria-label', `Line ${lineNumber}`)
      gutter.appendChild(lineSpan)

      // El número de línea se guarda en la entrada para que la delegación en
      // #output resuelva hover/click sin listeners por nodo.
      entry.dataset.lineNumber = String(lineNumber)

      // Cambiar cursor a pointer para indicar que es clickeable
      entry.style.cursor = 'pointer'
    }

    if (gutter.childElementCount > 0) entry.prepend(gutter)

    pendingLogNodes.push(entry)
    scheduleLogFlush()
  }

  // Native Node.js runtime path (desktop only). Instead of the sandboxed
  // browser worker, run the editor's code against a real Node 26 process so it
  // can use installed npm dependencies, the full stdlib and native modules.
  if (currentSettings.runtime === 'node') {
    if (await isNativeRuntimeAvailable()) {
      await runCodeNative(code, addLog)
      lastExecutionSignature = executionSignature
      return
    }
    // Runtime selected but not usable (e.g. running on the web): tell the user
    // and fall through to the browser worker so code still runs.
    addLog(
      'warn',
      null,
      'Native Node runtime is not available here — falling back to the browser sandbox. Open GoJS as a desktop app to use Node.',
    )
  }

  try {
    // Preparar el código en un worker dedicado: transpila TypeScript, detecta
    // módulos nativos de Node, reescribe imports, instrumenta tiempos e inyecta el
    // logging de expresiones, calculando el lineMap. Así el hilo principal no hace
    // varios `acorn.parse` ni Sucrase por ejecución.
    const prepared = await prepareCode({
      code,
      lineTimings: currentSettings.lineTimings,
      autoLogExpressions: currentSettings.autoLogExpressions,
    })

    // Si otra ejecución arrancó mientras preparábamos, abortamos esta para no
    // pisar la salida ni lanzar un executor obsoleto.
    if (runId !== browserRunSeq) return

    // Los módulos nativos de Node.js (`node:os`, `fs`, …) no existen en el sandbox
    // del navegador. Si intentamos importarlos, WKWebView falla al resolverlos y lo
    // reporta como un error críptico de CORS. Lo interceptamos aquí para mostrar un
    // mensaje claro y ofrecer cambiar al runtime de Node.js.
    if (prepared.nodeBuiltins.length > 0) {
      await showNodeBuiltinNotice(outputElement, prepared.nodeBuiltins)
      lastExecutionSignature = executionSignature
      return
    }

    const modifiedCode = prepared.code
    const lineMapObj = prepared.lineMap

    // Recrear siempre el worker para cada ejecución. Así garantizamos un contexto
    // limpio y, sobre todo, matamos cualquier callback asíncrono (timers, promesas)
    // de una ejecución anterior que, de lo contrario, escribiría logs duplicados
    // en la salida ya limpiada (ver issue #16).
    initExecutorWorker()

    // Configurar manejo de mensajes del worker. El handler descarta mensajes de
    // ejecuciones ya superadas (comparando runId) por robustez ante solapamientos.
    executorWorker!.onmessage = (e: MessageEvent) => {
      if (runId !== browserRunSeq) return
      const message = e.data

      switch (message.type) {
        case 'log':
        case 'info':
        case 'warn':
        case 'time':
        case 'count':
        case 'expression':
          addLog(message.type, message.lineNumber, message.data)
          break

        case 'error':
          // Limpiar timeout cuando hay un error
          if (executionTimeoutId !== null) {
            clearTimeout(executionTimeoutId)
            executionTimeoutId = null
          }

          // Diferenciar entre error de ejecución (con message/stack) y console.error (con data)
          if (message.message) {
            // Error de ejecución del worker
            addLog('error', null, `Error: ${message.message}`)
            if (message.stack) {
              addLog('error', null, message.stack)
            }
          } else {
            // console.error del usuario
            addLog('error', message.lineNumber, message.data)
          }
          break

        case 'table':
          addLog('table', message.lineNumber, message.data, message.columns)
          break

        case 'timings': {
          // Guardar las duraciones y repintar el gutter con el tiempo por línea.
          const durations = message.durations as Record<number, number>
          const map = new Map<number, number>()
          for (const key in durations) {
            map.set(Number(key), durations[key])
          }
          lineTimings = map
          // Reajusta el ancho del margen según haya o no tiempos visibles y repinta.
          refreshLineNumbers()
          break
        }

        case 'complete':
          // Limpiar timeout cuando la ejecución termina exitosamente
          if (executionTimeoutId !== null) {
            clearTimeout(executionTimeoutId)
            executionTimeoutId = null
          }
          break
      }
    }

    // Manejar errores del worker
    executorWorker!.onerror = (error) => {
      // Limpiar timeout
      if (executionTimeoutId !== null) {
        clearTimeout(executionTimeoutId)
        executionTimeoutId = null
      }

      addLog('error', null, `Error del worker: ${error.message}`)
      // Reiniciar el worker
      initExecutorWorker()
    }

    // Configurar timeout desde el hilo principal (esto SÍ puede detener loops síncronos)
    if (EXECUTION_TIMEOUT > 0) {
      executionTimeoutId = window.setTimeout(() => {
        // Una ejecución posterior ya tomó el relevo: no toques su worker/salida.
        if (runId !== browserRunSeq) return

        // Mostrar mensaje de timeout
        addLog(
          'error',
          null,
          `⏱️ Execution stopped: the code exceeded the timeout limit (${EXECUTION_TIMEOUT / 1000}s)`,
        )
        addLog('warn', null, 'Possible infinite loop or code that takes too long to execute')

        // Terminar el worker inmediatamente (esto SÍ detiene loops síncronos)
        if (executorWorker) {
          executorWorker.terminate()
          executorWorker = null
        }

        // Reiniciar el worker para la próxima ejecución
        initExecutorWorker()

        executionTimeoutId = null
      }, EXECUTION_TIMEOUT)
    }

    // Enviar código al worker para su ejecución
    executorWorker!.postMessage({
      type: 'execute',
      code: modifiedCode,
      lineMap: lineMapObj,
      runId,
    })

    // Guardar el código que acabamos de ejecutar
    lastExecutionSignature = executionSignature
  } catch (error: any) {
    addLog('error', null, `Error de sintaxis: ${error.message}`)
    if (error.stack) {
      addLog('error', null, error.stack)
    }
  }
}

// Ejecuta el código del editor contra el runtime nativo de Node.js (solo
// desktop). La salida stdout/stderr se transmite en vivo al panel de salida.
type AddLogFn = (
  type: 'log' | 'info' | 'warn' | 'error' | 'time' | 'table' | 'count' | 'expression' | 'timeout',
  lineNumber: number | null,
  data?: any,
  columns?: string[],
) => void

async function runCodeNative(code: string, addLog: AddLogFn) {
  // Reclamar el turno de ejecución. Cualquier ejecución nativa anterior queda
  // superada: su listener dejará de pintar en cuanto vea que ya no es la última.
  const runId = ++nativeRunSeq

  // Transpilar TS → JS (solo type-stripping) manteniendo los imports intactos,
  // para que `import x from 'pkg'` resuelva desde el node_modules del workspace
  // (sin reescritura a CDN, que es lo contrario de lo que queremos en Node).
  let jsCode = code
  try {
    jsCode = await transpileToJs(code)
  } catch {
    // Si el type-stripping falla, dejamos que Node procese el fuente original.
    jsCode = code
  }

  // Cancelar cualquier ejecución nativa anterior que siga viva (p. ej. un
  // re-run mientras la previa aún corría) para no acumular procesos.
  await stopNative()

  // Instrumentar `console.*` para que la salida llegue tipada (log/info/warn/
  // error/table/count/time) y enlazada a su línea, igual que en el sandbox.
  const instrumentedCode = instrumentNodeCode(jsCode).replace(
    'return s.length === 1 ? s[0] : s;',
    'return s.length === 1 ? s[0] : { __type: "Arguments", __values: s };',
  )

  // Suscribirse a la salida en vivo ANTES de lanzar el proceso. Las líneas de
  // nuestra instrumentación se pintan tipadas; el resto (stdout crudo de un
  // proceso hijo, errores nativos por stderr) se muestra tal cual.
  const unlisten = await onNativeOutput((chunk) => {
    // Solo la ejecución más reciente pinta: si otra la ha superado, callar.
    if (runId !== nativeRunSeq) return
    // Descartar salida de un proceso nativo anterior que aún se está muriendo
    // (llega con una generación menor). La salida de npm usa 0 y nunca se filtra.
    if (chunk.run !== 0) {
      if (chunk.run < latestNativeRunGen) return
      latestNativeRunGen = chunk.run
    }
    const parsed = parseNativeLogLine(chunk.line)
    if (parsed) {
      addLog(parsed.type, parsed.line, parsed.data, parsed.columns)
    } else {
      addLog(chunk.channel === 'stderr' ? 'error' : 'log', null, chunk.line)
    }
  })

  try {
    const result = await runNative(instrumentedCode, 'js', NATIVE_EXECUTION_TIMEOUT)
    if (result.timed_out) {
      // El backend ya mató el proceso; solo lo comunicamos al usuario.
      addLog(
        'error',
        null,
        `⏱️ Execution stopped: the code exceeded the timeout limit (${NATIVE_EXECUTION_TIMEOUT / 1000}s)`,
      )
      addLog('warn', null, 'Possible infinite loop or code that takes too long to execute')
    } else if (result.exit_code != null && result.exit_code !== 0) {
      addLog('warn', null, `Process exited with code ${result.exit_code} · ${result.duration_ms}ms`)
    }
  } catch (error: any) {
    addLog('error', null, `Native runtime error: ${error?.message || error}`)
  } finally {
    unlisten()
  }
}

// -------------------------------------------------------------------------
// UI del runtime nativo (solo desktop): selector del header, pestaña de
// Settings y gestor de dependencias (npm install/update/uninstall).
// -------------------------------------------------------------------------

// Mantiene sincronizados el botón del header y el <select> de Settings con el
// runtime activo, y actualiza iconos/etiqueta/título.
function applyRuntimeUI(runtime: Runtime) {
  const toggle = $('#runtime-toggle-button') as HTMLButtonElement | null
  const browserIcon = $('#runtime-browser-icon') as HTMLElement | null
  const nodeIcon = $('#runtime-node-icon') as HTMLElement | null
  const label = $('#runtime-label') as HTMLElement | null
  const select = $('#setting-runtime') as HTMLSelectElement | null
  const isNode = runtime === 'node'

  if (browserIcon) browserIcon.style.display = isNode ? 'none' : ''
  if (nodeIcon) nodeIcon.style.display = isNode ? '' : 'none'
  if (label) label.textContent = isNode ? 'Node' : 'JS'
  if (toggle) {
    toggle.title = isNode ? 'Runtime: Node.js (native) — click to switch' : 'Runtime: Browser sandbox — click to switch'
    toggle.classList.toggle('is-node', isNode)
    toggle.setAttribute('aria-pressed', String(isNode))
  }
  if (select) select.value = runtime
}

function setRuntime(runtime: Runtime, { rerun = true, explicit = false }: { rerun?: boolean; explicit?: boolean } = {}) {
  currentSettings = updateSetting(currentSettings, 'runtime', runtime)
  // Marcar la elección como explícita solo cuando la origina el usuario, para
  // que el default automático (Node.js en desktop) no la sobrescriba después.
  if (explicit && !currentSettings.runtimeExplicit) {
    currentSettings = updateSetting(currentSettings, 'runtimeExplicit', true)
  }
  applyRuntimeUI(runtime)
  if (rerun) {
    // Forzar una nueva ejecución (el runtime cambió aunque el código no).
    lastExecutionSignature = ''
    runCode()
  }
}

async function setupNativeRuntimeUI() {
  // En la web no hay runtime nativo: aseguramos 'browser' y ocultamos la UI.
  applyRuntimeUI(currentSettings.runtime)

  if (!isTauri()) {
    if (currentSettings.runtime !== 'browser') setRuntime('browser', { rerun: false })
    return
  }

  const toggle = $('#runtime-toggle-button') as HTMLButtonElement | null
  const runtimeTab = $('#settings-tab-runtime') as HTMLElement | null
  const runtimeSelect = $('#setting-runtime') as HTMLSelectElement | null
  const nodeStatus = $('#setting-node-status') as HTMLElement | null

  // Revelar los controles específicos de desktop.
  if (toggle) toggle.hidden = false
  if (runtimeTab) runtimeTab.hidden = false

  const info: NodeInfo | null = await getNodeInfo(true)
  const renderNodeStatus = () => {
    if (!nodeStatus) return
    if (info?.available) {
      const src = info.source === 'bundled' ? 'bundled' : 'system'
      nodeStatus.textContent = `Node ${info.version} (${src})${info.npm_version ? ` · npm ${info.npm_version}` : ''}`
      nodeStatus.classList.remove('error')
    } else {
      nodeStatus.textContent =
        'No Node.js runtime found. Ship the bundled Node with the app, or install Node on your PATH.'
      nodeStatus.classList.add('error')
    }
  }
  renderNodeStatus()

  if (info?.available) {
    // En desktop, Node.js es el runtime por defecto. Solo lo aplicamos si el
    // usuario no ha elegido explícitamente otro runtime. Re-ejecutamos porque
    // la ejecución inicial ya corrió (en el sandbox) antes de resolverse esto.
    if (!currentSettings.runtimeExplicit && currentSettings.runtime !== 'node') {
      setRuntime('node', { rerun: true })
    }
  } else if (currentSettings.runtime === 'node') {
    // Node estaba seleccionado pero no hay runtime disponible: degradar a browser.
    setRuntime('browser', { rerun: false })
  }

  toggle?.addEventListener('click', async () => {
    const next: Runtime = currentSettings.runtime === 'node' ? 'browser' : 'node'
    if (next === 'node' && !(await isNativeRuntimeAvailable())) {
      if (nodeStatus) renderNodeStatus()
      return
    }
    setRuntime(next, { explicit: true })
  })

  runtimeSelect?.addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value as Runtime
    setRuntime(value, { explicit: true })
  })

  setupDependenciesManager()
}

// Gestor de dependencias: lista, instala, actualiza y elimina paquetes npm en
// el workspace nativo mediante el bridge de Tauri.
function setupDependenciesManager() {
  const listEl = $('#deps-list') as HTMLUListElement | null
  const statusEl = $('#deps-status') as HTMLElement | null
  const addName = $('#deps-add-name') as HTMLInputElement | null
  const addVersion = $('#deps-add-version') as HTMLInputElement | null
  const addButton = $('#deps-add-button') as HTMLButtonElement | null
  const refreshButton = $('#deps-refresh-button') as HTMLButtonElement | null
  const revealButton = $('#deps-reveal-button') as HTMLButtonElement | null
  if (!listEl) return

  let busy = false

  const setStatus = (message: string, kind: 'info' | 'error' | 'ok' = 'info') => {
    if (!statusEl) return
    statusEl.textContent = message
    statusEl.classList.toggle('error', kind === 'error')
    statusEl.classList.toggle('ok', kind === 'ok')
  }

  const setBusy = (value: boolean) => {
    busy = value
    ;[addButton, refreshButton, revealButton].forEach((b) => b && (b.disabled = value))
    listEl.classList.toggle('is-busy', value)
  }

  const renderList = (deps: Dependency[]) => {
    listEl.innerHTML = ''
    if (deps.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'deps-empty'
      empty.textContent = 'No dependencies installed yet.'
      listEl.appendChild(empty)
      return
    }

    for (const dep of deps) {
      const item = document.createElement('li')
      item.className = 'deps-item'

      const info = document.createElement('div')
      info.className = 'deps-item-info'
      const name = document.createElement('span')
      name.className = 'deps-name'
      name.textContent = dep.name
      const version = document.createElement('span')
      version.className = 'deps-version'
      version.textContent = dep.installed ? `v${dep.installed}` : dep.wanted ?? 'not installed'
      info.append(name, version)

      const actions = document.createElement('div')
      actions.className = 'deps-item-actions'

      const versionInput = document.createElement('input')
      versionInput.type = 'text'
      versionInput.className = 'deps-input deps-update-version'
      versionInput.placeholder = 'version'
      versionInput.autocomplete = 'off'
      versionInput.spellcheck = false

      const updateBtn = document.createElement('button')
      updateBtn.type = 'button'
      updateBtn.className = 'settings-action-button deps-update-btn'
      updateBtn.textContent = 'Update'
      updateBtn.addEventListener('click', () => {
        void runOp(
          () => updateDependency(dep.name, versionInput.value.trim() || 'latest'),
          `Updating ${dep.name}…`,
          `Updated ${dep.name}`,
        )
      })

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'settings-action-button danger deps-remove-btn'
      removeBtn.textContent = 'Remove'
      removeBtn.addEventListener('click', () => {
        void runOp(() => removeDependency(dep.name), `Removing ${dep.name}…`, `Removed ${dep.name}`)
      })

      actions.append(versionInput, updateBtn, removeBtn)
      item.append(info, actions)
      listEl.appendChild(item)
    }
  }

  const refresh = async () => {
    try {
      const deps = await listDependencies()
      renderList(deps)
    } catch (err: any) {
      setStatus(`Could not read dependencies: ${err?.message || err}`, 'error')
    }
  }

  // Ejecuta una operación npm, refresca la lista y reporta el resultado.
  const runOp = async (op: () => Promise<{ exit_code: number | null; stderr: string }>, pending: string, done: string) => {
    if (busy) return
    setBusy(true)
    setStatus(pending)
    try {
      const result = await op()
      if (result.exit_code === 0 || result.exit_code == null) {
        setStatus(done, 'ok')
      } else {
        const detail = result.stderr.trim().split('\n').slice(-1)[0] || `exit code ${result.exit_code}`
        setStatus(`npm failed: ${detail}`, 'error')
      }
    } catch (err: any) {
      setStatus(`Error: ${err?.message || err}`, 'error')
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const handleAdd = () => {
    const name = (addName?.value || '').trim()
    if (!name) {
      setStatus('Type a package name to install.', 'error')
      addName?.focus()
      return
    }
    const version = (addVersion?.value || '').trim()
    void runOp(() => addDependency(name, version || undefined), `Installing ${name}…`, `Installed ${name}`).then(() => {
      if (addName) addName.value = ''
      if (addVersion) addVersion.value = ''
    })
  }

  addButton?.addEventListener('click', handleAdd)
  addName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd()
  })
  addVersion?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd()
  })
  refreshButton?.addEventListener('click', () => void refresh())
  revealButton?.addEventListener('click', () => {
    void revealWorkspace().catch((err) => setStatus(`Error: ${err?.message || err}`, 'error'))
  })

  void refresh()
}

type ConsoleCollection = {
  entries: Array<[string, any]>
  open: string
  closed: string
  close: string
}

function getConsoleCollection(value: any): ConsoleCollection | null {
  if (Array.isArray(value)) {
    return {
      entries: value.map((item, index) => [String(index), item]),
      open: `Array(${value.length}) [`,
      closed: `Array(${value.length}) […]`,
      close: ']',
    }
  }

  if (isSerializedConsoleValue(value)) {
    if (value.__type === 'Set') {
      return {
        entries: value.__values.map((item, index) => [String(index), item]),
        open: `Set(${value.__values.length}) {`,
        closed: `Set(${value.__values.length}) {…}`,
        close: '}',
      }
    }

    if (value.__type === 'Map') {
      return {
        entries: value.__entries.map(([key, item]) => [formatConsoleValueText(key), item]),
        open: `Map(${value.__entries.length}) {`,
        closed: `Map(${value.__entries.length}) {…}`,
        close: '}',
      }
    }

    return null
  }

  if (value === null || typeof value !== 'object') return null

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  return {
    entries: Object.entries(value),
    open: '{',
    closed: '{…}',
    close: '}',
  }
}

function formatConsoleObjectKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) || /^\d+$/.test(key) ? key : JSON.stringify(key)
}

function createConsoleObjectTree(value: any, label?: string): HTMLElement {
  const collection = getConsoleCollection(value)
  if (!collection) {
    const fallback = document.createElement('span')
    appendFormattedValue(fallback, value)
    return fallback
  }

  if (collection.entries.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'log-object-empty'
    if (label !== undefined) {
      const key = document.createElement('span')
      key.className = 'log-json-key'
      key.textContent = `${formatConsoleObjectKey(label)}: `
      empty.appendChild(key)
    }
    empty.appendChild(document.createTextNode(collection.open + collection.close))
    return empty
  }

  const details = document.createElement('details')
  details.className = 'log-object-tree'
  details.open = true
  details.addEventListener('click', (event) => event.stopPropagation())

  const summary = document.createElement('summary')
  summary.className = 'log-object-summary'

  const chevron = document.createElement('span')
  chevron.className = 'log-object-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.textContent = '›'
  summary.appendChild(chevron)

  if (label !== undefined) {
    const key = document.createElement('span')
    key.className = 'log-json-key'
    key.textContent = `${formatConsoleObjectKey(label)}: `
    summary.appendChild(key)
  }

  const closed = document.createElement('span')
  closed.className = 'log-object-closed'
  closed.textContent = collection.closed
  summary.appendChild(closed)

  const open = document.createElement('span')
  open.className = 'log-object-open'
  open.textContent = collection.open
  summary.appendChild(open)

  details.appendChild(summary)

  const body = document.createElement('div')
  body.className = 'log-object-body'

  for (const [keyText, item] of collection.entries) {
    const nestedCollection = getConsoleCollection(item)
    if (nestedCollection) {
      body.appendChild(createConsoleObjectTree(item, keyText))
      continue
    }

    const row = document.createElement('div')
    row.className = 'log-object-field'

    const key = document.createElement('span')
    key.className = 'log-json-key'
    key.textContent = `${formatConsoleObjectKey(keyText)}: `
    row.appendChild(key)
    appendFormattedValue(row, item)
    body.appendChild(row)
  }

  const closing = document.createElement('div')
  closing.className = 'log-object-closing'
  closing.textContent = collection.close
  body.appendChild(closing)

  details.appendChild(body)
  return details
}

// Añadir valor formateado al contenedor con syntax highlighting
function appendFormattedValue(container: HTMLElement, value: any) {
  const collection = getConsoleCollection(value)
  if (collection && !Array.isArray(value)) {
    container.appendChild(createConsoleObjectTree(value))
    return
  }

  // Manejar valores serializados especiales del worker (promesas, funciones, etc.)
  if (isSerializedConsoleValue(value)) {
    const span = document.createElement('span')

    switch (value.__type) {
      case 'Promise':
        span.className = 'log-promise'
        break
      case 'Function':
        span.className = 'log-function'
        break
      case 'Set':
      case 'Map':
        span.className = 'log-array'
        break
      case 'Object':
      case 'Unknown':
      case 'Circular':
        span.className = 'log-object'
        break
      default:
        span.className = 'log-object'
    }

    span.textContent = formatConsoleValueText(value)
    container.appendChild(span)
    return
  }

  if (value === null) {
    const span = document.createElement('span')
    span.className = 'log-null'
    span.textContent = 'null'
    container.appendChild(span)
  } else if (value === undefined) {
    const span = document.createElement('span')
    span.className = 'log-undefined'
    span.textContent = 'undefined'
    container.appendChild(span)
  } else if (typeof value === 'string') {
    const span = document.createElement('span')
    span.className = 'log-string'
    span.textContent = `"${value}"`
    container.appendChild(span)
  } else if (typeof value === 'number') {
    const span = document.createElement('span')
    span.className = 'log-number'
    span.textContent = String(value)
    container.appendChild(span)
  } else if (typeof value === 'boolean') {
    const span = document.createElement('span')
    span.className = 'log-boolean'
    span.textContent = String(value)
    container.appendChild(span)
  } else if (typeof value === 'function') {
    const span = document.createElement('span')
    span.className = 'log-function'
    span.textContent = value.toString()
    container.appendChild(span)
  } else if (typeof value === 'object') {
    // Manejar arrays de forma especial para mostrarlos en formato compacto
    if (Array.isArray(value)) {
      const span = document.createElement('span')
      span.className = 'log-array'
      span.textContent = '['

      value.forEach((item, index) => {
        if (index > 0) {
          span.appendChild(document.createTextNode(', '))
        }

        // Crear un span temporal para obtener el valor formateado
        const tempSpan = document.createElement('span')
        appendFormattedValue(tempSpan, item)

        // Si el item es un objeto complejo, usar JSON compacto
        if (typeof item === 'object' && item !== null && !Array.isArray(item) && !isSerializedConsoleValue(item)) {
          tempSpan.textContent = JSON.stringify(item)
        }

        span.appendChild(tempSpan)
      })

      span.appendChild(document.createTextNode(']'))
      container.appendChild(span)
    } else {
      // Objetos normales (no arrays)
      try {
        container.appendChild(createConsoleObjectTree(value))
      } catch {
        const span = document.createElement('span')
        span.className = 'log-object'
        span.textContent = String(value)
        container.appendChild(span)
      }
    }
  } else {
    container.appendChild(document.createTextNode(String(value)))
  }
}

// Crear elemento de tabla HTML para console.table
function createTableElement(data: any, columns?: string[]): HTMLElement {
  const tableContainer = document.createElement('div')
  tableContainer.className = 'console-table-container'

  if (isSerializedConsoleValue(data)) {
    tableContainer.textContent = formatConsoleValueText(data)
    return tableContainer
  }

  // Si no es un objeto o array, mostrar como texto
  if (!data || typeof data !== 'object') {
    tableContainer.textContent = String(data)
    return tableContainer
  }

  const table = document.createElement('table')
  table.className = 'console-table'

  // Convertir data a array de entries si es necesario
  let entries: [string | number, any][]

  if (Array.isArray(data)) {
    entries = data.map((item, index) => [index, item])
  } else {
    entries = Object.entries(data)
  }

  if (entries.length === 0) {
    tableContainer.textContent = '(empty)'
    return tableContainer
  }

  // Determinar las columnas
  let allKeys = new Set<string>()
  entries.forEach(([_, value]) => {
    if (value && typeof value === 'object') {
      Object.keys(value).forEach((key) => allKeys.add(key))
    }
  })

  const keysToShow = columns || Array.from(allKeys)
  const hasSubProperties = keysToShow.length > 0

  // Crear header
  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')

  // Columna de índice
  const indexHeader = document.createElement('th')
  indexHeader.textContent = '(index)'
  headerRow.appendChild(indexHeader)

  // Columnas de propiedades o columna "Value"
  if (hasSubProperties) {
    keysToShow.forEach((key) => {
      const th = document.createElement('th')
      th.textContent = key
      headerRow.appendChild(th)
    })
  } else {
    const valueHeader = document.createElement('th')
    valueHeader.textContent = 'Value'
    headerRow.appendChild(valueHeader)
  }

  thead.appendChild(headerRow)
  table.appendChild(thead)

  // Crear body
  const tbody = document.createElement('tbody')

  entries.forEach(([index, value]) => {
    const row = document.createElement('tr')

    // Celda de índice
    const indexCell = document.createElement('td')
    indexCell.className = 'table-index'
    indexCell.textContent = String(index)
    row.appendChild(indexCell)

    // Celdas de datos
    if (hasSubProperties && value && typeof value === 'object') {
      keysToShow.forEach((key) => {
        const td = document.createElement('td')
        const cellValue = (value as any)[key]
        td.textContent = formatCellValue(cellValue)
        row.appendChild(td)
      })
    } else {
      const td = document.createElement('td')
      td.textContent = formatCellValue(value)
      row.appendChild(td)
    }

    tbody.appendChild(row)
  })

  table.appendChild(tbody)
  tableContainer.appendChild(table)

  return tableContainer
}

// Formatear valor de celda de tabla
function formatCellValue(value: any): string {
  if (isSerializedConsoleValue(value)) return formatConsoleValueText(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// Destacar línea en el editor
function highlightEditorLine(lineNumber: number, reveal = false) {
  if (!editor || !monaco) return

  // Limpiar decoraciones anteriores
  currentDecorations = editor.deltaDecorations(currentDecorations, [
    {
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        isWholeLine: true,
        className: 'line-highlight',
        glyphMarginClassName: 'line-highlight-glyph',
      },
    },
  ])

  // Solo desplazamos el editor cuando se pide explícitamente (p. ej. al hacer clic
  // en un log). Al pasar el ratón por encima no queremos mover el viewport.
  if (reveal) {
    editor.revealLineInCenter(lineNumber, 0) // 0 = smooth scroll
  }
}

// Ir a la línea en el editor y hacer focus
function goToLineInEditor(lineNumber: number) {
  if (!editor || !monaco) return

  // Hacer focus en el editor
  editor.focus()

  // Posicionar el cursor al inicio de la línea
  editor.setPosition({
    lineNumber: lineNumber,
    column: 1,
  })

  // Centrar la línea en el viewport
  editor.revealLineInCenter(lineNumber, 0)

  // Destacar la línea temporalmente
  highlightEditorLine(lineNumber)

  // Quitar el highlight después de 2 segundos
  setTimeout(() => {
    clearEditorHighlight()
  }, 2000)
}

// Limpiar highlight del editor
function clearEditorHighlight() {
  if (!editor) return
  currentDecorations = editor.deltaDecorations(currentDecorations, [])
}

// Delegación de interacciones del panel de salida. Un único juego de listeners en
// #output resuelve hover/click de cualquier log leyendo `data-line-number`, en vez
// de registrar tres listeners por cada entrada (que se recrean en cada ejecución).
let outputInteractionsAttached = false
function setupOutputInteractions(output: HTMLElement) {
  if (outputInteractionsAttached) return
  outputInteractionsAttached = true

  const lineOf = (target: EventTarget | null): number | null => {
    const entry = (target as HTMLElement | null)?.closest?.('.log-entry') as HTMLElement | null
    const raw = entry?.dataset.lineNumber
    return raw ? Number(raw) : null
  }

  output.addEventListener('mouseover', (e) => {
    const line = lineOf(e.target)
    if (line !== null) highlightEditorLine(line)
  })

  output.addEventListener('mouseout', (e) => {
    const entry = (e.target as HTMLElement | null)?.closest?.('.log-entry') as HTMLElement | null
    if (!entry || !entry.dataset.lineNumber) return
    // Ignorar transiciones entre hijos de la misma entrada.
    const related = e.relatedTarget as HTMLElement | null
    if (related && entry.contains(related)) return
    clearEditorHighlight()
  })

  output.addEventListener('click', (e) => {
    const line = lineOf(e.target)
    if (line !== null) goToLineInEditor(line)
  })
}

// Inicializar aplicación
async function start() {
  window.addEventListener('pagehide', teardownApp, { once: true })

  // Prettier se carga bajo demanda en la primera llamada a formatCode()

  await initEditor()
  await refreshChromePromptApiModelAvailability()
  enableChromePromptApiAssistantIfAvailable()

  // Event listener para el botón de cambio de layout
  const layoutToggleButton = $('#layout-toggle-button') as HTMLButtonElement | null
  const layoutHorizontalIcon = $('#layout-horizontal-icon') as HTMLElement | null
  const layoutVerticalIcon = $('#layout-vertical-icon') as HTMLElement | null
  const layoutTooltip = $('#tooltip-layout') as HTMLElement | null
  const resizePanelsElement = document.querySelector('resize-panels') as ResizePanelsElement | null

  if (layoutToggleButton && layoutHorizontalIcon && layoutVerticalIcon && resizePanelsElement) {
    const mobileLayoutMediaQuery = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY)
    const syncLayoutOrientation = () => {
      if (mobileLayoutMediaQuery.matches) {
        resizePanelsElement.setAttribute('orientation', 'vertical')
        return
      }

      if (currentSettings.layoutOrientation) {
        resizePanelsElement.setAttribute('orientation', currentSettings.layoutOrientation)
      } else {
        resizePanelsElement.removeAttribute('orientation')
      }
    }

    const syncLayoutToggleUI = () => {
      const orientation = getPanelOrientation(resizePanelsElement)
      const isHorizontal = orientation === 'horizontal'
      const nextOrientation: PanelOrientation = isHorizontal ? 'vertical' : 'horizontal'
      const label = `Switch to ${nextOrientation} layout`

      layoutHorizontalIcon.style.display = isHorizontal ? 'block' : 'none'
      layoutVerticalIcon.style.display = isHorizontal ? 'none' : 'block'
      layoutToggleButton.title = label
      layoutToggleButton.setAttribute('aria-label', label)
      layoutToggleButton.setAttribute('aria-pressed', String(isHorizontal))

      if (layoutTooltip) {
        layoutTooltip.textContent = label
      }
    }

    syncLayoutOrientation()
    syncLayoutToggleUI()
    window.addEventListener('resize', syncLayoutToggleUI)
    mobileLayoutMediaQuery.addEventListener('change', () => {
      syncLayoutOrientation()
      resizePanelsElement.requestLayoutUpdate?.()
      syncLayoutToggleUI()
    })

    layoutToggleButton.addEventListener('click', () => {
      if (mobileLayoutMediaQuery.matches) {
        syncLayoutOrientation()
        syncLayoutToggleUI()
        return
      }

      const currentOrientation = getPanelOrientation(resizePanelsElement)
      const nextOrientation: PanelOrientation = currentOrientation === 'horizontal' ? 'vertical' : 'horizontal'

      currentSettings = updateSetting(currentSettings, 'layoutOrientation', nextOrientation)
      resizePanelsElement.setAttribute('orientation', nextOrientation)
      resizePanelsElement.requestLayoutUpdate?.()
      syncLayoutToggleUI()
    })
  }

  // Event listener para el botón de auto-run toggle
  const autorunToggleButton = $('#autorun-toggle-button') as HTMLElement
  const pauseIcon = $('#pause-icon') as HTMLElement
  const playIcon = $('#play-icon') as HTMLElement

  if (autorunToggleButton && pauseIcon && playIcon) {
    autorunToggleButton.addEventListener('click', () => {
      autoRunEnabled = !autoRunEnabled

      // Alternar los iconos
      if (autoRunEnabled) {
        pauseIcon.style.display = 'block'
        playIcon.style.display = 'none'
        autorunToggleButton.title = 'Auto-run enabled (click to disable)'
        // Ejecutar el código cuando se activa
        runCode()
      } else {
        pauseIcon.style.display = 'none'
        playIcon.style.display = 'block'
        autorunToggleButton.title = 'Auto-run disabled (click to enable)'
      }
    })
  }

  // Event listener para el botón de IA toggle
  const aiToggleButton = document.getElementById('ai-toggle-button')
  const robotIcon = document.getElementById('robot-icon')
  const robotOffIcon = document.getElementById('robot-off-icon')
  const chatbotPanel = document.getElementById('chatbot-panel')
  let aiEnabled = currentSettings.aiEnabled

  if (aiToggleButton && robotIcon && robotOffIcon && chatbotPanel) {
    const syncAiToggleUI = () => {
      robotIcon.style.display = aiEnabled ? 'block' : 'none'
      robotOffIcon.style.display = aiEnabled ? 'none' : 'block'
      aiToggleButton.title = aiEnabled ? 'AI enabled (click to disable)' : 'AI disabled (click to enable)'
      chatbotPanel.style.display = aiEnabled ? 'flex' : 'none'
      chatbotPanel.classList.toggle('hidden', !aiEnabled)
    }

    syncAiToggleUI()

    aiToggleButton.addEventListener('click', () => {
      aiEnabled = !aiEnabled
      currentSettings = updateSetting(currentSettings, 'aiEnabled', aiEnabled)
      syncAiToggleUI()

      if (aiEnabled) {
        initChatbot()
      }

      // Redistribuir el espacio entre los paneles restantes
      redistributePanelSpace()
    })
  }

  // Event listener para el botón de settings
  const settingsButton = document.getElementById('settings-button')
  const settingsModal = document.getElementById('settings-modal')
  const closeSettings = document.getElementById('close-settings')
  const modalOverlay = settingsModal?.querySelector('.modal-overlay')

  if (settingsButton && settingsModal) {
    let settingsTrigger: HTMLElement | null = null

    const getFocusableModalElements = () =>
      Array.from(
        settingsModal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]') && element.offsetParent !== null)

    const openModal = () => {
      settingsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : settingsButton
      settingsModal.style.display = 'flex'
      settingsModal.classList.add('is-open')
      settingsModal.setAttribute('aria-hidden', 'false')

      const activePanel = settingsModal.querySelector<HTMLElement>('.settings-panel.active')
      const firstPanelControl = activePanel?.querySelector<HTMLElement>('select, input, button:not([disabled])')
      ;(firstPanelControl ?? closeSettings)?.focus()
    }

    const closeModal = () => {
      settingsModal.classList.remove('is-open')
      settingsModal.style.display = 'none'
      settingsModal.setAttribute('aria-hidden', 'true')
      settingsTrigger?.focus()
    }

    settingsButton.addEventListener('click', openModal)
    closeSettings?.addEventListener('click', closeModal)
    modalOverlay?.addEventListener('click', closeModal)

    document.addEventListener('keydown', (e) => {
      if (settingsModal.style.display !== 'flex') return

      if (e.key === 'Escape') {
        closeModal()
        return
      }

      if (e.key === 'Tab') {
        const focusableElements = getFocusableModalElements()
        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]

        if (!firstElement || !lastElement) {
          e.preventDefault()
          return
        }

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    })

    // Settings tabs
    const tabs = Array.from($$('.settings-tab')) as HTMLElement[]
    const panels = Array.from($$('.settings-panel')) as HTMLElement[]

    const activateSettingsTab = (selectedTab: HTMLElement) => {
      const targetPanel = selectedTab.getAttribute('data-tab')

      tabs.forEach((tab) => {
        const isActive = tab === selectedTab
        tab.classList.toggle('active', isActive)
        tab.setAttribute('aria-selected', String(isActive))
        tab.tabIndex = isActive ? 0 : -1
      })

      panels.forEach((panel) => {
        const isActive = panel.getAttribute('data-panel') === targetPanel
        panel.classList.toggle('active', isActive)
        panel.hidden = !isActive
      })
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        activateSettingsTab(tab)
      })

      tab.addEventListener('keydown', (e) => {
        const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
        if (!keys.includes(e.key)) return

        e.preventDefault()

        const currentIndex = tabs.indexOf(tab)
        const nextIndex =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                ? (currentIndex - 1 + tabs.length) % tabs.length
                : (currentIndex + 1) % tabs.length
        const nextTab = tabs[nextIndex]

        activateSettingsTab(nextTab)
        nextTab.focus()
      })
    })

    // Cargar valores actuales en el formulario
    const themeSelect = $('#setting-theme') as HTMLSelectElement
    const fontFamilySelect = $('#setting-font-family') as HTMLSelectElement
    const fontSizeInput = $('#setting-font-size') as HTMLInputElement
    const aiModelSelect = $('#setting-ai-model') as HTMLSelectElement
    const aiModelMeta = $('#setting-ai-model-meta') as HTMLElement
    const aiModelStatus = $('#setting-ai-model-status') as HTMLElement
    const aiModelInstallButton = $('#setting-ai-model-install') as HTMLButtonElement
    const aiModelUninstallButton = $('#setting-ai-model-uninstall') as HTMLButtonElement
    const aiModelClearLocalDataButton = $('#setting-ai-clear-local-data') as HTMLButtonElement
    const aiStorageUsage = $('#setting-ai-storage-usage') as HTMLElement
    const minimapCheck = $('#setting-minimap') as HTMLInputElement
    const lineNumbersCheck = $('#setting-line-numbers') as HTMLInputElement
    const lineTimingsCheck = $('#setting-line-timings') as HTMLInputElement
    const wordWrapCheck = $('#setting-word-wrap') as HTMLInputElement
    const fontLigaturesCheck = $('#setting-font-ligatures') as HTMLInputElement
    const stickyScrollCheck = $('#setting-sticky-scroll') as HTMLInputElement
    const indentGuidesCheck = $('#setting-indent-guides') as HTMLInputElement
    const renderWhitespaceSelect = $('#setting-render-whitespace') as HTMLSelectElement
    const debounceInput = $('#setting-debounce') as HTMLInputElement
    const autoLogExpressionsCheck = $('#setting-auto-log-expressions') as HTMLInputElement
    const formatPasteCheck = $('#setting-format-on-paste') as HTMLInputElement
    const formatTypeCheck = $('#setting-format-on-type') as HTMLInputElement

    let isUpdatingAiModel = false
    let allowUninstallWhileLoading = false
    let isClearingAiStorage = false

    const refreshAiModelMeta = () => {
      if (!aiModelSelect || !aiModelMeta) return

      aiModelMeta.textContent = getChatModelMetaText(aiModelSelect.value)
    }

    const refreshAiStorageUsage = async () => {
      if (!aiStorageUsage) return

      if (!navigator.storage?.estimate) {
        aiStorageUsage.textContent = 'Local storage usage is not available in this browser.'
        return
      }

      try {
        const estimate = (await navigator.storage.estimate()) as StorageEstimateWithDetails
        const usage = estimate.usage ?? 0
        const quota = estimate.quota ?? 0
        const details = estimate.usageDetails ?? {}
        const detailParts = [
          details.indexedDB ? `IndexedDB ${formatStorageBytes(details.indexedDB)}` : '',
          details.caches ? `Cache ${formatStorageBytes(details.caches)}` : '',
        ].filter(Boolean)

        aiStorageUsage.textContent = [
          `Local storage used by this site: ${formatStorageBytes(usage)}`,
          quota > 0 ? `of ${formatStorageBytes(quota)} available` : '',
          detailParts.length > 0 ? `(${detailParts.join(', ')})` : '',
        ]
          .filter(Boolean)
          .join(' ')
      } catch {
        aiStorageUsage.textContent = 'Could not calculate local storage usage.'
      }
    }

    const refreshAiModelSettings = async () => {
      if (!aiModelSelect || !aiModelStatus || !aiModelInstallButton || !aiModelUninstallButton) return

      refreshAiModelMeta()

      const selectedModelId = aiModelSelect.value
      const isSystemModel = isChromePromptApiModelId(selectedModelId)
      const selectedModelName = getChatModelDisplayNameById(selectedModelId)
      const selectedInstalled = await chatbot.isModelInstalled(selectedModelId).catch(() => false)
      const chatbotState = chatbot.getState()
      const isSelectedActive = chatbotState.currentModelId === selectedModelId && chatbotState.isReady
      const isSelectedLoading = chatbotState.currentModelId === selectedModelId && chatbotState.isInitializing
      const canUninstallSelected = !isSystemModel && (selectedInstalled || isSelectedActive || isSelectedLoading)

      if (isSelectedLoading) {
        aiModelStatus.textContent = `Installing or loading ${selectedModelName}...`
      } else if (isSelectedActive) {
        aiModelStatus.textContent = isSystemModel
          ? `${selectedModelName} is active.`
          : `${selectedModelName} is installed and active.`
      } else if (isSystemModel && selectedInstalled) {
        aiModelStatus.textContent = `${selectedModelName} is available in Chrome. No model download is needed.`
      } else if (selectedInstalled) {
        aiModelStatus.textContent = `${selectedModelName} is installed in this browser, but it is not active.`
      } else {
        aiModelStatus.textContent = `${selectedModelName} is not installed. It will download when loaded.`
      }

      if (isSelectedLoading) {
        aiModelInstallButton.textContent = 'Loading...'
      } else if (isSelectedActive) {
        aiModelInstallButton.textContent = 'Reload model'
      } else if (isSystemModel) {
        aiModelInstallButton.textContent = 'Use system model'
      } else if (selectedInstalled) {
        aiModelInstallButton.textContent = 'Load model'
      } else {
        aiModelInstallButton.textContent = 'Download and load'
      }

      aiModelUninstallButton.textContent = isSystemModel
        ? 'Not uninstallable'
        : isSelectedLoading
          ? 'Cancel and uninstall'
          : 'Uninstall'
      aiModelInstallButton.disabled = isUpdatingAiModel || chatbotState.isInitializing
      aiModelUninstallButton.disabled =
        !canUninstallSelected || (isUpdatingAiModel && !(allowUninstallWhileLoading && isSelectedLoading))

      if (aiModelClearLocalDataButton) {
        aiModelClearLocalDataButton.textContent = isClearingAiStorage ? 'Clearing...' : 'Clear all local AI data'
        aiModelClearLocalDataButton.disabled = isUpdatingAiModel || isClearingAiStorage || chatbotState.isInitializing
      }
    }

    const runAiModelAction = async (
      action: () => Promise<void>,
      options: { allowUninstallWhileLoading?: boolean } = {},
    ) => {
      isUpdatingAiModel = true
      allowUninstallWhileLoading = Boolean(options.allowUninstallWhileLoading)
      await refreshAiModelSettings()

      try {
        await action()
      } finally {
        isUpdatingAiModel = false
        allowUninstallWhileLoading = false
        await refreshAiModelSettings()
        await refreshAiStorageUsage()
      }
    }

    if (aiModelSelect) {
      aiModelSelect.innerHTML = getChatModelOptionsHtml(getVisibleChatModelId(currentSettings.aiModelId))
    }

    // Sincronizar UI con settings actuales
    if (themeSelect) themeSelect.value = currentSettings.theme
    if (fontFamilySelect) fontFamilySelect.value = currentSettings.fontFamily
    if (fontSizeInput) fontSizeInput.value = String(currentSettings.fontSize)
    if (aiModelSelect) aiModelSelect.value = getVisibleChatModelId(currentSettings.aiModelId)
    if (minimapCheck) minimapCheck.checked = currentSettings.minimap
    if (lineNumbersCheck) lineNumbersCheck.checked = currentSettings.lineNumbers
    if (lineTimingsCheck) lineTimingsCheck.checked = currentSettings.lineTimings
    if (wordWrapCheck) wordWrapCheck.checked = currentSettings.wordWrap
    if (fontLigaturesCheck) fontLigaturesCheck.checked = currentSettings.fontLigatures
    if (stickyScrollCheck) stickyScrollCheck.checked = currentSettings.stickyScroll
    if (indentGuidesCheck) indentGuidesCheck.checked = currentSettings.indentGuides
    if (renderWhitespaceSelect) renderWhitespaceSelect.value = currentSettings.renderWhitespace
    if (debounceInput) debounceInput.value = String(currentSettings.debounceDelay)
    if (autoLogExpressionsCheck) autoLogExpressionsCheck.checked = currentSettings.autoLogExpressions
    if (formatPasteCheck) formatPasteCheck.checked = currentSettings.formatOnPaste
    if (formatTypeCheck) formatTypeCheck.checked = currentSettings.formatOnType

    void refreshAiModelSettings()
    void refreshAiStorageUsage()

    // Event listeners para cambios en settings
    themeSelect?.addEventListener('change', async (e) => {
      const theme = (e.target as HTMLSelectElement).value
      if (!isAvailableTheme(theme)) return

      const previousTheme = currentSettings.theme
      currentSettings = updateSetting(currentSettings, 'theme', theme)

      const applied = await changeTheme(theme)
      if (!applied && currentSettings.theme === theme) {
        currentSettings = updateSetting(currentSettings, 'theme', previousTheme)
        themeSelect.value = previousTheme
        await changeTheme(previousTheme)
      }
    })

    fontFamilySelect?.addEventListener('change', (e) => {
      const fontFamily = (e.target as HTMLSelectElement).value
      currentSettings = updateSetting(currentSettings, 'fontFamily', fontFamily as any)
      applyEditorLineHeightVar(currentSettings.fontSize)
      editor?.updateOptions({
        fontFamily: getEditorFontFamilyStack(),
      })
    })

    fontSizeInput?.addEventListener('input', (e) => {
      const size = parseInt((e.target as HTMLInputElement).value, 10)
      currentSettings = updateSetting(currentSettings, 'fontSize', size)
      const lineHeight = calculateLineHeight(currentSettings.fontSize)
      applyEditorLineHeightVar(currentSettings.fontSize)
      editor?.updateOptions({
        fontSize: currentSettings.fontSize,
        lineHeight: lineHeight,
      })
    })

    aiModelSelect?.addEventListener('change', async (e) => {
      const modelId = (e.target as HTMLSelectElement).value
      currentSettings = updateSetting(currentSettings, 'aiModelId', modelId)

      const chatbotModelSelect = $('#chatbot-model-select') as HTMLSelectElement | null
      if (chatbotModelSelect) {
        chatbotModelSelect.value = modelId
        void refreshChatbotModelPickerStatus()
      }

      await refreshAiModelSettings()
    })

    aiModelInstallButton?.addEventListener('click', async () => {
      const selectedModelId = aiModelSelect?.value || currentSettings.aiModelId

      await runAiModelAction(
        async () => {
          await loadChatbotModel(selectedModelId)
        },
        { allowUninstallWhileLoading: true },
      )
    })

    aiModelUninstallButton?.addEventListener('click', async () => {
      const selectedModelId = aiModelSelect?.value || currentSettings.aiModelId

      await runAiModelAction(async () => {
        await chatbot.uninstallModel(selectedModelId)

        if (chatbot.getState().currentModelId === selectedModelId && !chatbot.getState().isReady) {
          const chatbotMessages = $('#chatbot-messages') as HTMLElement | null
          if (chatbotMessages) {
            renderChatbotModelPickerUI()
          }
        }
      })
    })

    aiModelClearLocalDataButton?.addEventListener('click', async () => {
      if (isClearingAiStorage) return

      const confirmed = window.confirm(
        'This will remove all local AI storage for this site, including every CacheStorage cache, every IndexedDB database, and all origin private files. Continue?',
      )
      if (!confirmed) return

      isClearingAiStorage = true
      if (aiStorageUsage) {
        aiStorageUsage.textContent = 'Clearing all local AI storage...'
      }
      await refreshAiModelSettings()

      let cleared = false

      try {
        const result = await chatbot.clearLocalAiData()
        cleared = true

        if (aiStorageUsage) {
          aiStorageUsage.textContent = `Deleted ${result.deletedCaches} cache${result.deletedCaches === 1 ? '' : 's'}, ${result.deletedDatabases} IndexedDB database${result.deletedDatabases === 1 ? '' : 's'}, and ${result.deletedFiles} local file entr${result.deletedFiles === 1 ? 'y' : 'ies'}.`
        }

        renderChatbotModelPickerUI()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not clear local AI data.'
        if (aiStorageUsage) {
          aiStorageUsage.textContent = message
        }
      } finally {
        isClearingAiStorage = false
        await refreshAiModelSettings()

        if (cleared) {
          await refreshAiStorageUsage()
        }
      }
    })

    minimapCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'minimap', enabled)
      editor?.updateOptions({ minimap: { enabled: currentSettings.minimap } })
    })

    lineNumbersCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'lineNumbers', enabled)
      refreshLineNumbers()
    })

    lineTimingsCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'lineTimings', enabled)
      refreshLineNumbers()
    })

    wordWrapCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'wordWrap', enabled)
      editor?.updateOptions({ wordWrap: currentSettings.wordWrap ? 'on' : 'off' })
    })

    fontLigaturesCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'fontLigatures', enabled)
      editor?.updateOptions({ fontLigatures: currentSettings.fontLigatures })
    })

    stickyScrollCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'stickyScroll', enabled)
      editor?.updateOptions({ stickyScroll: { enabled: currentSettings.stickyScroll } })
    })

    indentGuidesCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'indentGuides', enabled)
      editor?.updateOptions({
        guides: {
          indentation: currentSettings.indentGuides,
          highlightActiveIndentation: currentSettings.indentGuides,
        },
      })
    })

    renderWhitespaceSelect?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as RenderWhitespace
      currentSettings = updateSetting(currentSettings, 'renderWhitespace', value)
      editor?.updateOptions({ renderWhitespace: currentSettings.renderWhitespace })
    })

    debounceInput?.addEventListener('input', (e) => {
      const delay = parseInt((e.target as HTMLInputElement).value, 10)
      currentSettings = updateSetting(currentSettings, 'debounceDelay', delay)
    })

    autoLogExpressionsCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'autoLogExpressions', enabled)

      if (autoRunEnabled) {
        runCode()
      }
    })

    formatPasteCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'formatOnPaste', enabled)
      editor?.updateOptions({ formatOnPaste: currentSettings.formatOnPaste })
    })

    formatTypeCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      currentSettings = updateSetting(currentSettings, 'formatOnType', enabled)
      editor?.updateOptions({ formatOnType: currentSettings.formatOnType })
    })

    // Settings de Formatting (Prettier)
    const autoFormatCheck = document.getElementById('setting-auto-format') as HTMLInputElement
    const printWidthInput = document.getElementById('setting-print-width') as HTMLInputElement
    const tabWidthInput = document.getElementById('setting-tab-width') as HTMLInputElement
    const semiCheck = document.getElementById('setting-semi') as HTMLInputElement
    const singleQuoteCheck = document.getElementById('setting-single-quote') as HTMLInputElement
    const quotePropsSelect = document.getElementById('setting-quote-props') as HTMLSelectElement
    const jsxSingleQuoteCheck = document.getElementById('setting-jsx-single-quote') as HTMLInputElement
    const trailingCommaSelect = document.getElementById('setting-trailing-comma') as HTMLSelectElement
    const bracketSpacingCheck = document.getElementById('setting-bracket-spacing') as HTMLInputElement
    const arrowParensSelect = document.getElementById('setting-arrow-parens') as HTMLSelectElement

    // Sincronizar UI con settings de Prettier
    if (autoFormatCheck) autoFormatCheck.checked = currentSettings.prettier.autoFormat
    if (printWidthInput) printWidthInput.value = String(currentSettings.prettier.printWidth)
    if (tabWidthInput) tabWidthInput.value = String(currentSettings.prettier.tabWidth)
    if (semiCheck) semiCheck.checked = currentSettings.prettier.semi
    if (singleQuoteCheck) singleQuoteCheck.checked = currentSettings.prettier.singleQuote
    if (quotePropsSelect) quotePropsSelect.value = currentSettings.prettier.quoteProps
    if (jsxSingleQuoteCheck) jsxSingleQuoteCheck.checked = currentSettings.prettier.jsxSingleQuote
    if (trailingCommaSelect) trailingCommaSelect.value = currentSettings.prettier.trailingComma
    if (bracketSpacingCheck) bracketSpacingCheck.checked = currentSettings.prettier.bracketSpacing
    if (arrowParensSelect) arrowParensSelect.value = currentSettings.prettier.arrowParens

    // Event listeners para cambios en Prettier settings
    autoFormatCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      const newPrettier = { ...currentSettings.prettier, autoFormat: enabled }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    printWidthInput?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value, 10)
      const newPrettier = { ...currentSettings.prettier, printWidth: value }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    tabWidthInput?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value, 10)
      const newPrettier = { ...currentSettings.prettier, tabWidth: value }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    semiCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      const newPrettier = { ...currentSettings.prettier, semi: enabled }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    singleQuoteCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      const newPrettier = { ...currentSettings.prettier, singleQuote: enabled }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    quotePropsSelect?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as 'as-needed' | 'consistent' | 'preserve'
      const newPrettier = { ...currentSettings.prettier, quoteProps: value }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    jsxSingleQuoteCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      const newPrettier = { ...currentSettings.prettier, jsxSingleQuote: enabled }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    trailingCommaSelect?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as 'none' | 'es5' | 'all'
      const newPrettier = { ...currentSettings.prettier, trailingComma: value }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    bracketSpacingCheck?.addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked
      const newPrettier = { ...currentSettings.prettier, bracketSpacing: enabled }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })

    arrowParensSelect?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as 'always' | 'avoid'
      const newPrettier = { ...currentSettings.prettier, arrowParens: value }
      currentSettings = updateSetting(currentSettings, 'prettier', newPrettier)
    })
  }

  // Inicializar popovers del header
  initHeaderPopovers()

  // Configurar el runtime nativo de Node.js (solo tiene efecto en desktop)
  void setupNativeRuntimeUI()

  if (currentSettings.aiEnabled) {
    initChatbot()
  }

  // Ejecutar código inicial si auto-run está habilitado
  if (autoRunEnabled) {
    runCode()
  }
}

// Función para redistribuir el espacio entre paneles
function redistributePanelSpace() {
  const resizePanelsElement = document.querySelector('resize-panels')
  if (!resizePanelsElement) return

  if (typeof (resizePanelsElement as any).requestLayoutUpdate === 'function') {
    ;(resizePanelsElement as any).requestLayoutUpdate()
  }
}

// Inicializar el chatbot
let chatbotInitialized = false

async function initChatbot() {
  const chatbotMessages = $('#chatbot-messages') as HTMLElement
  const chatbotInput = $('#chatbot-input') as HTMLTextAreaElement
  const chatbotSend = $('#chatbot-send') as HTMLButtonElement
  const chatbotClear = $('#chatbot-clear') as HTMLButtonElement
  const chatbotQueue = $('#chatbot-queue') as HTMLElement
  const chatbotQueueToggle = $('#chatbot-queue-toggle') as HTMLButtonElement
  const chatbotQueueLabel = $('#chatbot-queue-label') as HTMLElement
  const chatbotQueueList = $('#chatbot-queue-list') as HTMLOListElement

  if (
    !chatbotMessages ||
    !chatbotInput ||
    !chatbotSend ||
    !chatbotClear ||
    !chatbotQueue ||
    !chatbotQueueToggle ||
    !chatbotQueueLabel ||
    !chatbotQueueList
  ) {
    console.error('Chatbot elements not found')
    return
  }

  const syncChatbotClearVisibility = () => {
    const hasConversation = !!chatbotMessages.querySelector('.chatbot-message, .agent-run')
    chatbotClear.hidden = !hasConversation && chatQueue.length === 0
  }

  const resizeChatbotInput = () => {
    chatbotInput.style.height = 'auto'
    chatbotInput.style.height = chatbotInput.value ? `${chatbotInput.scrollHeight}px` : 'auto'
  }

  const syncComposerActionState = () => {
    const hasMessage = chatbotInput.value.trim().length > 0
    chatbotSend.disabled = !hasMessage
    const label = agentBusy ? 'Add message to queue' : 'Send message'
    chatbotSend.title = label
    chatbotSend.setAttribute('aria-label', label)
  }

  const renderChatQueue = () => {
    const count = chatQueue.length
    chatbotQueue.hidden = count === 0
    chatbotQueueLabel.textContent = `${count} Queued`
    chatbotQueue.classList.toggle('collapsed', chatQueueCollapsed)
    chatbotQueueToggle.setAttribute('aria-expanded', String(!chatQueueCollapsed))
    chatbotQueueList.hidden = chatQueueCollapsed
    chatbotQueueList.innerHTML = ''

    chatQueue.forEach((item, index) => {
      const row = document.createElement('li')
      row.className = 'chatbot-queue-item'
      row.dataset.queueId = item.id

      const indicator = document.createElement('span')
      indicator.className = 'chatbot-queue-indicator'
      indicator.setAttribute('aria-hidden', 'true')

      const copy = document.createElement('span')
      copy.className = 'chatbot-queue-copy'
      copy.textContent = item.message
      copy.title = item.message

      const actions = document.createElement('span')
      actions.className = 'chatbot-queue-actions'

      const actionSpecs = [
        {
          action: 'edit',
          label: 'Edit queued message',
          icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1l1-4Z"/>',
          disabled: false,
        },
        {
          action: 'prioritize',
          label: 'Move queued message up',
          icon: '<path d="M12 19V5"/><path d="m5 12l7-7l7 7"/>',
          disabled: index === 0,
        },
        {
          action: 'remove',
          label: 'Remove queued message',
          icon: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
          disabled: false,
        },
      ] as const

      actionSpecs.forEach(({ action, label, icon, disabled }) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `chatbot-queue-action chatbot-queue-action--${action}`
        button.dataset.queueAction = action
        button.setAttribute('aria-label', label)
        button.title = label
        button.disabled = disabled
        button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`
        actions.appendChild(button)
      })

      row.append(indicator, copy, actions)
      chatbotQueueList.appendChild(row)
    })

    syncChatbotClearVisibility()
  }

  const focusChatbotInput = () => {
    if (chatbotInput.disabled) return

    requestAnimationFrame(() => {
      chatbotInput.focus()
    })
  }

  syncChatbotClearVisibility()

  if (!chatbotInitialized) {
    chatbotInitialized = true

    setupComposerModelSelector()

    // Configurar listener de estado
    chatbot.setStateChangeListener((state: ChatbotState) => {
      syncChatbotClearVisibility()

      // La carga del modelo es siempre en segundo plano (sin pantalla de carga). Si
      // un envío está esperando, reflejamos el progreso en el mensaje de estado.
      if (state.isInitializing && modelLoadStatusUpdater) {
        modelLoadStatusUpdater(describeModelLoadStatus(state))
      }

      // El composer siempre es usable: se puede escribir aunque el modelo no esté
      // cargado (al enviar se resuelve y carga).
      const modelPicker = $('#chatbot-model-picker') as HTMLElement | null
      if (modelPicker) modelPicker.remove()
      const loadingElement = $('#chatbot-loading') as HTMLElement | null
      if (loadingElement) loadingElement.remove()
      chatbotInput.disabled = false
      syncComposerActionState()

      updateComposerModelLabel()
      updateChatEmptyState()

      void refreshChatbotModelPickerStatus()

      const aiModelStatus = $('#setting-ai-model-status') as HTMLElement | null
      const aiModelInstallButton = $('#setting-ai-model-install') as HTMLButtonElement | null
      const aiModelUninstallButton = $('#setting-ai-model-uninstall') as HTMLButtonElement | null
      const aiModelClearLocalDataButton = $('#setting-ai-clear-local-data') as HTMLButtonElement | null

      if (aiModelStatus && aiModelInstallButton && aiModelUninstallButton) {
        const selectedModelId = (document.getElementById('setting-ai-model') as HTMLSelectElement | null)?.value

        if (selectedModelId && state.currentModelId === selectedModelId && state.isInitializing) {
          const selectedModelName = getChatModelDisplayNameById(selectedModelId)

          aiModelStatus.textContent = `Installing or loading ${selectedModelName}...`
          aiModelInstallButton.textContent = 'Loading...'
          aiModelUninstallButton.textContent = 'Cancel and uninstall'
          aiModelInstallButton.disabled = true
          aiModelUninstallButton.disabled = false
        }
      }

      if (aiModelClearLocalDataButton) {
        aiModelClearLocalDataButton.disabled = state.isInitializing
      }
    })

    // Auto-resize del textarea
    chatbotInput.addEventListener('input', () => {
      resizeChatbotInput()
      syncComposerActionState()
    })

    // Enviar mensaje con Enter (Shift+Enter para nueva línea)
    chatbotInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendChatMessage()
      }
    })

    // Enviar mensaje con botón
    chatbotSend.addEventListener('click', () => {
      sendChatMessage()
    })

    chatbotQueueToggle.addEventListener('click', () => {
      chatQueueCollapsed = !chatQueueCollapsed
      renderChatQueue()
    })

    chatbotQueueList.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-queue-action]')
      const row = button?.closest<HTMLElement>('[data-queue-id]')
      const id = row?.dataset.queueId
      if (!button || !id) return

      switch (button.dataset.queueAction) {
        case 'edit': {
          const result = takeQueuedMessageForEdit(chatQueue, id)
          chatQueue = result.queue
          if (result.item) {
            chatbotInput.value = result.item.message
            pendingSelection = result.item.selection
            renderSelectionChip()
            resizeChatbotInput()
            syncComposerActionState()
            focusChatbotInput()
          }
          break
        }
        case 'prioritize':
          chatQueue = prioritizeQueuedMessage(chatQueue, id)
          break
        case 'remove':
          chatQueue = removeQueuedMessage(chatQueue, id).queue
          break
      }

      renderChatQueue()
    })

    // Limpiar conversación
    chatbotClear.addEventListener('click', () => {
      chatbot.clearHistory()
      chatQueue = []
      renderChatQueue()
      if (chatbotMessages) {
        // Desmontar los roots de React antes de vaciar el DOM para que liberen sus
        // recursos en vez de quedar huérfanos.
        unmountChatResponseRoots()
        chatbotMessages.innerHTML = ''
        syncChatbotClearVisibility()
        updateChatEmptyState()
        focusChatbotInput()
      }
    })
  }

  const chatbotState = chatbot.getState()
  syncChatbotClearVisibility()
  renderChatQueue()
  updateComposerModelLabel()
  updateChatEmptyState()

  // El composer siempre está listo para escribir. La carga del modelo es en segundo
  // plano y silenciosa (sin pantalla de carga); si al enviar aún no está, el mensaje
  // mostrará "Preparing model…" / "Downloading model… X%".
  chatbotInput.disabled = false
  chatbotInput.readOnly = false
  syncComposerActionState()

  if (!chatbotState.isReady && !chatbotState.isInitializing) {
    // Precarga en segundo plano solo si no requiere descarga (modelo del sistema) o
    // ya está instalado. Los modelos grandes se descargan al primer envío.
    const target = resolveModelChoice(userModelChoice)
    const targetInstalled = await chatbot.isModelInstalled(target).catch(() => false)
    if (isChromePromptApiModelId(target) || targetInstalled) {
      void ensureModelLoadedForChoice()
    }
  }

  // Captura el composer. Si hay un turno activo, el mensaje espera en la cola;
  // en caso contrario comienza a procesarse inmediatamente.
  function sendChatMessage() {
    const message = chatbotInput.value.trim()
    if (!message) {
      focusChatbotInput()
      return
    }

    const item: ChatQueueItem = {
      id: `queued-message-${++queuedMessageSequence}`,
      message,
      selection: takePendingSelection(),
    }
    chatbotInput.value = ''
    resizeChatbotInput()
    syncComposerActionState()

    if (agentBusy) {
      chatQueue = enqueueChatMessage(chatQueue, item)
      chatQueueCollapsed = false
      renderChatQueue()
      focusChatbotInput()
      return
    }

    void processAgentTurn(item)
  }

  function finishAgentTurn() {
    agentBusy = false
    modelLoadStatusUpdater = null
    syncComposerActionState()

    const next = dequeueChatMessage(chatQueue)
    chatQueue = next.queue
    renderChatQueue()

    if (next.item) {
      void processAgentTurn(next.item)
    } else {
      focusChatbotInput()
    }
  }

  // Procesa exactamente un turno. Solo esta función añade el mensaje al historial.
  async function processAgentTurn(item: ChatQueueItem) {
    agentBusy = true
    syncComposerActionState()

    addChatMessage('user', item.message)
    syncChatbotClearVisibility()
    updateChatEmptyState()

    // Línea de estado dinámica al final de la conversación ("Planning next moves…",
    // "Editing the code…", "Running the code…", "Downloading model… X%").
    let statusEl: HTMLElement | null = null
    const showStatus = (text: string) => {
      if (!statusEl) {
        statusEl = document.createElement('div')
        statusEl.className = 'agent-status'
      }
      statusEl.textContent = text
      chatbotMessages?.appendChild(statusEl)
      chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
    }
    const clearStatus = () => {
      statusEl?.remove()
      statusEl = null
    }

    // Si el modelo aún no está listo, lo cargamos mostrando el progreso en el estado
    // ("Preparing model…" / "Downloading model… X%") en vez de una pantalla de carga.
    if (!chatbot.getState().isReady) {
      showStatus(describeModelLoadStatus(chatbot.getState()))
      modelLoadStatusUpdater = showStatus
      const ready = await ensureModelLoadedForChoice()
      modelLoadStatusUpdater = null
      if (!ready) {
        clearStatus()
        const realError = chatbot.getState().error
        let failureMessage: string
        if (isTauri()) {
          // On the desktop we run inference natively (llama.cpp). A failure here
          // is a download/startup problem, not WebGPU — surface the real cause.
          failureMessage =
            'I could not set up the local AI model (llama.cpp). Check your connection and disk space, then try again.'
        } else if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
          // On the web WebLLM needs WebGPU; without it the model can never load.
          failureMessage =
            'Your browser does not support WebGPU, which is required to run the AI model. Try Chrome/Edge with hardware acceleration enabled.'
        } else {
          failureMessage =
            'I could not load an AI model. Check your connection or pick another model in the selector.'
        }
        addChatMessage('assistant', realError ? `${failureMessage}\n\n\`${realError}\`` : failureMessage)
        updateChatEmptyState()
        finishAgentTurn()
        return
      }
    }

    // Grupo de trabajo del agente ("Worked for Xs", plegable). Se crea al primer paso.
    const runStart = performance.now()
    let runGroup: HTMLElement | null = null
    let runStepsEl: HTMLElement | null = null
    let runHeaderLabel: HTMLElement | null = null

    const ensureRunGroup = () => {
      if (runGroup) return
      runGroup = document.createElement('div')
      runGroup.className = 'agent-run'

      const header = document.createElement('button')
      header.type = 'button'
      header.className = 'agent-run-header'

      runHeaderLabel = document.createElement('span')
      runHeaderLabel.textContent = 'Working…'
      header.appendChild(runHeaderLabel)

      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      chevron.setAttribute('class', 'agent-run-chevron')
      chevron.setAttribute('width', '12')
      chevron.setAttribute('height', '12')
      chevron.setAttribute('viewBox', '0 0 24 24')
      chevron.setAttribute('fill', 'none')
      chevron.setAttribute('stroke', 'currentColor')
      chevron.setAttribute('stroke-width', '2')
      chevron.setAttribute('stroke-linecap', 'round')
      chevron.setAttribute('stroke-linejoin', 'round')
      chevron.innerHTML = '<path d="M6 9l6 6l6 -6" />'
      header.appendChild(chevron)

      runStepsEl = document.createElement('div')
      runStepsEl.className = 'agent-run-steps'

      header.addEventListener('click', () => runGroup?.classList.toggle('collapsed'))
      runGroup.appendChild(header)
      runGroup.appendChild(runStepsEl)
      chatbotMessages?.appendChild(runGroup)
    }

    let runFinalized = false
    const finalizeRunGroup = () => {
      if (runFinalized || !runGroup || !runHeaderLabel) return
      runFinalized = true
      const seconds = Math.max(1, Math.round((performance.now() - runStart) / 1000))
      runHeaderLabel.textContent = `Worked for ${seconds}s`
      runGroup.classList.add('collapsed')
    }

    // Tarjeta de EDICIÓN con diff aplicado (+X −Y, expandible para ver el diff).
    const renderAgentEdit = (info: AgentEditInfo) => {
      ensureRunGroup()

      const card = document.createElement('div')
      card.className = 'agent-card edit'

      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'agent-card-head'
      head.setAttribute('aria-expanded', 'true')

      const language = editor?.getModel?.()?.getLanguageId?.() === 'javascript' ? 'javascript' : 'typescript'
      const languageBadge = language === 'javascript' ? 'JS' : 'TS'
      const activeTitle = getActiveTabTitle()
      const fileName = /\.[a-z0-9]+$/i.test(activeTitle) ? activeTitle : `main.${language === 'javascript' ? 'js' : 'ts'}`
      const stats = [
        info.added > 0 ? `<span class="diff-add">+${info.added}</span>` : '',
        info.removed > 0 ? `<span class="diff-del">−${info.removed}</span>` : '',
      ].join('')

      head.title = info.note || 'Edited the code'
      head.innerHTML = `
        <span class="agent-file-badge agent-file-badge--${languageBadge.toLowerCase()}">${languageBadge}</span>
        <span class="agent-card-title">${escapeHtml(fileName)}</span>
        <span class="agent-card-stats">${stats}</span>
        <svg class="agent-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6 9l6 6l6 -6"/></svg>`

      const changedIndexes = info.lines.flatMap((line, index) => (line.type === 'ctx' ? [] : [index]))
      const previewIndexes = new Set<number>()
      for (const index of changedIndexes) {
        for (let contextIndex = Math.max(0, index - 1); contextIndex <= Math.min(info.lines.length - 1, index + 1); contextIndex++) {
          previewIndexes.add(contextIndex)
        }
      }
      const shownIndexes = [...previewIndexes].sort((a, b) => a - b).slice(0, 80)
      const diffEl = document.createElement('div')
      diffEl.className = 'agent-card-diff'
      let previousIndex = -2
      diffEl.innerHTML =
        shownIndexes
          .map((index) => {
            const line = info.lines[index]
            const cls = line.type === 'ctx' ? 'ctx' : line.type
            const num = line.type === 'del' ? line.oldLine : line.newLine
            const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''
            const separator = index > previousIndex + 1 ? '<div class="diff-separator" aria-hidden="true">···</div>' : ''
            previousIndex = index
            return `${separator}<div class="diff-row ${cls}"><span class="diff-num">${num ?? ''}</span><span class="diff-sign">${sign}</span><span class="diff-code" data-diff-index="${index}">${escapeHtml(line.text) || ' '}</span></div>`
          })
          .join('') +
        (previewIndexes.size > shownIndexes.length
          ? `<div class="diff-more">… ${previewIndexes.size - shownIndexes.length} more lines</div>`
          : '')

      const colorizeDiff = async () => {
        const codeElements = diffEl.querySelectorAll<HTMLElement>('.diff-code[data-diff-index]')
        await Promise.all(
          [...codeElements].map(async (codeElement) => {
            const index = Number(codeElement.dataset.diffIndex)
            const line = info.lines[index]
            if (!line || !monaco?.editor?.colorize) return
            const highlighted = await monaco.editor.colorize(line.text || ' ', language, {})
            if (codeElement.isConnected) codeElement.innerHTML = highlighted
          }),
        )
      }
      void colorizeDiff()

      head.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed')
        head.setAttribute('aria-expanded', String(!collapsed))
      })
      card.appendChild(head)
      card.appendChild(diffEl)
      runStepsEl?.appendChild(card)
      chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
    }

    // Tarjeta de EJECUCIÓN (estado ok/error).
    const renderAgentRun = () => {
      ensureRunGroup()

      const card = document.createElement('div')
      card.className = 'agent-card run'
      card.innerHTML = `
        <svg class="agent-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4v16l13 -8z"/></svg>
        <span class="agent-card-title">Ran the code</span>
        <span class="agent-card-detail"></span>`
      const detailEl = card.querySelector('.agent-card-detail') as HTMLElement
      runStepsEl?.appendChild(card)
      chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)

      return {
        update(detail: string, state?: 'ok' | 'error') {
          detailEl.textContent = detail
          if (state) card.classList.add(state)
          chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
        },
      }
    }

    // Pinta la respuesta final del asistente como markdown (reutiliza ChatResponse)
    const renderAssistantMarkdown = (markdown: string) => {
      finalizeRunGroup()

      const assistantMessageDiv = document.createElement('div')
      assistantMessageDiv.className = 'chatbot-message assistant'

      const contentDiv = document.createElement('div')
      contentDiv.className = 'chatbot-message-content'
      assistantMessageDiv.appendChild(contentDiv)

      const meta = document.createElement('div')
      meta.className = 'chatbot-message-meta'
      const time = document.createElement('span')
      time.textContent = 'Just now'
      const copyIconSvg =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"/></svg>'
      const checkIconSvg =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 12l5 5l10 -10"/></svg>'
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.title = 'Copy response'
      copyBtn.innerHTML = copyIconSvg
      let copyResetTimer: number | undefined
      copyBtn.addEventListener('click', () => {
        void navigator.clipboard?.writeText(markdown)
        copyBtn.innerHTML = checkIconSvg
        copyBtn.classList.add('copied')
        window.clearTimeout(copyResetTimer)
        copyResetTimer = window.setTimeout(() => {
          copyBtn.innerHTML = copyIconSvg
          copyBtn.classList.remove('copied')
        }, 1800)
      })
      meta.appendChild(time)
      meta.appendChild(copyBtn)
      assistantMessageDiv.appendChild(meta)

      chatbotMessages?.appendChild(assistantMessageDiv)

      const reactRoot = createRoot(contentDiv)
      chatResponseRoots.add(reactRoot)
      reactRoot.render(
        React.createElement(ChatResponse, {
          content: markdown,
          isStreaming: false,
          monaco,
          theme: currentSettings.theme,
          fontFamily: getEditorFontFamilyStack(),
          fontSize: currentSettings.fontSize,
          lineHeight: calculateLineHeight(currentSettings.fontSize),
        }),
      )
      syncChatbotClearVisibility()
      updateChatEmptyState()
      chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
    }

    const bridge: AgentBridge = {
      getCode: () => editor?.getValue() || '',
      setCode: (code: string) => {
        editor?.setValue(code)
      },
      language: () => 'javascript',
      run: () => runCodeAndCollect(),
      format: (code: string) => formatCode(code, currentSettings.prettier),
    }

    const fullMessage = item.selection
      ? `${formatSelectionContext(item.selection)}\n\n${item.message}`
      : item.message

    try {
      await runAgent(fullMessage, {
        generate: (messages, onChunk) => chatbot.generate(messages, onChunk),
        bridge,
        maxSteps: 6,
        ui: {
          status: showStatus,
          clearStatus,
          edit: renderAgentEdit,
          run: renderAgentRun,
          finalAnswer: renderAssistantMarkdown,
        },
      })
    } catch (error: any) {
      console.error('Error running agent:', error)
      clearStatus()
      addChatMessage('assistant', `Error: ${error?.message ?? String(error)}`)
    } finally {
      clearStatus()
      finalizeRunGroup()
      updateChatEmptyState()
      chatbotInput.disabled = false
      finishAgentTurn()
    }
  }

  // Función auxiliar para añadir mensajes al chat
  function addChatMessage(role: 'user' | 'assistant', content: string) {
    if (!chatbotMessages) return

    const messageDiv = document.createElement('div')
    messageDiv.className = `chatbot-message ${role}`

    const roleSpan = document.createElement('div')
    roleSpan.className = 'chatbot-message-role'
    roleSpan.textContent = role === 'user' ? 'Yo' : 'AI Assistant'

    const contentDiv = document.createElement('div')
    contentDiv.className = 'chatbot-message-content'
    contentDiv.textContent = content

    messageDiv.appendChild(roleSpan)
    messageDiv.appendChild(contentDiv)

    chatbotMessages.appendChild(messageDiv)
    syncChatbotClearVisibility()
    chatbotMessages.scrollTo(0, chatbotMessages.scrollHeight)
  }

  // Procesar código markdown en el contenido
}

// Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
