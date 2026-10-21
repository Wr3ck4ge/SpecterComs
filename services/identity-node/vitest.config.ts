import { defineConfig } from 'vitest/config';

export default defineConfig({
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
