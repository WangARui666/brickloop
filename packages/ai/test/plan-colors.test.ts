import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDConfig } from '../../catalog/src/colors.js';
import { normalizePlanColors as normalize, type PlanColor } from '../src/workflows/image-to-model/colors.js';
import { parseStructurePlan, type StructurePlan } from '../src/workflows/image-to-model/plan.js';
import { structurePlanIssues } from '../src/workflows/image-to-model/validation.js';

const catalog = parseLDConfig(readFileSync(new URL('../../../library/ldraw/LDConfig.ldr', import.meta.url), 'utf8'));
const factory = catalog.filter((c) => c.legoName !== null);
// The established nearest-colour behavior is available only after the model's rewrite.
const normalizePlanColors = (input: StructurePlan, palette: PlanColor[], catalog: PlanColor[] = palette) =>
  normalize(input, palette, catalog, true);
function plan(colors: string[], name = 'Body'): StructurePlan {
  return {
    name: 'Model',
    components: [
      { id: 'body', name, size: { width: 4, depth: 4, height: 3 }, colors, partTypes: ['brick'], connections: [] },
    ],
    buildOrder: ['body'],
  };
}
const spellings = [
  ['c:bright-green', 'c:bright-green'],
  ['bright-green', 'c:bright-green'],
  ['BRIGHT-GREEN', 'c:bright-green'],
  ['Bright Green', 'c:bright-green'],
  ['bright_green', 'c:bright-green'],
  ['  bRiGhT__Green  ', 'c:bright-green'],
  ['Dark Green', 'c:dark-green'],
  ['sand-green', 'c:sand-green'],
  ['earth-orange', 'c:earth-orange'],
  ['sand-yellow', 'c:sand-yellow'],
  ['transparent-blue', 'c:transparent-blue'],
  ['transparent-light-blue', 'c:transparent-light-blue'],
  ['medium-blue', 'c:medium-blue'],
  ['red', 'c:bright-red'],
  ['blue', 'c:bright-blue'],
];

describe('A-112 plan palette normalization', () => {
  it.each(spellings)('resolves factory spelling %s', (from, to) => {
    expect(normalizePlanColors(plan([from!]), factory, catalog).plan.components[0]!.colors).toEqual([to]);
  });
  it.each(spellings)('maps out-of-scope %s only to custom palette colors', (from, id) => {
    const source = factory.find((c) => c.id === id)!;
    const custom: PlanColor[] = [
      { id: 'custom:target', legoName: 'Selected color', rgb: source.rgb, alpha: source.alpha },
      { id: 'custom:opposite-opacity', legoName: 'Other color', rgb: source.rgb, alpha: source.alpha < 1 ? 1 : 0.5 },
    ];
    expect(normalizePlanColors(plan([from!]), custom, catalog).plan.components[0]!.colors).toEqual(['custom:target']);
  });
  it('honors IDs before names, handles aliases and keeps first occurrence order', () => {
    const palette = [
      { id: 'one', legoName: 'First', aliases: ['Fresh Green'], rgb: '#00852B' },
      { id: 'two', legoName: 'one', rgb: '#1E5AA8' },
    ];
    const input = plan(['one', 'fresh_green', 'two', 'foo', 'one']);
    const result = normalizePlanColors(input, palette);
    expect(result.plan.components[0]!.colors).toEqual(['one', 'two']);
    expect(result.colorRepairs).toEqual([
      { componentId: 'body', from: 'fresh_green', to: null, reason: 'duplicate' },
      { componentId: 'body', from: 'foo', to: null },
      { componentId: 'body', from: 'one', to: null, reason: 'duplicate' },
    ]);
    expect(input.components[0]!.colors).toHaveLength(5);
  });
  it.each([{ palette: factory }, { palette: [factory.find((c) => c.id === 'c:transparent-blue')!] }])(
    'uses descriptions after deleting unknown colors',
    ({ palette }) => {
      const result = normalizePlanColors(plan(['foo'], 'Window in transparent light blue'), palette, catalog);
      expect(result.plan.components[0]!.colors).toEqual([
        palette.length === 1 ? 'c:transparent-blue' : 'c:transparent-light-blue',
      ]);
      expect(result.colorRepairs).toEqual([
        { componentId: 'body', from: 'foo', to: null },
        {
          componentId: 'body',
          from: 'transparent light blue',
          to: result.plan.components[0]!.colors[0],
          reason: 'description',
        },
      ]);
    },
  );
  it('uses Chinese description names and connection notes', () => {
    const source = factory.find((c) => c.id === 'c:bright-green')!;
    const input = plan(['foo']);
    input.components[0]!.connections.push({ target: 'other', description: `连接${source.nameZh}墙面` });
    expect(normalizePlanColors(input, factory, catalog).plan.components[0]!.colors).toEqual([source.id]);
  });
  it.each([{ palette: factory }, { palette: [factory.find((c) => c.id === 'c:dark-green')!] }])(
    'reports first-palette fallback when no description color resolves',
    ({ palette }) => {
      for (const colors of [['foo'], []]) {
        const result = normalizePlanColors(plan(colors), palette, catalog);
        expect(result.plan.components[0]!.colors).toEqual([palette[0]!.id]);
        expect(result.colorRepairs.at(-1)).toEqual({
          componentId: 'body',
          from: '',
          to: palette[0]!.id,
          reason: 'palette-first',
        });
      }
    },
  );
  it('excludes all six internal material colors, including exact IDs and nearest-color requests', () => {
    for (const code of [16, 24, 493, 494, 495, 10047]) {
      const internal = catalog.find((c) => c.ldrawCode === code)!;
      const result = normalizePlanColors(plan([internal.id, internal.rgb]), [internal, factory[0]!], catalog);
      expect(result.paletteColorIds).toEqual([factory[0]!.id]);
      expect(result.plan.components[0]!.colors).toEqual([factory[0]!.id]);
    }
  });
  it('leaves an empty palette invalid instead of inventing an out-of-scope color', () => {
    const result = normalizePlanColors(plan(['bright-green', 'foo']), [], catalog);
    expect(result.plan.components[0]!.colors).toEqual([]);
    expect(structurePlanIssues(result.plan, [])).toEqual([{ componentId: 'body', field: 'colors' }]);
  });
});

describe('A-125 unambiguous colour normalization before rewriting', () => {
  it.each(spellings.filter(([from]) => !['red', 'blue'].includes(from!)))(
    'resolves %s without a rewrite',
    (from, to) => {
      const result = normalize(plan([from!]), factory, catalog);
      expect(result.issues).toEqual([]);
      expect(result.plan.components[0]!.colors).toEqual([to]);
      expect(result.colorRepairs).toEqual(from === to ? [] : [{ componentId: 'body', from, to }]);
    },
  );
  it.each(['c:nonexistent', 'red', '#00852b', 'Bright Green', 'transparent-light-blue'])(
    'returns %s to the model when it cannot map exactly into the selected palette',
    (from) => {
      const palette = [{ id: 'custom:blue', legoName: 'Chosen blue', rgb: '#123456' }];
      const result = normalize(plan([from]), palette, catalog);
      expect(result.plan.components[0]!.colors).toEqual([from]);
      expect(result.colorRepairs).toEqual([]);
      expect(result.issues).toEqual([
        {
          path: 'components.0.colors.0',
          message: expect.stringContaining(`Component body: colour ${JSON.stringify(from)}`),
        },
      ]);
      expect(result.issues[0]!.message).toContain('["custom:blue"]');
    },
  );
  it('accepts exact aliases but asks about ambiguous names even if the first match is plausible', () => {
    const palette = [
      { id: 'a', legoName: 'Green', aliases: ['Fresh Green'], rgb: '#00852b' },
      { id: 'b', legoName: 'Other', aliases: ['Green'], rgb: '#228833' },
    ];
    expect(normalize(plan(['fresh_green']), palette).plan.components[0]!.colors).toEqual(['a']);
    expect(normalize(plan(['Green']), palette).issues).toHaveLength(1);
    expect(normalize(plan(['a']), palette).issues).toEqual([]);
  });
});

it('allows zero dimensions only for review and identifies editable errors by component and field', () => {
  const input = plan(['foo']);
  input.components[0]!.size.width = 0;
  expect(parseStructurePlan(input).ok).toBe(false);
  // A zero size with an otherwise positive box is also repairable in the dialog.
  expect(
    parseStructurePlan(
      {
        ...input,
        components: [
          {
            ...input.components[0],
            boundingBox: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 4, y: 3, z: 4 },
            },
          },
        ],
      },
      [],
      true,
    ).ok,
  ).toBe(true);
  const review = parseStructurePlan(input, [], true);
  expect(review.ok).toBe(true);
  if (!review.ok) throw new Error('Expected editable plan');
  expect(structurePlanIssues(review.plan, ['c:bright-green'])).toEqual(
    expect.arrayContaining([
      { componentId: 'body', field: 'width' },
      { componentId: 'body', field: 'boundingBox' },
      { componentId: 'body', field: 'colors' },
    ]),
  );
  review.plan.components[0]!.size.width = 4;
  review.plan.components[0]!.boundingBox!.max.x = 4;
  review.plan.components[0]!.colors = ['c:bright-green'];
  expect(structurePlanIssues(review.plan, ['c:bright-green'])).toEqual([]);
  review.plan.components[0]!.connections = [{ target: 'missing', description: '' }];
  review.plan.buildOrder = [];
  expect(structurePlanIssues(review.plan, ['c:bright-green'])).toEqual(
    expect.arrayContaining([
      { componentId: 'body', field: 'connections' },
      { componentId: 'body', field: 'order' },
    ]),
  );
});
