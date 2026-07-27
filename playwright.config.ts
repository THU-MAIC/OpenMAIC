import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Lets contributors validate with an already-installed Chrome when
        // Playwright's managed browser is unavailable locally. CI leaves this
        // unset and continues to use the browser it installs explicitly.
        channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL,
      },
    },
  ],
  webServer: {
    // next.config.ts uses `output: standalone` outside Vercel. `next start`
    // cannot serve that output, while the generated standalone server can.
    command: process.env.CI ? 'pnpm build && node .next/standalone/server.js' : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Enable the MAIC Editor (Pro mode) so editor e2e can reach it. This is a
    // build-time NEXT_PUBLIC_* flag, so it must be set when the webServer runs
    // `pnpm build` (CI) or `pnpm dev` (local).
    env: { PORT: '3002', NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true' },
  },
});
