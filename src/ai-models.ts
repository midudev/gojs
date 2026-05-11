import { ModelType, prebuiltAppConfig, type AppConfig, type ModelRecord } from '@mlc-ai/web-llm'

export const DEFAULT_CHATBOT_MODEL_ID = 'Qwen3.5-0.8B-q4f16_1-MLC'
export const CHROME_PROMPT_API_MODEL_ID = 'chrome-prompt-api'

const MODERN_CHAT_MODEL_PREFIXES = ['Qwen3.5-']
const CHAT_MODEL_ID_PATTERN = /^(Qwen)(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?B)-(.+)-MLC$/

type ParsedChatModelId = {
  familyName: string
  modelSize: string
  quantization: string
}

export const AVAILABLE_CHAT_MODELS = [...prebuiltAppConfig.model_list]
  .filter(
    (model) =>
      (model.model_type ?? ModelType.LLM) === ModelType.LLM &&
      MODERN_CHAT_MODEL_PREFIXES.some((prefix) => model.model_id.startsWith(prefix)),
  )
  .sort((left, right) => {
    const leftVram = left.vram_required_MB ?? Number.MAX_SAFE_INTEGER
    const rightVram = right.vram_required_MB ?? Number.MAX_SAFE_INTEGER

    if (leftVram !== rightVram) {
      return leftVram - rightVram
    }

    return left.model_id.localeCompare(right.model_id)
  })

export const CHATBOT_APP_CONFIG = {
  ...prebuiltAppConfig,
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

function getChatModelPrecisionLabel(modelId: string): string | null {
  const quantization = parseChatModelId(modelId)?.quantization

  if (!quantization) return null
  if (quantization.startsWith('q4f16')) return 'fast'
  if (quantization.startsWith('q4f32')) return 'more precise'
  if (quantization.startsWith('q0f16')) return 'unquantized'
  if (quantization.startsWith('q0f32')) return 'unquantized, more precise'

  return quantization.replace(/_/g, ' ')
}

export function getChatModelDisplayName(modelOrId: ModelRecord | string): string {
  const modelId = typeof modelOrId === 'string' ? modelOrId : modelOrId.model_id

  if (isChromePromptApiModelId(modelId)) {
    return 'Chrome system model'
  }

  const parsedModelId = parseChatModelId(modelId)

  if (!parsedModelId) {
    return modelId.replace(/-MLC$/, '').replace(/-/g, ' ')
  }

  return `${parsedModelId.familyName} ${parsedModelId.modelSize}`
}

export function getChatModelLabel(model: ModelRecord): string {
  const parts = [
    getChatModelDisplayName(model),
    getChatModelSizeLabel(model.model_id),
    getChatModelPrecisionLabel(model.model_id),
  ]

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
