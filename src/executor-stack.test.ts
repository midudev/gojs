import { describe, expect, it } from 'vitest'
import { extractGeneratedLine, USER_CODE_SOURCE_URL, withSourceUrl } from './executor-stack'

describe('extractGeneratedLine', () => {
  it('extracts the user line from a JavaScriptCore/WKWebView frame', () => {
    const stack = [
      'log@tauri://localhost/assets/executor-worker.js:49:19',
      `anonymous@${USER_CODE_SOURCE_URL}:8:11`,
    ].join('\n')

    expect(extractGeneratedLine(stack, USER_CODE_SOURCE_URL)).toBe(8)
  })

  it('extracts the user line from a V8 sourceURL frame', () => {
    const stack = [
      'Error',
      '    at Object.log (http://localhost/executor-worker.js:49:19)',
      `    at eval (${USER_CODE_SOURCE_URL}:5:9)`,
    ].join('\n')

    expect(extractGeneratedLine(stack, USER_CODE_SOURCE_URL)).toBe(5)
  })

  it('keeps support for legacy anonymous frames', () => {
    const stack = ['Error', '    at Object.log (worker.js:49:19)', '    at eval (<anonymous>:7:3)'].join('\n')

    expect(extractGeneratedLine(stack, USER_CODE_SOURCE_URL)).toBe(7)
  })

  it('returns null when the stack has no generated-code location', () => {
    expect(extractGeneratedLine('log@tauri://localhost/executor-worker.js:49:19', USER_CODE_SOURCE_URL)).toBeNull()
  })
})

describe('withSourceUrl', () => {
  it('names generated code without changing its existing line positions', () => {
    const code = 'console.log(1)\nconsole.log(2)'
    const namedCode = withSourceUrl(code, USER_CODE_SOURCE_URL)

    expect(namedCode.startsWith(code)).toBe(true)
    expect(namedCode.split('\n')[2]).toBe(`//# sourceURL=${USER_CODE_SOURCE_URL}`)
  })
})
