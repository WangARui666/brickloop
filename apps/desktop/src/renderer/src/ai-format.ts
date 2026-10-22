/** Two significant digits below one cent; cents at and above it. */
export function formatUsd(amount: number): string {
  if (amount === 0) return '0.00';
  if (amount >= 0.01) return amount.toFixed(2);
  const significant = amount.toPrecision(2);
  const exponent = Math.floor(Math.log10(Number(significant)));
  // Drop trailing zeros so 0.00060 reads as 0.0006.
  return Number(significant)
    .toFixed(Math.min(100, Math.max(0, 1 - exponent)))
    .replace(/0+$/, '');
}
