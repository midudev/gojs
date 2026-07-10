// AUTO-GENERADO por scripts/gen-webllm-models.mjs — NO EDITAR A MANO.
// Snapshot de los metadatos de modelos de chat de @mlc-ai/web-llm para evitar
// importar el runtime completo del motor en el chunk principal.

import type { ModelRecord } from '@mlc-ai/web-llm'

export const WEBLLM_VERSION = '0.2.84'

// cacheBackend por defecto de prebuiltAppConfig (la app lo sobreescribe a 'indexeddb').
export const WEBLLM_DEFAULT_CACHE_BACKEND = "cache"

export const WEBLLM_CHAT_MODEL_CANDIDATES: readonly ModelRecord[] = [
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-0.8B-q4f16_1-MLC",
    "model_id": "Qwen3.5-0.8B-q4f16_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f16_1_cs1k-webgpu.wasm",
    "vram_required_MB": 1629.49,
    "low_resource_required": true,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-0.8B-q4f32_1-MLC",
    "model_id": "Qwen3.5-0.8B-q4f32_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm",
    "vram_required_MB": 1894.19,
    "low_resource_required": true,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-0.8B-q0f16-MLC",
    "model_id": "Qwen3.5-0.8B-q0f16-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q0f16_cs1k-webgpu.wasm",
    "vram_required_MB": 2660.27,
    "low_resource_required": true,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC",
    "model_id": "Qwen3.5-2B-q4f16_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
    "vram_required_MB": 2245.44,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f32_1-MLC",
    "model_id": "Qwen3.5-2B-q4f32_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-2B-q4f32_1_cs1k-webgpu.wasm",
    "vram_required_MB": 2591.55,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f16_1-MLC",
    "model_id": "Qwen3.5-4B-q4f16_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f16_1_cs1k-webgpu.wasm",
    "vram_required_MB": 3867.82,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f32_1-MLC",
    "model_id": "Qwen3.5-4B-q4f32_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f32_1_cs1k-webgpu.wasm",
    "vram_required_MB": 4680.36,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-9B-q4f16_1-MLC",
    "model_id": "Qwen3.5-9B-q4f16_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm",
    "vram_required_MB": 6433.01,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  },
  {
    "model": "https://huggingface.co/mlc-ai/Qwen3.5-9B-q4f32_1-MLC",
    "model_id": "Qwen3.5-9B-q4f32_1-MLC",
    "model_lib": "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-9B-q4f32_1_cs1k-webgpu.wasm",
    "vram_required_MB": 7544.74,
    "low_resource_required": false,
    "overrides": {
      "context_window_size": 4096,
      "max_history_size": 1
    }
  }
]
