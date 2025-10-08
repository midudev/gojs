import * as prettier from 'prettier/standalone'
import * as prettierPluginBabel from 'prettier/plugins/babel'
import * as prettierPluginEstree from 'prettier/plugins/estree'
import * as prettierPluginTypescript from 'prettier/plugins/typescript'

export interface FormatRequest {
  code: string
  options: prettier.Options
}

export interface FormatResponse {
  formatted: string
  error?: string
}

// Escuchar mensajes del thread principal
self.onmessage = async (e: MessageEvent<FormatRequest>) => {
  const { code, options } = e.data

  try {
    const formatted = await prettier.format(code, {
      parser: 'babel-ts',
      plugins: [prettierPluginBabel, prettierPluginEstree, prettierPluginTypescript],
      ...options,
    })

    const response: FormatResponse = {
      formatted,
    }

    self.postMessage(response)
  } catch (error) {
    const response: FormatResponse = {
      formatted: code, // Devolver el código original si hay error
      error: error instanceof Error ? error.message : String(error),
    }

    self.postMessage(response)
  }
}


