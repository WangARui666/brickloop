import { it, expect } from 'vitest';
import { build } from './fixtures.js';

it('BS-04 packs 2,000 bricks within two seconds and repeats the same output hash', async () => {
  const code = `box(0,0,0,160,100,6,'red')`;
  const a = await build(code),
    b = await build(code);
  expect(a.stats.parts).toBe(2000);
  expect(b.stats.parts).toBe(2000);
  expect(a.stats.ms).toBeLessThanOrEqual(2000);
  expect(b.stats.ms).toBeLessThanOrEqual(2000);
  expect(a.hash).toBe(b.hash);
}, 10000);
