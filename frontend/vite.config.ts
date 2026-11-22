import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3113', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:3113', changeOrigin: false },
    },
  },
  build: {
    outDir: '../internal/webui/assets',
    emptyOutDir: true,
    assetsDir: 'static',
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1800,
  },
})
