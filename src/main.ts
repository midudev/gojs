import './style.css'
import './fonts.css'

import { init } from 'modern-monaco'
import {
  AVAILABLE_CHAT_MODELS,
  CHROME_PROMPT_API_MODEL_ID,
  getChatModelDisplayName,
  getChatModelLabel,
  getChatModelRecord,
  getChromePromptApiModelLabel,
  isChromePromptApiModelId,
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
import { initPrettierWorker, formatCode, destroyPrettierWorker } from './prettier'
import { injectExpressionLogging, transformImports, lineMap } from './console'
import { formatConsoleValueText, isSerializedConsoleValue } from './console-values'
import { initHeaderPopovers } from './popovers'
import { initTabs } from './tabs'
import { $, $$ } from './dom'
import { chatbot, ChatbotState } from './chatbot'
import './keyboard-events'
import './resize-panels'
import { createRoot } from 'react-dom/client'
import { ChatResponse } from './ChatResponse'
import React from 'react'
import { isChromePromptApiAvailable } from './prompt-api'
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
let currentThemeData: EditorThemeData | null = null

// Web Worker para ejecución de código con timeout
let executorWorker: Worker | null = null
let executionTimeoutId: number | null = null // Timer del hilo principal para timeout
const EXECUTION_TIMEOUT = 2000 // 2 segundos de timeout por defecto
let teardownStarted = false

// Guardar la última ejecución para evitar ejecuciones innecesarias
let lastExecutionSignature: string = ''

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
  if (isChromePromptApiModelId(modelId) && !chromePromptApiModelAvailable) {
    return AVAILABLE_CHAT_MODELS[0]?.model_id ?? modelId
  }

  return modelId
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
  renderChatbotLoadingUI(0, modelId)

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

// Inicializar editor
async function initEditor() {
  const editorElement = $('#editor')!
  const loadedThemes = await Promise.all(AVAILABLE_THEMES.map(loadThemeData))

  // Inicializar Monaco con configuración manual
  monaco = await init({
    defaultTheme: currentSettings.theme,
    themes: loadedThemes,
    lsp: {
      typescript: {
        compilerOptions: {
          target: 99, // ES2022
          module: 99, // ESNext
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          moduleResolution: 2, // NodeJs
          allowJs: true,
          checkJs: true,
          jsx: 2, // React
          noEmit: true,
        },
      },
    },
  })

  // Crear instancia del editor
  editor = monaco.editor.create(editorElement, {
    value: INITIAL_CODE,
    language: 'javascript',
    theme: currentSettings.theme,
    fontFamily: `${currentSettings.fontFamily}, Menlo, Monaco, Courier New, monospace`,
    fontSize: currentSettings.fontSize,
    lineHeight: calculateLineHeight(currentSettings.fontSize),
    minimap: {
      enabled: currentSettings.minimap,
    },
    lineNumbers: currentSettings.lineNumbers ? 'on' : 'off',
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

  // Aplicar el tema inicial con la misma ruta que los cambios en settings.
  await changeTheme(currentSettings.theme)

  // Inicializar sistema de pestañas (tabs) y re-ejecutar al activar
  initTabs(editor, monaco, () => {
    // Re-ejecutar el código de la pestaña activa para refrescar la salida
    runCode()
  })
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

// Configurar eventos del editor
function setupEditorEvents() {
  // Escuchar cambios en el contenido del editor para ejecución automática
  if (editor) {
    editor.onDidChangeModelContent(() => {
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
  }
}

// Formatear código del editor con Prettier
async function formatEditorCode() {
  if (!editor) return

  try {
    const code = editor.getValue()
    const formatted = await formatCode(code, currentSettings.prettier).catch(() => code)

    if (formatted !== code) {
      // Guardar posición del cursor
      const position = editor.getPosition()

      // Actualizar el código
      editor.setValue(formatted)

      // Restaurar posición del cursor (aproximada)
      if (position) {
        editor.setPosition(position)
      }
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

  executorWorker?.terminate()
  executorWorker = null
  destroyPrettierWorker()
  void chatbot.destroy()

  editor?.dispose?.()
  editor = null
}

// Ejecutar código
async function runCode() {
  if (!editor) return

  // Si auto-format está activado, formatear antes de ejecutar
  if (currentSettings.prettier.autoFormat) {
    await formatEditorCode()
  }

  const code = editor.getValue()
  const executionSignature = `${currentSettings.autoLogExpressions ? 'expressions:on' : 'expressions:off'}\n${code}`

  // Verificar si el código es el mismo que se ejecutó anteriormente
  if (executionSignature === lastExecutionSignature) {
    return
  }

  const outputElement = $('#output')!

  // Limpiar salida anterior
  outputElement.innerHTML = ''

  const addLog = (
    type: 'log' | 'info' | 'warn' | 'error' | 'time' | 'table' | 'count' | 'expression' | 'timeout',
    lineNumber: number | null,
    data?: any,
    columns?: string[],
  ) => {
    const entry = document.createElement('div')
    entry.className = `log-entry ${type}`

    // No mostrar el tipo para expresiones
    if (type !== 'expression') {
      const typeSpan = document.createElement('span')
      typeSpan.className = 'log-type'
      typeSpan.textContent = type
      entry.appendChild(typeSpan)
    }

    // Si es una tabla, renderizar de forma especial
    if (type === 'table' && data !== undefined) {
      const tableElement = createTableElement(data, columns)
      entry.appendChild(tableElement)
    } else {
      const contentSpan = document.createElement('span')
      contentSpan.className = 'log-content'

      // Formatear el contenido con syntax highlighting
      // Para expresiones, el array ES el valor (no múltiples argumentos)
      if (Array.isArray(data) && type !== 'expression') {
        // Múltiples argumentos de console.log, console.info, etc.
        data.forEach((arg, index) => {
          if (index > 0) {
            contentSpan.appendChild(document.createTextNode(' '))
          }
          appendFormattedValue(contentSpan, arg)
        })
      } else {
        // Un solo valor (o una expresión que devuelve un array)
        appendFormattedValue(contentSpan, data)
      }

      entry.appendChild(contentSpan)
    }

    // Agregar número de línea si está disponible
    if (lineNumber !== null) {
      const lineSpan = document.createElement('span')
      lineSpan.className = 'log-line-number'
      lineSpan.textContent = `L${lineNumber}`
      entry.appendChild(lineSpan)

      // Agregar eventos de hover para destacar la línea en el editor
      entry.addEventListener('mouseenter', () => {
        highlightEditorLine(lineNumber)
      })

      entry.addEventListener('mouseleave', () => {
        clearEditorHighlight()
      })

      // Agregar evento de click para ir a la línea y hacer focus
      entry.addEventListener('click', () => {
        goToLineInEditor(lineNumber)
      })

      // Cambiar cursor a pointer para indicar que es clickeable
      entry.style.cursor = 'pointer'
    }

    outputElement.appendChild(entry)
  }

  try {
    // Reescribir imports estáticos a import() dinámicos (permite ESM desde CDN)
    const codeWithImports = transformImports(code)

    // Inyectar logging de expresiones en el código
    const modifiedCode = injectExpressionLogging(codeWithImports, { enabled: currentSettings.autoLogExpressions })

    // Recrear siempre el worker para cada ejecución. Así garantizamos un contexto
    // limpio y, sobre todo, matamos cualquier callback asíncrono (timers, promesas)
    // de una ejecución anterior que, de lo contrario, escribiría logs duplicados
    // en la salida ya limpiada (ver issue #16).
    initExecutorWorker()

    // Configurar manejo de mensajes del worker
    executorWorker!.onmessage = (e: MessageEvent) => {
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

    // Convertir lineMap a objeto plano para enviar al worker
    const lineMapObj: Record<number, number> = {}
    lineMap.forEach((value, key) => {
      lineMapObj[key] = value
    })

    // Configurar timeout desde el hilo principal (esto SÍ puede detener loops síncronos)
    if (EXECUTION_TIMEOUT > 0) {
      executionTimeoutId = window.setTimeout(() => {
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

// Añadir valor formateado al contenedor con syntax highlighting
function appendFormattedValue(container: HTMLElement, value: any) {
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
        const json = JSON.stringify(value, null, 2)
        const pre = document.createElement('pre')
        pre.className = 'log-object'
        pre.innerHTML = syntaxHighlightJSON(json)
        container.appendChild(pre)
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

// Syntax highlighting para JSON
function syntaxHighlightJSON(json: string): string {
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'log-json-number'
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'log-json-key'
          match = match.slice(0, -1) // Remover el ':'
        } else {
          cls = 'log-json-string'
        }
      } else if (/true|false/.test(match)) {
        cls = 'log-json-boolean'
      } else if (/null/.test(match)) {
        cls = 'log-json-null'
      }
      return `<span class="${cls}">${match}</span>` + (cls === 'log-json-key' ? ':' : '')
    },
  )
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
function highlightEditorLine(lineNumber: number) {
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

  // Hacer scroll suave a la línea
  editor.revealLineInCenter(lineNumber, 0) // 0 = smooth scroll
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

// Inicializar aplicación
async function start() {
  window.addEventListener('pagehide', teardownApp, { once: true })

  // Inicializar Prettier worker
  initPrettierWorker()

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
      editor?.updateOptions({
        fontFamily: `${currentSettings.fontFamily}, Menlo, Monaco, Courier New, monospace`,
      })
    })

    fontSizeInput?.addEventListener('input', (e) => {
      const size = parseInt((e.target as HTMLInputElement).value, 10)
      currentSettings = updateSetting(currentSettings, 'fontSize', size)
      const lineHeight = calculateLineHeight(currentSettings.fontSize)
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
      editor?.updateOptions({ lineNumbers: currentSettings.lineNumbers ? 'on' : 'off' })
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

  if (!chatbotMessages || !chatbotInput || !chatbotSend || !chatbotClear) {
    console.error('Chatbot elements not found')
    return
  }

  const syncChatbotClearVisibility = (state = chatbot.getState()) => {
    chatbotClear.hidden = !state.isReady
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

    // Configurar listener de estado
    chatbot.setStateChangeListener((state: ChatbotState) => {
      syncChatbotClearVisibility(state)

      if (state.isInitializing) {
        const loadingElement = $('#chatbot-loading') as HTMLElement | null

        if (!loadingElement) {
          renderChatbotLoadingUI(state.loadProgress, state.currentModelId, state.downloadSpeedBytesPerSecond)
        }

        const loadingProgressBar = $('#loading-progress-bar') as HTMLElement | null
        const loadingProgressText = $('#loading-progress-text') as HTMLElement | null
        const loadingDownloadSpeed = $('#loading-download-speed') as HTMLElement | null

        if (loadingProgressBar) {
          loadingProgressBar.style.width = `${state.loadProgress}%`
        }

        if (loadingProgressText) {
          loadingProgressText.textContent = `${Math.round(state.loadProgress)}%`
        }

        if (loadingDownloadSpeed) {
          const downloadSpeedText = formatDownloadSpeed(state.downloadSpeedBytesPerSecond)
          loadingDownloadSpeed.textContent = downloadSpeedText
          loadingDownloadSpeed.hidden = downloadSpeedText === ''
        }

        chatbotInput.disabled = true
        chatbotInput.readOnly = false
        chatbotSend.disabled = true
      } else if (state.isReady) {
        const loadingElement = $('#chatbot-loading') as HTMLElement | null

        if (loadingElement) {
          loadingElement.remove()
        }

        const modelPicker = $('#chatbot-model-picker') as HTMLElement | null
        if (modelPicker) {
          modelPicker.remove()
        }

        chatbotInput.disabled = false
        chatbotInput.readOnly = false
        chatbotSend.disabled = false

        if (!chatbotMessages.querySelector('.chatbot-message')) {
          const modelName = getChatModelDisplayNameById(state.currentModelId)

          addChatMessage(
            'assistant',
            `Hello! I am your AI assistant. Current model: ${modelName}. What can I help you with?`,
          )
        }
      } else if (state.error) {
        renderChatbotModelPickerUI(state.error)
        chatbotInput.disabled = true
        chatbotInput.readOnly = false
        chatbotSend.disabled = true
      } else {
        chatbotInput.disabled = true
        chatbotInput.readOnly = false
        chatbotSend.disabled = true

        if (!$('#chatbot-model-picker') && !chatbotMessages.querySelector('.chatbot-message')) {
          renderChatbotModelPickerUI()
        }
      }

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
      chatbotInput.style.height = 'auto'
      chatbotInput.style.height = chatbotInput.scrollHeight + 'px'
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

    // Limpiar conversación
    chatbotClear.addEventListener('click', () => {
      chatbot.clearHistory()
      // Limpiar UI (mantener solo mensaje de bienvenida si el modelo esta listo)
      if (chatbotMessages) {
        chatbotMessages.innerHTML = ''
        const state = chatbot.getState()
        syncChatbotClearVisibility(state)

        if (state.isReady) {
          addChatMessage(
            'assistant',
            `Hello! I am your AI assistant. Current model: ${getChatModelDisplayNameById(state.currentModelId)}. What can I help you with?`,
          )
        } else {
          renderChatbotModelPickerUI()
        }
      }
    })
  }

  const chatbotState = chatbot.getState()
  syncChatbotClearVisibility(chatbotState)

  if (chatbotState.isReady && chatbotState.currentModelId === currentSettings.aiModelId) {
    chatbotInput.disabled = false
    chatbotInput.readOnly = false
    chatbotSend.disabled = false

    if (!chatbotMessages.querySelector('.chatbot-message')) {
      addChatMessage(
        'assistant',
        `Hello! I am your AI assistant. Current model: ${getChatModelDisplayNameById(chatbotState.currentModelId)}. What can I help you with?`,
      )
    }

    return
  }

  if (chatbotState.isInitializing) {
    chatbotInput.disabled = true
    chatbotInput.readOnly = false
    chatbotSend.disabled = true
    renderChatbotLoadingUI(
      chatbotState.loadProgress,
      chatbotState.currentModelId,
      chatbotState.downloadSpeedBytesPerSecond,
    )
    return
  }

  chatbotInput.disabled = true
  chatbotInput.readOnly = false
  chatbotSend.disabled = true

  const selectedModelInstalled = await chatbot.isModelInstalled(currentSettings.aiModelId).catch(() => false)

  if (selectedModelInstalled && shouldAutoLoadChatModel(currentSettings.aiModelId)) {
    await loadChatbotModel(currentSettings.aiModelId)
    return
  }

  renderChatbotModelPickerUI()

  // Función para enviar mensaje
  async function sendChatMessage() {
    const message = chatbotInput.value.trim()
    if (!message || !chatbot.getState().isReady) {
      focusChatbotInput()
      return
    }

    // Obtener contexto del código y output
    const code = editor?.getValue() || ''
    const outputElement = $('#output')

    // Formatear output correctamente para la IA
    let formattedOutput = ''
    if (outputElement) {
      const logEntries = outputElement.querySelectorAll('.log-entry')
      const outputLines: string[] = []

      logEntries.forEach((entry) => {
        const contentEl = entry.querySelector('.log-content')
        const lineNumberEl = entry.querySelector('.log-line-number')

        if (contentEl) {
          const content = contentEl.textContent?.trim() || ''
          const lineNumber = lineNumberEl?.textContent?.trim() || ''

          if (lineNumber) {
            // Formato: contenido (número de línea)
            outputLines.push(`${content} (${lineNumber})`)
          } else {
            outputLines.push(content)
          }
        }
      })

      formattedOutput = outputLines.join('\n')
    }

    // Crear mensaje contextual
    let contextualMessage = message
    if (code || formattedOutput) {
      contextualMessage = `Current code:\n\`\`\`javascript\n${code}\n\`\`\`\n\n`
      if (formattedOutput) {
        contextualMessage += `Console output:\n\`\`\`\n${formattedOutput}\n\`\`\`\n\n`
      }
      contextualMessage += `User question: ${message}`
    }

    // Mostrar mensaje del usuario
    addChatMessage('user', message)

    // Limpiar input
    chatbotInput.value = ''
    chatbotInput.style.height = 'auto'
    focusChatbotInput()

    // Mantener el textarea enfocable mientras se procesa la respuesta.
    chatbotInput.readOnly = true
    chatbotSend.disabled = true

    // Mostrar indicador de escritura
    const typingIndicator = document.createElement('div')
    typingIndicator.className = 'chatbot-typing-indicator'
    typingIndicator.innerHTML = '<span></span><span></span><span></span>'
    chatbotMessages?.appendChild(typingIndicator)
    chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)

    try {
      // Crear elemento de mensaje del asistente
      const assistantMessageDiv = document.createElement('div')
      assistantMessageDiv.className = 'chatbot-message assistant'

      const roleSpan = document.createElement('div')
      roleSpan.className = 'chatbot-message-role'
      roleSpan.textContent = 'AI Assistant'

      assistantMessageDiv.appendChild(roleSpan)

      // Ocultar indicador de escritura y mostrar mensaje
      typingIndicator.remove()
      chatbotMessages?.appendChild(assistantMessageDiv)

      // Variables para procesar el streaming con <think>
      let fullContent = ''
      let isInThinkTag = false
      let thinkContent = ''
      let regularContent = ''
      let thinkBlock: HTMLElement | null = null
      let contentDiv: HTMLElement | null = null
      let reactRoot: any = null

      // Enviar mensaje y recibir respuesta con streaming
      await chatbot.sendMessage(contextualMessage, (chunk) => {
        fullContent += chunk

        // Detectar inicio de <think>
        if (fullContent.includes('<think>') && !isInThinkTag) {
          isInThinkTag = true
          const parts = fullContent.split('<think>')
          regularContent = parts[0]
          thinkContent = parts[1] || ''

          // Crear bloque de pensamiento si no existe
          if (!thinkBlock) {
            thinkBlock = createThinkingBlock()
            assistantMessageDiv.appendChild(thinkBlock)
          }
        }

        // Detectar fin de </think>
        if (fullContent.includes('</think>') && isInThinkTag) {
          isInThinkTag = false
          const parts = fullContent.split('</think>')
          const beforeClose = parts[0]
          const afterClose = parts[1] || ''

          // Extraer contenido del think
          if (beforeClose.includes('<think>')) {
            thinkContent = beforeClose.split('<think>')[1]
          }

          // Actualizar bloque de pensamiento con contenido completo
          if (thinkBlock) {
            updateThinkingBlock(thinkBlock, thinkContent, true)
          }

          // Crear div para contenido regular si no existe
          if (!contentDiv) {
            contentDiv = document.createElement('div')
            assistantMessageDiv.appendChild(contentDiv)
            reactRoot = createRoot(contentDiv)
          }

          regularContent = afterClose
          // Renderizar con React usando Streamdown
          if (reactRoot) {
            reactRoot.render(
              React.createElement(ChatResponse, {
                content: regularContent,
                isStreaming: false,
                monaco,
                theme: currentSettings.theme,
                fontFamily: `${currentSettings.fontFamily}, Menlo, Monaco, Courier New, monospace`,
                fontSize: currentSettings.fontSize,
                lineHeight: calculateLineHeight(currentSettings.fontSize),
              }),
            )
          }
        } else if (isInThinkTag) {
          // Actualizar contenido de think
          const parts = fullContent.split('<think>')
          if (parts.length > 1) {
            thinkContent = parts[1]
            if (thinkBlock) {
              updateThinkingBlock(thinkBlock, thinkContent, false)
            }
          }
        } else {
          // Actualizar contenido regular
          if (!contentDiv) {
            contentDiv = document.createElement('div')
            assistantMessageDiv.appendChild(contentDiv)
            reactRoot = createRoot(contentDiv)
          }

          // Si no hay think tag, mostrar todo
          if (!fullContent.includes('<think>')) {
            // Renderizar con React usando Streamdown
            if (reactRoot) {
              reactRoot.render(
                React.createElement(ChatResponse, {
                  content: fullContent,
                  isStreaming: true,
                  monaco,
                  theme: currentSettings.theme,
                  fontFamily: `${currentSettings.fontFamily}, Menlo, Monaco, Courier New, monospace`,
                  fontSize: currentSettings.fontSize,
                  lineHeight: calculateLineHeight(currentSettings.fontSize),
                }),
              )
            }
          } else {
            // Ya pasó el think tag, mostrar solo la parte después de </think>
            const parts = fullContent.split('</think>')
            if (parts.length > 1) {
              const content = parts[1]
              if (reactRoot) {
                reactRoot.render(
                  React.createElement(ChatResponse, {
                    content: content,
                    isStreaming: true,
                    monaco,
                    theme: currentSettings.theme,
                    fontFamily: `${currentSettings.fontFamily}, Menlo, Monaco, Courier New, monospace`,
                    fontSize: currentSettings.fontSize,
                    lineHeight: calculateLineHeight(currentSettings.fontSize),
                  }),
                )
              }
            }
          }
        }

        chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
      })

      // Hacer scroll al final
      chatbotMessages?.scrollTo(0, chatbotMessages.scrollHeight)
    } catch (error: any) {
      console.error('Error sending message:', error)
      typingIndicator.remove()
      addChatMessage('assistant', `Error: ${error.message}`)
    } finally {
      // Rehabilitar input
      chatbotInput.disabled = false
      chatbotInput.readOnly = false
      chatbotSend.disabled = false
      focusChatbotInput()
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
    chatbotMessages.scrollTo(0, chatbotMessages.scrollHeight)
  }

  // Crear bloque de pensamiento
  function createThinkingBlock(): HTMLElement {
    const thinkBlock = document.createElement('div')
    thinkBlock.className = 'thinking-block'
    thinkBlock.dataset.startTime = String(performance.now())

    const thinkHeader = document.createElement('div')
    thinkHeader.className = 'thinking-header'

    const thinkIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    thinkIcon.setAttribute('width', '16')
    thinkIcon.setAttribute('height', '16')
    thinkIcon.setAttribute('viewBox', '0 0 24 24')
    thinkIcon.setAttribute('fill', 'none')
    thinkIcon.setAttribute('stroke', 'currentColor')
    thinkIcon.setAttribute('stroke-width', '1.5')
    thinkIcon.setAttribute('stroke-linecap', 'round')
    thinkIcon.setAttribute('stroke-linejoin', 'round')
    thinkIcon.innerHTML = `
      <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
      <path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8" />
      <path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8" />
      <path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5" />
      <path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0" />
      <path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5" />
      <path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10" />
    `

    const thinkLabel = document.createElement('span')
    thinkLabel.className = 'thinking-label'
    thinkLabel.textContent = 'Thinking...'

    const thinkTime = document.createElement('span')
    thinkTime.className = 'thinking-time'
    thinkTime.textContent = ''

    const chevronIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    chevronIcon.classList.add('thinking-chevron')
    chevronIcon.setAttribute('width', '14')
    chevronIcon.setAttribute('height', '14')
    chevronIcon.setAttribute('viewBox', '0 0 24 24')
    chevronIcon.setAttribute('fill', 'none')
    chevronIcon.setAttribute('stroke', 'currentColor')
    chevronIcon.setAttribute('stroke-width', '2')
    chevronIcon.setAttribute('stroke-linecap', 'round')
    chevronIcon.setAttribute('stroke-linejoin', 'round')
    chevronIcon.innerHTML = '<path d="M6 9l6 6l6 -6" />'
    thinkHeader.appendChild(thinkIcon)
    thinkHeader.appendChild(thinkLabel)
    thinkHeader.appendChild(thinkTime)
    thinkHeader.appendChild(chevronIcon)

    const thinkContent = document.createElement('div')
    thinkContent.className = 'thinking-content loading'

    thinkBlock.appendChild(thinkHeader)
    thinkBlock.appendChild(thinkContent)

    // Click para expandir/contraer
    thinkHeader.addEventListener('click', () => {
      thinkBlock.classList.toggle('expanded')
    })

    return thinkBlock
  }

  // Actualizar bloque de pensamiento
  function updateThinkingBlock(thinkBlock: HTMLElement, content: string, isComplete: boolean) {
    const thinkContent = thinkBlock.querySelector('.thinking-content')
    const thinkLabel = thinkBlock.querySelector('.thinking-label')
    const thinkTime = thinkBlock.querySelector('.thinking-time')
    if (!thinkContent) return

    thinkContent.textContent = content

    if (isComplete) {
      thinkContent.classList.remove('loading')
      // Detener el intervalo si existe
      const intervalId = thinkBlock.dataset.intervalId
      if (intervalId) {
        clearInterval(Number(intervalId))
        delete thinkBlock.dataset.intervalId
      }
      // Cambiar label a "THOUGHT" y mostrar duración final
      if (thinkLabel && thinkTime) {
        const startTime = Number(thinkBlock.dataset.startTime || '0')
        const endTime = performance.now()
        const durationMs = endTime - startTime
        const durationSeconds = Math.max(0, Math.round(durationMs / 1000))
        thinkLabel.textContent = 'THOUGHT '
        thinkTime.textContent = `${durationSeconds}s`
      }
      // Auto-colapsar cuando está completo
      setTimeout(() => {
        thinkBlock.classList.remove('expanded')
      }, 1000)
    } else {
      // Expandir solo la primera vez, después respetar la decisión del usuario
      if (!thinkBlock.dataset.intervalId) {
        thinkBlock.classList.add('expanded')
      }

      if (thinkLabel && thinkTime) {
        const startTime = Number(thinkBlock.dataset.startTime || '0')

        // Si no hay intervalo activo, crear uno
        if (!thinkBlock.dataset.intervalId) {
          const intervalId = setInterval(() => {
            const currentTime = performance.now()
            const durationMs = currentTime - startTime
            const durationSeconds = Math.max(0, Math.round(durationMs / 1000))
            thinkLabel.textContent = 'Thinking... '
            thinkTime.textContent = `${durationSeconds}s`
          }, 100) // Actualizar cada 100ms

          thinkBlock.dataset.intervalId = String(intervalId)
        }
      }
    }
  }

  // Procesar código markdown en el contenido
}

// Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
