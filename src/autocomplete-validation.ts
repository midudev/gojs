import { parse } from 'acorn'
import { transform } from 'sucrase'

function parseable(code: string, language: string): boolean {
  try {
    const javascript =
      language === 'typescript'
        ? transform(code, {
            transforms: ['typescript'],
            disableESTransforms: true,
          }).code
        : code
    parse(javascript, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    })
    return true
  } catch {
    return false
  }
}

function delimiterImbalance(code: string): number {
  const stack: string[] = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  let quote: string | null = null
  let escaped = false

  for (const character of code) {
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'" || character === '`') quote = character
    else if (character === '(' || character === '[' || character === '{') stack.push(character)
    else if (pairs[character]) {
      if (stack.at(-1) === pairs[character]) stack.pop()
      else stack.push(character)
    }
  }
  return stack.length + (quote ? 1 : 0)
}

export function rankCandidateIndices(
  code: string,
  cursorOffset: number,
  candidates: string[],
  language: string,
): number[] {
  const baselineParses = parseable(code, language)
  const baselineImbalance = delimiterImbalance(code)

  return candidates
    .map((candidate, index) => {
      const completedCode = `${code.slice(0, cursorOffset)}${candidate}${code.slice(cursorOffset)}`
      const candidateParses = parseable(completedCode, language)
      const syntaxScore = candidateParses ? (baselineParses ? 4 : 6) : baselineParses ? -20 : 0
      const balanceScore = baselineImbalance - delimiterImbalance(completedCode)
      return {
        index,
        score: syntaxScore + balanceScore - candidate.length / 2_000,
        accepted: !baselineParses || candidateParses,
      }
    })
    .filter((candidate) => candidate.accepted)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index }) => index)
}
