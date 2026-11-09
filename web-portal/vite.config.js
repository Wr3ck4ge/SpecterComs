import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// E2EV: the browser build's client version for the voice ticket's
// client_version (desktop builds use Tauri's getVersion() instead).
const pkgVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version

// https://vitejs.dev/config/
export default defineConfig({
  define: { __SPECTER_CLIENT_VERSION__: JSON.stringify(pkgVersion) }, // E2EV
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
        // Tray strip window (src-tauri/src/strip.rs).
        strip: resolve(process.cwd(), 'strip.html'),
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
