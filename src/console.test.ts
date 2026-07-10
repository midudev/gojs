import { describe, expect, it } from 'vitest'
import {
  buildImportMap,
  collectBareSpecifiers,
  collectNodeBuiltinImports,
  injectExpressionLogging,
  isNodeBuiltinSpecifier,
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

  it('maps lines after an injected multiline expression to their original line', () => {
    const code = [
      'const url = "https://example.com"',
      'fetch(url)',
      '  .then(response => response.json())',
      '  .then(data => data)',
      'const result = 42',
      'console.log(result)',
    ].join('\n')

    const transformedCode = injectExpressionLogging(code)
    const transformedConsoleLine =
      transformedCode.split('\n').findIndex(line => line.includes('console.log(result)')) + 1

    expect(transformedConsoleLine).toBe(12)
    expect(lineMap.get(transformedConsoleLine)).toBe(6)
  })

  it('maps a console.log inside a multiline .then to its original line', () => {
    const code = [
      'const url = "https://example.com"', // 1
      'fetch(url)', // 2
      '  .then(response => response.json())', // 3
      '  .then(json => console.log(json))', // 4
    ].join('\n')

    const transformedCode = injectExpressionLogging(code)
    const consoleLine =
      transformedCode.split('\n').findIndex(line => line.includes('console.log(json)')) + 1

    // El console.log queda dentro de la IIFE inyectada, pero su línea debe mapear
    // a la línea original del `.then` (4), no a la línea del código instrumentado.
    expect(lineMap.get(consoleLine)).toBe(4)
  })

  it('maps every line of a multiline expression span to its original line', () => {
    const code = [
      'fetch(url)', // 1
      '  .then(response => response.json())', // 2
      '  .then(data => data)', // 3
    ].join('\n')

    injectExpressionLogging(code)

    // La plantilla inyectada queda así:
    //   1: ;(function() {
    //   2:       const __expr_result__ = fetch(url)     -> original 1
    //   3:   .then(response => response.json())          -> original 2
    //   4:   .then(data => data);                        -> original 3
    expect(lineMap.get(2)).toBe(1)
    expect(lineMap.get(3)).toBe(2)
    expect(lineMap.get(4)).toBe(3)
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

describe('isNodeBuiltinSpecifier', () => {
  it('flags node: prefixed specifiers', () => {
    expect(isNodeBuiltinSpecifier('node:os')).toBe(true)
    expect(isNodeBuiltinSpecifier('node:fs/promises')).toBe(true)
    // Cualquier prefijo node: cuenta aunque no reconozcamos el submódulo.
    expect(isNodeBuiltinSpecifier('node:whatever')).toBe(true)
  })

  it('flags bare core modules and their subpaths', () => {
    expect(isNodeBuiltinSpecifier('fs')).toBe(true)
    expect(isNodeBuiltinSpecifier('os')).toBe(true)
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true)
  })

  it('does not flag npm packages or URLs', () => {
    expect(isNodeBuiltinSpecifier('lodash')).toBe(false)
    expect(isNodeBuiltinSpecifier('zod')).toBe(false)
    expect(isNodeBuiltinSpecifier('https://esm.sh/react')).toBe(false)
  })
})

describe('collectNodeBuiltinImports', () => {
  it('collects node builtins from static and dynamic imports', () => {
    const code = [
      "import os from 'node:os'",
      "import { readFile } from 'fs/promises'",
      "const path = await import('node:path')",
      "import _ from 'lodash'",
    ].join('\n')

    const found = collectNodeBuiltinImports(code)

    expect(found).toEqual(expect.arrayContaining(['node:os', 'fs/promises', 'node:path']))
    expect(found).not.toContain('lodash')
  })

  it('returns an empty array when there are no node builtins', () => {
    expect(collectNodeBuiltinImports("import _ from 'lodash'\nconsole.log(_)")).toEqual([])
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
