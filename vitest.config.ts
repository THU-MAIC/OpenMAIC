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
    // The suite is I/O-bound — loopback HTTP servers, SSRF/DNS guards, cold
    // dynamic imports, repo-wide lint scans. Capping workers at the CI runner's
    // core count keeps those stable (more workers than cores only adds
    // connection churn), and the I/O-heavy cases need more than the 5s default
    // before they are declared failed.
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
