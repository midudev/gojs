import type { ChatMessage } from '../chatbot'
import { computeLineDiff, type CodeDiff, type DiffLine } from '../diff'

// Reexportamos el diff (ahora en un módulo propio) para no romper importaciones
// existentes que lo consumían desde el agente.
export { computeLineDiff }
export type { CodeDiff, DiffLine }

/**
 * Agente de código para el playground. Convierte al asistente de IA en un mini
 * "Claude Code": según lo que pida el usuario, o bien responde (pregunta), o bien
 * actúa sobre el código del editor (escribir/arreglar/inyectar/borrar/modificar)
 * y lo ejecuta, iterando en bucle hasta que funciona.
 *
 * El modo es transparente: no hay toggle. Lo decide el propio modelo a partir del
 * mensaje del usuario, emitiendo (o no) acciones.
 */

export interface AgentRunResult {
  /** Salida de consola formateada (una línea por entrada). */
  output: string
  /** true SOLO si hubo un error de ejecución no capturado (no cuenta console.error). */
  hasError: boolean
}

/** Puente hacia el editor y el runner del playground. Lo implementa main.ts. */
export interface AgentBridge {
  getCode(): string
  setCode(code: string): void
  run(): Promise<AgentRunResult>
  /** Lenguaje actual para los bloques de código ('javascript' | 'typescript'). */
  language?(): string
  /** Formatea el código con Prettier (transformación determinista). Opcional. */
  format?(code: string): Promise<string>
}

export interface AgentEditInfo {
  added: number
  removed: number
  note?: string
  lines: DiffLine[]
}

export interface AgentStepHandle {
  update(detail: string, state?: 'ok' | 'error'): void
}

/** Callbacks de UI. Los implementa main.ts para pintar pasos y la respuesta final. */
export interface AgentUI {
  /** Pinta una tarjeta de edición con el diff aplicado (+añadidas / −borradas). */
  edit(info: AgentEditInfo): void
  /** Pinta una tarjeta de ejecución y devuelve un updater. */
  run(): AgentStepHandle
  /** Pinta la respuesta final del asistente (markdown). */
  finalAnswer(markdown: string): void
  /** Actualiza el indicador de estado ("Pensando…", "Trabajando…"). */
  status(text: string): void
  /** Oculta el indicador de estado. */
  clearStatus(): void
}

export interface AgentDeps {
  generate(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string>
  bridge: AgentBridge
  ui: AgentUI
  /** Máximo de acciones antes de parar (evita loops infinitos). */
  maxSteps?: number
}

interface ParsedAction {
  kind: 'write' | 'run' | 'final' | 'strip-comments' | 'format'
  code?: string
  note?: string
  text?: string
  /** true si la etiqueta <action> venía explícita en la respuesta del modelo. */
  tagged: boolean
}

// ---------------------------------------------------------------------------
// Transformaciones deterministas (las ejecuta el harness, no el modelo).
// Un modelo pequeño reescribiendo el fichero entero es poco fiable; para tareas
// mecánicas (quitar comentarios, formatear) hacerlo nosotros acierta siempre.
// ---------------------------------------------------------------------------

/** ¿Puede aparecer una regex justo después de este carácter significativo? */
function regexCanFollow(prev: string): boolean {
  if (prev === '') return true
  // Tras un identificador, número, `)` `]` o `.` un `/` es división, no regex.
  return !/[\w$)\]]/.test(prev)
}

/**
 * Elimina comentarios `//` y `/* *\/` de código JS/TS respetando strings,
 * template literals y (heurísticamente) expresiones regulares. Limpia espacios
 * finales y colapsa las líneas en blanco que deja al borrar comentarios completos.
 */
export function stripComments(code: string): string {
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'regex'
  let state: State = 'code'
  let out = ''
  let lastSig = ''
  let i = 0
  const n = code.length

  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1] ?? ''

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && c2 === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        out += c
        state = c === '"' ? 'dq' : c === "'" ? 'sq' : 'tpl'
        lastSig = c
        i++
        continue
      }
      if (c === '/' && regexCanFollow(lastSig)) {
        out += c
        state = 'regex'
        lastSig = c
        i++
        continue
      }
      out += c
      if (!/\s/.test(c)) lastSig = c
      i++
      continue
    }

    if (state === 'line') {
      if (c === '\n') {
        out += c
        state = 'code'
      }
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code'
        i += 2
        continue
      }
      // Conservamos los saltos de línea del comentario para no fusionar líneas.
      if (c === '\n') out += c
      i++
      continue
    }

    // Strings y regex: copiamos tal cual y respetamos los escapes.
    out += c
    if (c === '\\') {
      out += code[i + 1] ?? ''
      i += 2
      continue
    }
    if (
      (state === 'dq' && c === '"') ||
      (state === 'sq' && c === "'") ||
      (state === 'tpl' && c === '`') ||
      (state === 'regex' && c === '/')
    ) {
      state = 'code'
    }
    i++
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n')
}

// ---------------------------------------------------------------------------
// Detección de intención de EDICIÓN (heurística, ES + EN).
// Conservadora a propósito: sólo verbos imperativos de cambio que casi nunca
// aparecen en preguntas, para no forzar ediciones cuando el usuario sólo pregunta.
// ---------------------------------------------------------------------------
const EDIT_INTENT_RE =
  /\b(quita|elimina|borra|suprime|remove|delete|strip|arregla|corrige|repara|fix|refactor(?:iza)?|formatea|format(?:ea)?|reempl(?:aza|azar)|replace|renombra|rename|a[ñn]ade|agrega|inserta|insert|implementa|implement|extrae|extract|optimiza|optimize|traduce|translate)\b/i

export function isEditIntent(userMessage: string): boolean {
  return EDIT_INTENT_RE.test(userMessage)
}

// Otros verbos de edición que, si aparecen, indican que la petición NO es una
// transformación mecánica pura (hay trabajo extra que sí necesita al modelo).
const OTHER_WORK_RE =
  /\b(a[ñn]ade|agrega|add|arregla|corrige|fix|refactor(?:iza)?|renombra|rename|reempl(?:aza|azar)|replace|implementa|implement|traduce|translate|cambia|change|convierte|convert|optimiza|optimize|extrae|extract)\b/i

/**
 * Detecta peticiones que son una transformación DETERMINISTA pura (quitar
 * comentarios, formatear). En esos casos el harness la ejecuta él mismo sin pasar
 * por el modelo, que es el eslabón poco fiable. Devuelve null si la petición mezcla
 * otro trabajo (p.ej. "quita los comentarios Y añade tipos") -> ahí sí usamos el loop.
 */
export function detectDeterministicIntent(userMessage: string): 'strip-comments' | 'format' | null {
  const m = userMessage.toLowerCase()
  const mentionsComments = /\bcomentarios?\b|\bcomments?\b/.test(m)
  const removeVerb = /\b(quita(?:r)?|elimina(?:r)?|borra(?:r)?|suprime|remove|delete|strip|sin)\b/.test(m)
  const otherWork = OTHER_WORK_RE.test(m)

  if (mentionsComments && removeVerb && !otherWork) return 'strip-comments'

  const formatVerb = /\b(formatea(?:r)?|format|prettifica|prettify|prettier|indenta(?:r)?)\b/.test(m)
  if (formatVerb && !mentionsComments && !otherWork) return 'format'

  return null
}

// ---------------------------------------------------------------------------
// Protocolo (etiquetas + bloques de código; más fiable que JSON en modelos pequeños)
// ---------------------------------------------------------------------------
function buildSystemPrompt(language: string): string {
  return `You are a coding AGENT embedded in a live ${language} playground. You can talk to the user AND directly control the code in the editor.

You work in a loop. On EACH turn you output EXACTLY ONE action, and you MUST begin your reply with its <action> tag:

1) To CHANGE the code (fix a bug, add a feature, inject, delete or modify anything), rewrite the WHOLE file:
<action>write</action>
\`\`\`${language}
<the complete, updated code>
\`\`\`

2) To EXECUTE the current code and read the console output / errors:
<action>run</action>

3) To REMOVE every comment from the current code (done deterministically for you — do NOT rewrite the file yourself for this):
<action>strip-comments</action>

4) To FORMAT / prettify the current code (done deterministically for you — do NOT rewrite the file yourself for this):
<action>format</action>

5) To FINISH and reply to the user (also for pure questions/explanations that need no code change):
<action>final</action>
<your message to the user, in Markdown>

Rules:
- ALWAYS start your reply with one of the <action> tags above. Never answer with plain prose alone.
- Decide from the request whether to answer or to act. Questions -> <action>final</action>. Fix/change requests -> act first, then finish.
- For "remove/strip the comments" use <action>strip-comments</action>. For "format/prettify" use <action>format</action>. These are reliable; do NOT hand-rewrite the file for them.
- NEVER claim you changed, removed or rewrote something without emitting the action that actually does it. Saying "done" without an edit is a failure.
- IMPORTANT: console.log / console.warn / console.error are normal program OUTPUT, NOT errors. Only treat the run as failed if the output explicitly says the execution threw an uncaught error.
- After a run that succeeded (no uncaught error), reply with <action>final</action>. Do NOT keep rewriting working code.
- If you cannot fix a real error after one attempt, stop with <action>final</action> and explain it. Never loop.
- With "write" always output the entire file, never a diff.
- Keep going autonomously; do not ask for confirmation mid-task.
- Match the user's language in your final message.`
}

/**
 * Prompt de cada turno (#4). En vez de acumular el historial completo (que en un
 * modelo con ventana pequeña acaba tapando la instrucción original), reconstruimos
 * un contexto compacto: código ACTUAL del editor + petición + un log breve de lo
 * hecho hasta ahora (sin re-incrustar el fichero entero en cada mensaje).
 */
function buildTurnPrompt(
  userMessage: string,
  code: string,
  language: string,
  transcript: string[],
): string {
  const codeBlock = code.trim() ? `\`\`\`${language}\n${code}\n\`\`\`` : '(the editor is empty)'
  const progress = transcript.length ? `\n\nProgress so far:\n${transcript.join('\n')}` : ''
  return `The code currently in the editor is:\n${codeBlock}\n\nUser request: ${userMessage}${progress}\n\nOutput your next single action now.`
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function extractFirstCodeBlock(text: string): string | null {
  const match = text.match(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/)
  if (!match) return null
  return match[1].replace(/\r?\n$/, '')
}

export function parseAction(raw: string): ParsedAction {
  const text = stripThink(raw)
  const tagMatch = text.match(/<action>\s*(write|run|final|strip-comments|format)\s*<\/action>/i)

  if (!tagMatch) {
    // Sin etiqueta: es texto suelto. Lo tratamos como respuesta final, pero marcamos
    // tagged=false para que el loop pueda desconfiar si se esperaba una edición (#1).
    return { kind: 'final', text, tagged: false }
  }

  const kind = tagMatch[1].toLowerCase() as ParsedAction['kind']
  const after = text.slice((tagMatch.index ?? 0) + tagMatch[0].length).trim()

  if (kind === 'write') {
    const code = extractFirstCodeBlock(after) ?? extractFirstCodeBlock(text) ?? ''
    const note = after.split('```')[0].trim()
    return { kind: 'write', code, note: note || undefined, tagged: true }
  }

  if (kind === 'run' || kind === 'strip-comments' || kind === 'format') {
    return { kind, tagged: true }
  }

  return { kind: 'final', text: after || text, tagged: true }
}

function summarizeOutput(result: AgentRunResult): string {
  if (result.hasError) return 'execution error'
  const lines = result.output.split('\n').filter((l) => l.trim()).length
  return lines > 0 ? `${lines} line${lines === 1 ? '' : 's'} of output` : 'no errors'
}

export async function runAgent(userMessage: string, deps: AgentDeps): Promise<void> {
  const { generate, bridge, ui } = deps
  const maxSteps = deps.maxSteps ?? 8
  const language = bridge.language?.() ?? 'javascript'
  const editIntent = isEditIntent(userMessage)

  // Fast-path determinista (#3): para transformaciones mecánicas puras NO dependemos
  // del modelo (que enruta de forma poco fiable): las hace el propio harness.
  const deterministic = detectDeterministicIntent(userMessage)
  if (deterministic === 'strip-comments') {
    const oldCode = bridge.getCode()
    const newCode = stripComments(oldCode)
    const diff = computeLineDiff(oldCode, newCode)
    ui.clearStatus()
    if (diff.removed === 0 && diff.added === 0) {
      ui.finalAnswer('The code has no comments to remove.')
      return
    }
    bridge.setCode(newCode)
    ui.edit({ added: diff.added, removed: diff.removed, note: 'Removed comments', lines: diff.lines })
    ui.finalAnswer(`Removed all comments (−${diff.removed} ${diff.removed === 1 ? 'line' : 'lines'}).`)
    return
  }
  if (deterministic === 'format' && bridge.format) {
    const oldCode = bridge.getCode()
    ui.status('Formatting the code…')
    let newCode = oldCode
    try {
      newCode = await bridge.format(oldCode)
    } catch {
      newCode = oldCode
    }
    const diff = computeLineDiff(oldCode, newCode)
    ui.clearStatus()
    if (diff.removed === 0 && diff.added === 0) {
      ui.finalAnswer('The code is already properly formatted.')
      return
    }
    bridge.setCode(newCode)
    ui.edit({ added: diff.added, removed: diff.removed, note: 'Formatted with Prettier', lines: diff.lines })
    ui.finalAnswer(`Formatted the code (+${diff.added} −${diff.removed}).`)
    return
  }

  // Log breve de lo hecho, en vez de acumular el fichero completo cada turno (#4).
  const transcript: string[] = []
  let didEdit = false
  let noChangeWrites = 0
  let previousErrorOutput: string | null = null
  let editIntentNudged = false

  // Aplica una edición (write / strip-comments / format) al editor y actualiza el
  // estado. Devuelve true si hubo cambios reales; false si el código quedó igual.
  const applyEdit = (newCode: string, note?: string): boolean => {
    const oldCode = bridge.getCode()
    const diff = computeLineDiff(oldCode, newCode)
    if (diff.added === 0 && diff.removed === 0) return false
    ui.status('Editing the code…')
    bridge.setCode(newCode)
    didEdit = true
    noChangeWrites = 0
    ui.edit({ added: diff.added, removed: diff.removed, note, lines: diff.lines })
    transcript.push(`- Applied an edit (+${diff.added} -${diff.removed}). The editor now holds the updated code shown above.`)
    return true
  }

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    ui.status(stepIndex === 0 ? 'Planning next moves…' : didEdit ? 'Reviewing the result…' : 'Thinking…')

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(language) },
      { role: 'user', content: buildTurnPrompt(userMessage, bridge.getCode(), language, transcript) },
    ]

    let raw = ''
    try {
      raw = await generate(messages)
    } catch (error) {
      ui.clearStatus()
      ui.finalAnswer(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const action = parseAction(raw)

    if (action.kind === 'final') {
      // #1 + #2: el usuario pidió cambiar el código pero el modelo "termina" sin
      // haber editado nada (a veces sin ni siquiera la etiqueta <action>). No nos
      // fiamos: le damos un aviso estricto y una segunda oportunidad de actuar.
      if (editIntent && !didEdit && !editIntentNudged) {
        editIntentNudged = true
        transcript.push(
          '- You replied as if finished, but you have NOT edited the code yet. The request requires changing it. ' +
            'Do it now: emit <action>write</action> (full file), or <action>strip-comments</action> / <action>format</action> if that matches. ' +
            'Do NOT claim it is done without an edit.',
        )
        continue
      }

      ui.clearStatus()
      // Si tras el aviso sigue sin tocar el código, decimos la verdad en lugar de
      // repetir una afirmación (posiblemente falsa) de que ya está hecho.
      if (editIntent && !didEdit) {
        ui.finalAnswer(
          "I didn't change the code — it may already be the way you want, or I wasn't able to make the change. Give me a bit more detail and I'll try again.",
        )
        return
      }
      ui.finalAnswer(action.text?.trim() || '(done)')
      return
    }

    if (action.kind === 'strip-comments') {
      const newCode = stripComments(bridge.getCode())
      if (!applyEdit(newCode, 'Removed comments')) {
        transcript.push('- There were no comments to remove; the code is unchanged.')
      }
      continue
    }

    if (action.kind === 'format') {
      if (!bridge.format) {
        transcript.push('- Formatting is not available here; change the code with <action>write</action> instead.')
        continue
      }
      ui.status('Formatting the code…')
      let formatted = bridge.getCode()
      try {
        formatted = await bridge.format(bridge.getCode())
      } catch {
        transcript.push('- Formatting failed; leave the code as it is or edit it with <action>write</action>.')
        continue
      }
      if (!applyEdit(formatted, 'Formatted with Prettier')) {
        transcript.push('- The code was already properly formatted; nothing changed.')
      }
      continue
    }

    if (action.kind === 'write') {
      const newCode = action.code ?? ''
      if (!newCode.trim()) {
        transcript.push(
          '- Your "write" action had no fenced code block. Output the full updated code inside a ``` block, or use <action>final</action>.',
        )
        continue
      }

      // Sin cambios reales: evita quedarse en bucle reescribiendo lo mismo.
      if (!applyEdit(newCode, action.note)) {
        noChangeWrites++
        if (noChangeWrites >= 2) {
          ui.clearStatus()
          ui.finalAnswer('The code is already as it should be; there are no more changes to apply.')
          return
        }
        transcript.push('- That write produced no changes (identical code). If the task is done, reply with <action>final</action>.')
        continue
      }
      continue
    }

    if (action.kind === 'run') {
      ui.status('Running the code…')
      const handle = ui.run()
      let result: AgentRunResult
      try {
        result = await bridge.run()
      } catch (error) {
        result = { output: error instanceof Error ? error.message : String(error), hasError: true }
      }
      handle.update(summarizeOutput(result), result.hasError ? 'error' : 'ok')

      const observation = result.output.trim() || '(sin salida en consola)'

      // Si el mismo error se repite, no seguimos intentando (anti-bucle).
      if (result.hasError && previousErrorOutput !== null && observation === previousErrorOutput) {
        ui.clearStatus()
        ui.finalAnswer(
          `I could not fix the error automatically:\n\n\`\`\`\n${observation.slice(0, 500)}\n\`\`\`\n\nTake a look or give me more details.`,
        )
        return
      }
      previousErrorOutput = result.hasError ? observation : null

      const truncated = observation.length > 800 ? `${observation.slice(0, 800)}\n…(truncated)` : observation
      transcript.push(
        `- Ran the code. Console output:\n\`\`\`\n${truncated}\n\`\`\`\n${
          result.hasError
            ? '  There is an UNCAUGHT execution error. Fix it with <action>write</action> (full file), then run again. If you cannot, reply <action>final</action> explaining why.'
            : '  It ran without uncaught errors. Reply with <action>final</action> summarizing what you did.'
        }`,
      )
      continue
    }
  }

  ui.clearStatus()
  ui.finalAnswer(
    didEdit
      ? '_I reached the step limit. Check the current code and tell me if you want me to continue._'
      : '_I could not complete the task. Can you give me more details?_',
  )
}
