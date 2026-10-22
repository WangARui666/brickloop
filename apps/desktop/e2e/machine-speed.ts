import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';

// Scale the 4.4 s / 300 million-iteration probe down to target 300–500 ms.
// Keep the source identical in Node, the renderer and the Worker; return the value
// as well as the duration so the computation has an observable result.
export const FIXED_WORK = `function fixedWork() {
  const started = performance.now();
  let x = 0;
  for (let i = 0; i < 30000000; i++) x = (x * 1.0000001 + i) % 1e9;
  return { ms: performance.now() - started, value: x };
}`;

const exec = promisify(execFile);

export async function referenceMs(): Promise<number> {
  const samples: number[] = [];
  for (let sample = 0; sample < 2; sample++) {
    // Playwright sets FORCE_COLOR; console.log(number) would include ANSI escapes.
    const { stdout } = await exec(process.execPath, ['-e', `process.stdout.write(String((${FIXED_WORK})().ms))`]);
    const ms = Number(stdout.trim());
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid machine speed reference: ${JSON.stringify(stdout)}`);
    samples.push(ms);
  }
  return Math.min(...samples);
}

export async function pageMs(page: Page): Promise<{ page: number; worker: number | null }> {
  const samples: number[] = [];
  for (let sample = 0; sample < 2; sample++) {
    const result = await page.evaluate<{ ms: number; value: number }>(`(${FIXED_WORK})()`);
    samples.push(result.ms);
  }
  // contentSecurityPolicy() allows worker-src 'self' blob: in both build modes.
  // Embed the function directly: the Worker's inherited CSP does not allow eval.
  const worker = await page.evaluate(async (source) => {
    const url = URL.createObjectURL(
      new Blob([`const work = ${source}; self.postMessage(Math.min(work().ms, work().ms));`], {
        type: 'text/javascript',
      }),
    );
    let worker: Worker | undefined;
    try {
      worker = new Worker(url);
      return await new Promise<number>((resolve, reject) => {
        worker!.onmessage = (event: MessageEvent<number>) => resolve(event.data);
        worker!.onerror = (event) => reject(new Error(`Machine speed Worker: ${event.message}`));
      });
    } finally {
      worker?.terminate();
      URL.revokeObjectURL(url);
    }
  }, FIXED_WORK);
  return { page: Math.min(...samples), worker };
}

export function classify(
  { reference, page, worker }: { reference: number; page: number; worker: number | null },
  // A-129: fast-state ratios are about 1.0; the observed slow state is 3.2–3.6.
  limit = 1.8,
): { slow: boolean; pageRatio: number; workerRatio: number | null } {
  const pageRatio = page / reference;
  const workerRatio = worker === null ? null : worker / reference;
  return { slow: pageRatio > limit || (workerRatio !== null && workerRatio > limit), pageRatio, workerRatio };
}

// Pacing is 30 × 2 s = 60 s. Fast runs took 60.06–60.12 s; slow runs took 75.9–90.9 s.
export const EDITING_OVERRUN_LIMIT_MS = 66000;

export function classifyAttempt({
  beforeSeed,
  afterSeed,
  afterRun,
  editingMs,
}: {
  beforeSeed: { slow: boolean };
  afterSeed: { slow: boolean } | null;
  afterRun: { slow: boolean } | null;
  editingMs: number | null;
}): boolean {
  return (
    beforeSeed.slow ||
    afterSeed?.slow === true ||
    afterRun?.slow === true ||
    (editingMs !== null && editingMs > EDITING_OVERRUN_LIMIT_MS)
  );
}

export function decide({
  passed,
  slow,
  launches,
  maxLaunches,
  normalFailures,
  maxNormalFailures,
}: {
  passed: boolean;
  slow: boolean;
  launches: number;
  maxLaunches: number;
  normalFailures: number;
  maxNormalFailures: number;
}): 'pass' | 'retry' | 'fail' {
  if (passed) return 'pass';
  if (launches >= maxLaunches) return 'fail';
  return slow || normalFailures < maxNormalFailures ? 'retry' : 'fail';
}

export async function calibrate(page: Page) {
  const reference = await referenceMs();
  const timings = await pageMs(page);
  return {
    referenceMs: reference,
    pageMs: timings.page,
    workerMs: timings.worker,
    ...classify({ reference, ...timings }),
  };
}
