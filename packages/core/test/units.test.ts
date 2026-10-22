import { describe, expect, it } from 'vitest';
import { fromLdu, toLdu } from '../src/index';
import type { LengthUnit } from '../src/index';

const units: { unit: LengthUnit; ldu: number }[] = [
  { unit: 'ldu', ldu: 1 },
  { unit: 'stud', ldu: 20 },
  { unit: 'plate', ldu: 8 },
  { unit: 'brick', ldu: 24 },
  { unit: 'mm', ldu: 2.5 },
  { unit: 'cm', ldu: 25 },
  { unit: 'inch', ldu: 63.5 },
];

describe('length units', () => {
  it.each(units)('converts one $unit to $ldu LDU and back', ({ unit, ldu }) => {
    expect(toLdu(1, unit)).toBeCloseTo(ldu, 12);
    expect(fromLdu(ldu, unit)).toBeCloseTo(1, 12);
  });

  it.each(units)('round-trips zero, negative, and fractional values in $unit', ({ unit }) => {
    for (const value of [0, -12.75, 0.125, 42.625]) {
      expect(fromLdu(toLdu(value, unit), unit)).toBeCloseTo(value, 12);
      expect(toLdu(fromLdu(value, unit), unit)).toBeCloseTo(value, 12);
    }
  });

  it('converts the 3001 bounding box: 80 × 28 × 40 LDU, including studs', () => {
    const [width, height, depth] = [80, 28, 40] as const;

    expect(fromLdu(width, 'stud')).toBe(4);
    expect(fromLdu(depth, 'stud')).toBe(2);
    expect(height).toBe(toLdu(1, 'brick') + 4);
    expect(fromLdu(width, 'cm')).toBeCloseTo(3.2, 12);
    expect(fromLdu(height, 'cm')).toBeCloseTo(1.12, 12);
    expect(fromLdu(depth, 'cm')).toBeCloseTo(1.6, 12);
    expect(toLdu(3.2, 'cm')).toBeCloseTo(width, 12);
    expect(toLdu(1.12, 'cm')).toBeCloseTo(height, 12);
    expect(toLdu(1.6, 'cm')).toBeCloseTo(depth, 12);
  });
});
