import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ArcoResolver } from 'unplugin-vue-components/resolvers'

// The bundle replaces internal/webui/assets; the Go server serves that
// directory at the root of the admin listener, so the base stays "/".
export default defineConfig({
  plugins: [
    vue(),
    // Import only the Arco components a page actually uses. Styles still come
    // from the single arco.css file imported by main.js.
    Components({ resolvers: [ArcoResolver({ sideEffect: false })], dts: false }),
  ],
  base: '/',
  server: {
    // "npm run dev" proxies the admin API to a locally running instance.
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
    target: 'es2020',
    // One stylesheet for the whole app: the per-route CSS is a few hundred
    // bytes each, and a single file keeps the jsdom smoke from waiting on
    // stylesheet load events when it imports a route chunk.
    cssCodeSplit: false,
    // Arco is bundled whole; the warning at 500 kB is noise for an admin SPA.
    chunkSizeWarningLimit: 1500,
  },
})
