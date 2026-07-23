import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_CHAT_MODELS,
  getChatModelDisplayName,
  isFimCapableModelId,
} from './ai-models'

describe('AI model capabilities', () => {
  it('includes code-specialized WebLLM models in the generated catalog', () => {
    expect(AVAILABLE_CHAT_MODELS.some((model) => model.model_id.includes('Qwen2.5-Coder-1.5B'))).toBe(true)
  })

  it('recognizes FIM-capable coder models', () => {
    expect(isFimCapableModelId('Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC')).toBe(true)
    expect(isFimCapableModelId('Qwen3.5-2B-q4f16_1-MLC')).toBe(false)
  })

  it('formats coder model names without leaking quantization details', () => {
    expect(getChatModelDisplayName('Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC')).toBe(
      'Qwen 2.5 Coder 1.5B',
    )
  })
})
