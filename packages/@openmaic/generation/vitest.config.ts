import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve the package self-import to source so tests run on a clean checkout
// without requiring a build first. Published consumers resolve through dist.
export default defineConfig({
  resolve: {
    alias: {
      '@openmaic/generation': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
