import { describe, expect, it } from 'vitest'
import { injectExpressionLogging, lineMap } from './console'

describe('expression logging injection', () => {
  it('keeps automatic expression logging enabled by default', () => {
    const code = 'const value = 2\nvalue + 2'

    const transformedCode = injectExpressionLogging(code)

    expect(transformedCode).toContain('console.__logExpression__')
  })

  it('returns the original code and line map when disabled', () => {
    const code = 'const value = 2\nvalue + 2'

    const transformedCode = injectExpressionLogging(code, { enabled: false })

    expect(transformedCode).toBe(code)
    expect(lineMap.get(2)).toBe(1)
    expect(lineMap.get(3)).toBe(2)
  })
})
