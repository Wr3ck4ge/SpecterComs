import { defineConfig } from 'vitest/config';

// Event-contract tests (see shared/events/schema.js). Kept out of src/ and
// out of the default vitest.config.ts on purpose:
//  - they import ../../shared/events, which isn't inside the Docker build
//    context (Dockerfile copies only services/identity-node and runs tsc over
//    src/**), so living under src/ would break the production build;
//  - unlike src/test/**, they need no database or NATS, so CI can always run
//    them.
// Run: npx vitest run --config vitest.contracts.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/contracts/**/*.test.ts'],
    testTimeout: 30000,
  },
});
