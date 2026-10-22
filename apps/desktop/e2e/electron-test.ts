import { test as base } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import { finishPageErrorGuards } from './page-errors';
import type { PageErrorGuard } from './page-errors';

const guardsByTest = new WeakMap<TestInfo, PageErrorGuard[]>();

// Auto-fixture teardown runs after the test and all its afterEach hooks. This
// also checks apps that exited unexpectedly or whose caller forgot close().
export const test = base.extend<{ electronPageErrors: void }>({
  electronPageErrors: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires fixture dependencies to be destructured.
    async ({}, use, info) => {
      const guards: PageErrorGuard[] = [];
      guardsByTest.set(info, guards);
      try {
        await use();
      } finally {
        try {
          await finishPageErrorGuards(guards, info);
        } finally {
          guardsByTest.delete(info);
        }
      }
    },
    { auto: true },
  ],
});

export function currentPageErrorGuards() {
  let info: TestInfo;
  try {
    info = base.info();
  } catch {
    // The offline/CLI evaluation runner also uses launchElectron outside tests.
    return undefined;
  }
  const guards = guardsByTest.get(info);
  if (!guards) throw new Error('launchElectron requires test from ./electron-test (automatic page-error teardown).');
  return guards;
}
