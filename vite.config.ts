import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5555,
    open: true,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
  },
  optimizeDeps: {
    include: ['modern-monaco'],
  },
})
