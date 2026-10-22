import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLibraryDir } from '../src/catalog-index';
import { isLDrawInternalColor, LDRAW_INTERNAL_COLOR_CODES, parseLDConfig } from '../src/colors';

describe('BS-09 LDraw internal material colors', () => {
  it.each([16, 24, 493, 494, 495, 10047])('BS-09 identifies internal LDraw code %s', (ldrawCode) => {
    expect(isLDrawInternalColor({ ldrawCode })).toBe(true);
  });

  it.each([4, 15, 47, null])('BS-09 keeps selectable LDraw code %s, including custom colors', (ldrawCode) => {
    expect(isLDrawInternalColor({ ldrawCode })).toBe(false);
  });
});

const configPath = path.join(defaultLibraryDir, 'LDConfig.ldr');
describe.skipIf(!existsSync(configPath))('BS-09 real LDraw internal material section', () => {
  let source: string;
  beforeAll(async () => {
    source = await readFile(configPath, 'utf8');
  });

  it('BS-09 matches the complete set of internal material codes in LDConfig.ldr', () => {
    const lines = source.split(/\r?\n/);
    const heading = lines.findIndex((line) => /^0\s+\/\/\s*LDraw Internal Common Material Colours\s*$/.test(line));
    expect(
      heading,
      'LDConfig.ldr must contain the LDraw Internal Common Material Colours section',
    ).toBeGreaterThanOrEqual(0);
    const following = lines.slice(heading + 1);
    const nextHeading = following.findIndex((line) => /^0\s+\/\//.test(line));
    const section = (nextHeading < 0 ? following : following.slice(0, nextHeading)).join('\n');
    const codes = [...section.matchAll(/^0\s+!COLOUR\s+\S+\s+CODE\s+(\d+)\b/gm)].map((match) => Number(match[1]));
    expect(new Set(codes), 'LDConfig.ldr internal materials changed; review LDRAW_INTERNAL_COLOR_CODES').toEqual(
      LDRAW_INTERNAL_COLOR_CODES,
    );
  });

  it('BS-09 preserves all six internal materials in the full parsed color table', () => {
    const colors = parseLDConfig(source);
    for (const ldrawCode of [16, 24, 493, 494, 495, 10047]) {
      expect(colors.find((color) => color.ldrawCode === ldrawCode)).toMatchObject({
        id: `ld:${ldrawCode}`,
        ldrawCode,
        legoName: null,
        legoColorId: null,
      });
    }
  });
});
