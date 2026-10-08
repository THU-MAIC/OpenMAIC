import { availableParallelism } from 'node:os';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Hundreds of DOM suites and large document fixtures can exhaust memory
    // when a high-core-count machine starts one fork per core. Bound workers
    // instead of relaxing test timeouts or reducing coverage.
    maxWorkers: Math.min(4, availableParallelism()),
  },
});
