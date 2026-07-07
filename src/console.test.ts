import { describe, expect, it } from 'vitest'
import { injectExpressionLogging, lineMap, resolveModuleSpecifier, transformImports } from './console'

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
    // El mapa de líneas es 1:1 con el código original. El desfase que introduce el
    // wrapper de AsyncFunction se calcula aparte en el worker (varía según el motor).
    expect(lineMap.get(1)).toBe(1)
    expect(lineMap.get(2)).toBe(2)
  })
})

describe('resolveModuleSpecifier', () => {
  it('maps bare npm specifiers to the ESM CDN', () => {
    expect(resolveModuleSpecifier('lodash')).toBe('https://esm.sh/lodash')
    expect(resolveModuleSpecifier('lodash/fp')).toBe('https://esm.sh/lodash/fp')
    expect(resolveModuleSpecifier('@scope/pkg')).toBe('https://esm.sh/@scope/pkg')
    expect(resolveModuleSpecifier('@scope/pkg/sub')).toBe('https://esm.sh/@scope/pkg/sub')
    expect(resolveModuleSpecifier('zod@3')).toBe('https://esm.sh/zod@3')
  })

  it('leaves absolute URLs, protocols and relative paths untouched', () => {
    expect(resolveModuleSpecifier('https://esm.sh/react')).toBe('https://esm.sh/react')
    expect(resolveModuleSpecifier('//esm.sh/react')).toBe('//esm.sh/react')
    expect(resolveModuleSpecifier('data:text/javascript,export default 1')).toBe(
      'data:text/javascript,export default 1',
    )
    expect(resolveModuleSpecifier('node:path')).toBe('node:path')
    expect(resolveModuleSpecifier('./local.js')).toBe('./local.js')
    expect(resolveModuleSpecifier('../up.js')).toBe('../up.js')
    expect(resolveModuleSpecifier('/root.js')).toBe('/root.js')
  })
})

describe('transformImports', () => {
  it('rewrites a bare named import to a dynamic import against the CDN', () => {
    const code = "import { z } from 'zod'\nconsole.log(z)"
    const transformed = transformImports(code)

    expect(transformed).toContain('await import("https://esm.sh/zod")')
    expect(transformed).toContain('const { z } =')
    // Se conserva el número de líneas del original.
    expect(transformed.split('\n').length).toBe(code.split('\n').length)
  })

  it('handles default imports of npm packages', () => {
    const transformed = transformImports("import _ from 'lodash'")

    expect(transformed).toContain('await import("https://esm.sh/lodash")')
    expect(transformed).toContain('default: _')
  })
})
