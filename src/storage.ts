/**
 * Utilidad para manejar el almacenamiento local de configuraciones
 */

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
] as const

export type Theme = (typeof AVAILABLE_THEMES)[number]

// Fuentes disponibles
export const AVAILABLE_FONTS = ['JetBrains Mono', 'Cascadia Code'] as const

export type FontFamily = (typeof AVAILABLE_FONTS)[number]

export interface EditorSettings {
  theme: Theme
  fontSize: number
  fontFamily: FontFamily
  minimap: boolean
  lineNumbers: boolean
  debounceDelay: number
  formatOnPaste: boolean
  formatOnType: boolean
}

export const DEFAULT_SETTINGS: EditorSettings = {
  theme: 'vitesse-dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono',
  minimap: false,
  lineNumbers: true,
  debounceDelay: 800,
  formatOnPaste: true,
  formatOnType: true,
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

/**
 * Valida y normaliza las configuraciones cargadas
 */
function validateSettings(settings: Partial<EditorSettings>): EditorSettings {
  return {
    theme: settings.theme && isValidTheme(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme,
    fontSize: validateNumber(settings.fontSize, 10, 30, DEFAULT_SETTINGS.fontSize),
    fontFamily:
      settings.fontFamily && isValidFont(settings.fontFamily) ? settings.fontFamily : DEFAULT_SETTINGS.fontFamily,
    minimap: validateBoolean(settings.minimap, DEFAULT_SETTINGS.minimap),
    lineNumbers: validateBoolean(settings.lineNumbers, DEFAULT_SETTINGS.lineNumbers),
    debounceDelay: validateNumber(settings.debounceDelay, 100, 5000, DEFAULT_SETTINGS.debounceDelay),
    formatOnPaste: validateBoolean(settings.formatOnPaste, DEFAULT_SETTINGS.formatOnPaste),
    formatOnType: validateBoolean(settings.formatOnType, DEFAULT_SETTINGS.formatOnType),
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
