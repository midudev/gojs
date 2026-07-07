import { CreateMLCEngine, MLCEngine, deleteModelAllInfoInCache, hasModelInCache } from '@mlc-ai/web-llm'
import {
  CHATBOT_APP_CONFIG,
  CHROME_PROMPT_API_MODEL_ID,
  DEFAULT_CHATBOT_MODEL_ID,
  isChromePromptApiModelId,
  isValidChatModelId,
} from './ai-models'
import {
  createChromePromptApiSession,
  isChromePromptApiAvailable,
  streamChromePromptApiResponse,
  type ChromePromptApiSession,
} from './prompt-api'

// Estado del chatbot
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatbotState {
  isInitializing: boolean
  isReady: boolean
  error: string | null
  loadProgress: number
  downloadSpeedBytesPerSecond: number | null
  currentModelId: string | null
}

const MEGABYTE_IN_BYTES = 1024 * 1024
const FETCHED_MEGABYTES_PATTERN = /(\d+(?:\.\d+)?)\s*MB\s+fetched/i

type IDBFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string | null }>>
}

type OriginPrivateFileSystemDirectoryHandle = {
  entries: () => AsyncIterable<[string, unknown]>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
}

type StorageManagerWithDirectory = StorageManager & {
  getDirectory?: () => Promise<OriginPrivateFileSystemDirectoryHandle>
}

function deleteIndexedDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Could not delete IndexedDB database "${name}" because it is blocked.`))
  })
}

async function deleteAllCacheStorage(): Promise<number> {
  if (!('caches' in window)) return 0

  const cacheNames = await caches.keys()
  const cacheResults = await Promise.allSettled(cacheNames.map((cacheName) => caches.delete(cacheName)))
  const failedDeletion = cacheResults.find((result) => result.status === 'rejected')

  if (failedDeletion?.status === 'rejected') {
    throw failedDeletion.reason
  }

  return cacheNames.length
}

async function deleteAllIndexedDatabases(): Promise<number> {
  const indexedDbWithDatabases = indexedDB as IDBFactoryWithDatabases
  if (!indexedDbWithDatabases.databases) return 0

  const databases = await indexedDbWithDatabases.databases()
  const databaseNames = databases.map((database) => database.name).filter((name): name is string => Boolean(name))
  const deletionResults = await Promise.allSettled(databaseNames.map((name) => deleteIndexedDatabase(name)))
  const failedDeletion = deletionResults.find((result) => result.status === 'rejected')

  if (failedDeletion?.status === 'rejected') {
    throw failedDeletion.reason
  }

  return databaseNames.length
}

async function deleteOriginPrivateFileSystem(): Promise<number> {
  const storageWithDirectory = navigator.storage as StorageManagerWithDirectory | undefined
  if (!storageWithDirectory?.getDirectory) return 0

  const root = await storageWithDirectory.getDirectory()
  let deletedEntries = 0

  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true })
    deletedEntries += 1
  }

  return deletedEntries
}

function getFetchedBytesFromProgressText(text: string): number | null {
  const match = text.match(FETCHED_MEGABYTES_PATTERN)
  if (!match) return null

  const fetchedMegabytes = Number.parseFloat(match[1])
  if (!Number.isFinite(fetchedMegabytes)) return null

  return fetchedMegabytes * MEGABYTE_IN_BYTES
}

// Mensaje del sistema con instrucciones sobre el formato
const SYSTEM_MESSAGE = `You are the built-in AI assistant for a JavaScript and TypeScript playground.

Your job is to help the user understand, debug, refactor, and improve the code currently open in the editor. Be practical, specific, and grounded in the exact code and console output you receive.

Context you may receive:
1. Current code: the full JavaScript or TypeScript snippet from the editor.
2. Console output: values produced by the last execution.
3. User question: what the user wants to know or change.

Console output format:
- Each output entry may include a source line, for example: "value (L12)".
- The line marker means that the value was produced by that source line.
- Use those line markers to connect behavior with the exact statements that produced it.
- If output is missing, stale, truncated, or not enough to prove a claim, say so clearly.

Response style:
- Match the user's language. If the user writes Spanish, answer in Spanish.
- Be concise, but do not skip the useful reasoning.
- Start with the most likely answer or fix, then explain why.
- Prefer concrete examples over generic advice.
- Use Markdown and fenced code blocks when showing code.
- When showing a fix, provide the smallest useful code change unless the user asks for a larger rewrite.
- If there are multiple possible interpretations, state the assumption you are using.

Debugging rules:
- Do not invent code, files, dependencies, runtime behavior, or console output that was not provided.
- Do not claim you executed code. You can only reason from the code and output given to you.
- If there is an exception or unexpected output, identify the likely line, cause, and minimal fix.
- Explain async behavior, promises, event loop timing, closures, scopes, mutation, equality, coercion, prototypes, modules, DOM APIs, and TypeScript types when they are relevant.
- When a bug depends on browser behavior, mention the relevant browser API or constraint.

Code review rules:
- Focus on correctness, readability, runtime behavior, edge cases, and developer ergonomics.
- Call out risky patterns such as hidden mutation, accidental globals, confusing coercion, unhandled promises, broad try/catch blocks, fragile DOM selectors, and unsafe HTML injection.
- Do not over-engineer. Prefer simple, idiomatic JavaScript and TypeScript.

Teaching rules:
- Help the user build intuition, especially when explaining surprising JavaScript behavior.
- If the user asks "why", explain the mental model first, then the fix.
- If the user asks "how can I", give a direct implementation path.

Example:
If the code is:
\`\`\`javascript
const x = 4
console.log(x)
const y = 10
console.log(y)
\`\`\`

And the console output is:
\`\`\`
4 (L2)
10 (L4)
\`\`\`

You should be able to say that line 2 logs the value of x and line 4 logs the value of y, then answer the user's question using that mapping.`

class Chatbot {
  private engine: MLCEngine | null = null
  private promptApiSession: ChromePromptApiSession | null = null
  private state: ChatbotState = {
    isInitializing: false,
    isReady: false,
    error: null,
    loadProgress: 0,
    downloadSpeedBytesPerSecond: null,
    currentModelId: null,
  }
  private onStateChange: ((state: ChatbotState) => void) | null = null
  private conversationHistory: ChatMessage[] = []
  private loadToken = 0

  // Establecer listener para cambios de estado
  public setStateChangeListener(callback: (state: ChatbotState) => void) {
    this.onStateChange = callback
  }

  // Notificar cambios de estado
  private notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state })
    }
  }

  private resetConversationHistory() {
    this.conversationHistory = [
      {
        role: 'system',
        content: SYSTEM_MESSAGE,
      },
    ]
  }

  private normalizeModelId(modelId?: string): string {
    if (isChromePromptApiModelId(modelId)) {
      return CHROME_PROMPT_API_MODEL_ID
    }

    if (modelId && isValidChatModelId(modelId)) {
      return modelId
    }

    return DEFAULT_CHATBOT_MODEL_ID
  }

  private getInitializationErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '')

    if (message.includes('Cache.add() encountered a network error')) {
      return 'The model download failed while storing files in the browser. Check your connection and try a smaller model.'
    }

    if (/quota|storage|disk/i.test(message)) {
      return 'The browser does not have enough free storage for this model. Free up site storage or try a smaller model.'
    }

    return message || 'Error initializing the model'
  }

  private destroyPromptApiSession() {
    this.promptApiSession?.destroy?.()
    this.promptApiSession = null
  }

  private async unloadWebLlmEngine() {
    if (!this.engine) return

    await this.engine.unload()
    this.engine = null
  }

  private async loadChromePromptApiModel(forceReload: boolean): Promise<void> {
    const targetModelId = CHROME_PROMPT_API_MODEL_ID

    if (this.state.isInitializing && this.state.currentModelId === targetModelId) {
      return
    }

    if (!forceReload && this.state.isReady && this.state.currentModelId === targetModelId) {
      return
    }

    const loadToken = ++this.loadToken

    this.state.isInitializing = true
    this.state.isReady = false
    this.state.error = null
    this.state.loadProgress = 0
    this.state.downloadSpeedBytesPerSecond = null
    this.state.currentModelId = targetModelId
    this.notifyStateChange()

    try {
      await this.unloadWebLlmEngine()
      this.destroyPromptApiSession()

      const session = await createChromePromptApiSession(SYSTEM_MESSAGE)

      if (loadToken !== this.loadToken) {
        session.destroy?.()
        return
      }

      this.promptApiSession = session
      this.resetConversationHistory()

      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.state.downloadSpeedBytesPerSecond = null
      this.state.currentModelId = targetModelId
      this.notifyStateChange()
    } catch (error: any) {
      if (loadToken !== this.loadToken) return

      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = this.getInitializationErrorMessage(error)
      this.state.downloadSpeedBytesPerSecond = null
      this.notifyStateChange()
      console.error('Error initializing Chrome Prompt API:', error)
    }
  }

  // Inicializar el modelo
  public async initialize(modelId?: string): Promise<void> {
    await this.loadModel(modelId)
  }

  public async loadModel(modelId?: string, forceReload = false): Promise<void> {
    const targetModelId = this.normalizeModelId(modelId)

    if (isChromePromptApiModelId(targetModelId)) {
      await this.loadChromePromptApiModel(forceReload)
      return
    }

    if (this.state.isInitializing && this.state.currentModelId === targetModelId) {
      return
    }

    if (!forceReload && this.state.isReady && this.state.currentModelId === targetModelId) {
      return
    }

    const loadToken = ++this.loadToken

    this.state.isInitializing = true
    this.state.isReady = false
    this.state.error = null
    this.state.loadProgress = 0
    this.state.downloadSpeedBytesPerSecond = null
    this.state.currentModelId = targetModelId
    this.notifyStateChange()

    try {
      this.destroyPromptApiSession()

      // Variable para simular progreso cuando el callback devuelve 0
      let simulatedProgress = 0
      let lastDownloadSample: { bytes: number; timeElapsedMs: number } | null = null
      let currentDownloadSpeedBytesPerSecond: number | null = null

      const initProgressCallback = (report: any) => {
        if (loadToken !== this.loadToken) return

        // El progreso viene como decimal (0-1), convertir a porcentaje (0-100)
        const reportedProgress = (report.progress ?? 0) * 100
        const fetchedBytes = getFetchedBytesFromProgressText(report.text ?? '')
        const reportTimeElapsedMs =
          typeof report.timeElapsed === 'number' && Number.isFinite(report.timeElapsed)
            ? report.timeElapsed * 1000
            : performance.now()

        if (fetchedBytes === null) {
          lastDownloadSample = null
          currentDownloadSpeedBytesPerSecond = null
          this.state.downloadSpeedBytesPerSecond = null
        } else {
          if (
            lastDownloadSample &&
            fetchedBytes > lastDownloadSample.bytes &&
            reportTimeElapsedMs > lastDownloadSample.timeElapsedMs
          ) {
            currentDownloadSpeedBytesPerSecond =
              ((fetchedBytes - lastDownloadSample.bytes) / (reportTimeElapsedMs - lastDownloadSample.timeElapsedMs)) *
              1000
          } else if (!lastDownloadSample && fetchedBytes > 0 && reportTimeElapsedMs > 0) {
            currentDownloadSpeedBytesPerSecond = (fetchedBytes / reportTimeElapsedMs) * 1000
          }

          if (!lastDownloadSample || fetchedBytes >= lastDownloadSample.bytes) {
            lastDownloadSample = {
              bytes: fetchedBytes,
              timeElapsedMs: reportTimeElapsedMs,
            }
          }

          this.state.downloadSpeedBytesPerSecond = currentDownloadSpeedBytesPerSecond
        }

        // Si el progreso reportado es 0, simular un pequeño avance
        if (reportedProgress === 0) {
          simulatedProgress = Math.min(simulatedProgress + 0.5, 95)
          this.state.loadProgress = simulatedProgress
        }
        // Si el progreso reportado es menor que el simulado, ignorar (no retroceder)
        else if (reportedProgress < simulatedProgress) {
          // Mantener el progreso simulado actual
          return
        }
        // Si el progreso reportado es mayor, usarlo y actualizar la simulación
        else {
          simulatedProgress = reportedProgress
          this.state.loadProgress = reportedProgress
        }

        this.notifyStateChange()
      }

      if (this.engine) {
        this.engine.setAppConfig(CHATBOT_APP_CONFIG)
        this.engine.setInitProgressCallback(initProgressCallback)
        await this.engine.reload(targetModelId)
      } else {
        // Crear el motor con el modelo específico
        const engine = await CreateMLCEngine(targetModelId, {
          appConfig: CHATBOT_APP_CONFIG,
          initProgressCallback,
        })

        if (loadToken !== this.loadToken) {
          await engine.unload().catch((unloadError) => {
            console.warn('Error unloading stale chatbot engine:', unloadError)
          })
          return
        }

        this.engine = engine
      }

      if (loadToken !== this.loadToken) return

      this.resetConversationHistory()

      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.state.downloadSpeedBytesPerSecond = null
      this.state.currentModelId = targetModelId
      this.notifyStateChange()
    } catch (error: any) {
      if (loadToken !== this.loadToken) return

      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = this.getInitializationErrorMessage(error)
      this.state.downloadSpeedBytesPerSecond = null
      this.notifyStateChange()
      console.error('Error initializing chatbot:', error)
    }
  }

  // Enviar un mensaje y obtener respuesta
  public async sendMessage(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (isChromePromptApiModelId(this.state.currentModelId)) {
      return this.sendPromptApiMessage(userMessage, onChunk)
    }

    if (!this.engine || !this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    // Añadir mensaje del usuario al historial
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    })

    try {
      let fullResponse = ''

      // Generar respuesta con streaming
      const chunks = await this.engine.chat.completions.create({
        messages: this.conversationHistory,
        temperature: 0.7,
        max_tokens: 1024,
        stream: true,
      })

      for await (const chunk of chunks) {
        const content = chunk.choices[0]?.delta?.content || ''
        if (content) {
          fullResponse += content
          if (onChunk) {
            onChunk(content)
          }
        }
      }

      // Añadir respuesta del asistente al historial
      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
      })

      return fullResponse
    } catch (error: any) {
      console.error('Error sending message:', error)
      throw new Error(error.message || 'Error al enviar el mensaje')
    }
  }

  private async sendPromptApiMessage(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (!this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    })

    try {
      if (!this.promptApiSession) {
        this.promptApiSession = await createChromePromptApiSession(SYSTEM_MESSAGE)
      }

      let fullResponse = ''

      for await (const chunk of streamChromePromptApiResponse(this.promptApiSession, userMessage)) {
        fullResponse += chunk
        onChunk?.(chunk)
      }

      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
      })

      return fullResponse
    } catch (error: any) {
      console.error('Error sending message with Chrome Prompt API:', error)
      throw new Error(error.message || 'Error al enviar el mensaje')
    }
  }

  /**
   * Genera una respuesta a partir de una lista de mensajes arbitraria (con su
   * propio system prompt), SIN tocar el historial de chat ni el system prompt por
   * defecto. Es la primitiva de bajo nivel que usa el agente de código para poder
   * dar sus propias instrucciones y hacer varios turnos de razonamiento.
   */
  public async generate(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string> {
    if (isChromePromptApiModelId(this.state.currentModelId)) {
      return this.generateWithPromptApi(messages, onChunk)
    }

    if (!this.engine || !this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    let fullResponse = ''

    const chunks = await this.engine.chat.completions.create({
      messages,
      // Temperatura baja: queremos respuestas deterministas y acciones precisas.
      temperature: 0.3,
      max_tokens: 2048,
      stream: true,
    })

    for await (const chunk of chunks) {
      const content = chunk.choices[0]?.delta?.content || ''
      if (content) {
        fullResponse += content
        onChunk?.(content)
      }
    }

    return fullResponse
  }

  // Genera una respuesta con la Chrome Prompt API usando una sesión efímera con el
  // system prompt indicado (el primer mensaje 'system' de la lista).
  private async generateWithPromptApi(
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (!this.state.isReady) {
      throw new Error('The chatbot is not ready. Please wait for it to load.')
    }

    const systemMessage = messages.find((message) => message.role === 'system')?.content ?? ''
    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n')

    const session = await createChromePromptApiSession(systemMessage)

    try {
      let fullResponse = ''
      for await (const chunk of streamChromePromptApiResponse(session, conversation)) {
        fullResponse += chunk
        onChunk?.(chunk)
      }
      return fullResponse
    } finally {
      session.destroy?.()
    }
  }

  // Limpiar el historial de conversación
  public clearHistory() {
    this.resetConversationHistory()

    if (isChromePromptApiModelId(this.state.currentModelId)) {
      this.destroyPromptApiSession()
    }
  }

  public async isModelInstalled(modelId: string): Promise<boolean> {
    if (isChromePromptApiModelId(modelId)) {
      return isChromePromptApiAvailable()
    }

    return hasModelInCache(this.normalizeModelId(modelId), CHATBOT_APP_CONFIG)
  }

  public async uninstallModel(modelId: string): Promise<void> {
    const targetModelId = this.normalizeModelId(modelId)
    const isCurrentModel = this.state.currentModelId === targetModelId

    if (isChromePromptApiModelId(targetModelId)) {
      if (isCurrentModel) {
        this.loadToken += 1
        this.destroyPromptApiSession()
        this.resetConversationHistory()
        this.state = {
          isInitializing: false,
          isReady: false,
          error: null,
          loadProgress: 0,
          downloadSpeedBytesPerSecond: null,
          currentModelId: targetModelId,
        }
        this.notifyStateChange()
      }

      return
    }

    if (isCurrentModel) {
      this.loadToken += 1
      this.resetConversationHistory()
      this.state = {
        isInitializing: false,
        isReady: false,
        error: null,
        loadProgress: 0,
        downloadSpeedBytesPerSecond: null,
        currentModelId: targetModelId,
      }
      this.notifyStateChange()
    }

    if (this.engine && isCurrentModel) {
      await this.engine.unload()
      this.engine = null
    }

    await deleteModelAllInfoInCache(targetModelId, CHATBOT_APP_CONFIG)

    if (isCurrentModel) {
      this.notifyStateChange()
    }
  }

  public async clearLocalAiData(): Promise<{ deletedCaches: number; deletedDatabases: number; deletedFiles: number }> {
    this.loadToken += 1
    await this.unloadWebLlmEngine()
    this.destroyPromptApiSession()
    this.resetConversationHistory()

    this.state = {
      isInitializing: false,
      isReady: false,
      error: null,
      loadProgress: 0,
      downloadSpeedBytesPerSecond: null,
      currentModelId: null,
    }
    this.notifyStateChange()

    const [deletedCaches, deletedDatabases, deletedFiles] = await Promise.all([
      deleteAllCacheStorage(),
      deleteAllIndexedDatabases(),
      deleteOriginPrivateFileSystem(),
    ])

    return { deletedCaches, deletedDatabases, deletedFiles }
  }

  // Obtener el estado actual
  public getState(): ChatbotState {
    return { ...this.state }
  }

  // Destruir la instancia del chatbot
  public async destroy() {
    this.loadToken += 1

    if (this.engine) {
      await this.engine.unload()

      // @mlc-ai/web-llm no tiene un método destroy explícito
      // pero podemos limpiar nuestras referencias
      this.engine = null
    }

    this.destroyPromptApiSession()
    this.conversationHistory = []
    this.state = {
      isInitializing: false,
      isReady: false,
      error: null,
      loadProgress: 0,
      downloadSpeedBytesPerSecond: null,
      currentModelId: null,
    }
    this.notifyStateChange()
  }
}

// Exportar instancia singleton
export const chatbot = new Chatbot()
