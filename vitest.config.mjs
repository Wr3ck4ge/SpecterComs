import { defineConfig } from 'vitest/config';

// Root vitest run: the shared event contracts and the web-portal client
// tests (web-portal/test/**). Deliberately not web-portal/vite.config.js —
// that one pulls in the Tauri / wasm plugins the tests don't need.
// identity-node's suites run from their own directory (see package.json).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['shared/**/*.test.js', 'web-portal/test/**/*.test.{js,jsx}'],
    testTimeout: 15000,
  },
});
