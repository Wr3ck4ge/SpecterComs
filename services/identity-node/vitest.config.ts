import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  resolve: {
    alias: [
      // src/ still carries a stale, tracked, compiled src/index.js (no `app`
      // export). Vite resolves the test helpers' `../index.js` import to that
      // real file instead of index.ts, so every integration test got
      // `app === undefined`. Pin it to the TypeScript source.
      { find: /^\.\.\/index\.js$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['src/test/**/*.test.ts'],
    // Each file runs in its own process so DB state from one test file
    // doesn't bleed into another.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
