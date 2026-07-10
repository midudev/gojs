import type { AppConfig, ModelRecord } from '@mlc-ai/web-llm'
import { WEBLLM_CHAT_MODEL_CANDIDATES } from './webllm-models.generated'

export const DEFAULT_CHATBOT_MODEL_ID = 'Qwen3.5-0.8B-q4f16_1-MLC'
export const CHROME_PROMPT_API_MODEL_ID = 'chrome-prompt-api'
// Selección "Auto": dejamos que la app decida el mejor modelo disponible.
export const AUTO_MODEL_ID = 'auto'

const CHAT_MODEL_ID_PATTERN = /^(Qwen)(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?B)-(.+)-MLC$/

type ParsedChatModelId = {
  familyName: string
  modelSize: string
  quantization: string
}

export type ChatModelPresentation = {
  level: 1 | 2 | 3 | 4
  name: 'Small' | 'Medium' | 'Smart' | 'Smarter'
  size: string
}

// Preferimos una sola variante por modelo: la más equilibrada para el navegador
// (q4f16 = rápida y ligera). Así evitamos duplicar cada modelo en fast/more precise.
const PREFERRED_QUANTIZATION_ORDER = ['q4f16', 'q4f32', 'q0f16', 'q0f32']

function getQuantizationRank(modelId: string): number {
  const quantization = parseChatModelId(modelId)?.quantization ?? ''
  const index = PREFERRED_QUANTIZATION_ORDER.findIndex((prefix) => quantization.startsWith(prefix))
  return index === -1 ? PREFERRED_QUANTIZATION_ORDER.length : index
}

export const AVAILABLE_CHAT_MODELS = (() => {
  // El snapshot generado ya viene filtrado a modelos LLM de la familia de chat.
  const candidates = WEBLLM_CHAT_MODEL_CANDIDATES

  // Nos quedamos con una única variante por nombre de modelo (p. ej. "Qwen 3.5 0.8B"),
  // eligiendo la cuantización preferida.
  const bestByDisplayName = new Map<string, ModelRecord>()
  for (const model of candidates) {
    const key = getChatModelDisplayName(model)
    const existing = bestByDisplayName.get(key)
    if (!existing || getQuantizationRank(model.model_id) < getQuantizationRank(existing.model_id)) {
      bestByDisplayName.set(key, model)
    }
  }

  return [...bestByDisplayName.values()].sort((left, right) => {
    const leftVram = left.vram_required_MB ?? Number.MAX_SAFE_INTEGER
    const rightVram = right.vram_required_MB ?? Number.MAX_SAFE_INTEGER

    if (leftVram !== rightVram) {
      return leftVram - rightVram
    }

    return left.model_id.localeCompare(right.model_id)
  })
})()

// prebuiltAppConfig solo contenía `model_list` y `cacheBackend`, ambos
// sobreescritos aquí, así que no necesitamos importar el runtime de web-llm.
export const CHATBOT_APP_CONFIG = {
  model_list: AVAILABLE_CHAT_MODELS,
  cacheBackend: 'indexeddb',
} satisfies AppConfig

export function isChromePromptApiModelId(modelId: string | null | undefined): boolean {
  return modelId === CHROME_PROMPT_API_MODEL_ID
}

export function isValidChatModelId(modelId: string): boolean {
  return isChromePromptApiModelId(modelId) || AVAILABLE_CHAT_MODELS.some((model) => model.model_id === modelId)
}

export function getChatModelRecord(modelId: string): ModelRecord | undefined {
  return AVAILABLE_CHAT_MODELS.find((model) => model.model_id === modelId)
}

function parseChatModelId(modelId: string): ParsedChatModelId | null {
  const match = modelId.match(CHAT_MODEL_ID_PATTERN)

  if (!match) return null

  const [, familyName, version, modelSize, quantization] = match

  return {
    familyName: `${familyName} ${version}`,
    modelSize,
    quantization,
  }
}

function getChatModelSizeLabel(modelId: string): string | null {
  const parsedModelId = parseChatModelId(modelId)
  const parameterCount = parsedModelId ? Number.parseFloat(parsedModelId.modelSize) : Number.NaN

  if (!Number.isFinite(parameterCount)) return null

  if (parameterCount < 1) return 'very lightweight'
  if (parameterCount < 3) return 'lightweight'
  if (parameterCount < 6) return 'balanced'

  return 'high quality'
}

export function getChatModelPresentation(model: ModelRecord): ChatModelPresentation {
  const parsedModelId = parseChatModelId(model.model_id)
  const parameterCount = parsedModelId ? Number.parseFloat(parsedModelId.modelSize) : Number.NaN
  const size =
    typeof model.vram_required_MB === 'number' ? `${(model.vram_required_MB / 1024).toFixed(1)} GB` : '—'

  if (!Number.isFinite(parameterCount) || parameterCount < 1) {
    return { level: 1, name: 'Small', size }
  }

  if (parameterCount < 3) {
    return { level: 2, name: 'Medium', size }
  }

  if (parameterCount < 6) {
    return { level: 3, name: 'Smart', size }
  }

  return { level: 4, name: 'Smarter', size }
}

export function getChatModelDisplayName(modelOrId: ModelRecord | string): string {
  const modelId = typeof modelOrId === 'string' ? modelOrId : modelOrId.model_id

  if (isChromePromptApiModelId(modelId)) {
    return 'Gemini'
  }

  const parsedModelId = parseChatModelId(modelId)

  if (!parsedModelId) {
    return modelId.replace(/-MLC$/, '').replace(/-/g, ' ')
  }

  return `${parsedModelId.familyName} ${parsedModelId.modelSize}`
}

export function getChatModelLabel(model: ModelRecord): string {
  const parts = [getChatModelDisplayName(model), getChatModelSizeLabel(model.model_id)]

  if (typeof model.vram_required_MB === 'number') {
    parts.push(`${(model.vram_required_MB / 1024).toFixed(1)} GB VRAM`)
  }

  if (model.low_resource_required) {
    parts.push('low resource')
  }

  return parts.filter(Boolean).join(' · ')
}

export function getChromePromptApiModelLabel(): string {
  return `${getChatModelDisplayName(CHROME_PROMPT_API_MODEL_ID)} · Prompt API · no download`
}

export function isAutoModelId(modelId: string | null | undefined): boolean {
  return modelId === AUTO_MODEL_ID
}

/**
 * Elige el mejor modelo WebLLM que probablemente pueda cargar este dispositivo,
 * usando la memoria disponible como aproximación (no hay API fiable de VRAM de GPU).
 * Es conservador a propósito: Auto debe cargar sin sustos.
 */
export function pickBestDownloadableModelId(): string {
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4
  // Presupuesto de VRAM estimado: la mitad de la memoria del dispositivo, con margen.
  const vramBudgetMb = deviceMemoryGb * 1024 * 0.5

  // AVAILABLE_CHAT_MODELS viene ordenado ascendente por VRAM: cogemos el mayor que quepa.
  let best = AVAILABLE_CHAT_MODELS[0]
  for (const model of AVAILABLE_CHAT_MODELS) {
    const vram = model.vram_required_MB ?? Number.MAX_SAFE_INTEGER
    if (vram <= vramBudgetMb) best = model
  }

  return best?.model_id ?? DEFAULT_CHATBOT_MODEL_ID
}

/**
 * Resuelve la selección "Auto" a un modelo concreto:
 * - Si el modelo del sistema (Chrome Prompt API) está disponible, ese (sin descarga).
 * - Si no, el mejor modelo descargable que estimamos que este equipo puede cargar.
 */
export function resolveAutoModelId(chromePromptApiAvailable: boolean): string {
  if (chromePromptApiAvailable) return CHROME_PROMPT_API_MODEL_ID
  return pickBestDownloadableModelId()
}
