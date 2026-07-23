import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const MODERN_MONACO_DIST = dirname(fileURLToPath(import.meta.resolve('modern-monaco')))
const MODERN_MONACO_FILES = [
  'cache.mjs',
  'editor-core.mjs',
  'editor-worker-main.mjs',
  'editor-worker.mjs',
  'util.mjs',
  'lsp/client.mjs',
  'lsp/index.mjs',
  'lsp/typescript/setup.mjs',
  'lsp/typescript/worker.mjs',
] as const

const TYPESCRIPT_WORKER_PATH = 'lsp/typescript/worker.mjs'
const TYPESCRIPT_WORKER_SOURCE = buildSync({
  entryPoints: [join(MODERN_MONACO_DIST, TYPESCRIPT_WORKER_PATH)],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
}).outputFiles[0].contents

function readModernMonacoAsset(relativePath: (typeof MODERN_MONACO_FILES)[number]) {
  return relativePath === TYPESCRIPT_WORKER_PATH
    ? TYPESCRIPT_WORKER_SOURCE
    : readFileSync(join(MODERN_MONACO_DIST, relativePath))
}

function modernMonacoAssets(): Plugin {
  return {
    name: 'modern-monaco-assets',
    configureServer(server) {
      server.middlewares.use(
        (
          request: { url?: string },
          response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: unknown): void },
          next: () => void,
        ) => {
          const prefix = '/modern-monaco/'
          const url = request.url?.split('?', 1)[0]
          if (!url?.startsWith(prefix)) return next()

          const relativePath = decodeURIComponent(url.slice(prefix.length))
          if (!MODERN_MONACO_FILES.includes(relativePath as (typeof MODERN_MONACO_FILES)[number])) {
            response.statusCode = 404
            response.end()
            return
          }

          response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          response.end(readModernMonacoAsset(relativePath as (typeof MODERN_MONACO_FILES)[number]))
        },
      )
    },
    generateBundle() {
      for (const relativePath of MODERN_MONACO_FILES) {
        this.emitFile({
          type: 'asset',
          fileName: `modern-monaco/${relativePath}`,
          source: readModernMonacoAsset(relativePath),
        })
      }
    },
  }
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5555,
    strictPort: true,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
  },
  worker: {
    // Emitir los workers como módulos ES (type: 'module'). Necesario para que el
    // executor-worker pueda hacer `import()` dinámico de módulos ESM cross-origin
    // (esm.sh) dentro de WKWebView (Tauri): un worker clásico lo rechaza con
    // "Cross-origin script load denied by Cross-Origin Resource Sharing policy".
    format: 'es',
  },
  optimizeDeps: {
    // modern-monaco crea sus workers con URLs relativas a sus propios módulos.
    // El prebundle de Vite mueve el módulo principal, pero no worker.mjs, dejando
    // el LSP de TypeScript esperando para siempre con "Loading..." en sugerencias.
    exclude: ['modern-monaco'],
  },
  plugins: [modernMonacoAssets(), react(), tailwindcss()],
})
