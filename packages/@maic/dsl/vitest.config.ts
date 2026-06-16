import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve `@maic/dsl` self-imports to the package source so `pnpm test` is
// standalone on a clean checkout (no `dist` build required). Consumers still
// resolve the package via its `exports` map → `dist` as before.
export default defineConfig({
  resolve: {
    alias: {
      '@maic/dsl': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
