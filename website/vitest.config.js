import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.js: the tests are plain modules (session,
// invite guard, auth payloads) and need no React plugin. The repo root's
// `npm test` runs this suite too (see test:web in ../package.json).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}'],
    testTimeout: 15000,
  },
});
