import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogIndex, createCatalogIndex, defaultLibraryDir, repositoryRoot } from '../src/catalog-index';
import { groupPatterns, parsePatternRules, PatternCatalog, PATTERN_GROUP_IDS } from '../src/patterns';
import type { PatternRules } from '../src/patterns';
import type { PartDef } from '../src/types';
import rawRules from '../../../library/macros/patterns.json';

const rules = parsePatternRules(rawRules);
const fixture = createCatalogIndex([
  { file: '3626bp01.dat', source: '0 Minifig Head with Smile Pattern' },
  { file: '973p01.dat', source: '0 Minifig Torso with Shirt and Buttons Pattern' },
  { file: '3816cp01.dat', source: '0 Minifig Leg Left with Trousers Pattern' },
  { file: '3068bp01.dat', source: '0 Tile 2 x 2 with Monitor Screen and Keyboard Pattern' },
  { file: '3069bp01.dat', source: '0 Tile 1 x 2 with Keyboard Pattern' },
  { file: '3069bp02.dat', source: '0 Tile 1 x 2 with Piano Keyboard Pattern' },
  { file: '3069bp03.dat', source: '0 Tile 1 x 2 with Black Windscreen Pattern' },
  { file: '3068bp02.dat', source: '0 Tile 2 x 2 with Newspaper Pattern' },
  { file: '3068bp03.dat', source: '0 Tile 2 x 2 with Space Logo Pattern' },
  { file: '3068b.dat', source: '0 Tile 2 x 2 with Screen' },
  { file: '3001p01.dat', source: '0 Brick 2 x 4 with Keyboard Pattern' },
]);
describe('deterministic printed pattern grouping', () => {
  it('requires printed and baseOf, fixes group order and deduplicates cross-group matches', () => {
    const groups = groupPatterns(fixture, rules);
    expect(groups.map((group) => group.groupId)).toEqual(PATTERN_GROUP_IDS);
    expect(groups.map((group) => group.parts)).toEqual([
      ['ld:3626bp01'],
      ['ld:973p01'],
      ['ld:3816cp01'],
      ['ld:3068bp01'],
      ['ld:3068bp02'],
      ['ld:3069bp01'],
      ['ld:3068bp03'],
    ]);
    const noFlags: PartDef = { ...fixture.parts[0]!, flags: [] };
    const noBase: PartDef = { ...fixture.parts[1]! };
    delete noBase.baseOf;
    expect(groupPatterns({ parts: [noFlags, noBase] }, rules).flatMap((group) => group.parts)).toEqual([]);
    expect(
      groupPatterns({ parts: [...fixture.parts].reverse() }, { ...rules, groups: [...rules.groups].reverse() }),
    ).toEqual(groups);
  });
  it('manual whitelist overrides base/title exclusions, blacklist wins, and unprinted parts never qualify', () => {
    const custom: PatternRules = structuredClone(rules);
    const controls = custom.groups.find((rule) => rule.groupId === 'controls')!;
    controls.whitelist = ['ld:3069bp02', 'ld:3001p01', 'ld:3068b'];
    controls.blacklist = ['ld:3001p01'];
    expect(groupPatterns(fixture, custom).find((group) => group.groupId === 'controls')!.parts).toEqual([
      'ld:3069bp01',
      'ld:3069bp02',
    ]);
  });
  it('searches IDs, Chinese/English names and keywords within optional groups without a 100-row cap', () => {
    const patterns = new PatternCatalog(fixture, rules);
    expect(patterns.searchPatterns('MONITOR screen').map((part) => part.id)).toEqual(['ld:3068bp01']);
    expect(patterns.searchPatterns('2×2 screen', 'screens').map((part) => part.id)).toEqual(['ld:3068bp01']);
    expect(patterns.searchPatterns('3069bp01', 'controls').map((part) => part.id)).toEqual(['ld:3069bp01']);
    expect(patterns.searchPatterns('screen', 'faces')).toEqual([]);
    expect(patterns.searchPatterns('')).toHaveLength(7);
    expect(patterns.unclassified).toEqual(['ld:3001p01', 'ld:3069bp02', 'ld:3069bp03']);
    expect(patterns.searchPatterns('人仔', 'faces')).toHaveLength(1);
  });
  it('rejects missing/duplicate groups and unsupported rule versions', () => {
    expect(() => parsePatternRules({ ...rules, version: 2 })).toThrow('catalog.patterns.invalidRules');
    expect(() => parsePatternRules({ ...rules, groups: rules.groups.slice(1) })).toThrow();
    expect(() => parsePatternRules({ ...rules, groups: rules.groups.map(() => rules.groups[0]) })).toThrow();
  });
});

describe.skipIf(!existsSync(path.join(defaultLibraryDir, 'LDConfig.ldr')))(
  'read-only complete LDraw pattern statistics',
  () => {
    it('covers head/clothing families and keeps screen/control shapes relevant', async () => {
      const catalog = await buildCatalogIndex();
      const loaded = parsePatternRules(
        JSON.parse(await readFile(path.join(repositoryRoot, 'library/macros/patterns.json'), 'utf8')) as unknown,
      );
      const patterns = new PatternCatalog(catalog, loaded);
      const eligible = catalog.parts.filter((part) => part.flags?.includes('printed') && part.baseOf);
      expect(patterns.groups.reduce((sum, group) => sum + group.parts.length, 0) + patterns.unclassified.length).toBe(
        eligible.length,
      );
      const ids = (group: string) => new Set(patterns.groups.find((entry) => entry.groupId === group)!.parts);
      const families = [
        ['faces', /^(?:Minifig (?:Baby )?Head\b|Figure Friends .*Head\b)/i],
        ['torsos', /^(?:Minifig Torso\b|Figure Friends .*Torso\b)/i],
        ['legs', /^(?:Minifig (?:Hips|Leg|Legs|Skirt)\b|Figure Friends (?:Hips|Legs)\b)/i],
      ] as const;
      for (const [group, expression] of families) {
        const expected = eligible.filter((part) => expression.test(part.nameEn));
        expect(expected.length).toBeGreaterThan(100);
        expect(expected.filter((part) => !ids(group).has(part.id)).map((part) => part.id)).toEqual([]);
      }
      for (const part of patterns.searchPatterns('', 'screens'))
        expect(part.nameEn).toMatch(/\b(screen|display|monitor)\b/i);
      for (const part of patterns.searchPatterns('', 'controls')) {
        expect(part.nameEn).toMatch(/^(Tile|Slope Brick)\b/);
        expect(part.nameEn).not.toMatch(/\b(minifig|shirt|jacket|piano|accordion)\b/i);
      }
      console.log(
        JSON.stringify(
          {
            libraryVersion: catalog.libraryVersion,
            eligible: eligible.length,
            groups: patterns.groups.map((group) => ({ groupId: group.groupId, count: group.parts.length })),
            unclassified: patterns.unclassified.length,
            examples: patterns.unclassified
              .slice(0, 8)
              .map((id) => ({ id, title: catalog.parts.find((part) => part.id === id)!.nameEn })),
          },
          null,
          2,
        ),
      );
    }, 60_000);
  },
);
