import { defineConfig, devices } from '@playwright/test';

const retries = Number(process.env.PLAYWRIGHT_RETRIES ?? (process.env.CI ? 2 : 0));

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries,
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
    // Next does not copy static browser chunks into standalone output. Copy
    // them before starting the generated server, otherwise pages hydrate with
    // dozens of 404s and remain stuck in their loading state.
    command: process.env.CI
      ? 'pnpm build && cp -R .next/static .next/standalone/.next/static && node .next/standalone/server.js'
      : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Enable the MAIC Editor (Pro mode) so editor e2e can reach it. This is a
    // build-time NEXT_PUBLIC_* flag, so it must be set when the webServer runs
    // `pnpm build` (CI) or `pnpm dev` (local).
    env: { PORT: '3002', NEXT_PUBLIC_MAIC_EDITOR_ENABLED: 'true' },
  },
});
