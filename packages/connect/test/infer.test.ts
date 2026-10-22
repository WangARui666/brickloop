import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
import { describe, expect, it } from 'vitest';
import { LibraryResolver, createMemorySource } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { importPack } from '@brickloop/catalog';
import { connectorCells, inferConnectors, parseConnectorFile, readConnectorFile } from '../src';
import type { ConnectorFile, ConnectorType } from '../src';

const resolver = createLibraryResolver({ libraryDir: path.join(root, 'library/ldraw') });
type Expected = Partial<Record<ConnectorType, number[][]>>;
const grid = (cols: number, rows: number, y: number): number[][] =>
  Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => [-(cols - 1) * 10 + c * 20, y, -(rows - 1) * 10 + r * 20]),
  ).flat();
const standard = (cols: number, rows: number, h: number): Expected => ({
  stud: grid(cols, rows, 0),
  antistud: grid(cols, rows, h),
  ...(rows === 1 && cols > 1
    ? { 'bar.post': Array.from({ length: cols - 1 }, (_, i) => [-(cols - 2) * 10 + i * 20, 4, 0]) }
    : {}),
  ...(rows === 2
    ? { 'antistud.tube': Array.from({ length: cols - 1 }, (_, i) => [-(cols - 2) * 10 + i * 20, h, 0]) }
    : {}),
});
// Expected coordinates were derived from the DAT primitive transforms and cavity
// outlines, not generated snapshots. Raw inference and corrected files are separate.
const expected: Record<string, Expected> = {
  '3001': standard(4, 2, 24),
  '3003': standard(2, 2, 24),
  '3004': standard(2, 1, 24),
  '3020': standard(4, 2, 8),
  '3022': standard(2, 2, 8),
  '3023': standard(2, 1, 8),
  '3023b': standard(2, 1, 8),
  '3024': standard(1, 1, 8),
  '3069b': { antistud: grid(2, 1, 8) },
  '3062b': { 'stud.hollow': [[0, 0, 0]], 'antistud.tube': [[0, 24, 0]] },
  '4073': { stud: [[0, 0, 0]], 'antistud.tube': [[0, 8, 0]] },
  '6141': { stud: [[0, 0, 0]], 'antistud.tube': [[0, 8, 0]] },
  '3794': { antistud: grid(2, 1, 8), 'bar.post': [[0, 4, 0]], 'stud.hollow': [[0, 0, 0]] },
  '2412': {},
  '2412b': {},
  '3700': {
    'bar.post': [[0, 18, 0]],
    'pin.hole': [
      [0, 10, -10],
      [0, 10, 10],
    ],
    'stud.hollow': grid(2, 1, 0),
  },
  '3713': { 'axle.hole': [[0, 0, -10]] },
  '3749': { axle: [[0, 0, 0]], pin: [[0, 0, 0]] },
  '3673': {
    pin: [
      [0, 0, 0],
      [0, 0, 0],
    ],
  },
  '6558': {
    pin: [
      [-10, 0, 0],
      [-10, 0, 0],
    ],
  },
  '32523': { 'pin.hole': [-10, 10].flatMap((y) => [-20, 0, 20].map((z) => [0, y, z])) },
  '4274': { pin: [[0, 0, 0]], 'stud.hollow': [[0, 0, 0]] },
  '4085': { antistud: [[0, 8, 0]], stud: [[0, 0, 0]], clip: [[0, 0, -20]] },
  '4085c': { antistud: [[0, 8, 0]], stud: [[0, 0, 0]], clip: [[0, 0, -20]] },
  '15712': { antistud: [[0, 8, 0]] },
  '61252': { antistud: [[0, 8, 0]], stud: [[0, 0, 0]], clip: [[-4, 2, -20]] },
  '14417': { antistud: grid(2, 1, 8), ball: [[0, 4, -20]], 'bar.post': [[0, 4, 0]], 'stud.hollow': grid(2, 1, 0) },
  '14418': { 'ball.socket': [[30, 4, 0]], 'bar.post': [[0, 4, 0]], 'stud.hollow': grid(2, 1, 0) },
  '3626': { 'stud.hollow': [[0, 0, 0]] },
  '3626c': { 'stud.hollow': [[0, 0, 0]] },
  '973': {},
  '970': {},
};
function positions(file: ConnectorFile): Expected {
  const result: Expected = {};
  for (const c of file.connectors)
    (result[c.type] ??= []).push(...connectorCells(c).map((cell) => Array.from(cell.origin)));
  for (const value of Object.values(result)) value.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
  return result;
}
function sorted(expected: Expected): Expected {
  return Object.fromEntries(
    Object.entries(expected).map(([type, points]) => [
      type,
      [...points].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!),
    ]),
  );
}
describe('real LDraw common parts', () => {
  it.each(Object.entries(expected))('%s inference: exact type counts and every position', async (id, wanted) => {
    const inferred = await inferConnectors(`${id}.dat`, resolver);
    expect(inferred.status).toBe('inferred');
    expect(inferred.partId).toBe(`ld:${id}`);
    expect(positions(inferred)).toEqual(sorted(wanted));
    expect(parseConnectorFile(inferred).issues).toEqual([]);
  });
  it('CON-10 3001 grid dimensions and the three tube cells', async () => {
    const inferred = await inferConnectors('3001.dat', resolver);
    const top = inferred.connectors.find((c) => c.type === 'stud')!,
      bottom = inferred.connectors.find((c) => c.type === 'antistud')!;
    expect(top.grid).toEqual({ rows: 2, cols: 4, pitch: 20, mask: null });
    expect(bottom.grid).toEqual(top.grid);
    expect(bottom.cells).toEqual({
      tube: [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    });
    expect(bottom.frame.origin).toEqual([-30, 24, -10]);
    expect(top.frame.origin).toEqual([-30, 0, -10]);
  });
  it('6558 merges the long pin half across consecutive primitives without losing its collar', async () => {
    const inferred = await inferConnectors('6558.dat', resolver);
    expect(inferred.connectors.map((c) => c.length).sort()).toEqual([20, 40]);
    expect(inferred.connectors.every((c) => c.ends?.start === 'closed')).toBe(true);
  });
  it.each(['2357', '2420', '14719'])('%s corner footprint leaves the missing cell masked', async (id) => {
    const file = await inferConnectors(`${id}.dat`, resolver);
    const bottom = file.connectors.find((c) => c.type === 'antistud')!;
    expect(bottom.grid).toMatchObject({ rows: 2, cols: 2 });
    expect(connectorCells(bottom)).toHaveLength(3);
    if (id !== '14719') {
      const top = file.connectors.filter((c) => c.type === 'stud').flatMap(connectorCells);
      expect(
        connectorCells(bottom)
          .map((c) => [c.origin[0], c.origin[2]])
          .sort(),
      ).toEqual(top.map((c) => [c.origin[0], c.origin[2]]).sort());
    }
  });
  it.each([
    ['2412', 'antistud', 2, [-10, 8, 0]],
    ['2412b', 'antistud', 2, [-10, 8, 0]],
    ['3700', 'antistud', 2, [-10, 24, 0]],
    ['14418', 'antistud', 2, [-10, 8, 0]],
    ['15712', 'clip', 1, [0, -6, -4]],
    ['3626', 'fixed', 1, [0, 24, 0]],
    ['3626c', 'fixed', 1, [0, 24, 0]],
    ['973', 'fixed', 4, [0, 0, 0]],
    ['970', 'fixed', 3, [0, 0, 0]],
    ['3815b', 'fixed', 3, [0, 0, 0]],
  ] as const)('%s manual draft supplies %s and its measured location', async (id, type, count, origin) => {
    const file = await readConnectorFile(`library/connectors/${id}.json`, (name) =>
      fs.readFile(path.join(root, name), 'utf8'),
    );
    expect(file.status).toBe('draft');
    const found = file.connectors.filter((c) => c.type === type);
    expect(found.flatMap(connectorCells)).toHaveLength(count);
    expect(found[0]!.frame.origin).toEqual(origin);
  });
  it('all actual demo pack IDs have valid files, distinct from the legacy acceptance IDs', async () => {
    const result = await importPack(path.join(root, 'library/packs/demo'), {
      libraryDir: path.join(root, 'library/ldraw'),
    });
    expect(result.pack).toBeDefined();
    expect(result.pack!.parts).toHaveLength(222);
    for (const part of result.pack!.parts) {
      const file = await readConnectorFile(`library/connectors/${part.partId.slice(3)}.json`, (name) =>
        fs.readFile(path.join(root, name), 'utf8'),
      );
      expect(file.partId).toBe(part.partId);
      expect(file.connectors.length, part.partId).toBeGreaterThan(0);
    }
  }, 120000);
});

describe('recursive inference', () => {
  it('accumulates rotations and nonuniform axial scales without duplicate primitive children', async () => {
    const source = createMemorySource('fixture', {
      'parts/root.dat': '0 Root\n1 16 10 20 30 0 0 1 0 1 0 -1 0 0 s/inner.dat',
      'parts/s/inner.dat': '0 Inner\n1 16 5 0 0 1 0 0 0 -3 0 0 0 1 stud3.dat',
      'p/stud3.dat': '0 Stud post\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
      'p/stud.dat': '0 Stud',
    });
    const file = await inferConnectors('root.dat', new LibraryResolver({ library: source }));
    expect(file.connectors).toHaveLength(1);
    expect(file.connectors[0]!.frame.origin).toEqual([10, 20, 25]);
    expect(file.connectors[0]!.frame.axis).toEqual([0, 1, 0]);
    expect(file.connectors[0]!.length).toBe(12);
  });
  it('missing files and cycles throw explicit errors rather than writing empty successes', async () => {
    const missing = new LibraryResolver({
      embedded: { 'root.dat': '0 Root\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 missing.dat' },
    });
    await expect(inferConnectors('root.dat', missing)).rejects.toThrow('missing.dat');
    const cyclic = new LibraryResolver({ embedded: { 'root.dat': '0 Root\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 root.dat' } });
    await expect(inferConnectors('root.dat', cyclic)).rejects.toThrow('Cyclic reference');
  });
});
