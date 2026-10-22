import { defineConfig } from '@playwright/test';
import desktopConfig from '../../apps/desktop/playwright.config';

export default defineConfig({
  ...desktopConfig,
  testDir: './e2e',
  outputDir: '../../.devdata/e2e-results/viewport-artifacts',
  reporter: [['list'], ['json', { outputFile: '../../.devdata/e2e-results/viewport-results.json' }]],
});
