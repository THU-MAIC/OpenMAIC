import { defineConfig } from '@playwright/test';

// Run the component focus regression without booting Next or provisioning a DB.
// The main Playwright config also discovers this spec in the normal E2E CI job.
export default defineConfig({
  testDir: './tests',
  testMatch: 'material-library-focus-handover.spec.ts',
  outputDir: '../test-results/library-focus',
  workers: 1,
  use: { browserName: 'chromium' },
});
