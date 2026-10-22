import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryResolver, createMemorySource } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { connectorCells, inferConnectors, isCompatible, parseConnectorFile } from '../src';
import type { ConnectorType } from '../src';

const resolver = createLibraryResolver({ libraryDir: path.resolve('library/ldraw') });
const read = async (id: string) => {
  const parsed = parseConnectorFile(await fs.readFile(`library/connectors/${id}.json`, 'utf8'));
  expect(parsed.issues, id).toEqual([]);
  return parsed.file!;
};
// Independent measured anchors; these are not generated snapshots of the files.
const anchors: [string, ConnectorType, number[]][] = [
  ['11090', 'bar.hole', [0, 30, 0]],
  ['11477', 'antistud', [0, -8, 10]],
  ['24246', 'antistud', [0, 8, 0]],
  ['25269', 'antistud', [0, 8, 0]],
  ['2654a', 'stud.hollow', [-10, 0, -10]],
  ['28192', 'antistud', [0, 24, -20]],
  ['30027b', 'wheel.hole', [0, 0, 10]],
  ['30648', 'fixed', [0, 0, 0]],
  ['32072', 'axle.hole', [0, 0, -10]],
  ['32123a', 'axle.hole', [0, 0, -5]],
  ['32556a', 'pin', [-8, 0, 0]],
  ['3648b', 'axle.hole', [0, 0, -9.625]],
  ['3650c', 'axle.hole', [0, 0, -8]],
  ['3816c', 'antistud', [-10, 28, -1.25]],
  ['3817c', 'antistud', [10, 28, -1.25]],
  ['3818', 'fixed', [-5, 18.9, -9.9]],
  ['3819', 'fixed', [5, 18.9, -9.9]],
  ['3820', 'fixed', [0, 0, 0]],
  ['3854', 'fixed', [0, 30, 0]],
  ['3937', 'fixed', [0, 10, 0]],
  ['4095', 'bar', [0, -4, 0]],
  ['44309', 'fixed', [0, 0, 0]],
  ['4624', 'wheel.hole', [0, 0, 8]],
  ['48729b', 'clip', [0, 0, -4]],
  ['50950', 'antistud', [0, 16, 20]],
  ['54200', 'antistud', [0, 0, 0]],
  ['56145', 'axle.hole', [0, 0, 0]],
  ['56898', 'fixed', [0, 0, 0]],
  ['6014a', 'wheel.hole', [0, 0, 8]],
  ['60601', 'fixed', [0, 4, -5]],
  ['60602', 'fixed', [0, 4, -5]],
  ['63965a', 'bar', [0, -8, 0]],
  ['86210', 'fixed', [0, 0, 0]],
  ['98138', 'antistud.tube', [0, 8, 0]],
];
describe('the 34 previously empty demo parts', () => {
  it.each(anchors)('%s has an authored %s at the measured seat', async (id, type, origin) => {
    const file = await read(id);
    expect(file.status).toBe('draft');
    expect(
      file.connectors
        .filter((c) => c.type === type)
        .flatMap(connectorCells)
        .map((c) => c.origin),
    ).toContainEqual(origin);
    expect(file.source).toMatch(/LDraw.*(dat|孔|腔)/);
  });
  it.each([
    ['30648', '55982'],
    ['44309', '56145'],
    ['56898', '60208'],
    ['3937', '3938'],
    ['60601', '60592'],
    ['60602', '60593'],
    ['86210', '60594'],
    ['3854', '3853'],
    ['3818', '3820'],
    ['3819', '3820'],
    ['3816c', '3815b'],
    ['3817c', '3815b'],
  ])('%s has a compatible authored counterpart on %s', async (a, b) => {
    const [left, right] = await Promise.all([read(a!), read(b!)]);
    expect(left.connectors.some((x) => right.connectors.some((y) => isCompatible(x, y).ok))).toBe(true);
  });
  it('tyre diameter alone cannot match different bead widths; the plain hinge has no click teeth', async () => {
    const [tyre, rim, hinge] = await Promise.all([read('56898'), read('56145'), read('3937')]);
    expect(tyre.connectors.some((a) => rim.connectors.some((b) => isCompatible(a, b).ok))).toBe(false);
    expect(hinge.connectors.some((c) => c.type === 'hinge.click')).toBe(false);
  });
});

const mapped: [string, ConnectorType, number[], number | undefined][] = [
  ['clip5.dat', 'clip', [0, -4, 0], 8],
  ['stud6a.dat', 'stud.hollow', [0, 0, 0], undefined],
  ['stud4o.dat', 'antistud.tube', [0, -4, 0], 4],
  ['axlehol5.dat', 'axle.hole', [0, 0, 0], 1],
  ['axl2hole.dat', 'axle.hole', [0, 0, 0], 1],
  ['axl3hole.dat', 'axle.hole', [0, 0, 0], 1],
  ['connect2.dat', 'pin', [0, 0, 0], 20],
  ['wpinhol2.dat', 'wheel.hole', [0, -1, 0], 1],
  ['wpin.dat', 'wheel.pin', [0, 0, 0], 12],
];
describe('additional LDraw primitive semantics', () => {
  it.each(mapped)('%s maps %s through a rotated, axially scaled reflection', async (name, type, origin, length) => {
    const source = createMemorySource('mapping-fixture', {
      'parts/root.dat': `0 Fixture\n1 16 10 20 30 0 0 -1 0 3 0 -1 0 0 ${name}`,
      [`p/${name}`]: '0 Primitive\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
      'p/stud.dat': '0 Stud',
    });
    const file = await inferConnectors('root.dat', new LibraryResolver({ library: source }));
    expect(file.connectors).toHaveLength(1);
    expect(file.connectors[0]).toMatchObject({
      type,
      frame: { origin: [10 - origin[2]!, 20 + origin[1]! * 3, 30 - origin[0]!], axis: [0, -1, 0] },
    });
    expect(file.connectors[0]!.length).toBe(length === undefined ? undefined : length * 3);
    expect(parseConnectorFile(file).issues).toEqual([]);
  });
  it.each([
    ['2654a', 'stud.hollow', 4],
    ['32072', 'axle.hole', 1],
    ['32123a', 'axle.hole', 1],
    ['3650c', 'axle.hole', 1],
    ['56145', 'axle.hole', 1],
    ['98138', 'antistud.tube', 1],
    ['11090', 'clip', 1],
    ['30027b', 'wheel.hole', 1],
    ['32556a', 'pin', 2],
  ] as const)('%s is now recognized as %s from actual geometry', async (id, type, count) => {
    const file = await inferConnectors(`${id}.dat`, resolver);
    expect(file.connectors.filter((c) => c.type === type).flatMap(connectorCells)).toHaveLength(count);
  });
  it.each([
    ['4095', 116, 12, -4],
    ['63965a', 96, 16, -8],
  ] as const)('%s separates both shafts at the stop faces', async (id, long, short, seat) => {
    const file = await inferConnectors(`${id}.dat`, resolver);
    expect(file.connectors).toHaveLength(2);
    expect(file.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'bar',
          length: long,
          frame: { origin: [0, seat, 0], axis: [0, -1, 0], ref: [1, 0, 0] },
          stops: [0],
          ends: { start: 'closed', end: 'open' },
        }),
        expect.objectContaining({
          type: 'bar',
          length: short,
          frame: { origin: [0, 0, 0], axis: [0, 1, 0], ref: [1, 0, 0] },
          stops: [0],
        }),
      ]),
    );
  });
  it.each(['inverted', 'one-ended', 'elliptical', 'sheared'])(
    'stopped-bar recognition rejects %s geometry',
    async (mode) => {
      const lines = [
        '0 Bar 6L with Stop',
        ...(mode === 'inverted' ? ['0 BFC INVERTNEXT'] : []),
        `1 16 0 12 0 4 ${mode === 'sheared' ? 1 : 0} 0 0 -12 0 0 0 ${mode === 'elliptical' ? 3 : 4} 4-4cylc.dat`,
        ...(mode === 'one-ended' ? [] : ['1 16 0 -120 0 4 0 0 0 116 0 0 0 4 4-4cylc.dat']),
        '1 16 0 0 0 6 0 0 0 -4 0 0 0 6 4-4cyli.dat',
      ];
      const source = createMemorySource('negative', {
        'parts/root.dat': lines.join('\n'),
        'p/4-4cylc.dat': '0 Capped cylinder',
        'p/4-4cyli.dat': '0 Cylinder',
      });
      expect((await inferConnectors('root.dat', new LibraryResolver({ library: source }))).connectors).toEqual([]);
    },
  );
});
