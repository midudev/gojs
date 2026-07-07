import type { ChatMessage } from '../chatbot'

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
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  /** Número de línea en el archivo antiguo (para 'del' y 'ctx'). */
  oldLine?: number
  /** Número de línea en el archivo nuevo (para 'add' y 'ctx'). */
  newLine?: number
}

export interface CodeDiff {
  added: number
  removed: number
  lines: DiffLine[]
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
  kind: 'write' | 'run' | 'final'
  code?: string
  note?: string
  text?: string
}

// ---------------------------------------------------------------------------
// Diff por líneas (LCS). Sirve para mostrar "+X −Y" y el diff coloreado.
// ---------------------------------------------------------------------------
export function computeLineDiff(oldCode: string, newCode: string): CodeDiff {
  const a = oldCode.length ? oldCode.split('\n') : []
  const b = newCode.length ? newCode.split('\n') : []
  const m = a.length
  const n = b.length

  // Tabla LCS (longitud de subsecuencia común) desde el final.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', text: a[i], oldLine: oldNo++, newLine: newNo++ })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i], oldLine: oldNo++ })
      i++
      removed++
    } else {
      lines.push({ type: 'add', text: b[j], newLine: newNo++ })
      j++
      added++
    }
  }
  while (i < m) {
    lines.push({ type: 'del', text: a[i], oldLine: oldNo++ })
    i++
    removed++
  }
  while (j < n) {
    lines.push({ type: 'add', text: b[j], newLine: newNo++ })
    j++
    added++
  }

  return { added, removed, lines }
}

// ---------------------------------------------------------------------------
// Protocolo (etiquetas + bloques de código; más fiable que JSON en modelos pequeños)
// ---------------------------------------------------------------------------
function buildSystemPrompt(language: string): string {
  return `You are a coding AGENT embedded in a live ${language} playground. You can talk to the user AND directly control the code in the editor.

You work in a loop. On EACH turn you output EXACTLY ONE action:

1) To CHANGE the code (fix a bug, add a feature, inject, delete or modify anything), rewrite the WHOLE file:
<action>write</action>
\`\`\`${language}
<the complete, updated code>
\`\`\`

2) To EXECUTE the current code and read the console output / errors:
<action>run</action>

3) To FINISH and reply to the user (also for pure questions/explanations that need no code change):
<action>final</action>
<your message to the user, in Markdown>

Rules:
- Decide from the request whether to answer or to act. Questions -> <action>final</action>. Fix/change requests -> <action>write</action> then <action>run</action>.
- IMPORTANT: console.log / console.warn / console.error are normal program OUTPUT, NOT errors. Only treat the run as failed if the output explicitly says the execution threw an uncaught error.
- After a run that succeeded (no uncaught error), reply with <action>final</action>. Do NOT keep rewriting working code.
- If you cannot fix a real error after one attempt, stop with <action>final</action> and explain it. Never loop.
- With "write" always output the entire file, never a diff.
- Keep going autonomously; do not ask for confirmation mid-task.
- Match the user's language in your final message.`
}

function buildUserPrompt(userMessage: string, code: string, language: string): string {
  const codeBlock = code.trim() ? `\`\`\`${language}\n${code}\n\`\`\`` : '(the editor is empty)'
  return `The code currently in the editor is:\n${codeBlock}\n\nUser request: ${userMessage}`
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
  const tagMatch = text.match(/<action>\s*(write|run|final)\s*<\/action>/i)

  if (!tagMatch) {
    return { kind: 'final', text: text }
  }

  const kind = tagMatch[1].toLowerCase() as 'write' | 'run' | 'final'
  const after = text.slice((tagMatch.index ?? 0) + tagMatch[0].length).trim()

  if (kind === 'write') {
    const code = extractFirstCodeBlock(after) ?? extractFirstCodeBlock(text) ?? ''
    const note = after.split('```')[0].trim()
    return { kind: 'write', code, note: note || undefined }
  }

  if (kind === 'run') {
    return { kind: 'run' }
  }

  return { kind: 'final', text: after || text }
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

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(language) },
    { role: 'user', content: buildUserPrompt(userMessage, bridge.getCode(), language) },
  ]

  let didEdit = false
  let noChangeWrites = 0
  let previousErrorOutput: string | null = null

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    ui.status(stepIndex === 0 ? 'Planning next moves…' : didEdit ? 'Reviewing the result…' : 'Thinking…')

    let raw = ''
    try {
      raw = await generate(messages)
    } catch (error) {
      ui.clearStatus()
      ui.finalAnswer(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const action = parseAction(raw)
    messages.push({ role: 'assistant', content: raw })

    if (action.kind === 'final') {
      ui.clearStatus()
      ui.finalAnswer(action.text?.trim() || '(done)')
      return
    }

    if (action.kind === 'write') {
      const newCode = action.code ?? ''
      if (!newCode.trim()) {
        messages.push({
          role: 'user',
          content:
            'Your "write" action had no fenced code block. Output the full updated code inside a ``` block, or use <action>final</action>.',
        })
        continue
      }

      const oldCode = bridge.getCode()
      const diff = computeLineDiff(oldCode, newCode)

      // Sin cambios reales: evita quedarse en bucle reescribiendo lo mismo.
      if (diff.added === 0 && diff.removed === 0) {
        noChangeWrites++
        if (noChangeWrites >= 2) {
          ui.finalAnswer('The code is already as it should be; there are no more changes to apply.')
          return
        }
        messages.push({
          role: 'user',
          content: 'That produced no changes (identical code). If the task is done, reply with <action>final</action>.',
        })
        continue
      }

      noChangeWrites = 0
      ui.status('Editing the code…')
      bridge.setCode(newCode)
      didEdit = true
      ui.edit({ added: diff.added, removed: diff.removed, note: action.note, lines: diff.lines })

      messages.push({
        role: 'user',
        content: `Applied (+${diff.added} -${diff.removed}). The editor now contains exactly:\n\`\`\`${language}\n${newCode}\n\`\`\`\nRun it with <action>run</action> to verify, or finish with <action>final</action>.`,
      })
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
        ui.finalAnswer(
          `I could not fix the error automatically:\n\n\`\`\`\n${observation.slice(0, 500)}\n\`\`\`\n\nTake a look or give me more details.`,
        )
        return
      }
      previousErrorOutput = result.hasError ? observation : null

      messages.push({
        role: 'user',
        content: `Console output after running:\n\`\`\`\n${observation}\n\`\`\`\n${
          result.hasError
            ? 'There is an UNCAUGHT execution error. Fix it with another <action>write</action> (full file), then run again. If you cannot, reply <action>final</action> explaining why.'
            : 'The code ran without uncaught errors. Reply with <action>final</action> summarizing what you did.'
        }`,
      })
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
