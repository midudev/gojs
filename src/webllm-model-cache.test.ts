import type { AppConfig } from '@mlc-ai/web-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateWebLlmModelInstallation,
  isWebLlmModelInstalled,
  probeWebLlmModelCache,
} from './webllm-model-cache'

const databasesToDelete = new Set<string>()

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Database ${name} is blocked`))
  })
}

function writeCacheEntries(
  databaseName: string,
  entries: Array<{ url: string; data: unknown }>,
): Promise<void> {
  databasesToDelete.add(databaseName)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)

    request.onupgradeneeded = () => {
      request.result.createObjectStore('urls', { keyPath: 'url' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('urls', 'readwrite')
      const store = transaction.objectStore('urls')

      for (const entry of entries) store.put(entry)

      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => {
        database.close()
        reject(transaction.error)
      }
    }
  })
}

afterEach(async () => {
  invalidateWebLlmModelInstallation()
  vi.restoreAllMocks()
  await Promise.all([...databasesToDelete].map(deleteDatabase))
  databasesToDelete.clear()
})

describe('probeWebLlmModelCache', () => {
  it('detecta un modelo completo leyendo solo las claves de sus fragmentos', async () => {
    const databaseName = `webllm-model-cache-complete-${crypto.randomUUID()}`
    const modelUrl = 'https://example.com/models/demo'
    const baseUrl = `${modelUrl}/resolve/main/`
    const manifestUrl = `${baseUrl}tensor-cache.json`
    const shardUrls = [`${baseUrl}params_shard_0.bin`, `${baseUrl}params_shard_1.bin`]

    await writeCacheEntries(databaseName, [
      {
        url: manifestUrl,
        data: {
          records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }],
        },
      },
      { url: shardUrls[0], data: new ArrayBuffer(1024) },
      { url: shardUrls[1], data: new ArrayBuffer(1024) },
    ])

    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get')
    const getKeySpy = vi.spyOn(IDBObjectStore.prototype, 'getKey')

    await expect(probeWebLlmModelCache(modelUrl, { databaseName })).resolves.toBe(true)

    expect(getSpy.mock.calls.map(([key]) => key)).toContain(manifestUrl)
    expect(getSpy.mock.calls.map(([key]) => key)).not.toContain(shardUrls[0])
    expect(getSpy.mock.calls.map(([key]) => key)).not.toContain(shardUrls[1])
    expect(getKeySpy.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining(shardUrls))
  })

  it('devuelve false cuando falta un fragmento', async () => {
    const databaseName = `webllm-model-cache-partial-${crypto.randomUUID()}`
    const modelUrl = 'https://example.com/models/partial/resolve/main/'
    const manifestUrl = `${modelUrl}tensor-cache.json`

    await writeCacheEntries(databaseName, [
      {
        url: manifestUrl,
        data: {
          records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }],
        },
      },
      { url: `${modelUrl}params_shard_0.bin`, data: new ArrayBuffer(1024) },
    ])

    await expect(probeWebLlmModelCache(modelUrl, { databaseName })).resolves.toBe(false)
  })
})

describe('isWebLlmModelInstalled', () => {
  it('memoiza el resultado para no volver a abrir IndexedDB', async () => {
    const databaseName = `webllm-model-cache-memo-${crypto.randomUUID()}`
    const modelId = `test-model-${crypto.randomUUID()}`
    const modelUrl = `https://example.com/models/${modelId}/resolve/main/`
    const manifestUrl = `${modelUrl}tensor-cache.json`

    await writeCacheEntries(databaseName, [
      {
        url: manifestUrl,
        data: {
          records: [{ dataPath: 'params_shard_0.bin' }],
        },
      },
      { url: `${modelUrl}params_shard_0.bin`, data: new ArrayBuffer(1024) },
    ])

    const appConfig = {
      model_list: [{ model_id: modelId, model: modelUrl }],
    } as unknown as AppConfig
    const openSpy = vi.spyOn(indexedDB, 'open')

    await expect(isWebLlmModelInstalled(modelId, appConfig, { databaseName })).resolves.toBe(true)
    await expect(isWebLlmModelInstalled(modelId, appConfig, { databaseName })).resolves.toBe(true)

    expect(openSpy.mock.calls.filter(([name]) => name === databaseName)).toHaveLength(1)
  })
})
