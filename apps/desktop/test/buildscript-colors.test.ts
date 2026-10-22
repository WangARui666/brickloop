import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLibraryDir, isLDrawInternalColor, LDRAW_INTERNAL_COLOR_CODES, readColors } from '@brickloop/catalog';
import { ColorMapper } from '../../../packages/buildscript/src/colors';
import { Budget } from '../../../packages/buildscript/src/limits';
import { runBuildScript, standardPackingParts } from '../../../packages/buildscript/src/index';
import type { BuildWarning } from '../../../packages/buildscript/src/types';
import { compactBuildCatalog, type BuildCatalog } from '../src/shared/buildscript-catalog';

const configPath = path.join(defaultLibraryDir, 'LDConfig.ldr');
describe.skipIf(!existsSync(configPath))('BS-08 real LDraw palette', () => {
  let catalog: BuildCatalog;
  let source: Awaited<ReturnType<typeof readColors>>;
  beforeAll(async () => {
    source = await readColors(configPath);
    catalog = compactBuildCatalog(
      [],
      source.map((c) => ({ ...c, factoryCode: null })),
    );
  });

  it('BS-08 retains every library alpha in the compact catalog', () => {
    expect(catalog.colors.length).toBeGreaterThan(0);
    expect(catalog.colors).toHaveLength(source.length - source.filter(isLDrawInternalColor).length);
    const sourceById = new Map<string, (typeof source)[number]>(source.map((color) => [color.id, color]));
    for (const color of catalog.colors) {
      expect(sourceById.has(color.id)).toBe(true);
      expect(color).toHaveProperty('alpha', sourceById.get(color.id)!.alpha);
    }
    expect(catalog.colors.some((c) => c.alpha! < 1)).toBe(true);
  });

  it.each([
    ['red', 'c:bright-red'],
    ['blue', 'c:bright-blue'],
    ['green', 'c:dark-green'],
    ['gray', 'c:medium-stone-grey'],
    ['trans-red', 'c:transparent-red'],
    ['#C91A0980', 'c:transparent-red'],
    ['Transparent Red', 'c:transparent-red'],
    ['clear', 'c:transparent'],
  ])('BS-08 resolves %s to %s without distance warnings', (value, expected) => {
    const warnings: BuildWarning[] = [],
      mapper = new ColorMapper(catalog.colors, catalog.colors, warnings, new Budget(undefined));
    expect(mapper.resolve(value)).toBe(expected);
    expect(warnings).toEqual([]);
  });

  it('BS-08 maps web red to an opaque color', () => {
    const mapper = new ColorMapper(catalog.colors, catalog.colors, [], new Budget(undefined));
    expect(catalog.colors.find((c) => c.id === mapper.resolve('#ff0000'))!.alpha).toBe(1);
  });

  it('BS-08 repeats all acceptance colors through the script engine deterministically', async () => {
    const options = {
      catalog: { ...catalog, parts: standardPackingParts.map((p) => ({ ...p, factory: true })) },
      scope: 'all' as const,
      seed: 42,
    };
    const code = `['red','blue','green','gray','#ff0000','trans-red','clear','#C91A0980','Transparent Red']
      .forEach((c,x)=>part('3005',{x:x*2,y:3},c));`;
    const first = await runBuildScript(code, options),
      second = await runBuildScript(code, options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Script failed');
    expect(first.instances.map((i) => i.colorId)).toEqual([
      'c:bright-red',
      'c:bright-blue',
      'c:dark-green',
      'c:medium-stone-grey',
      first.instances[4]!.colorId,
      'c:transparent-red',
      'c:transparent',
      'c:transparent-red',
      'c:transparent-red',
    ]);
    expect(catalog.colors.find((c) => c.id === first.instances[4]!.colorId)!.alpha).toBe(1);
    expect(first.hash).toBe(second.hash);
  });

  it('BS-09 excludes internal materials only from the compact palette, preserving color order', () => {
    const internal = source.filter(isLDrawInternalColor);
    expect(new Set(internal.map((color) => color.ldrawCode))).toEqual(LDRAW_INTERNAL_COLOR_CODES);
    for (const color of internal) {
      expect(catalog.colors.some((compact) => compact.id === color.id)).toBe(false);
    }
    expect(catalog.colors.map((color) => color.id)).toEqual(
      source.filter((color) => !isLDrawInternalColor(color)).map((color) => color.id),
    );
  });

  it.each(['#7F7F7F', '#FFFF80', '#656761', '#D0D0D0', '#AE7A59', '#FFFFFF80'])(
    'BS-09 maps %s to a selectable color',
    (value) => {
      const mapper = new ColorMapper(catalog.colors, catalog.colors, [], new Budget(undefined));
      const resolved = mapper.resolve(value);
      const color = source.find((entry) => entry.id === resolved);
      expect(color).toBeDefined();
      expect(isLDrawInternalColor(color!)).toBe(false);
      if (value === '#656761') expect(resolved).toBe('c:dark-stone-grey');
      if (value === '#FFFFFF80') expect(resolved).toBe('c:transparent');
    },
  );

  it.each(['ld:24', 'ld:16'])('BS-09 rejects internal color ID %s as unknown', (value) => {
    const mapper = new ColorMapper(catalog.colors, catalog.colors, [], new Budget(undefined));
    expect(() => mapper.resolve(value)).toThrow('Unknown color');
  });

  it('BS-09 repeats all six color values through the script engine deterministically', async () => {
    const options = {
      catalog: { ...catalog, parts: standardPackingParts.map((part) => ({ ...part, factory: true })) },
      scope: 'all' as const,
      seed: 42,
    };
    const code = `['#7F7F7F','#FFFF80','#656761','#D0D0D0','#AE7A59','#FFFFFF80']
      .forEach((c,x)=>part('3005',{x:x*2,y:3},c));`;
    const first = await runBuildScript(code, options),
      second = await runBuildScript(code, options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Script failed');
    expect(first.instances).toHaveLength(6);
    for (const result of [first, second]) {
      for (const instance of result.instances) {
        const color = source.find((entry) => entry.id === instance.colorId);
        expect(color).toBeDefined();
        expect(isLDrawInternalColor(color!)).toBe(false);
      }
      expect(result.instances[2]!.colorId).toBe('c:dark-stone-grey');
      expect(result.instances[5]!.colorId).toBe('c:transparent');
    }
    expect(first.hash).toBe(second.hash);
  });
});
