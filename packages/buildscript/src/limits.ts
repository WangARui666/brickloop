import type { BuildError, BuildOptions } from './types.js';

export class BuildFailure extends Error {
  constructor(
    readonly code: BuildError['code'],
    message: string,
    readonly suggestions?: string[],
  ) {
    super(message);
  }
}
export const defaults = { cpuMs: 10_000, memoryBytes: 256 * 1024 * 1024, maxVoxels: 2_000_000, maxParts: 50_000 };
export class Budget {
  readonly limits: typeof defaults;
  readonly started = performance.now();
  bytes = 0;
  voxels = 0;
  parts = 0;
  fatal: BuildFailure | undefined;
  constructor(limits: BuildOptions['limits']) {
    this.limits = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      const value = limits?.[key];
      if (value !== undefined) {
        if (!Number.isFinite(value) || value <= 0) throw new BuildFailure('LIMIT', `Invalid limit: ${key}`);
        this.limits[key] = Math.min(defaults[key], Math.floor(value));
      }
    }
  }
  fail(code: BuildError['code'], message: string): never {
    this.fatal = new BuildFailure(code, message);
    throw this.fatal;
  }
  check() {
    if (this.fatal) throw this.fatal;
    if (performance.now() - this.started >= this.limits.cpuMs) this.fail('TIMEOUT', '运行超时 (execution timed out)');
  }
  memory(bytes: number) {
    this.bytes += bytes;
    // Reserve half for QuickJS and half for conservatively accounted host structures.
    if (this.bytes > this.limits.memoryBytes / 2) this.fail('MEMORY', 'Build memory limit exceeded');
  }
  voxel(delta: number) {
    this.voxels += delta;
    if (this.voxels > this.limits.maxVoxels) this.fail('LIMIT', 'Voxel limit exceeded');
  }
  part() {
    if (++this.parts > this.limits.maxParts) this.fail('LIMIT', 'Part limit exceeded');
  }
}
export function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000)
    throw new BuildFailure('RUNTIME', `${label} must be finite and within ±1,000,000`);
  return value;
}
export function integer(value: unknown, label: string, min = -1_000_000): number {
  const n = number(value, label);
  if (!Number.isInteger(n) || n < min) throw new BuildFailure('RUNTIME', `${label} must be an integer >= ${min}`);
  return n;
}
export function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new BuildFailure('RUNTIME', 'Expected an options object');
  return value as Record<string, unknown>;
}
