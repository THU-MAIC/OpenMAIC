import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI builds the production bundle in a dedicated workflow step, so this
  // process only drives Chromium. Two workers fit a 4-core runner.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // In CI the production build runs as a dedicated workflow step before
    // Playwright, so this only boots the already-built server (`pnpm start`).
    // The 120s budget covers startup, not the (much slower) build. Locally we
    // run the dev server.
    //
    // The server refuses to start without DATABASE_URL (courses are stored in
    // PostgreSQL). CI provides a Postgres service and sets it for the job;
    // locally run `pnpm db:up` and set it in .env.local or the environment.
    // Specs seed their courses through the app's persistence endpoint
    // (e2e/fixtures/server-seed.ts), each under a fresh id.
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Enable the MAIC Editor (Pro mode) so editor e2e can reach it. This is a
    // build-time NEXT_PUBLIC_* flag: in CI it must be set on the dedicated
    // `pnpm build` step; locally `pnpm dev` reads it here.
    env: {
      PORT: '3002',
      NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true',
      // Leave Pi chat unset so the browser suite exercises the shipped default.
      NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED: 'true',
    },
  },
});
