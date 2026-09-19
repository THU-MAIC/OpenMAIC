import { resolve } from 'node:path';

// Test the exact lightweight cleanup source in the patched checkout without
// loading the engine barrel or installing/building the upstream workspace.
export default {
  resolve: {
    alias: {
      '@hyperframes/engine/temporary-cleanup': resolve(
        process.cwd(),
        'packages/engine/src/utils/temporaryCleanup.ts',
      ),
    },
  },
};
