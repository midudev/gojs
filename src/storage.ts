/**
 * Utilidad para manejar el almacenamiento local de configuraciones
 */

import { DEFAULT_CHATBOT_MODEL_ID, isValidChatModelId } from './ai-models'

// Temas disponibles en modern-monaco
export const AVAILABLE_THEMES = [
  'vitesse-dark',
  'vitesse-light',
  'github-dark',
  'github-light',
  'dracula',
  'monokai',
  'nord',
  'tokyo-night',
  'one-dark-pro',
] as const

export type Theme = (typeof AVAILABLE_THEMES)[number]

// Fuentes disponibles
export const AVAILABLE_FONTS = ['JetBrains Mono', 'Cascadia Code'] as const

export type FontFamily = (typeof AVAILABLE_FONTS)[number]

export type LayoutOrientation = 'horizontal' | 'vertical'

export interface PrettierSettings {
  autoFormat: boolean
  printWidth: number
  tabWidth: number
  semi: boolean
  singleQuote: boolean
  quoteProps: 'as-needed' | 'consistent' | 'preserve'
  jsxSingleQuote: boolean
  trailingComma: 'none' | 'es5' | 'all'
  bracketSpacing: boolean
  arrowParens: 'always' | 'avoid'
}

export interface EditorSettings {
  theme: Theme
  fontSize: number
  fontFamily: FontFamily
  aiEnabled: boolean
  aiModelId: string
  minimap: boolean
  lineNumbers: boolean
  debounceDelay: number
  autoLogExpressions: boolean
  formatOnPaste: boolean
  formatOnType: boolean
  layoutOrientation: LayoutOrientation | null
  prettier: PrettierSettings
}

export const DEFAULT_SETTINGS: EditorSettings = {
  theme: 'vitesse-dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono',
  aiEnabled: true,
  aiModelId: DEFAULT_CHATBOT_MODEL_ID,
  minimap: false,
  lineNumbers: true,
  debounceDelay: 800,
  autoLogExpressions: true,
  formatOnPaste: true,
  formatOnType: true,
  layoutOrientation: null,
  prettier: {
    autoFormat: false,
    printWidth: 80,
    tabWidth: 2,
    semi: true,
    singleQuote: false,
    quoteProps: 'as-needed',
    jsxSingleQuote: false,
    trailingComma: 'es5',
    bracketSpacing: true,
    arrowParens: 'always',
  },
}

/**
 * Calcula el line-height óptimo basado en el tamaño de fuente
 */
export function calculateLineHeight(fontSize: number): number {
  // Usar un ratio de 1.57 (aproximadamente golden ratio)
  return Math.round(fontSize * 1.57)
}

const STORAGE_KEY = 'xjs-settings'

/**
 * Valida que el tema esté disponible
 */
function isValidTheme(theme: string): theme is Theme {
  return AVAILABLE_THEMES.includes(theme as Theme)
}

/**
 * Valida un valor numérico dentro de un rango
 */
function validateNumber(value: any, min: number, max: number, defaultValue: number): number {
  const num = Number(value)
  if (isNaN(num) || num < min || num > max) {
    return defaultValue
  }
  return num
}

/**
 * Valida un valor booleano
 */
function validateBoolean(value: any, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue
}

/**
 * Valida que la fuente esté disponible
 */
function isValidFont(font: string): font is FontFamily {
  return AVAILABLE_FONTS.includes(font as FontFamily)
}

function isValidLayoutOrientation(value: unknown): value is LayoutOrientation {
  return value === 'horizontal' || value === 'vertical'
}

/**
 * Valida y normaliza las configuraciones cargadas
 */
function validateSettings(settings: Partial<EditorSettings>): EditorSettings {
  const prettierSettings: Partial<PrettierSettings> = settings.prettier || ({} as Partial<PrettierSettings>)
  return {
    theme: settings.theme && isValidTheme(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
    fontSize: validateNumber(settings.fontSize, 10, 30, DEFAULT_SETTINGS.fontSize),
    fontFamily:
      settings.fontFamily && isValidFont(settings.fontFamily) ? settings.fontFamily : DEFAULT_SETTINGS.fontFamily,
    aiEnabled: validateBoolean(settings.aiEnabled, DEFAULT_SETTINGS.aiEnabled),
    aiModelId:
      typeof settings.aiModelId === 'string' && isValidChatModelId(settings.aiModelId)
        ? settings.aiModelId
        : DEFAULT_SETTINGS.aiModelId,
    minimap: validateBoolean(settings.minimap, DEFAULT_SETTINGS.minimap),
    lineNumbers: validateBoolean(settings.lineNumbers, DEFAULT_SETTINGS.lineNumbers),
    debounceDelay: validateNumber(settings.debounceDelay, 100, 5000, DEFAULT_SETTINGS.debounceDelay),
    autoLogExpressions: validateBoolean(settings.autoLogExpressions, DEFAULT_SETTINGS.autoLogExpressions),
    formatOnPaste: validateBoolean(settings.formatOnPaste, DEFAULT_SETTINGS.formatOnPaste),
    formatOnType: validateBoolean(settings.formatOnType, DEFAULT_SETTINGS.formatOnType),
    layoutOrientation: isValidLayoutOrientation(settings.layoutOrientation)
      ? settings.layoutOrientation
      : DEFAULT_SETTINGS.layoutOrientation,
    prettier: {
      autoFormat: validateBoolean(prettierSettings.autoFormat, DEFAULT_SETTINGS.prettier.autoFormat),
      printWidth: validateNumber(prettierSettings.printWidth, 40, 200, DEFAULT_SETTINGS.prettier.printWidth),
      tabWidth: validateNumber(prettierSettings.tabWidth, 1, 8, DEFAULT_SETTINGS.prettier.tabWidth),
      semi: validateBoolean(prettierSettings.semi, DEFAULT_SETTINGS.prettier.semi),
      singleQuote: validateBoolean(prettierSettings.singleQuote, DEFAULT_SETTINGS.prettier.singleQuote),
      quoteProps:
        prettierSettings.quoteProps && ['as-needed', 'consistent', 'preserve'].includes(prettierSettings.quoteProps)
          ? prettierSettings.quoteProps
          : DEFAULT_SETTINGS.prettier.quoteProps,
      jsxSingleQuote: validateBoolean(prettierSettings.jsxSingleQuote, DEFAULT_SETTINGS.prettier.jsxSingleQuote),
      trailingComma:
        prettierSettings.trailingComma && ['none', 'es5', 'all'].includes(prettierSettings.trailingComma)
          ? prettierSettings.trailingComma
          : DEFAULT_SETTINGS.prettier.trailingComma,
      bracketSpacing: validateBoolean(prettierSettings.bracketSpacing, DEFAULT_SETTINGS.prettier.bracketSpacing),
      arrowParens:
        prettierSettings.arrowParens && ['always', 'avoid'].includes(prettierSettings.arrowParens)
          ? prettierSettings.arrowParens
          : DEFAULT_SETTINGS.prettier.arrowParens,
    },
  }
}

/**
 * Carga las configuraciones desde localStorage
 * Si no existen o hay errores, retorna las configuraciones por defecto
 */
export function loadSettings(): EditorSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)

    if (!stored) {
      return DEFAULT_SETTINGS
    }

    const parsed = JSON.parse(stored)
    return validateSettings(parsed)
  } catch (error) {
    console.warn('Error loading settings from localStorage:', error)
    return DEFAULT_SETTINGS
  }
}

/**
 * Guarda las configuraciones en localStorage
 * Valida antes de guardar
 */
export function saveSettings(settings: EditorSettings): boolean {
  try {
    const validated = validateSettings(settings)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(validated))
    return true
  } catch (error) {
    console.error('Error saving settings to localStorage:', error)
    return false
  }
}

/**
 * Actualiza una configuración específica
 */
export function updateSetting<K extends keyof EditorSettings>(
  currentSettings: EditorSettings,
  key: K,
  value: EditorSettings[K],
): EditorSettings {
  const newSettings = { ...currentSettings, [key]: value }
  const validated = validateSettings(newSettings)
  saveSettings(validated)
  return validated
}

/**
 * Resetea las configuraciones a los valores por defecto
 */
export function resetSettings(): EditorSettings {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('Error resetting settings:', error)
  }
  return DEFAULT_SETTINGS
}

/**
 * Verifica si localStorage está disponible
 */
export function isLocalStorageAvailable(): boolean {
  try {
    const test = '__localStorage_test__'
    localStorage.setItem(test, test)
    localStorage.removeItem(test)
    return true
  } catch {
    return false
  }
}
