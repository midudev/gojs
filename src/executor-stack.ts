export const USER_CODE_SOURCE_URL = 'gojs-user-code.js'
export const WRAPPER_PROBE_SOURCE_URL = 'gojs-wrapper-probe.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function withSourceUrl(code: string, sourceUrl: string): string {
  return `${code}\n//# sourceURL=${sourceUrl}`
}

/**
 * Extracts a generated function line from V8, Gecko and JavaScriptCore stacks.
 * Giving Function/AsyncFunction bodies a sourceURL is essential in WebKit:
 * without it, WKWebView can emit `anonymous@` frames with no line information.
 */
export function extractGeneratedLine(stack: string, sourceUrl: string): number | null {
  const sourceFrame = new RegExp(`${escapeRegExp(sourceUrl)}:(\\d+):\\d+`)
  const sourceMatch = stack.match(sourceFrame)
  if (sourceMatch) return Number(sourceMatch[1])

  const lines = stack.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const chromeMatch = line.match(/<anonymous>:(\d+):\d+\)?$/)
    const firefoxMatch = line.match(/(?:eval|Function):(\d+):\d+/)
    const match = chromeMatch || firefoxMatch

    if (match && i > 0) return Number(match[1])
  }

  return null
}
