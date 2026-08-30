import { describe, expect, it } from 'vitest'
import {
  INITIAL_SCAN_STATE,
  annotateTokens,
  classifyLine,
  patchBracketColorizationInComments,
  type ScopeToken,
} from './bracket-tokens'

const wholeLine = (line: string): ScopeToken[] => [{ startIndex: 0, scopes: 'source.js' }]

const scopesAt = (line: string, tokens: ScopeToken[], index: number): string => {
  let current = tokens[0]
  for (const token of tokens) {
    if (token.startIndex <= index) current = token
    else break
  }
  return current.scopes
}

const kindAt = (line: string, index: number, start = INITIAL_SCAN_STATE) => {
  const { kinds } = classifyLine(line, start)
  return kinds[index]
}

describe('classifyLine', () => {
  it('marca un comentario de línea completo, incluidos los brackets', () => {
    const line = '// for (let i = 0; i < word.length; i++) {'
    const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)

    expect(kinds.every((kind) => kind === 'comment')).toBe(true)
    expect(kindAt(line, line.indexOf('('))).toBe('comment')
    expect(kindAt(line, line.indexOf('{'))).toBe('comment')
  })

  it('marca varios comentarios de línea seguidos (código comentado)', () => {
    const lines = [
      '// for (let i = 0; i < word.length; i++) {',
      '//   if (word[i] === char) {',
      '//     totalChar++',
      '//   }',
      '// }',
    ]

    for (const line of lines) {
      const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)
      expect(kinds.every((kind) => kind === 'comment')).toBe(true)
    }
  })

  it('no marca el código previo a un comentario de línea', () => {
    const line = 'const x = 1 // (hello)'
    const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)
    const commentStart = line.indexOf('//')

    expect(kinds.slice(0, commentStart).every((kind) => kind === 'code')).toBe(true)
    expect(kinds.slice(commentStart).every((kind) => kind === 'comment')).toBe(true)
  })

  it('arrastra un comentario de bloque entre líneas', () => {
    const first = classifyLine('const x = 1 /* {', INITIAL_SCAN_STATE)
    expect(first.kinds[first.kinds.length - 1]).toBe('comment')
    expect(first.endState.context).toBe('blockComment')

    const continued = '  (still comment) } */ const y = 2'
    const second = classifyLine(continued, first.endState)
    expect(kindAt(continued, continued.indexOf('('), first.endState)).toBe('comment')
    expect(kindAt(continued, continued.indexOf('const'), first.endState)).toBe('code')
    expect(second.endState.context).toBe('code')
  })

  it('marca strings y deja el código fuera', () => {
    const line = 'const s = "foo(bar)"'
    const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)
    const open = line.indexOf('"')
    const close = line.lastIndexOf('"')

    expect(kinds[open]).toBe('string')
    expect(kinds[open + 4]).toBe('string') // (
    expect(kinds[close]).toBe('string')
    expect(kinds[0]).toBe('code')
  })

  it('no trata una división como regex', () => {
    const line = 'const x = foo / bar'
    const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)
    expect(kinds[line.indexOf('/')]).toBe('code')
  })

  it('reconoce un regex al inicio de expresión', () => {
    const line = 'const x = /foo(bar)/'
    const { kinds } = classifyLine(line, INITIAL_SCAN_STATE)
    expect(kinds[line.indexOf('/')]).toBe('regexp')
    expect(kinds[line.indexOf('(')]).toBe('regexp')
  })
})

describe('annotateTokens', () => {
  it('añade el scope comment a un token que cubre una línea comentada', () => {
    const line = '// for (let i = 0; i < word.length; i++) {'
    const { tokens } = annotateTokens(line, wholeLine(line), INITIAL_SCAN_STATE)

    expect(tokens.length).toBe(1)
    expect(tokens[0].scopes).toBe('comment')
  })

  it('parte un token mixto para no manchar el código con comment', () => {
    const line = 'const x = 1 // (hello)'
    const { tokens } = annotateTokens(line, wholeLine(line), INITIAL_SCAN_STATE)

    expect(tokens.length).toBe(2)
    expect(scopesAt(line, tokens, 0)).not.toMatch(/\bcomment\b/)
    expect(scopesAt(line, tokens, line.indexOf('('))).toMatch(/\bcomment\b/)
  })

  it('no duplica el scope si el token ya era comment', () => {
    const line = '// hi'
    const { tokens } = annotateTokens(line, [{ startIndex: 0, scopes: 'comment.line' }], INITIAL_SCAN_STATE)
    expect(tokens[0].scopes).toBe('comment.line')
  })
})

describe('patchBracketColorizationInComments', () => {
  it('envuelve el provider de JS/TS y anota comentarios', () => {
    let registered: { tokenize: (line: string, state: any) => { tokens: ScopeToken[]; endState: any } } | null =
      null

    const monaco = {
      languages: {
        setTokensProvider(_id: string, provider: any) {
          registered = provider
        },
      },
    }

    patchBracketColorizationInComments(monaco)
    monaco.languages.setTokensProvider('typescript', {
      getInitialState: () => ({
        clone() {
          return this
        },
        equals() {
          return true
        },
      }),
      tokenize: (line: string) => ({
        tokens: [{ startIndex: 0, scopes: 'source.js' }],
        endState: {
          clone() {
            return this
          },
          equals() {
            return true
          },
        },
      }),
    })

    const initial = (registered as any).getInitialState()
    const result = registered!.tokenize('// (foo)', initial)
    expect(result.tokens[0].scopes).toBe('comment')
  })

  it('no envuelve lenguajes que no son JS/TS', () => {
    let registered: any = null
    const provider = { getInitialState() {}, tokenize() {} }
    const monaco = {
      languages: {
        setTokensProvider(_id: string, next: any) {
          registered = next
        },
      },
    }

    patchBracketColorizationInComments(monaco)
    monaco.languages.setTokensProvider('css', provider)
    expect(registered).toBe(provider)
  })
})
