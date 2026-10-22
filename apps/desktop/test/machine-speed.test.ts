import { describe, expect, it, vi } from 'vitest';
import { classify, classifyAttempt, decide, EDITING_OVERRUN_LIMIT_MS, referenceMs } from '../e2e/machine-speed';

it('measures a finite reference duration with forced console colors', async () => {
  vi.stubEnv('FORCE_COLOR', '1');
  try {
    const duration = await referenceMs();
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThan(0);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('machine speed classification', () => {
  it('accepts fast main-thread and Worker samples', () => {
    expect(classify({ reference: 400, page: 420, worker: 380 })).toEqual({
      slow: false,
      pageRatio: 1.05,
      workerRatio: 0.95,
    });
  });

  it('detects a slow main thread even when the Worker is fast', () => {
    expect(classify({ reference: 400, page: 1320, worker: 400 })).toEqual({
      slow: true,
      pageRatio: 3.3,
      workerRatio: 1,
    });
  });

  it('detects a slow Worker even when the main thread is fast', () => {
    expect(classify({ reference: 400, page: 400, worker: 1400 })).toEqual({
      slow: true,
      pageRatio: 1,
      workerRatio: 3.5,
    });
  });

  it.each([
    { page: 400, slow: false, pageRatio: 1 },
    { page: 1320, slow: true, pageRatio: 3.3 },
  ])('classifies the main thread without a Worker: $page ms', ({ page, slow, pageRatio }) => {
    expect(classify({ reference: 400, page, worker: null })).toEqual({ slow, pageRatio, workerRatio: null });
  });

  it('accepts both ratios exactly at the default limit', () => {
    expect(classify({ reference: 400, page: 720, worker: 720 })).toEqual({
      slow: false,
      pageRatio: 1.8,
      workerRatio: 1.8,
    });
  });

  it('uses a supplied limit and rejects only ratios above it', () => {
    expect(classify({ reference: 400, page: 800, worker: 800 }, 2).slow).toBe(false);
    expect(classify({ reference: 400, page: 801, worker: 800 }, 2).slow).toBe(true);
    expect(classify({ reference: 400, page: 800, worker: 801 }, 2).slow).toBe(true);
  });
});

describe('attempt classification', () => {
  const normal = {
    beforeSeed: { slow: false },
    afterSeed: { slow: false },
    afterRun: { slow: false },
    editingMs: 60120,
  };

  it('accepts normal calibrations and paced edits', () => {
    expect(classifyAttempt(normal)).toBe(false);
  });

  it.each(['beforeSeed', 'afterSeed', 'afterRun'] as const)('detects a slow %s alone', (phase) => {
    expect(classifyAttempt({ ...normal, [phase]: { slow: true } })).toBe(true);
  });

  it('detects editing overrun even when all calibrations are normal', () => {
    expect(classifyAttempt({ ...normal, editingMs: 75900 })).toBe(true);
  });

  it('accepts editing exactly at the overrun limit', () => {
    expect(classifyAttempt({ ...normal, editingMs: EDITING_OVERRUN_LIMIT_MS })).toBe(false);
  });

  it('classifies an attempt rejected before seeding without later samples', () => {
    expect(classifyAttempt({ beforeSeed: { slow: true }, afterSeed: null, afterRun: null, editingMs: null })).toBe(
      true,
    );
  });

  it('classifies an attempt rejected after seeding without a measured run', () => {
    expect(classifyAttempt({ ...normal, afterSeed: { slow: true }, afterRun: null, editingMs: null })).toBe(true);
  });
});

describe('attempt decision', () => {
  it.each([
    { passed: true, slow: false, launches: 1, normalFailures: 0, expected: 'pass' },
    { passed: true, slow: false, launches: 10, normalFailures: 3, expected: 'pass' },
    { passed: true, slow: true, launches: 10, normalFailures: 3, expected: 'pass' },
    { passed: false, slow: false, launches: 1, normalFailures: 1, expected: 'retry' },
    { passed: false, slow: false, launches: 2, normalFailures: 2, expected: 'retry' },
    { passed: false, slow: false, launches: 3, normalFailures: 3, expected: 'fail' },
    { passed: false, slow: true, launches: 9, normalFailures: 2, expected: 'retry' },
    { passed: false, slow: true, launches: 10, normalFailures: 0, expected: 'fail' },
    { passed: false, slow: true, launches: 11, normalFailures: 0, expected: 'fail' },
    { passed: false, slow: false, launches: 10, normalFailures: 1, expected: 'fail' },
    { passed: false, slow: false, launches: 11, normalFailures: 2, expected: 'fail' },
  ])(
    '$expected for passed=$passed, slow=$slow, launches=$launches, normalFailures=$normalFailures',
    ({ expected, ...input }) => {
      expect(decide({ ...input, maxLaunches: 10, maxNormalFailures: 3 })).toBe(expected);
    },
  );

  it('keeps normal failure counts across intervening slow failures', () => {
    const attempts = [
      { slow: false, normalFailures: 1 },
      { slow: true, normalFailures: 1 },
      { slow: false, normalFailures: 2 },
      { slow: true, normalFailures: 2 },
      { slow: false, normalFailures: 3 },
    ];
    expect(
      attempts.map((attempt, index) =>
        decide({ ...attempt, passed: false, launches: index + 1, maxLaunches: 10, maxNormalFailures: 3 }),
      ),
    ).toEqual(['retry', 'retry', 'retry', 'retry', 'fail']);
  });
});
