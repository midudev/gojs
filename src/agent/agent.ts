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
  /** true si la última ejecución produjo errores. */
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

export interface AgentStepHandle {
  update(detail: string, state?: 'ok' | 'error'): void
}

/** Callbacks de UI. Los implementa main.ts para pintar pasos y la respuesta final. */
export interface AgentUI {
  /** Pinta una tarjeta de paso (edición/ejecución) y devuelve un updater. */
  step(kind: 'edit' | 'run', title: string): AgentStepHandle
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
// Protocolo
// ---------------------------------------------------------------------------
//
// El modelo responde con UNA acción por turno. Usamos etiquetas + bloques de
// código (en vez de JSON con el código escapado, que los modelos pequeños rompen):
//
//   <action>write</action>       -> reescribe TODO el código (fenced block después)
//   <action>run</action>         -> ejecuta el código actual y observa la salida
//   <action>final</action>       -> termina; el texto es la respuesta al usuario
//
// Si no hay etiqueta <action>, se trata como respuesta final (chat normal). Así el
// modo es transparente: una pregunta simple se responde sin tocar el código.

function buildSystemPrompt(language: string): string {
  return `You are a coding AGENT embedded in a live ${language} playground. You can talk to the user AND directly control the code in the editor.

You work in a loop. On EACH turn you output EXACTLY ONE action, using this format:

1) To CHANGE the code (fix a bug, add a feature, inject, delete or modify anything), rewrite the WHOLE file:
<action>write</action>
\`\`\`${language}
<the complete, updated code — not a diff, the full file>
\`\`\`

2) To EXECUTE the current code and see the console output / errors:
<action>run</action>

3) To FINISH and reply to the user (also for pure questions/explanations that need no code change):
<action>final</action>
<your message to the user, in Markdown>

Rules:
- Decide from the user's request whether to just answer or to act. If they ask a question ("why does this fail?", "explain X"), use <action>final</action> with the explanation. If they ask you to fix/change/build something, use <action>write</action> then <action>run</action> to verify.
- After a "run", read the console output. If there are errors or the result is wrong, issue another <action>write</action> with the corrected full code, then run again. Iterate until it works.
- With "write" you ALWAYS output the entire file, never a fragment or a diff.
- Keep going autonomously; do not ask the user for confirmation mid-task. Only stop with <action>final</action>.
- Match the user's language in your final message.
- Do not wrap the action tag in extra prose. Optionally add a short one-line note between the tag and the code block.`
}

function buildUserPrompt(userMessage: string, code: string, language: string): string {
  const codeBlock = code.trim() ? `\`\`\`${language}\n${code}\n\`\`\`` : '(the editor is empty)'
  return `The code currently in the editor is:\n${codeBlock}\n\nUser request: ${userMessage}`
}

/** Elimina los bloques de razonamiento <think>…</think> que emiten algunos modelos. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/** Extrae el primer bloque de código fenced (```lang\n…```). */
function extractFirstCodeBlock(text: string): string | null {
  const match = text.match(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/)
  if (!match) return null
  return match[1].replace(/\r?\n$/, '')
}

export function parseAction(raw: string): ParsedAction {
  const text = stripThink(raw)
  const tagMatch = text.match(/<action>\s*(write|run|final)\s*<\/action>/i)

  // Sin etiqueta de acción -> es una respuesta de chat normal (modo transparente).
  if (!tagMatch) {
    return { kind: 'final', text: text }
  }

  const kind = tagMatch[1].toLowerCase() as 'write' | 'run' | 'final'
  const after = text.slice((tagMatch.index ?? 0) + tagMatch[0].length).trim()

  if (kind === 'write') {
    const code = extractFirstCodeBlock(after) ?? extractFirstCodeBlock(text) ?? ''
    // Nota opcional: texto entre la etiqueta y el bloque de código.
    const note = after.split('```')[0].trim()
    return { kind: 'write', code, note: note || undefined }
  }

  if (kind === 'run') {
    return { kind: 'run' }
  }

  // final: el texto tras la etiqueta (o todo si no hay nada después).
  return { kind: 'final', text: after || text }
}

/** Resumen corto de la salida de consola para la tarjeta del paso. */
function summarizeOutput(result: AgentRunResult): string {
  if (result.hasError) return 'finished with errors'
  const lines = result.output.split('\n').filter((l) => l.trim()).length
  return lines > 0 ? `${lines} line${lines === 1 ? '' : 's'} of output` : 'ran with no output'
}

export async function runAgent(userMessage: string, deps: AgentDeps): Promise<void> {
  const { generate, bridge, ui } = deps
  const maxSteps = deps.maxSteps ?? 6
  const language = bridge.language?.() ?? 'javascript'

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(language) },
    { role: 'user', content: buildUserPrompt(userMessage, bridge.getCode(), language) },
  ]

  let didEdit = false

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    ui.status(stepIndex === 0 ? 'Thinking…' : 'Working…')

    let raw = ''
    try {
      raw = await generate(messages)
    } catch (error) {
      ui.clearStatus()
      ui.finalAnswer(`⚠️ ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    ui.clearStatus()

    const action = parseAction(raw)
    messages.push({ role: 'assistant', content: raw })

    if (action.kind === 'final') {
      ui.finalAnswer(action.text?.trim() || '(done)')
      return
    }

    if (action.kind === 'write') {
      const code = action.code ?? ''
      if (!code.trim()) {
        messages.push({
          role: 'user',
          content:
            'Your "write" action had no fenced code block. Output the full updated code inside a ``` block, or use <action>final</action>.',
        })
        continue
      }

      bridge.setCode(code)
      didEdit = true
      const handle = ui.step('edit', action.note || 'Updated the code')
      handle.update(`${code.split('\n').length} lines`, 'ok')

      messages.push({
        role: 'user',
        content: `Applied. The editor now contains exactly:\n\`\`\`${language}\n${code}\n\`\`\`\nRun it with <action>run</action> to verify, or finish with <action>final</action>.`,
      })
      continue
    }

    if (action.kind === 'run') {
      const handle = ui.step('run', 'Running the code')
      let result: AgentRunResult
      try {
        result = await bridge.run()
      } catch (error) {
        result = { output: error instanceof Error ? error.message : String(error), hasError: true }
      }
      handle.update(summarizeOutput(result), result.hasError ? 'error' : 'ok')

      const observation = result.output.trim() || '(no console output)'
      messages.push({
        role: 'user',
        content: `Console output after running:\n\`\`\`\n${observation}\n\`\`\`\n${
          result.hasError
            ? 'There are errors. Fix them with another <action>write</action> (full file), then run again.'
            : 'If this is correct, reply with <action>final</action> summarizing what you did. Otherwise keep improving.'
        }`,
      })
      continue
    }
  }

  // Se alcanzó el límite de pasos.
  ui.finalAnswer(
    didEdit
      ? '_He alcanzado el límite de pasos. Revisa el código actual y dime si quieres que siga._'
      : '_He alcanzado el límite de pasos sin completar la tarea. ¿Puedes darme más detalles?_',
  )
}
