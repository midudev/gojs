import { describe, expect, it } from 'vitest'
import {
  buildImportMap,
  collectBareSpecifiers,
  injectExpressionLogging,
  lineMap,
  resolveModuleSpecifier,
  transformImports,
  transpileToJs,
} from './console'

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

describe('collectBareSpecifiers', () => {
  it('collects bare npm specifiers from static and dynamic imports', () => {
    const code = [
      "import { z } from 'zod'",
      "import _ from 'lodash-es'",
      "import './local'",
      "import x from 'https://esm.sh/nanoid'",
      "const m = await import('dayjs')",
    ].join('\n')

    const specifiers = collectBareSpecifiers(code).sort()

    expect(specifiers).toEqual(['dayjs', 'lodash-es', 'zod'])
  })

  it('returns an empty array for code without bare imports or on parse errors', () => {
    expect(collectBareSpecifiers("import './a'\nconst n = 1")).toEqual([])
    expect(collectBareSpecifiers('const = = =')).toEqual([])
  })
})

describe('buildImportMap', () => {
  it('maps packages and their subpath prefixes to the ESM CDN', () => {
    expect(buildImportMap(['zod'])).toEqual({
      zod: 'https://esm.sh/zod',
      'zod/': 'https://esm.sh/zod/',
    })
  })

  it('uses the package root for subpath and scoped specifiers', () => {
    expect(buildImportMap(['lodash-es/fp'])).toEqual({
      'lodash-es/fp': 'https://esm.sh/lodash-es/fp',
      'lodash-es/': 'https://esm.sh/lodash-es/',
    })

    expect(buildImportMap(['@scope/pkg/sub'])).toEqual({
      '@scope/pkg/sub': 'https://esm.sh/@scope/pkg/sub',
      '@scope/pkg/': 'https://esm.sh/@scope/pkg/',
    })
  })
})

describe('transpileToJs', () => {
  it('strips TypeScript types while preserving line count', async () => {
    const ts = 'interface User { name: string }\nconst greet = (u: User): string => u.name\nexport {}'
    const js = await transpileToJs(ts)

    expect(js).not.toContain('interface')
    expect(js).not.toContain(': string')
    expect(js).toContain('const greet = (u) =>')
    expect(js.split('\n').length).toBe(ts.split('\n').length)
  })
})
