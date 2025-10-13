import { CreateMLCEngine, MLCEngine } from '@mlc-ai/web-llm'

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
}

// Mensaje del sistema con instrucciones sobre el formato
const SYSTEM_MESSAGE = `You are a helpful assistant that specializes in JavaScript and TypeScript.

You will receive:
1. The current code being edited
2. The console output in this format: "value (line_number)" where line_number indicates which line of code produced that output

Example:
If the code is:
\`\`\`javascript
const x = 4
console.log(x)
const y = 10
console.log(y)
\`\`\`

The console output will be:
\`\`\`
4 (L2)
10 (L4)
\`\`\`

This format helps you understand which line produced which output. Use this information to provide accurate help about the code behavior.`

class Chatbot {
  private engine: MLCEngine | null = null
  private state: ChatbotState = {
    isInitializing: false,
    isReady: false,
    error: null,
    loadProgress: 0,
  }
  private onStateChange: ((state: ChatbotState) => void) | null = null
  private conversationHistory: ChatMessage[] = []

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

  // Inicializar el modelo
  public async initialize(): Promise<void> {
    if (this.state.isInitializing || this.state.isReady) {
      return
    }

    this.state.isInitializing = true
    this.state.error = null
    this.state.loadProgress = 0
    this.notifyStateChange()

    try {
      // Crear el motor con el modelo específico
      this.engine = await CreateMLCEngine('Qwen3-0.6B-q4f32_1-MLC', {
        initProgressCallback: (progress) => {
          console.log('Loading progress:', progress)
          this.state.loadProgress = progress.progress || 0
          this.notifyStateChange()
        },
      })

      // Establecer mensaje del sistema inicial solo si el historial está vacío
      if (this.conversationHistory.length === 0) {
        this.conversationHistory = [
          {
            role: 'system',
            content: SYSTEM_MESSAGE,
          },
        ]
      }

      this.state.isInitializing = false
      this.state.isReady = true
      this.state.loadProgress = 100
      this.notifyStateChange()

      console.log('Chatbot initialized successfully')
    } catch (error: any) {
      this.state.isInitializing = false
      this.state.isReady = false
      this.state.error = error.message || 'Error initializing the model'
      this.notifyStateChange()
      console.error('Error initializing chatbot:', error)
    }
  }

  // Enviar un mensaje y obtener respuesta
  public async sendMessage(userMessage: string, onChunk?: (chunk: string) => void): Promise<string> {
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

  // Limpiar el historial de conversación
  public clearHistory() {
    this.conversationHistory = [
      {
        role: 'system',
        content: SYSTEM_MESSAGE,
      },
    ]
  }

  // Obtener el estado actual
  public getState(): ChatbotState {
    return { ...this.state }
  }

  // Destruir la instancia del chatbot
  public async destroy() {
    if (this.engine) {
      // @mlc-ai/web-llm no tiene un método destroy explícito
      // pero podemos limpiar nuestras referencias
      this.engine = null
      this.conversationHistory = []
      this.state = {
        isInitializing: false,
        isReady: false,
        error: null,
        loadProgress: 0,
      }
      this.notifyStateChange()
    }
  }
}

// Exportar instancia singleton
export const chatbot = new Chatbot()
