import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { resolve } from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait()
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        overlay: resolve(process.cwd(), 'overlay.html'),
      },
    },
  },
  resolve: {
    // See website/vite.config.js — same file:-dependency symlink dedupe rationale.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: true,
    strictPort: true,
    port: 5173
  }
})
