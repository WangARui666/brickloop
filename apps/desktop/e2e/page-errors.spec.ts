import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { test } from './electron-test';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../..', import.meta.url));

test('M12-29: real window exceptions fail the test, including forgotten close and unexpected exit', async () => {
  const temporary = path.join(root, '.devdata/tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'page-error-guard-'));
  const literal = (file: string) => JSON.stringify(file.replaceAll('\\', '/'));
  try {
    await writeFile(
      path.join(directory, 'main.cjs'),
      `
      const { app, BrowserWindow } = require('electron');
      app.whenReady().then(() => {
        const window = new BrowserWindow({ show: false });
        window.loadURL('data:text/html,<title>Guard test</title>');
      });
      app.on('window-all-closed', () => app.quit());
    `,
    );
    await writeFile(
      path.join(directory, 'playwright.config.mjs'),
      `export default {
      testDir: '.', testMatch: 'cases.spec.ts', workers: 1, retries: 0,
      outputDir: './artifacts', reporter: [['json', { outputFile: './results.json' }]],
    };`,
    );
    await writeFile(
      path.join(directory, 'cases.spec.ts'),
      `
      import { expect } from ${literal(require.resolve('@playwright/test').replace(/index\.js$/, 'index.mjs'))};
      import { test } from ${literal(path.join(root, 'apps/desktop/e2e/electron-test.ts'))};
      import { launchElectron } from ${literal(path.join(root, 'apps/desktop/e2e/electron-launch.ts'))};
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const launch = (allowPageErrors = []) => launchElectron({
        args: [${literal(path.join(directory, 'main.cjs'))}],
        env: { ...env, BRICKLOOP_DATA_DIR: test.info().outputPath('profile') },
        allowPageErrors,
      });
      async function crash(page) {
        await page.evaluate(() => new Promise((resolve) => {
          setTimeout(() => {
            // Finish on the following turn, after the uncaught exception is reported.
            setTimeout(resolve, 0);
            throw new Error('M12-29 deliberate exception');
          }, 0);
        }));
      }
      for (const mode of ['close', 'forgotten', 'exit', 'later', 'unload']) {
        test(mode, async () => {
          const app = await launch();
          let page = await app.firstWindow();
          if (mode === 'later') {
            const opened = app.waitForEvent('window');
            await app.evaluate(async ({ BrowserWindow }) => {
              const later = new BrowserWindow({ show: false });
              await later.loadURL('data:text/html,<title>Later window</title>');
            });
            page = await opened;
          }
          if (mode === 'unload') {
            await page.evaluate(() => window.addEventListener('beforeunload', () => {
              throw new Error('M12-29 deliberate exception');
            }));
          } else await crash(page);
          if (mode === 'forgotten') return;
          if (mode === 'exit') {
            await app.evaluate(({ app }) => app.exit(9)).catch(() => {});
            return;
          }
          // Even a caller swallowing close errors must fail in automatic teardown.
          await app.close().catch(() => {});
        });
      }
      test('allowed', async () => {
        const app = await launch([{
          pattern: /^M12-29 deliberate exception$/,
          reason: 'Self-test: prove that an explicitly declared uncaught exception is allowed.',
        }]);
        await crash(await app.firstWindow());
        await app.close();
      });
      test('empty reason', () => {
        expect(() => launch([{ pattern: /deliberate/, reason: ' ' }])).toThrow('non-empty reason');
      });
    `,
    );
    const result = await promisify(execFile)(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(directory, 'playwright.config.mjs')],
      { cwd: directory, windowsHide: true },
    ).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    expect(result).toBe(1);
    const report = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')) as {
      suites: {
        specs: { title: string; tests: { results: { status: string; errors: { message: string }[] }[] }[] }[];
      }[];
    };
    await test.info().attach('page-error-guard-self-test', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    const cases = report.suites.flatMap((suite) => suite.specs);
    expect(cases, JSON.stringify(report)).toHaveLength(7);
    for (const entry of cases) {
      const result = entry.tests[0]!.results[0]!;
      const expectedFailure = !['allowed', 'empty reason'].includes(entry.title);
      expect(result.status, entry.title).toBe(expectedFailure ? 'failed' : 'passed');
      if (expectedFailure)
        expect(result.errors.map((error) => error.message).join('\n')).toContain('M12-29 deliberate exception');
    }
  } finally {
    expect(path.dirname(path.resolve(directory))).toBe(temporary);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
