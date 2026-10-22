import { describe, expect, it } from 'vitest';
import { fromLDraw, identity, multiply, rotationAxisAngle, translation, transformPoint } from '@brickloop/core';
import {
  cloneConnector,
  ConnectorDataError,
  DEFAULT_RULES,
  instantiateConnectors,
  isCompatible,
  parseConnectorFile,
  readConnectorFile,
  transformConnector,
  writeConnectorFile,
} from '../src';
import type { Connector, ConnectorType } from '../src';
import { bar, connector, file, hole, instance } from './fixtures';

describe('connector data', () => {
  it('CON-05 gives concrete fields and file paths; read errors cannot become empty files', async () => {
    const bad = file([bar()]);
    bad.connectors[0]!.length = -1;
    bad.connectors[0]!.frame = { origin: [NaN, 0, 0], axis: [0, 2, 0], ref: [0, 1, 0] };
    const parsed = parseConnectorFile(bad, 'broken.json');
    expect(parsed.file).toBeNull();
    expect(parsed.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining([
        '$.connectors[0].length',
        '$.connectors[0].frame.origin',
        '$.connectors[0].frame.axis',
        '$.connectors[0].frame.ref',
      ]),
    );
    expect(parsed.issues.every((i) => i.file === 'broken.json')).toBe(true);
    expect(parseConnectorFile('{').issues[0]?.path).toBe('$');
    await expect(readConnectorFile('missing.json', () => Promise.reject(new Error('ENOENT')))).rejects.toThrow(
      'missing.json$',
    );
    await expect(readConnectorFile('broken.json', () => Promise.resolve('{'))).rejects.toBeInstanceOf(
      ConnectorDataError,
    );
    expect(() => writeConnectorFile(bad)).toThrow(ConnectorDataError);
  });
  it.each([
    { grid: { rows: 0, cols: 2, pitch: 20, mask: null } },
    { grid: { rows: 2, cols: 2, pitch: 0, mask: null } },
    { grid: { rows: 2, cols: 2, pitch: 20, mask: [[true]] } },
    { grid: { rows: 2, cols: 2, pitch: 20, mask: null }, cells: { tube: [[2, 0]] } },
    { rotation: Infinity },
    { stops: [30] },
    { limits: [30, -30] },
    { role: 'c' },
    { unexpected: true },
  ])('rejects invalid fields %j', (extra) => {
    expect(parseConnectorFile({ ...file([]), connectors: [{ ...bar(), ...extra }] }).file).toBeNull();
  });
  it('preserves every field through IO, copying, rotations and reflections', () => {
    const c = connector('hinge.click', {
      length: 20,
      ends: { start: 'open', end: 'closed' },
      stops: [0, 10],
      diameter: 8,
      studDepth: 4,
      rotation: 15,
      size: 'm',
      tag: 'example',
      role: 'a',
      limits: [-45, 60],
    });
    const copy = cloneConnector(c);
    expect(copy).toEqual(c);
    expect(copy.frame).not.toBe(c.frame);
    const saved = parseConnectorFile(writeConnectorFile(file([copy]))).file!;
    const m = multiply(translation([10, 20, 30]), rotationAxisAngle([1, 1, 0], 63));
    const transformed = transformConnector(saved.connectors[0]!, m);
    const { frame: originalFrame, ...semantics } = c;
    const { frame: worldFrame, ...worldSemantics } = transformed;
    expect(worldSemantics).toEqual(semantics);
    expect(worldFrame.origin).toEqual(transformPoint(m, originalFrame.origin));
    const reflected = transformConnector(c, fromLDraw([0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 1]));
    expect(reflected.limits).toEqual([-45, 60]);
    expect(reflected.role).toBe('a');
  });
  it('transforms grid cells individually, including masks and mirror handedness', () => {
    const grid = connector('stud', {
      grid: {
        rows: 2,
        cols: 2,
        pitch: 20,
        mask: [
          [true, false],
          [false, true],
        ],
      },
    });
    const mirror = fromLDraw([30, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const world = instantiateConnectors({ ...instance('grid', [grid]), worldMatrix: mirror });
    expect(world.map((w) => w.connector.frame.origin)).toEqual([
      [30, 0, 0],
      [10, 0, 20],
    ]);
    const transformed = transformConnector(grid, mirror);
    const rebased = instantiateConnectors({ ...instance('grid', [transformed]), worldMatrix: identity() });
    expect(rebased.map((w) => w.connector.frame.origin).sort()).toEqual(
      world.map((w) => w.connector.frame.origin).sort(),
    );
    expect(grid.grid!.mask).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

describe('CON-11 independent compatibility table', () => {
  const make = (type: ConnectorType, role: 'a' | 'b'): Connector =>
    connector(type, { length: 10, diameter: 8, studDepth: 10, size: 's', role, tag: 'pair' });
  it.each(DEFAULT_RULES.pairs)('$a / $b legal both ways, mismatched pair rejected', (rule) => {
    const a = make(rule.a, 'a'),
      b = make(rule.b, 'b');
    expect(isCompatible(a, b)).toEqual({ ok: true, reason: 'compatible' });
    expect(isCompatible(b, a).ok).toBe(true);
    const invalid = rule.role ? { ...b, role: 'a' as const } : connector('slider', { length: 10 });
    expect(isCompatible(a, invalid).ok).toBe(false);
  });
  it('rejects thin stems in normal Bar holes, undersized holes, bad roles and tags', () => {
    expect(isCompatible(connector('bar.thin', { length: 10, diameter: 3 }), hole()).reason).toBe('type');
    expect(isCompatible(bar(), { ...hole(), diameter: 6 }).reason).toBe('diameter');
    expect(isCompatible(connector('ball', { size: 's' }), connector('ball.socket', { size: 'l' })).reason).toBe('size');
    expect(isCompatible(make('fixed', 'a'), { ...make('fixed', 'b'), tag: 'other' }).reason).toBe('tag');
    expect(isCompatible(connector('stud'), connector('pin.hole', { length: 20, studDepth: 3 })).reason).toBe(
      'stud_depth',
    );
    expect(isCompatible(connector('stud'), connector('stud')).reason).toBe('type');
  });
});
