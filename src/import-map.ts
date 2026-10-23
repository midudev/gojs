// CDN usado para resolver imports de paquetes npm (bare specifiers) a módulos ESM.
export const ESM_CDN_BASE = 'https://esm.sh/'

/**
 * Resuelve el specifier de un import a algo que `import()` pueda cargar en el navegador.
 *
 * - URLs absolutas (`https:`, `data:`, `blob:`, `node:`…), protocolo-relativas (`//`),
 *   rutas absolutas (`/`) y relativas (`./`, `../`) se dejan intactas.
 * - Los "bare specifiers" (paquetes npm: `lodash`, `lodash/fp`, `@scope/pkg`,
 *   `zod@3`…) se mapean al CDN ESM para que el import funcione dentro del worker,
 *   que no dispone de resolución de módulos de node.
 */
export function resolveModuleSpecifier(specifier: string): string {
  const value = specifier.trim()

  if (
    value === '' ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) || // esquema: https:, data:, blob:, node:, file:…
    value.startsWith('//') || // protocolo-relativo
    value.startsWith('/') || // ruta absoluta
    value.startsWith('./') ||
    value.startsWith('../')
  ) {
    return value
  }

  // Bare specifier -> paquete npm servido como ESM desde el CDN.
  return `${ESM_CDN_BASE}${value}`
}

/**
 * Devuelve la raíz del paquete de un bare specifier:
 *   'lodash-es'        -> 'lodash-es'
 *   'lodash-es/fp'     -> 'lodash-es'
 *   '@scope/pkg/sub'   -> '@scope/pkg'
 */
export function packageRootOf(specifier: string): string {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

/**
 * Construye un import map (formato WICG) que mapea cada paquete npm importado a su
 * URL en el CDN ESM, incluyendo la entrada con barra final para resolver subrutas.
 * Este mapa alimenta al LSP de modern-monaco para dar IntelliSense y carga de tipos.
 */
export function buildImportMap(specifiers: string[]): Record<string, string> {
  const imports: Record<string, string> = {}

  for (const specifier of specifiers) {
    imports[specifier] = resolveModuleSpecifier(specifier)

    const root = packageRootOf(specifier)
    imports[`${root}/`] = `${ESM_CDN_BASE}${root}/`
  }

  return imports
}
