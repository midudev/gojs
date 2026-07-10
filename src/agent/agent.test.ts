import { describe, expect, it } from 'vitest'
import {
  detectDeterministicIntent,
  isEditIntent,
  parseAction,
  runAgent,
  stripComments,
  type AgentBridge,
  type AgentRunResult,
  type AgentUI,
} from './agent'
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

  it('parses the deterministic strip-comments and format actions', () => {
    expect(parseAction('<action>strip-comments</action>').kind).toBe('strip-comments')
    expect(parseAction('<action>format</action>').kind).toBe('format')
  })

  it('flags whether the <action> tag was explicit', () => {
    expect(parseAction('<action>final</action>\nhi').tagged).toBe(true)
    expect(parseAction('just some prose, no tag').tagged).toBe(false)
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

  bridge.format = async (code: string) => code.replace(/;+/g, ';').replace(/\s+$/gm, '')

  const finals: string[] = []
  const ui: AgentUI = {
    edit: (info) => events.push(`edit:+${info.added}-${info.removed}`),
    run: () => {
      events.push('step:run')
      return { update: (_detail, s) => events.push(`update:${s ?? ''}`) }
    },
    finalAnswer: (md) => {
      finals.push(md)
      events.push(`final:${md.slice(0, 20)}`)
    },
    status: () => {},
    clearStatus: () => {},
  }

  return { state, events, finals, bridge, ui }
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

  it('#1: does not trust a no-tag "done" on an edit request — nudges, then the agent acts', async () => {
    const { state, events, bridge, ui } = makeHarness('const x = 1')
    const scripted = [
      // El modelo parlotea sin etiqueta y afirma que ya está hecho.
      "It's already correct, nothing to change.",
      // Tras el aviso estricto, edita de verdad.
      '<action>write</action>\n```js\nconst x = 2\n```',
      '<action>final</action>\nArreglado.',
    ]
    let turn = 0
    const generate = async () => scripted[turn++]

    await runAgent('arregla el bug del codigo', { generate, bridge, ui, maxSteps: 6 })

    expect(events).toContain('setCode')
    expect(state.code).toBe('const x = 2')
    expect(events.some((e) => e.startsWith('final:'))).toBe(true)
  })

  it('#2: if an edit request ends with no edit at all, it says so honestly instead of faking success', async () => {
    const { events, finals, bridge, ui } = makeHarness('const x = 1')
    // El modelo insiste en que está hecho sin editar nunca.
    const generate = async () => 'Done, it already works.'

    await runAgent('arregla el bug del codigo', { generate, bridge, ui, maxSteps: 6 })

    expect(events).not.toContain('setCode')
    expect(finals.at(-1)).toMatch(/didn't change the code/i)
  })

  it('fast-path: "quita los comentarios" strips them without ever calling the model', async () => {
    const { state, events, bridge, ui } = makeHarness("// top\nconst u = 'http://x' // trailing\nconst y = 2")
    let called = 0
    const generate = async () => {
      called++
      return '<action>final</action>\nnope'
    }

    await runAgent('quita los comentarios del codigo', { generate, bridge, ui })

    expect(called).toBe(0) // el modelo no interviene
    expect(events).toContain('setCode')
    expect(state.code).not.toMatch(/\/\/ top|\/\/ trailing/)
    expect(state.code).toContain("'http://x'")
  })

  it('fast-path: reports honestly when there are no comments to remove', async () => {
    const { events, finals, bridge, ui } = makeHarness('const x = 1')
    const generate = async () => '<action>final</action>\nnope'

    await runAgent('quita los comentarios', { generate, bridge, ui })

    expect(events).not.toContain('setCode')
    expect(finals.at(-1)).toMatch(/no comments to remove/i)
  })

  it('fast-path: does NOT trigger when the request mixes other work (falls through to the model)', async () => {
    const { state, events, bridge, ui } = makeHarness('// c\nconst x = 1')
    const scripted = ['<action>write</action>\n```js\nconst x = 1\nfunction f() {}\n```', '<action>final</action>\nHecho.']
    let turn = 0
    const generate = async () => scripted[turn++]

    await runAgent('quita los comentarios y añade una función', { generate, bridge, ui, maxSteps: 4 })

    // Pasó por el modelo (aplicó su write), no por el fast-path determinista.
    expect(events).toContain('setCode')
    expect(state.code).toContain('function f()')
  })

  it('#3: strip-comments verb is executed deterministically by the harness', async () => {
    const { state, events, bridge, ui } = makeHarness("// top\nconst u = 'http://x' // trailing\nconst y = 2")
    const scripted = ['<action>strip-comments</action>', '<action>final</action>\nHecho.']
    let turn = 0
    const generate = async () => scripted[turn++]

    await runAgent('quita los comentarios', { generate, bridge, ui, maxSteps: 4 })

    expect(events).toContain('setCode')
    expect(state.code).not.toMatch(/\/\/ top|\/\/ trailing/)
    // No debe romper el string que contiene "//".
    expect(state.code).toContain("'http://x'")
  })

  it('#3: format verb runs the harness formatter', async () => {
    const { state, events, bridge, ui } = makeHarness('const x = 1;;;   ')
    const scripted = ['<action>format</action>', '<action>final</action>\nFormateado.']
    let turn = 0
    const generate = async () => scripted[turn++]

    await runAgent('formatea el codigo', { generate, bridge, ui, maxSteps: 4 })

    expect(events).toContain('setCode')
    expect(state.code).toBe('const x = 1;')
  })
})

describe('stripComments', () => {
  it('removes line and block comments but keeps code', () => {
    const src = "// Bienvenido a XJS!\nconsole.log('hi'); // inline\n/* block\n comment */\nconst x = 2"
    const out = stripComments(src)
    expect(out).not.toMatch(/Bienvenido|inline|block|comment/)
    expect(out).toContain("console.log('hi');")
    expect(out).toContain('const x = 2')
  })

  it('does not touch // or /* */ inside strings, templates or regex', () => {
    const src = "const u = 'http://x'\nconst t = `a // b`\nconst r = /a\\/b/\nconst d = \"/* not a comment */\""
    const out = stripComments(src)
    expect(out).toContain("'http://x'")
    expect(out).toContain('`a // b`')
    expect(out).toContain('/a\\/b/')
    expect(out).toContain('"/* not a comment */"')
  })

  it('returns identical code when there are no comments', () => {
    const src = "console.log('no comments here')\nconst x = 1"
    expect(stripComments(src)).toBe(src)
  })
})

describe('isEditIntent', () => {
  it('detects imperative edit requests (ES + EN)', () => {
    for (const m of ['quita los comentarios', 'elimina esto', 'arregla el error', 'fix the bug', 'format the code', 'refactoriza']) {
      expect(isEditIntent(m)).toBe(true)
    }
  })

  it('does not flag plain questions', () => {
    for (const m of ['why does it print 1?', '¿qué hace este código?', 'explain this loop']) {
      expect(isEditIntent(m)).toBe(false)
    }
  })
})

describe('detectDeterministicIntent', () => {
  it('detects pure comment-removal requests', () => {
    for (const m of ['quita los comentarios', 'elimina los comentarios del codigo', 'remove all comments', 'código sin comentarios']) {
      expect(detectDeterministicIntent(m)).toBe('strip-comments')
    }
  })

  it('detects pure format requests', () => {
    for (const m of ['formatea el codigo', 'format this', 'prettify the file']) {
      expect(detectDeterministicIntent(m)).toBe('format')
    }
  })

  it('returns null when the request mixes extra work or is a question', () => {
    expect(detectDeterministicIntent('quita los comentarios y añade tipos')).toBeNull()
    expect(detectDeterministicIntent('refactoriza y formatea')).toBeNull()
    expect(detectDeterministicIntent('¿por qué hay tantos comentarios?')).toBeNull()
    expect(detectDeterministicIntent('arregla el bug')).toBeNull()
  })
})
