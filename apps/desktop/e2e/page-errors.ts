import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

export interface AllowedPageError {
  pattern: RegExp;
  reason: string;
}

export function validateAllowedPageErrors(allowed: AllowedPageError[]) {
  for (const { reason } of allowed) {
    if (!reason.trim()) throw new Error('allowPageErrors requires a non-empty reason for every pattern.');
  }
}

/** Keep listeners alive until teardown, including the one-second close grace period. */
export function guardPageErrors(app: ElectronApplication, allowed: AllowedPageError[] = []) {
  validateAllowedPageErrors(allowed);
  const errors: { message: string; stack: string; reason?: string }[] = [];
  const listeners = new Map<Page, (error: Error) => void>();
  const watch = (page: Page) => {
    if (listeners.has(page)) return;
    const listener = (error: Error) => {
      const match = allowed.find(({ pattern }) => {
        // Stateful /g and /y patterns must behave the same for every occurrence.
        pattern.lastIndex = 0;
        return pattern.test(error.message);
      });
      errors.push({
        message: error.message,
        stack: (error.stack ?? error.message).split('\n').slice(0, 6).join('\n'),
        ...(match ? { reason: match.reason } : {}),
      });
    };
    listeners.set(page, listener);
    page.on('pageerror', listener);
  };
  app.on('window', watch);
  for (const page of app.windows()) watch(page);

  let closed = false;
  let grace: Promise<void> | undefined;
  const drain = () => (grace ??= new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  const onClose = () => {
    closed = true;
    void drain();
  };
  app.on('close', onClose);
  const assertNone = () => {
    const unexpected = errors.filter((error) => !error.reason);
    if (unexpected.length) {
      throw new Error(
        `Uncaught page errors (${unexpected.length}):\n` +
          unexpected.map((error, index) => `${index + 1}. ${error.message}\n${error.stack}`).join('\n\n'),
      );
    }
  };
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        if (!closed) await close();
      } finally {
        await drain();
        assertNone();
      }
    })();
    return closing;
  };
  return {
    async finish(info: Pick<TestInfo, 'attach'>) {
      try {
        await app.close();
        // Check again even if a caller caught close()'s rejection or closed earlier.
        assertNone();
      } finally {
        app.off('window', watch);
        app.off('close', onClose);
        for (const [page, listener] of listeners) page.off('pageerror', listener);
        if (errors.length) {
          await info.attach('page-errors', {
            body: JSON.stringify(errors, null, 2),
            contentType: 'application/json',
          });
        }
      }
    },
  };
}

export type PageErrorGuard = ReturnType<typeof guardPageErrors>;

export async function finishPageErrorGuards(guards: PageErrorGuard[], info: Pick<TestInfo, 'attach'>) {
  const failures: unknown[] = [];
  for (const guard of guards) {
    try {
      await guard.finish(info);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join('\n\n'));
}
