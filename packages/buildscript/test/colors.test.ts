import { expect, it } from 'vitest';
import { ColorMapper } from '../src/colors.js';
import { runBuildScript, standardPackingParts } from '../src/index.js';
import { Budget, BuildFailure } from '../src/limits.js';
import type { BuildWarning, CompactColor } from '../src/types.js';

const colors: CompactColor[] = [
  { id: 'c:transparent-red', name: 'Transparent Red', rgb: '#C91A09', alpha: 0.5, factory: true },
  { id: 'c:bright-red', name: 'Bright Red', rgb: '#B40000', alpha: 1, factory: true },
  { id: 'c:metallic-bright-red', name: 'Metallic Bright Red', rgb: '#D60026', alpha: 1, factory: true },
  { id: 'c:transparent-blue', name: 'Transparent Blue', rgb: '#0020A0', alpha: 0.5, factory: true },
  { id: 'c:bright-blue', name: 'Bright Blue', rgb: '#1E5AA8', alpha: 1, factory: true },
  { id: 'c:dark-green', name: 'Dark Green', rgb: '#00852B', alpha: 1, factory: true },
  { id: 'c:medium-stone-grey', name: 'Medium Stone Grey', rgb: '#969696', alpha: 1, factory: true },
  { id: 'c:transparent', name: 'Transparent', rgb: '#FCFCFC', alpha: 0.5, factory: true },
  { id: 'c:white', name: 'White', rgb: '#F4F4F4', alpha: 1, factory: true },
];
function mapper(available = colors, all = colors) {
  const warnings: BuildWarning[] = [],
    budget = new Budget(undefined);
  return { map: new ColorMapper(available, all, warnings, budget), warnings, budget };
}
function swatch(id: string, rgb: string, alpha: number): CompactColor {
  return { id, name: id, rgb, alpha, factory: true };
}

it.each([
  ['red', 'c:bright-red'],
  ['blue', 'c:bright-blue'],
  ['green', 'c:dark-green'],
  ['gray', 'c:medium-stone-grey'],
  ['grey', 'c:medium-stone-grey'],
  ['white', 'c:white'],
  ['bright_red', 'c:bright-red'],
  ['__BRIGHT--RED__', 'c:bright-red'],
])('BS-08a resolves %s to an opaque standard color', (value, expected) => {
  // The old mapper resolves red to c:transparent-red on this palette.
  const { map, warnings } = mapper();
  expect(map.resolve(value)).toBe(expected);
  expect(warnings).toEqual([]);
});

it.each([
  ['trans-red', 'c:transparent-red'],
  ['Trans_Red', 'c:transparent-red'],
  ['TRANS RED', 'c:transparent-red'],
  ['translucent red', 'c:transparent-red'],
  ['transparent-red', 'c:transparent-red'],
  [' clear__red ', 'c:transparent-red'],
  ['trans-blue', 'c:transparent-blue'],
  ['glass blue', 'c:transparent-blue'],
  ['clear', 'c:transparent'],
  ['trans clear', 'c:transparent'],
  ['transparent', 'c:transparent'],
  ['#C91A0980', 'c:transparent-red'],
  ['C91A0980', 'c:transparent-red'],
  ['#C91A0900', 'c:transparent-red'],
])('BS-08b honors transparent intent in %s without a distance warning', (value, expected) => {
  const { map, warnings } = mapper();
  expect(map.resolve(value)).toBe(expected);
  expect(warnings).toEqual([]);
});

it.each(['#C91A09FF', '#C91A09ff', '#C91A09', 'C91A09ff'])('BS-08b treats %s as opaque', (value) => {
  const { map } = mapper();
  expect(colors.find((c) => c.id === map.resolve(value))!.alpha).toBe(1);
});

it('BS-08b uses the base catalog name or generic value when no Transparent base name exists', () => {
  const { map, warnings } = mapper();
  expect(map.resolve('glass bright blue')).toBe('c:transparent-blue');
  expect(map.resolve('trans green')).toBe('c:transparent');
  expect(warnings.every((warning) => warning.code === 'COLOR_DISTANCE')).toBe(true);
});

it.each([
  ['c:transparent-red', 'c:transparent-red'],
  ['Transparent Red', 'c:transparent-red'],
  ['transparent red', 'c:transparent-red'],
  ['c:bright-red', 'c:bright-red'],
  ['BRIGHT RED', 'c:bright-red'],
])('BS-08c preserves exact matching for %s', (value, expected) => {
  const { map, warnings } = mapper();
  expect(map.resolve(value)).toBe(expected);
  expect(warnings).toEqual([]);
});

it('BS-08c exact names take priority over generic values and transparent words', () => {
  const exact = { ...swatch('exact', '#123456', 0.5), name: 'Red' },
    glass = { ...swatch('glass', '#654321', 1), name: 'Glass Blue' };
  const { map, warnings } = mapper([exact, glass, ...colors]);
  expect(map.resolve('red')).toBe('exact');
  expect(map.resolve('glass blue')).toBe('glass');
  expect(warnings).toEqual([]);
});

it.each(['#ff0000', 'ff0000'])('BS-08d maps %s only to opaque colors and retains distance warnings', (value) => {
  const { map, warnings } = mapper();
  const id = map.resolve(value);
  expect(id).toBe('c:metallic-bright-red');
  expect(colors.find((c) => c.id === id)!.alpha).toBe(1);
  expect(warnings).toEqual([
    {
      code: 'COLOR_DISTANCE',
      message: `${value} mapped to Metallic Bright Red (c:metallic-bright-red); Lab distance 26.8`,
    },
  ]);
});

it('BS-08d excludes transparent blue for an opaque blue hex value', () => {
  const { map, warnings } = mapper();
  const id = map.resolve('#0000ff');
  expect(id).not.toBe('c:transparent-blue');
  expect(colors.find((c) => c.id === id)!.alpha).toBe(1);
  expect(warnings.map((w) => w.code)).toEqual(['COLOR_DISTANCE']);
});

it.each(['c:transparent-red', 'Transparent Red', 'TRANSPARENT RED', 'trans-red'])(
  'BS-08e maps out-of-scope %s to the closest available transparent color',
  (value) => {
    const available = [swatch('opaque-twin', '#C91A09', 1), swatch('transparent-near', '#C81A09', 0.5)],
      { map, warnings } = mapper(available, [...colors, ...available]);
    expect(map.resolve(value)).toBe('transparent-near');
    expect(warnings).toEqual([]);
  },
);

it.each(['c:bright-red', 'Bright Red', 'bright_red'])(
  'BS-08e maps out-of-scope %s to the closest available opaque color',
  (value) => {
    const available = [swatch('transparent-twin', '#B40000', 0.5), swatch('opaque-near', '#B30000', 1)],
      { map, warnings } = mapper(available, [...colors, ...available]);
    expect(map.resolve(value)).toBe('opaque-near');
    expect(warnings).toEqual([]);
  },
);

it.each([
  ['trans-red', 1, 'transparent'],
  ['red', 0.5, 'opaque'],
] as const)('BS-08e warns when %s must fall back to the opposite opacity', (value, alpha, intent) => {
  const only = swatch('only-color', '#B40000', alpha),
    { map, warnings } = mapper([only], [...colors, only]);
  expect(map.resolve(value)).toBe(only.id);
  expect(warnings).toContainEqual({
    code: 'COLOR_TRANSPARENCY',
    message: `${value} requested ${intent}; mapped to ${only.name} (${only.id})`,
  });
});

it('BS-08e caches by original input and accounts for both fallback and distance warnings once', () => {
  const { map, warnings, budget } = mapper([colors[1]!]),
    value = '#0020A080';
  expect(map.resolve(value)).toBe('c:bright-red');
  expect(warnings.map((w) => w.code)).toEqual(['COLOR_TRANSPARENCY', 'COLOR_DISTANCE']);
  const bytes = 2 * (256 + value.length * 2) + 160 + value.length * 2;
  expect(budget.bytes).toBe(bytes);
  expect(map.resolve(value)).toBe('c:bright-red');
  expect(budget.bytes).toBe(bytes);
  expect(warnings).toHaveLength(2);
  map.resolve(value.toLowerCase());
  expect(budget.bytes).toBe(bytes * 2);
  expect(warnings).toHaveLength(4);
});

it('BS-08f breaks equal-distance opaque ties by palette order across mapper instances', () => {
  const first = swatch('first', '#B40000', 1),
    second = swatch('second', '#B40000', 1);
  for (const available of [
    [first, second],
    [second, first],
  ]) {
    expect(mapper(available, available).map.resolve('red')).toBe(available[0]!.id);
    expect(mapper(available, available).map.resolve('red')).toBe(available[0]!.id);
  }
});

it('BS-08f selects opacity by intent even when a transparent twin precedes an opaque color', () => {
  const available = [swatch('transparent-first', '#B40000', 0), swatch('opaque-second', '#B40000', 1)],
    { map, warnings } = mapper(available, available);
  expect(map.resolve('#B40000')).toBe('opaque-second');
  expect(map.resolve('#B4000080')).toBe('transparent-first');
  expect(warnings).toEqual([]);
});

it.each([undefined, null, 4, {}, []])('BS-08g rejects non-string input %s', (value) => {
  expect(() => mapper().map.resolve(value)).toThrow(
    new BuildFailure('RUNTIME', 'Color must be an ID, name, #rrggbb or #rrggbbaa'),
  );
});

it.each(['octarine', 'trans octarine', '---', '', '   ', '#12345', '#1234567', '#123456789', 'constructor'])(
  'BS-08g rejects unknown color %s',
  (value) => {
    expect(() => mapper().map.resolve(value)).toThrow(new BuildFailure('RUNTIME', `Unknown color: ${value}`));
  },
);

it.each([1.5, NaN, -0.1, Infinity, -Infinity])('BS-08g rejects invalid catalog alpha %s', (alpha) => {
  const invalid = swatch('invalid', '#123456', alpha);
  expect(() => mapper([invalid], [invalid])).toThrow(new BuildFailure('RUNTIME', 'Invalid catalog color invalid'));
  expect(() => mapper(colors, [...colors, invalid])).toThrow(
    new BuildFailure('RUNTIME', 'Invalid catalog color invalid'),
  );
});

it('BS-08g treats a legacy palette without alpha as entirely opaque', () => {
  const legacy = colors.map((c) => ({ id: c.id, name: c.name, rgb: c.rgb, factory: c.factory })),
    { map, warnings } = mapper(legacy, legacy);
  expect(map.resolve('red')).toBe('c:bright-red');
  expect(map.resolve('#C91A09')).toBe('c:transparent-red');
  expect(warnings).toEqual([]);
  expect(map.resolve('#C91A0980')).toBe('c:transparent-red');
  expect(warnings.map((w) => w.code)).toEqual(['COLOR_TRANSPARENCY']);
});

it('BS-08h resolves red to Bright Red through the script engine with a deterministic hash', async () => {
  const options = {
    catalog: { parts: standardPackingParts.map((p) => ({ ...p, factory: true })), colors },
    scope: 'all' as const,
    seed: 42,
  };
  const first = await runBuildScript("box(0,0,0,4,2,3,'red')", options),
    second = await runBuildScript("box(0,0,0,4,2,3,'red')", options);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error('Script failed');
  expect(first.instances.length).toBeGreaterThan(0);
  expect(new Set(first.instances.map((i) => i.colorId))).toEqual(new Set(['c:bright-red']));
  expect(first.hash).toBe(second.hash);
});
