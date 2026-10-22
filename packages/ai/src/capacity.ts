import type { ModelCapabilities } from './types.js';

/** Leave room for the next step; unknown (or legacy zero) windows have no proactive ceiling. */
export function calculateCeiling(window: number | null): number {
  if (window === null || window <= 0) return Infinity;
  return window - Math.max(Math.floor(window * 0.15), window >= 32_000 ? 16_000 : 0);
}

/** Use the projected request size, not the compression threshold, to reserve output space. */
export function outputLimit(
  capabilities: Pick<ModelCapabilities, 'contextWindow' | 'maxOutputTokens'>,
  inputTokens: number,
  override?: number,
): number | undefined {
  const max = override ?? capabilities.maxOutputTokens;
  if (max === undefined) return undefined;
  const window = capabilities.contextWindow;
  return Math.max(
    1024,
    Math.floor(
      Math.min(
        max,
        capabilities.maxOutputTokens ?? Infinity,
        256_000,
        window !== null && window > 0 ? window - Math.ceil(inputTokens * 1.15) : Infinity,
      ),
    ),
  );
}
