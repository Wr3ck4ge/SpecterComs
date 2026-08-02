import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The "file:../packages/shared-web" dependency symlinks @spectercoms/shared-web
    // straight to packages/shared-web — without dedupe its React import can
    // resolve to a second copy in that package's own node_modules tree (if one
    // ever gets installed there), breaking hooks with "Invalid hook call".
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: true,
    port: 5174,
  },
})
