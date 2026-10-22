import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  globalSetup: fileURLToPath(new URL('./e2e/appdata-setup.ts', import.meta.url)),
  testDir: './e2e',
  testMatch: 'user-guide.spec.ts',
  outputDir: '../../.devdata/docs-screenshots/results',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
