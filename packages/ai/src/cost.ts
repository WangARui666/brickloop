import { z } from 'zod';
import type { TokenUsage } from './types.js';
import defaultPrices from '../prices.json';
const rate = z.number().finite().nonnegative();
export const priceTableSchema = z.object({
  currency: z.literal('USD'),
  description: z.string().optional(),
  providers: z.record(
    z.string(),
    z.record(z.string(), z.object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate.optional() })),
  ),
});
export type PriceTable = z.output<typeof priceTableSchema>;
export const defaultPriceTable: PriceTable = priceTableSchema.parse(defaultPrices);
export interface CostEstimate {
  amount: number | null;
  currency: 'USD';
  label: string;
}
export function estimateCost(
  table: PriceTable,
  provider: string,
  model: string,
  usage: TokenUsage,
  billing: 'api' | 'plan' = 'api',
): CostEstimate {
  if (billing === 'plan') return { amount: null, currency: 'USD', label: '使用套餐额度' };
  const price = table.providers[provider]?.[model];
  if (!price) return { amount: null, currency: 'USD', label: '未配置模型价格' };
  const cached = Math.min(usage.inputTokens, usage.cacheReadInputTokens);
  const written = Math.min(usage.inputTokens - cached, usage.cacheWriteInputTokens ?? 0);
  const amount =
    ((usage.inputTokens - cached - written) * price.input +
      usage.outputTokens * price.output +
      cached * price.cacheRead +
      written * (price.cacheWrite ?? price.input)) /
    1_000_000;
  return { amount, currency: 'USD', label: `约 US$${amount.toFixed(6)}` };
}
/** Calendar dates follow the user's local timezone, including DST and offset changes. */
export class DailyCostLedger {
  private readonly totals: Map<string, number>;
  constructor(
    snapshot: Record<string, number> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.totals = new Map(Object.entries(z.record(z.string(), rate).parse(snapshot)));
  }
  day(): string {
    const date = new Date(this.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  spent(day = this.day()): number {
    return this.totals.get(day) ?? 0;
  }
  canStart(limit: number): boolean {
    return this.spent() < rate.parse(limit);
  }
  add(amount: number, day = this.day()): void {
    this.totals.set(day, this.spent(day) + rate.parse(amount));
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.totals);
  }
}
