import { defineConfig, devices } from '@playwright/test';

// CI splits the suite into three jobs by file (E2E_SHARD=1|2|3) instead of
// `--shard`, which cuts the ordered test list into equal counts: dozens of
// sub-second specs filled the first shards while the slow PBL and phone specs
// all landed in the last one, which then set the time of every run. The first
// two shards take the slow files listed here, of similar total duration, and
// the third runs every other file, so a new spec always runs somewhere.
const SHARD_FILES = [
  /[\\/](pbl-[^\\/]*|whiteboard-pick-transition)\.spec\.ts$/,
  /[\\/](mobile-[^\\/]*|generation-flow)\.spec\.ts$/,
];
const shard = process.env.E2E_SHARD;
if (shard && !['1', '2', '3'].includes(shard)) {
  throw new Error(`E2E_SHARD must be 1, 2 or 3, got ${shard}`);
}

export default defineConfig({
  testDir: './e2e/tests',
  ...(shard === '1' || shard === '2'
    ? { testMatch: SHARD_FILES[Number(shard) - 1] }
    : shard === '3'
      ? { testIgnore: SHARD_FILES }
      : {}),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI builds the production bundle in a dedicated workflow step, so this
  // process only drives Chromium. Two workers fit a 4-core runner.
  workers: process.env.CI ? 2 : undefined,
  // CI names every test as it finishes (`list`): with `html` alone the run
  // printed one unflushed line of dots, so a stall said nothing about which
  // test it was.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Every test, its hooks and fixtures included, gets 30 s (Playwright's
  // default, stated so a spec that raises it does so explicitly).
  timeout: 30_000,
  // Each shard's run stops inside the job's 20-minute budget (a passing shard
  // takes about 3 minutes after a 4-minute setup): Playwright then reports the
  // tests still running by name, and the report is uploaded, instead of the job
  // being cancelled with neither.
  globalTimeout: process.env.CI ? 13 * 60_000 : undefined,
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
      NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED: 'true',
    },
  },
});
