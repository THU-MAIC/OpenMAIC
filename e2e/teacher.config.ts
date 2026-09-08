import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'teacher-workbench.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    channel: process.env.TEACHER_E2E_BROWSER_CHANNEL || undefined,
    baseURL: process.env.TEACHER_E2E_BASE_URL || 'http://127.0.0.1:3000',
    locale: 'zh-CN',
    // Recovery codes are bearer credentials; do not capture network traces.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
