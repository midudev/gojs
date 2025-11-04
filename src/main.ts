import './style.css'
import './fonts.css'

import { init } from 'modern-monaco'
import { INITIAL_CODE } from './consts'
import { loadSettings, updateSetting, calculateLineHeight } from './storage'
import { initPrettierWorker, formatCode } from './prettier'
import { injectExpressionLogging, lineMap } from './console'
import { initHeaderPopovers } from './popovers'
import { initTabs } from './tabs'
import { $, $$ } from './dom'
import { chatbot, ChatbotState } from './chatbot'
import './keyboard-events'
import './resize-panels'
import { createRoot } from 'react-dom/client'
import { ChatResponse } from './ChatResponse'
import React from 'react'
// @ts-ignore
import ExecutorWorker from './executor-worker?worker'

// Estado de la aplicación
let editor: any = null
let monaco: any = null
let autoRunEnabled = true
let debounceTimer: number | null = null
let currentDecorations: any[] = [] // Para guardar las decoraciones activas

// Web Worker para ejecución de código con timeout
let executorWorker: Worker | null = null
let executionTimeoutId: number | null = null // Timer del hilo principal para timeout
const EXECUTION_TIMEOUT = 2000 // 2 segundos de timeout por defecto

// Guardar el último código ejecutado para evitar ejecuciones innecesarias
let lastExecutedCode: string = ''

let currentSettings = loadSettings()

// Inicializar editor
async function initEditor() {
  const editorElement = $('#editor')!

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
    const mtk14Color = getTokenColor('mtk14') || '#4fc3f7' // mtk14 token color for chatbot

    // Establecer variables CSS
    document.documentElement.style.setProperty('--theme-string', stringColor)
    document.documentElement.style.setProperty('--theme-number', numberColor)
    document.documentElement.style.setProperty('--theme-keyword', keywordColor)
    document.documentElement.style.setProperty('--theme-comment', commentColor)
    document.documentElement.style.setProperty('--theme-function', functionColor)
    document.documentElement.style.setProperty('--theme-boolean', booleanColor)
    document.documentElement.style.setProperty('--theme-mtk14', mtk14Color)
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

// Ejecutar código
async function runCode() {
  console.log('runCode')

  if (!editor) return

  // Si auto-format está activado, formatear antes de ejecutar
  if (currentSettings.prettier.autoFormat) {
    await formatEditorCode()
  }

  const code = editor.getValue()

  // Verificar si el código es el mismo que se ejecutó anteriormente
  if (code === lastExecutedCode) {
    console.log('Código sin cambios, ignorando ejecución')
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
    // Inyectar logging de expresiones en el código
    const modifiedCode = injectExpressionLogging(code)

    // Inicializar worker si no existe
    if (!executorWorker) {
      initExecutorWorker()
    }

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
    lastExecutedCode = code
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
  if (value && typeof value === 'object' && value.__type) {
    const span = document.createElement('span')

    switch (value.__type) {
      case 'Promise':
        span.className = 'log-promise'
        span.textContent = value.__value
        break
      case 'Function':
        span.className = 'log-function'
        span.textContent = value.__value
        break
      case 'Object':
      case 'Unknown':
        span.className = 'log-object'
        span.textContent = value.__value
        break
      default:
        span.textContent = String(value.__value || value)
    }

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
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
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

// Inicializar aplicación
async function start() {
  // Inicializar Prettier worker
  initPrettierWorker()

  await initEditor()

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
  const chatbotPanel = document.getElementById('chatbot-panel')
  let aiEnabled = true

  if (aiToggleButton && robotIcon && robotOffIcon && chatbotPanel) {
    // Configurar el estado inicial de la IA (habilitada por defecto)
    robotIcon.style.display = 'block'
    robotOffIcon.style.display = 'none'
    aiToggleButton.title = 'IA activada (click para desactivar)'
    chatbotPanel.style.display = 'flex'
    chatbotPanel.classList.remove('hidden')

    aiToggleButton.addEventListener('click', () => {
      aiEnabled = !aiEnabled

      // Alternar los iconos y mostrar/ocultar el panel
      if (aiEnabled) {
        robotIcon.style.display = 'block'
        robotOffIcon.style.display = 'none'
        aiToggleButton.title = 'IA activada (click para desactivar)'
        chatbotPanel.style.display = 'flex'
        chatbotPanel.classList.remove('hidden')

        // Inicializar el chatbot cuando se activa
        initChatbot()
      } else {
        robotIcon.style.display = 'none'
        robotOffIcon.style.display = 'block'
        aiToggleButton.title = 'IA desactivada (click para activar)'
        chatbotPanel.classList.add('hidden')
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
    const tabs = $$('.settings-tab')
    const panels = $$('.settings-panel')

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetPanel = tab.getAttribute('data-tab')

        // Update active tab
        tabs.forEach((t) => t.classList.remove('active'))
        tab.classList.add('active')

        // Update active panel
        panels.forEach((p) => p.classList.remove('active'))
        const panel = $(`[data-panel="${targetPanel}"]`)
        panel?.classList.add('active')
      })
    })

    // Cargar valores actuales en el formulario
    const themeSelect = $('#setting-theme') as HTMLSelectElement
    const fontFamilySelect = $('#setting-font-family') as HTMLSelectElement
    const fontSizeInput = $('#setting-font-size') as HTMLInputElement
    const minimapCheck = $('#setting-minimap') as HTMLInputElement
    const lineNumbersCheck = $('#setting-line-numbers') as HTMLInputElement
    const debounceInput = $('#setting-debounce') as HTMLInputElement
    const formatPasteCheck = $('#setting-format-on-paste') as HTMLInputElement
    const formatTypeCheck = $('#setting-format-on-type') as HTMLInputElement

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

  // Inicializar el chatbot automáticamente (fuera del bloque condicional)
  initChatbot()

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
  if (chatbotInitialized) return

  chatbotInitialized = true

  const chatbotMessages = $('#chatbot-messages') as HTMLElement
  const chatbotInput = $('#chatbot-input') as HTMLTextAreaElement
  const chatbotSend = $('#chatbot-send') as HTMLButtonElement
  const chatbotClear = $('#chatbot-clear') as HTMLButtonElement
  const loadingElement = $('#chatbot-loading') as HTMLElement
  const loadingProgressBar = $('#loading-progress-bar') as HTMLElement
  const loadingProgressText = $('#loading-progress-text') as HTMLElement

  if (!chatbotMessages || !chatbotInput || !chatbotSend || !chatbotClear) {
    console.error('Chatbot elements not found')
    return
  }

  // Configurar listener de estado
  chatbot.setStateChangeListener((state: ChatbotState) => {
    if (state.isInitializing) {
      // Actualizar progreso de carga
      if (loadingProgressBar && loadingProgressBar instanceof HTMLElement) {
        loadingProgressBar.style.width = `${state.loadProgress}%`
      }
      if (loadingProgressText) {
        loadingProgressText.textContent = `${Math.round(state.loadProgress)}%`
      }
    } else if (state.isReady) {
      // Ocultar mensaje de carga y habilitar input
      if (loadingElement && loadingElement instanceof HTMLElement) {
        loadingElement.style.display = 'none'
      }
      chatbotInput.disabled = false
      chatbotSend.disabled = false

      // Mostrar mensaje de bienvenida
      addChatMessage(
        'assistant',
        'Hello! I am your AI assistant. I can help you with questions about your JavaScript/TypeScript code. What can I help you with?',
      )
    } else if (state.error) {
      // Mostrar error
      if (loadingElement) {
        loadingElement.innerHTML = `
          <div class="chatbot-error-message">
            <strong>Error:</strong> ${state.error}
          </div>
        `
      }
    }
  })

  // Inicializar el modelo
  await chatbot.initialize()

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
    // Limpiar UI (mantener solo mensaje de bienvenida)
    if (chatbotMessages) {
      chatbotMessages.innerHTML = ''
      addChatMessage(
        'assistant',
        'Hello! I am your AI assistant. I can help you with questions about your JavaScript/TypeScript code. What can I help you with?',
      )
    }
  })

  // Función para enviar mensaje
  async function sendChatMessage() {
    const message = chatbotInput.value.trim()
    if (!message || !chatbot.getState().isReady) return

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

    // Deshabilitar input mientras se procesa
    chatbotInput.disabled = true
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
      chatbotSend.disabled = false
      chatbotInput.focus()
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
