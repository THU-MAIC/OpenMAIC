import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import teacherConfig from './teacher.config';

export default defineConfig({
  ...teacherConfig,
  testMatch: 'teacher-analysis.spec.ts',
  outputDir: resolve(__dirname, '../data/teacher-analysis-e2e-results'),
  use: { ...teacherConfig.use, baseURL: 'http://127.0.0.1:3001' },
  webServer: {
    command: 'node e2e/helpers/teacher-analysis-server.mjs',
    cwd: resolve(__dirname, '..'),
    url: 'http://127.0.0.1:3001/teacher',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
