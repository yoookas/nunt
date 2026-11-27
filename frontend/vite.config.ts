import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // tailwindcss only serves the vendored charts; see src/charts.css.
  plugins: [react(), tailwindcss()],
  resolve: {
    // The bklit charts are vendored from its shadcn registry, which imports
    // its shared helpers from "@/lib/utils".
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
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
    chunkSizeWarningLimit: 2400,
  },
})
