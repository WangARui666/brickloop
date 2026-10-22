import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  globalSetup: fileURLToPath(new URL('./e2e/appdata-setup.ts', import.meta.url)),
  testDir: './e2e',
  testIgnore: /(?:perf.*|user-guide)\.spec\.ts/,
  outputDir: '../../.devdata/e2e-results/artifacts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../../.devdata/e2e-results/results.json' }]],
});
