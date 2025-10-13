import './style.css'
import './fonts.css'

import { init } from 'modern-monaco'
import { INITIAL_CODE } from './consts'
import { loadSettings, updateSetting, calculateLineHeight } from './storage'
import { initPrettierWorker, formatCode } from './prettier'
import { injectExpressionLogging } from './console'
import { initHeaderPopovers } from './popovers'
import { initTabs } from './tabs'

// Estado de la aplicación
let editor: any = null
let monaco: any = null
let autoRunEnabled = true
let debounceTimer: number | null = null
let currentDecorations: any[] = [] // Para guardar las decoraciones activas
const timers: Map<string, number> = new Map() // Para console.time
const counters: Map<string, number> = new Map() // Para console.count

let currentSettings = loadSettings()

// Inicializar editor
async function initEditor() {
  const editorElement = document.getElementById('editor')!

  // Inicializar Monaco con configuración manual
  monaco = await init({
    theme: currentSettings.theme,
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

  // Sincronizar el color de fondo del editor con la consola
  syncEditorBackground()

  // Sincronizar colores del tema
  syncThemeColors()

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
    const getTokenColor = (selector: string): string | null => {
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

    // Mapear tokens de Monaco a variables CSS
    const stringColor = getTokenColor('mtk12') || '#ce9178' // strings
    const numberColor = getTokenColor('mtk9') || '#b5cea8' // numbers
    const keywordColor = getTokenColor('mtk9') || '#569cd6' // keywords/booleans
    const commentColor = getTokenColor('mtk3') || '#6a9955' // comments
    const functionColor = getTokenColor('mtk12') || '#dcdcaa' // functions
    const booleanColor = getTokenColor('mtk9') || '#569cd6' // booleans

    // Establecer variables CSS
    document.documentElement.style.setProperty('--theme-string', stringColor)
    document.documentElement.style.setProperty('--theme-number', numberColor)
    document.documentElement.style.setProperty('--theme-keyword', keywordColor)
    document.documentElement.style.setProperty('--theme-comment', commentColor)
    document.documentElement.style.setProperty('--theme-function', functionColor)
    document.documentElement.style.setProperty('--theme-boolean', booleanColor)
  } catch (error) {
    console.error('Error al sincronizar colores del tema:', error)
  }
}

// Mapa de imports estáticos de temas
const themeImports: Record<string, () => Promise<any>> = {
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

// Cargar y aplicar un tema dinámicamente desde tm-themes
async function changeTheme(themeName: string) {
  if (!editor || !monaco) {
    console.error('Editor not initialized', { editor: !!editor, monaco: !!monaco })
    return
  }

  try {
    console.log('Loading theme:', themeName)

    // Cargar el tema desde el mapa de imports
    const themeLoader = themeImports[themeName]
    if (!themeLoader) {
      throw new Error(`Theme "${themeName}" not found in theme imports`)
    }

    const themeModule = await themeLoader()
    const themeData = themeModule.default || themeModule

    // Definir el tema en Monaco
    if (monaco.editor && monaco.editor.defineTheme) {
      monaco.editor.defineTheme(themeName, themeData)
    } else {
      console.error('monaco.editor.defineTheme not available')
      return
    }

    // Aplicar el tema
    if (monaco.editor && monaco.editor.setTheme) {
      monaco.editor.setTheme(themeName)
    } else {
      console.error('monaco.editor.setTheme not available')
      return
    }

    // Forzar actualización
    editor.layout()

    // Sincronizar background
    await new Promise((resolve) => setTimeout(resolve, 100))
    syncEditorBackground()

    // Sincronizar colores del tema para syntax highlighting
    syncThemeColors()

    console.log('Theme applied successfully:', themeName)
  } catch (error) {
    console.error('Error loading/applying theme:', error, themeName)
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
    const formatted = await formatCode(code, currentSettings.prettier)

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

// Ejecutar código
async function runCode() {
  if (!editor) return

  // Si auto-format está activado, formatear antes de ejecutar
  if (currentSettings.prettier.autoFormat) {
    await formatEditorCode()
  }

  const code = editor.getValue()
  const outputElement = document.getElementById('output')!

  // Limpiar salida anterior
  outputElement.innerHTML = ''

  const addLog = (
    type: 'log' | 'info' | 'warn' | 'error' | 'time' | 'table' | 'count' | 'expression',
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
      if (Array.isArray(data)) {
        // Múltiples argumentos
        data.forEach((arg, index) => {
          if (index > 0) {
            contentSpan.appendChild(document.createTextNode(' '))
          }
          appendFormattedValue(contentSpan, arg)
        })
      } else {
        // Un solo argumento
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

  // Preparar funciones de console personalizadas
  const customConsole = {
    log: (...args: any[]) => {
      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('log', lineNumber, args.length === 1 ? args[0] : args)
    },
    info: (...args: any[]) => {
      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('info', lineNumber, args.length === 1 ? args[0] : args)
    },
    warn: (...args: any[]) => {
      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('warn', lineNumber, args.length === 1 ? args[0] : args)
    },
    error: (...args: any[]) => {
      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('error', lineNumber, args.length === 1 ? args[0] : args)
    },
    time: (label: string = 'default') => {
      timers.set(label, performance.now())
    },
    timeEnd: (label: string = 'default') => {
      const startTime = timers.get(label)
      if (startTime === undefined) {
        addLog('warn', null, `Timer '${label}' does not exist`)
        return
      }
      const duration = performance.now() - startTime
      timers.delete(label)

      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('time', lineNumber, `${label}: ${duration.toFixed(3)}ms`)
    },
    table: (data: any, columns?: string[]) => {
      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('table', lineNumber, data, columns)
    },
    count: (label: string = 'default') => {
      const currentCount = counters.get(label) || 0
      const newCount = currentCount + 1
      counters.set(label, newCount)

      const stack = new Error().stack || ''
      const lineNumber = extractLineNumber(stack)
      addLog('count', lineNumber, `${label}: ${newCount}`)
    },
    countReset: (label: string = 'default') => {
      counters.delete(label)
    },
    __logExpression__: (value: any, lineNumber: number) => {
      addLog('expression', lineNumber, value)
    },
  }

  // Función auxiliar para extraer número de línea
  function extractLineNumber(stack: string): number | null {
    const lines = stack.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Buscar patrones comunes de stack trace
      // Chrome/V8: "at eval (eval at <anonymous>, <anonymous>:4:1)"
      // Firefox: "@eval line 4 > eval:4:1"
      const chromeMatch = line.match(/<anonymous>:(\d+):\d+\)?$/)
      const firefoxMatch = line.match(/eval:(\d+):\d+/)

      const match = chromeMatch || firefoxMatch

      if (match && i > 0) {
        // Ignorar la primera línea (es el Error() mismo)
        // AsyncFunction añade 2 líneas al inicio (wrapper de la función)
        // Restar ese offset para obtener el número de línea real del código
        const lineNum = parseInt(match[1], 10) - 2
        return lineNum > 0 ? lineNum : null
      }
    }

    return null
  }

  try {
    // Inyectar logging de expresiones en el código
    const modifiedCode = injectExpressionLogging(code)

    // Ejecutar código en un contexto aislado con console personalizado
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const fn = new AsyncFunction('console', modifiedCode)

    // Ejecutar y manejar promesas, pasando el console personalizado
    Promise.resolve(fn(customConsole)).catch((error) => {
      addLog('error', null, `Error: ${error.message}`)
      if (error.stack) {
        addLog('error', null, error.stack)
      }
    })
  } catch (error: any) {
    addLog('error', null, `Error de sintaxis: ${error.message}`)
    if (error.stack) {
      addLog('error', null, error.stack)
    }
  }
}

// Añadir valor formateado al contenedor con syntax highlighting
function appendFormattedValue(container: HTMLElement, value: any) {
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

// Configurar resize del panel divisor
function setupResizer() {
  const divider = document.getElementById('divider')!
  const editorPanel = document.querySelector('.editor-panel') as HTMLElement
  const outputPanel = document.querySelector('.output-panel') as HTMLElement

  let isResizing = false
  let startX = 0
  let startWidthEditor = 0
  let startWidthOutput = 0

  divider.addEventListener('mousedown', (e) => {
    isResizing = true
    startX = e.clientX
    startWidthEditor = editorPanel.offsetWidth
    startWidthOutput = outputPanel.offsetWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return

    const delta = e.clientX - startX
    const newEditorWidth = startWidthEditor + delta
    const newOutputWidth = startWidthOutput - delta

    // Límites mínimos
    if (newEditorWidth < 300 || newOutputWidth < 300) return

    editorPanel.style.flex = `0 0 ${newEditorWidth}px`
    outputPanel.style.flex = `0 0 ${newOutputWidth}px`
  })

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  })
}

// Inicializar aplicación
async function start() {
  // Inicializar Prettier worker
  initPrettierWorker()

  await initEditor()
  setupResizer()

  // Event listener para el botón de auto-run toggle
  const autorunToggleButton = document.getElementById('autorun-toggle-button')
  const pauseIcon = document.getElementById('pause-icon')
  const playIcon = document.getElementById('play-icon')

  if (autorunToggleButton && pauseIcon && playIcon) {
    autorunToggleButton.addEventListener('click', () => {
      autoRunEnabled = !autoRunEnabled

      // Alternar los iconos
      if (autoRunEnabled) {
        pauseIcon.style.display = 'block'
        playIcon.style.display = 'none'
        autorunToggleButton.title = 'Auto-ejecutar activado (click para desactivar)'
        // Ejecutar el código cuando se activa
        runCode()
      } else {
        pauseIcon.style.display = 'none'
        playIcon.style.display = 'block'
        autorunToggleButton.title = 'Auto-ejecutar desactivado (click para activar)'
      }
    })
  }

  // Event listener para el botón de IA toggle
  const aiToggleButton = document.getElementById('ai-toggle-button')
  const robotIcon = document.getElementById('robot-icon')
  const robotOffIcon = document.getElementById('robot-off-icon')
  let aiEnabled = false

  if (aiToggleButton && robotIcon && robotOffIcon) {
    aiToggleButton.addEventListener('click', () => {
      aiEnabled = !aiEnabled

      // Alternar los iconos
      if (aiEnabled) {
        robotIcon.style.display = 'block'
        robotOffIcon.style.display = 'none'
        aiToggleButton.title = 'IA activada (click para desactivar)'
        // Aquí irá la lógica para activar la IA
      } else {
        robotIcon.style.display = 'none'
        robotOffIcon.style.display = 'block'
        aiToggleButton.title = 'IA desactivada (click para activar)'
        // Aquí irá la lógica para desactivar la IA
      }
    })
  }

  // Event listener para el botón de settings
  const settingsButton = document.getElementById('settings-button')
  const settingsModal = document.getElementById('settings-modal')
  const closeSettings = document.getElementById('close-settings')
  const modalOverlay = settingsModal?.querySelector('.modal-overlay')

  if (settingsButton && settingsModal) {
    settingsButton.addEventListener('click', () => {
      settingsModal.style.display = 'flex'
    })

    const closeModal = () => {
      if (settingsModal) {
        settingsModal.style.display = 'none'
      }
    }

    closeSettings?.addEventListener('click', closeModal)
    modalOverlay?.addEventListener('click', closeModal)

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && settingsModal.style.display === 'flex') {
        closeModal()
      }
    })

    // Settings tabs
    const tabs = document.querySelectorAll('.settings-tab')
    const panels = document.querySelectorAll('.settings-panel')

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetPanel = tab.getAttribute('data-tab')

        // Update active tab
        tabs.forEach((t) => t.classList.remove('active'))
        tab.classList.add('active')

        // Update active panel
        panels.forEach((p) => p.classList.remove('active'))
        const panel = document.querySelector(`[data-panel="${targetPanel}"]`)
        panel?.classList.add('active')
      })
    })

    // Cargar valores actuales en el formulario
    const themeSelect = document.getElementById('setting-theme') as HTMLSelectElement
    const fontFamilySelect = document.getElementById('setting-font-family') as HTMLSelectElement
    const fontSizeInput = document.getElementById('setting-font-size') as HTMLInputElement
    const minimapCheck = document.getElementById('setting-minimap') as HTMLInputElement
    const lineNumbersCheck = document.getElementById('setting-line-numbers') as HTMLInputElement
    const debounceInput = document.getElementById('setting-debounce') as HTMLInputElement
    const formatPasteCheck = document.getElementById('setting-format-on-paste') as HTMLInputElement
    const formatTypeCheck = document.getElementById('setting-format-on-type') as HTMLInputElement

    // Sincronizar UI con settings actuales
    if (themeSelect) themeSelect.value = currentSettings.theme
    if (fontFamilySelect) fontFamilySelect.value = currentSettings.fontFamily
    if (fontSizeInput) fontSizeInput.value = String(currentSettings.fontSize)
    if (minimapCheck) minimapCheck.checked = currentSettings.minimap
    if (lineNumbersCheck) lineNumbersCheck.checked = currentSettings.lineNumbers
    if (debounceInput) debounceInput.value = String(currentSettings.debounceDelay)
    if (formatPasteCheck) formatPasteCheck.checked = currentSettings.formatOnPaste
    if (formatTypeCheck) formatTypeCheck.checked = currentSettings.formatOnType

    // Event listeners para cambios en settings
    themeSelect?.addEventListener('change', async (e) => {
      const theme = (e.target as HTMLSelectElement).value
      currentSettings = updateSetting(currentSettings, 'theme', theme as any)
      await changeTheme(theme)
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

    debounceInput?.addEventListener('input', (e) => {
      const delay = parseInt((e.target as HTMLInputElement).value, 10)
      currentSettings = updateSetting(currentSettings, 'debounceDelay', delay)
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

  // Ejecutar código inicial si auto-run está habilitado
  if (autoRunEnabled) {
    runCode()
  }
}

// Iniciar cuando el DOM esté listo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
