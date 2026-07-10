import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    port: 5555,
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
    include: ['modern-monaco'],
  },
  plugins: [react(), tailwindcss()],
})
