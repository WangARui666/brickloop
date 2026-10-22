import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  globalSetup: fileURLToPath(new URL('./e2e/appdata-setup.ts', import.meta.url)),
  testDir: './e2e',
  testMatch: /perf\.spec\.ts/,
  outputDir: '../../.devdata/perf-fixtures/test-results',
  timeout: 3_600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
