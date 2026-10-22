import path from 'node:path';
import { _electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { guardPageErrors, validateAllowedPageErrors } from './page-errors';
import type { AllowedPageError } from './page-errors';
import { currentPageErrorGuards } from './electron-test';

type LaunchOptions = NonNullable<Parameters<typeof _electron.launch>[0]> & {
  allowPageErrors?: AllowedPageError[];
};

export function launchElectron(options: LaunchOptions = {}): Promise<ElectronApplication> {
  const directory = options.env?.BRICKLOOP_DATA_DIR?.trim();
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('测试启动必须指定测试数据目录：BRICKLOOP_DATA_DIR 必须是非空的绝对路径（A-91）。');
  }
  const args = options.args ?? [];
  if (args.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))) {
    throw new Error('请勿重复传入 --user-data-dir；launchElectron 按 BRICKLOOP_DATA_DIR 统一设置（A-91）。');
  }
  const { allowPageErrors = [], ...launchOptions } = options;
  validateAllowedPageErrors(allowPageErrors);
  const guards = currentPageErrorGuards();
  // A-91: ESM main-process linking can fail before index.ts executes setPath.
  // Chromium needs this switch even when none of the application code runs.
  return _electron.launch({ ...launchOptions, args: [`--user-data-dir=${directory}`, ...args] }).then((app) => {
    const guard = guardPageErrors(app, allowPageErrors);
    if (guards) guards.push(guard);
    else {
      // Standalone evaluation has no test fixture: fail the CLI on process exit,
      // even if its caller catches close(). Only this launched app is observed.
      app.once('close', () => {
        setImmediate(() => {
          void guard.finish({ attach: async () => {} }).catch((error: unknown) => {
            console.error(error);
            process.exitCode = 1;
          });
        });
      });
    }
    return app;
  });
}
