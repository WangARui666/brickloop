import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/**', '.devdata/**', '**/dist/**', '**/out/**', 'tools/**', 'docs/**']),
  js.configs.recommended,
  {
    // Plain Node scripts and config files.
    files: ['*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './packages/*/tsconfig.json', './apps/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/desktop/e2e/**/*.ts', 'apps/desktop/scripts/**/*.ts'],
    ignores: ['apps/desktop/e2e/electron-launch.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@playwright/test',
              importNames: ['_electron'],
              message:
                'Use launchElectron from apps/desktop/e2e/electron-launch.ts to keep Chromium data in the test directory (A-91).',
            },
          ],
        },
      ],
    },
  },
);
