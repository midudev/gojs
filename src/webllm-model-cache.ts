import type { AppConfig } from '@mlc-ai/web-llm'

const WEBLLM_MODEL_DATABASE = 'webllm/model'
const WEBLLM_MODEL_STORE = 'urls'
const TENSOR_CACHE_MANIFEST = 'tensor-cache.json'

type TensorCacheManifest = {
  records?: Array<{ dataPath?: unknown }>
}

type WebLlmCacheProbeOptions = {
  databaseName?: string
  objectStoreName?: string
}

const installationCache = new Map<string, boolean>()
const installationChecks = new Map<string, Promise<boolean>>()

function normalizeModelUrl(modelUrl: string): string {
  let normalized = modelUrl.endsWith('/') ? modelUrl : `${modelUrl}/`
  if (!/.+\/resolve\/.+\//.test(normalized)) {
    normalized += 'resolve/main/'
  }
  return new URL(normalized).href
}

function openModelDatabase(databaseName: string, objectStoreName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(objectStoreName)) {
        database.createObjectStore(objectStoreName, { keyPath: 'url' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readCacheEntry(database: IDBDatabase, objectStoreName: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, 'readonly')
    const request = transaction.objectStore(objectStoreName).get(key)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function hasAllCacheKeys(database: IDBDatabase, objectStoreName: string, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return Promise.resolve(false)

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, 'readonly')
    const store = transaction.objectStore(objectStoreName)
    const checks = keys.map(
      (key) =>
        new Promise<boolean>((resolveKey) => {
          // `getKey` only reads IndexedDB metadata. WebLLM's `hasModelInCache`
          // uses `get`, which materializes every model shard just to test that
          // it exists and can therefore read gigabytes into memory.
          const request = store.getKey(key)
          request.onsuccess = () => resolveKey(request.result !== undefined)
          request.onerror = () => resolveKey(false)
        }),
    )

    transaction.onerror = () => reject(transaction.error)
    void Promise.all(checks).then((results) => resolve(results.every(Boolean)), reject)
  })
}

export async function probeWebLlmModelCache(
  modelUrl: string,
  options: WebLlmCacheProbeOptions = {},
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false

  const databaseName = options.databaseName ?? WEBLLM_MODEL_DATABASE
  const objectStoreName = options.objectStoreName ?? WEBLLM_MODEL_STORE
  const normalizedModelUrl = normalizeModelUrl(modelUrl)
  const manifestUrl = new URL(TENSOR_CACHE_MANIFEST, normalizedModelUrl).href
  let database: IDBDatabase | null = null

  try {
    database = await openModelDatabase(databaseName, objectStoreName)
    const manifestEntry = (await readCacheEntry(database, objectStoreName, manifestUrl)) as
      | { data?: TensorCacheManifest }
      | undefined
    const records = manifestEntry?.data?.records
    if (!Array.isArray(records) || records.length === 0) return false

    const shardUrls: string[] = []
    for (const record of records) {
      if (typeof record.dataPath !== 'string') return false
      shardUrls.push(new URL(record.dataPath, normalizedModelUrl).href)
    }

    return await hasAllCacheKeys(database, objectStoreName, shardUrls)
  } catch (error) {
    console.warn('[webllm-cache] Could not inspect model cache:', error)
    return false
  } finally {
    database?.close()
  }
}

export async function isWebLlmModelInstalled(
  modelId: string,
  appConfig: AppConfig,
  probeOptions?: WebLlmCacheProbeOptions,
): Promise<boolean> {
  const cached = installationCache.get(modelId)
  if (cached !== undefined) return cached

  const existingCheck = installationChecks.get(modelId)
  if (existingCheck) return existingCheck

  const model = appConfig.model_list.find((candidate) => candidate.model_id === modelId)
  if (!model) return false

  let check: Promise<boolean>
  check = probeWebLlmModelCache(model.model, probeOptions)
    .then((installed) => {
      // An explicit load/uninstall may have updated the state while this probe
      // was running. Only the still-current probe may publish its result.
      if (installationChecks.get(modelId) === check) {
        installationCache.set(modelId, installed)
      }
      return installed
    })
    .finally(() => {
      if (installationChecks.get(modelId) === check) {
        installationChecks.delete(modelId)
      }
    })

  installationChecks.set(modelId, check)
  return check
}

export function setWebLlmModelInstallation(modelId: string, installed: boolean): void {
  installationCache.set(modelId, installed)
  installationChecks.delete(modelId)
}

export function invalidateWebLlmModelInstallation(modelId?: string): void {
  if (modelId) {
    installationCache.delete(modelId)
    installationChecks.delete(modelId)
    return
  }

  installationCache.clear()
  installationChecks.clear()
}
