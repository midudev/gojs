// Genera `src/node-types.generated.ts` con la lista de ficheros .d.ts de
// @types/node. modern-monaco carga cada URL de `compilerOptions.types` como un
// fichero del programa, PERO no sigue las `/// <reference path=... />` de esos
// ficheros. El `index.d.ts` de @types/node es casi solo referencias, así que
// cargarlo suelto no trae las declaraciones `declare module "node:os"`, etc.
//
// Solución: enumerar aquí index.d.ts + todas sus referencias directas (que sí
// contienen las declaraciones de módulo y globals) y pasarlas todas a `types`.
// Los ficheros referidos no tienen referencias propias, así que un nivel basta.
//
// Regenerar tras actualizar @types/node:  pnpm types:node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'node_modules', '@types', 'node')

const version = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version
const index = readFileSync(join(PKG_DIR, 'index.d.ts'), 'utf8')

// Extraer las rutas de `/// <reference path="..." />`.
const refs = []
const re = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g
let m
while ((m = re.exec(index))) {
  refs.push(posix.normalize(m[1]))
}

// index.d.ts primero; luego sus referencias (deduplicadas, orden estable).
const files = ['index.d.ts', ...refs.filter((f, i) => refs.indexOf(f) === i)]

const out = `// AUTO-GENERADO por scripts/gen-node-types.mjs — NO EDITAR A MANO.
// Ficheros .d.ts de @types/node cargados en el LSP del editor para que los
// módulos \`node:*\` y los globals (process, Buffer, ...) tengan tipos.

export const NODE_TYPES_VERSION = '${version}'

export const NODE_TYPES_FILES: readonly string[] = ${JSON.stringify(files, null, 2)}
`

writeFileSync(join(ROOT, 'src', 'node-types.generated.ts'), out)
console.log(`Wrote src/node-types.generated.ts — @types/node@${version}, ${files.length} files`)
