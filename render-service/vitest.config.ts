import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Node environment: these test the service's server-side boundaries
    // (unzip limits, admission arithmetic, body caps), no DOM needed.
    environment: 'node',
  },
});
