// Genera `src/webllm-models.generated.ts` con el catálogo mínimo de modelos de
// chat que la app ofrece (los Qwen3.5 tipo LLM de @mlc-ai/web-llm).
//
// Motivo: `@mlc-ai/web-llm` solo expone un único entry (`lib/index.js`) que
// mezcla los metadatos (`prebuiltAppConfig`) con TODO el runtime del motor
// (WASM, WebGPU, etc.). Importar `prebuiltAppConfig` en tiempo de ejecución
// arrastraba la librería entera (~8 MB) al chunk principal, aunque el motor
// solo se use al abrir la IA. Este snapshot deja los metadatos fuera del
// bundle de web-llm para poder cargar el runtime de forma perezosa.
//
// Regenerar tras actualizar @mlc-ai/web-llm:  pnpm types:webllm

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(ROOT, 'node_modules', '@mlc-ai', 'web-llm')

const version = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version

const { prebuiltAppConfig, ModelType } = await import('@mlc-ai/web-llm')

// Mismos prefijos que usa src/ai-models.ts para elegir la familia de chat.
const MODERN_CHAT_MODEL_PREFIXES = ['Qwen3.5-']

const candidates = prebuiltAppConfig.model_list.filter(
  (model) =>
    (model.model_type ?? ModelType.LLM) === ModelType.LLM &&
    MODERN_CHAT_MODEL_PREFIXES.some((prefix) => model.model_id.startsWith(prefix)),
)

const out = `// AUTO-GENERADO por scripts/gen-webllm-models.mjs — NO EDITAR A MANO.
// Snapshot de los metadatos de modelos de chat de @mlc-ai/web-llm para evitar
// importar el runtime completo del motor en el chunk principal.

import type { ModelRecord } from '@mlc-ai/web-llm'

export const WEBLLM_VERSION = '${version}'

// cacheBackend por defecto de prebuiltAppConfig (la app lo sobreescribe a 'indexeddb').
export const WEBLLM_DEFAULT_CACHE_BACKEND = ${JSON.stringify(prebuiltAppConfig.cacheBackend ?? 'cache')}

export const WEBLLM_CHAT_MODEL_CANDIDATES: readonly ModelRecord[] = ${JSON.stringify(candidates, null, 2)}
`

writeFileSync(join(ROOT, 'src', 'webllm-models.generated.ts'), out)
console.log(`Wrote src/webllm-models.generated.ts — @mlc-ai/web-llm@${version}, ${candidates.length} models`)
