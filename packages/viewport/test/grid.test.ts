import { describe, expect, it } from 'vitest';
import { defaultGrid, gridLines } from '../src/grid';

describe('grid parameters', () => {
  it('defaults to 64 × 64 studs with 20 LDU lines, 160 LDU major lines and unique axes', () => {
    const lines = gridLines(defaultGrid);
    expect(lines).toHaveLength(130);
    expect(Math.min(...lines.map((line) => line.coordinate))).toBe(-640);
    expect(Math.max(...lines.map((line) => line.coordinate))).toBe(640);
    expect(lines.filter((line) => line.kind === 'major')).toHaveLength(16);
    expect(lines.filter((line) => line.kind === 'x' || line.kind === 'z')).toEqual([
      { coordinate: 0, parallel: 'x', kind: 'x' },
      { coordinate: 0, parallel: 'z', kind: 'z' },
    ]);
  });
  it.each([10, 5])('subdivides at %i LDU without duplicating the stud or major lines', (stepLdu) => {
    const lines = gridLines({ ...defaultGrid, stepLdu });
    expect(lines).toHaveLength(2 * (1280 / stepLdu + 1));
    expect(lines.filter((line) => line.kind !== 'subdivision')).toEqual(gridLines(defaultGrid));
    expect(new Set(lines.map((line) => `${line.parallel}:${line.coordinate}`)).size).toBe(lines.length);
  });
  it('keeps the origin aligned for odd sizes and can be hidden', () => {
    const lines = gridLines({ visible: false, sizeStuds: 3, stepLdu: 20 });
    expect(lines.map((line) => line.coordinate)).toEqual([-20, -20, 0, 0, 20, 20]);
  });
  it('rejects invalid sizes and unsupported increments', () => {
    for (const sizeStuds of [0, -1, 1.5, Infinity, 1025]) {
      expect(() => gridLines({ ...defaultGrid, sizeStuds })).toThrow(RangeError);
    }
    for (const stepLdu of [0, 1, 8, 40, NaN]) {
      expect(() => gridLines({ ...defaultGrid, stepLdu })).toThrow(RangeError);
    }
  });
});
