// modern-monaco registra un TokensProvider clásico que solo guarda el scope
// derivado del color. Monaco infiere StandardTokenType (comment/string/regex)
// de ese string, y el colorizador de brackets ignora los pares dentro de esos
// tipos. Si el scope no contiene "comment", los ()[]{} de un comentario se
// pintan igual que el código (issue #27).
//
// Tras init() envolvemos setTokensProvider y anotamos cada token con el tipo
// real, clasificando la línea con un escáner de JS/TS.

export type TokenKind = 'code' | 'comment' | 'string' | 'regexp'

export interface ScanState {
  kind: TokenKind
  // `template` = dentro de `...`; `expr` = dentro de ${...} de un template.
  context: 'code' | 'blockComment' | 'single' | 'double' | 'template' | 'regex' | 'expr'
  exprBraceDepth: number
  templateDepth: number
}

export interface ScopeToken {
  startIndex: number
  scopes: string
}

export const INITIAL_SCAN_STATE: ScanState = {
  kind: 'code',
  context: 'code',
  exprBraceDepth: 0,
  templateDepth: 0,
}

const JS_LIKE_LANGUAGES = new Set(['javascript', 'typescript', 'jsx', 'tsx', 'javascriptreact', 'typescriptreact'])

function cloneScanState(state: ScanState): ScanState {
  return {
    kind: state.kind,
    context: state.context,
    exprBraceDepth: state.exprBraceDepth,
    templateDepth: state.templateDepth,
  }
}

function scanStatesEqual(a: ScanState, b: ScanState): boolean {
  return (
    a.kind === b.kind &&
    a.context === b.context &&
    a.exprBraceDepth === b.exprBraceDepth &&
    a.templateDepth === b.templateDepth
  )
}

function kindFromContext(context: ScanState['context']): TokenKind {
  if (context === 'blockComment') return 'comment'
  if (context === 'single' || context === 'double' || context === 'template') return 'string'
  if (context === 'regex') return 'regexp'
  return 'code'
}

function isIdentOrNumberChar(char: string): boolean {
  return /[A-Za-z0-9_$)\]\.]/.test(char)
}

/**
 * Clasifica cada carácter de la línea. El estado de bloque (comentarios,
 * strings, templates) se arrastra entre líneas.
 */
export function classifyLine(line: string, start: ScanState): { kinds: TokenKind[]; endState: ScanState } {
  const kinds: TokenKind[] = new Array(line.length)
  const state = cloneScanState(start)
  let lastSignificant = ''

  const setRange = (from: number, to: number, kind: TokenKind) => {
    for (let i = from; i < to; i++) kinds[i] = kind
  }

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]

    if (state.context === 'blockComment') {
      kinds[i] = 'comment'
      if (char === '*' && next === '/') {
        kinds[i + 1] = 'comment'
        i += 1
        state.context = state.templateDepth > 0 ? 'expr' : 'code'
        state.kind = 'code'
      }
      continue
    }

    if (state.context === 'single' || state.context === 'double') {
      kinds[i] = 'string'
      if (char === '\\') {
        if (i + 1 < line.length) {
          kinds[i + 1] = 'string'
          i += 1
        }
        continue
      }
      const quote = state.context === 'single' ? "'" : '"'
      if (char === quote) {
        state.context = state.templateDepth > 0 ? 'expr' : 'code'
        state.kind = 'code'
      }
      continue
    }

    if (state.context === 'template') {
      kinds[i] = 'string'
      if (char === '\\') {
        if (i + 1 < line.length) {
          kinds[i + 1] = 'string'
          i += 1
        }
        continue
      }
      if (char === '`') {
        state.templateDepth -= 1
        state.context = state.templateDepth > 0 ? 'expr' : 'code'
        state.kind = 'code'
        continue
      }
      if (char === '$' && next === '{') {
        kinds[i + 1] = 'string'
        i += 1
        state.context = 'expr'
        state.exprBraceDepth = 0
        state.kind = 'code'
      }
      continue
    }

    if (state.context === 'regex') {
      kinds[i] = 'regexp'
      if (char === '\\') {
        if (i + 1 < line.length) {
          kinds[i + 1] = 'regexp'
          i += 1
        }
        continue
      }
      if (char === '[') {
        // Clase de caracteres: avanzamos hasta el ] sin cerrar el regex.
        let j = i + 1
        while (j < line.length) {
          kinds[j] = 'regexp'
          if (line[j] === '\\' && j + 1 < line.length) {
            kinds[j + 1] = 'regexp'
            j += 2
            continue
          }
          if (line[j] === ']') break
          j += 1
        }
        i = Math.min(j, line.length - 1)
        continue
      }
      if (char === '/') {
        state.context = state.templateDepth > 0 ? 'expr' : 'code'
        state.kind = 'code'
      }
      continue
    }

    // code / expr
    if (char === '/' && next === '/') {
      setRange(i, line.length, 'comment')
      break
    }

    if (char === '/' && next === '*') {
      kinds[i] = 'comment'
      kinds[i + 1] = 'comment'
      i += 1
      state.context = 'blockComment'
      state.kind = 'comment'
      continue
    }

    if (char === "'" || char === '"') {
      kinds[i] = 'string'
      state.context = char === "'" ? 'single' : 'double'
      state.kind = 'string'
      continue
    }

    if (char === '`') {
      kinds[i] = 'string'
      state.templateDepth += 1
      state.context = 'template'
      state.kind = 'string'
      continue
    }

    if (char === '/' && !isIdentOrNumberChar(lastSignificant)) {
      kinds[i] = 'regexp'
      state.context = 'regex'
      state.kind = 'regexp'
      continue
    }

    if (state.context === 'expr') {
      if (char === '{') state.exprBraceDepth += 1
      if (char === '}') {
        if (state.exprBraceDepth === 0) {
          kinds[i] = 'string'
          state.context = 'template'
          state.kind = 'string'
          continue
        }
        state.exprBraceDepth -= 1
      }
    }

    kinds[i] = 'code'
    if (!/\s/.test(char)) lastSignificant = char
  }

  if (state.context === 'single' || state.context === 'double' || state.context === 'regex') {
    // Strings y regex de una línea no se arrastran (ASI / línea nueva).
    state.context = state.templateDepth > 0 ? 'expr' : 'code'
    state.kind = 'code'
  }

  state.kind = kindFromContext(state.context)
  return { kinds, endState: state }
}

function scopeForKind(kind: TokenKind): string {
  if (kind === 'comment') return 'comment'
  if (kind === 'string') return 'string'
  if (kind === 'regexp') return 'regexp'
  return ''
}

function withKindScope(scopes: string, kind: TokenKind): string {
  const extra = scopeForKind(kind)
  if (!extra) return scopes
  // TokenTheme hace match por puntos (`comment.line`), no por espacios.
  // Si el scope que viene de Shiki ya nombra el tipo, lo dejamos; si no
  // (p. ej. el color se mapeó a `source.js`), usamos el tipo solo para
  // que el tema pinte comentario/string y el colorizador ignore brackets.
  if (new RegExp(`\\b${extra}\\b`).test(scopes)) return scopes
  return extra
}

/**
 * Anota (y parte si hace falta) los tokens de Monaco para que los que caen
 * dentro de comentarios/strings/regex lleven ese scope. Así el colorizador
 * de brackets los ignora.
 */
export function annotateTokens(
  line: string,
  tokens: ScopeToken[],
  start: ScanState,
): { tokens: ScopeToken[]; endState: ScanState } {
  const { kinds, endState } = classifyLine(line, start)
  if (tokens.length === 0) {
    return { tokens, endState }
  }

  const annotated: ScopeToken[] = []

  for (let i = 0; i < tokens.length; i++) {
    const startIndex = tokens[i].startIndex
    const endIndex = i + 1 < tokens.length ? tokens[i + 1].startIndex : line.length
    if (startIndex >= endIndex) {
      annotated.push(tokens[i])
      continue
    }

    let segmentStart = startIndex
    let segmentKind = kinds[startIndex] ?? 'code'

    for (let offset = startIndex + 1; offset <= endIndex; offset++) {
      const kind = offset < endIndex ? (kinds[offset] ?? 'code') : null
      if (kind === segmentKind) continue

      annotated.push({
        startIndex: segmentStart,
        scopes: withKindScope(tokens[i].scopes, segmentKind),
      })

      if (kind === null) break
      segmentStart = offset
      segmentKind = kind
    }
  }

  return { tokens: annotated, endState }
}

interface MonacoState {
  clone(): MonacoState
  equals(other: MonacoState): boolean
}

interface MonacoTokensProvider {
  getInitialState(): MonacoState
  tokenize(line: string, state: MonacoState): { tokens: ScopeToken[]; endState: MonacoState }
}

class CombinedTokenizerState implements MonacoState {
  constructor(
    readonly inner: MonacoState,
    readonly scan: ScanState,
  ) {}

  clone(): CombinedTokenizerState {
    const clonedInner = typeof this.inner.clone === 'function' ? this.inner.clone() : this.inner
    return new CombinedTokenizerState(clonedInner, cloneScanState(this.scan))
  }

  equals(other: MonacoState): boolean {
    if (!(other instanceof CombinedTokenizerState)) return false
    const innerEqual =
      typeof this.inner.equals === 'function' ? this.inner.equals(other.inner) : this.inner === other.inner
    return innerEqual && scanStatesEqual(this.scan, other.scan)
  }
}

function wrapTokensProvider(provider: MonacoTokensProvider): MonacoTokensProvider {
  return {
    getInitialState() {
      return new CombinedTokenizerState(provider.getInitialState(), cloneScanState(INITIAL_SCAN_STATE))
    },
    tokenize(line, state) {
      const combined = state instanceof CombinedTokenizerState ? state : new CombinedTokenizerState(state, cloneScanState(INITIAL_SCAN_STATE))
      const result = provider.tokenize(line, combined.inner)
      const annotated = annotateTokens(line, result.tokens ?? [], combined.scan)
      return {
        tokens: annotated.tokens,
        endState: new CombinedTokenizerState(result.endState, annotated.endState),
      }
    },
  }
}

/**
 * Envuelve `setTokensProvider` para JS/TS. Hay que llamarlo justo después de
 * `init()` y antes de crear modelos, porque el tokenizer se registra al
 * activar el lenguaje.
 */
export function patchBracketColorizationInComments(monaco: {
  languages: { setTokensProvider: (languageId: string, provider: MonacoTokensProvider) => unknown }
}): void {
  const original = monaco.languages.setTokensProvider.bind(monaco.languages)
  monaco.languages.setTokensProvider = (languageId: string, provider: MonacoTokensProvider) => {
    if (!JS_LIKE_LANGUAGES.has(languageId)) {
      return original(languageId, provider)
    }
    return original(languageId, wrapTokensProvider(provider))
  }
}
