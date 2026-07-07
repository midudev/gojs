import { describe, expect, it } from 'vitest'
import { computeLineDiff, parseAction, runAgent, type AgentBridge, type AgentRunResult, type AgentUI } from './agent'

describe('computeLineDiff', () => {
  it('counts added and removed lines', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nB\nc\nd')
    expect(diff.removed).toBe(1) // b
    expect(diff.added).toBe(2) // B, d
  })

  it('reports no changes for identical code', () => {
    const diff = computeLineDiff('a\nb', 'a\nb')
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })
})
import type { ChatMessage } from '../chatbot'

describe('parseAction', () => {
  it('treats plain prose (no action tag) as a final chat answer', () => {
    const action = parseAction('This code logs 4 because x is 4.')
    expect(action.kind).toBe('final')
    expect(action.text).toContain('logs 4')
  })

  it('parses a write action and extracts the full code block', () => {
    const raw = '<action>write</action>\nHere is the fix:\n```js\nconst x = 5\nconsole.log(x)\n```'
    const action = parseAction(raw)
    expect(action.kind).toBe('write')
    expect(action.code).toBe('const x = 5\nconsole.log(x)')
  })

  it('parses a run action', () => {
    expect(parseAction('<action>run</action>').kind).toBe('run')
  })

  it('parses a final action and keeps the message text', () => {
    const action = parseAction('<action>final</action>\nDone! I fixed the typo.')
    expect(action.kind).toBe('final')
    expect(action.text).toBe('Done! I fixed the typo.')
  })

  it('strips <think> blocks before parsing', () => {
    const raw = '<think>let me reason...</think><action>run</action>'
    expect(parseAction(raw).kind).toBe('run')
  })
})

// Bridge y UI de mentira para probar el loop de forma determinista.
function makeHarness(initialCode = '') {
  const state = { code: initialCode, runs: 0 }
  const events: string[] = []

  const bridge: AgentBridge = {
    getCode: () => state.code,
    setCode: (code) => {
      state.code = code
      events.push('setCode')
    },
    run: async (): Promise<AgentRunResult> => {
      state.runs += 1
      // El primer run falla, el segundo va bien: simula un ciclo de arreglo.
      const hasError = state.runs === 1
      events.push(hasError ? 'run:error' : 'run:ok')
      return { output: hasError ? 'ERROR: x is not defined (L1)' : '5 (L2)', hasError }
    },
    language: () => 'javascript',
  }

  const ui: AgentUI = {
    edit: (info) => events.push(`edit:+${info.added}-${info.removed}`),
    run: () => {
      events.push('step:run')
      return { update: (_detail, s) => events.push(`update:${s ?? ''}`) }
    },
    finalAnswer: (md) => events.push(`final:${md.slice(0, 20)}`),
    status: () => {},
    clearStatus: () => {},
  }

  return { state, events, bridge, ui }
}

describe('runAgent loop', () => {
  it('answers a question without touching the code (transparent mode)', async () => {
    const { events, bridge, ui } = makeHarness('console.log(1)')
    const generate = async () => 'It prints 1 because you log the literal 1.'

    await runAgent('why does it print 1?', { generate, bridge, ui })

    expect(events).not.toContain('setCode')
    expect(events.some((e) => e.startsWith('final:'))).toBe(true)
  })

  it('iterates write -> run -> fix -> run -> final until the code works', async () => {
    const { state, events, bridge, ui } = makeHarness('cosnt x = 5\nconsole.log(x)')

    const scripted: string[] = [
      '<action>write</action>\n```js\nconst x = 5\nconsole.log(x)\n```',
      '<action>run</action>',
      // tras el primer run (error) el agente reescribe (cambio distinto)
      '<action>write</action>\n```js\nconst x = 5\nconsole.log(x * 1)\n```',
      '<action>run</action>',
      '<action>final</action>\nArreglado el typo `cosnt` -> `const`.',
    ]
    let turn = 0
    const generate = async (_messages: ChatMessage[]) => scripted[turn++]

    await runAgent('arregla el error', { generate, bridge, ui, maxSteps: 8 })

    // Aplicó dos ediciones, ejecutó y terminó con una respuesta final.
    expect(events.filter((e) => e === 'setCode').length).toBe(2)
    expect(events.some((e) => e.startsWith('edit:'))).toBe(true)
    expect(events).toContain('run:error')
    expect(events).toContain('run:ok')
    expect(events.some((e) => e.startsWith('final:'))).toBe(true)
    expect(state.code).toBe('const x = 5\nconsole.log(x * 1)')
  })

  it('stops after maxSteps to avoid infinite loops', async () => {
    const { events, bridge, ui } = makeHarness()
    // El modelo siempre pide ejecutar, nunca termina.
    const generate = async () => '<action>run</action>'

    await runAgent('bucle', { generate, bridge, ui, maxSteps: 3 })

    expect(events.filter((e) => e === 'step:run').length).toBe(3)
    // Aún así cierra con un mensaje final (no cuelga).
    expect(events.some((e) => e.startsWith('final:'))).toBe(true)
  })
})
