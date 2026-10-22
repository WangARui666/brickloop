import { describe, expect, it } from 'vitest';
import { LibraryResolver, normalizeTransform, parseLDraw, readModel, writeModel } from '../src/index.js';

const reference = '1 0x2AABBCC 1.234567 2 3 1 0 0 0 1 0 0 0 -1 sub model  with spaces.dat';
describe('LDraw text and model IO', () => {
  it('parses all line types, BOM, remainder filenames, known headers and unknown meta', () => {
    const file = parseLDraw(
      `\uFEFF0 Test title\n0 !CATEGORY Brick\n0 !KEYWORDS foo, bar\n0 !KEYWORDS baz\n0 !LDRAW_ORG Part UPDATE 2026-01\n0 !FUTURE   opaque data\n0 BFC CERTIFY CW\n${reference}\n2 24 0 0 0 1 0 0\n3 16 0 0 0 1 0 0 0 1 0\n4 16 0 0 0 1 0 0 1 1 0 0 1 0\n5 24 0 0 0 1 0 0 0 1 0 0 -1 0`,
      'TEST.DAT',
    );
    expect(file.fileName).toBe('test.dat');
    expect(file.title).toBe('Test title');
    expect(file.category).toBe('Brick');
    expect(file.keywords).toEqual(['foo', 'bar', 'baz']);
    expect(file.ldrawOrg).toBe('Part UPDATE 2026-01');
    expect(file.meta).toContain('0 !FUTURE   opaque data');
    expect(file.lines.find((line) => line.type === 1)).toMatchObject({
      color: 0x2aabbcc,
      fileName: 'sub model  with spaces.dat',
      transform: [1.234567, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, -1],
    });
    expect(file.lines.slice(-5).map((line) => line.type)).toEqual([1, 2, 3, 4, 5]);
    expect(file.warnings).toEqual([]);
  });

  it('reads colour definitions, byte alpha and material parameters separately', () => {
    const file = parseLDraw(
      '0 !COLOUR Glitter CODE 100 VALUE #AABBCC EDGE 7 ALPHA 128 LUMINANCE 20 MATERIAL GLITTER VALUE #FFFFFF ALPHA 100 FRACTION 0.5\n0 !COLOUR Rubber CODE 256 VALUE 0x123456 EDGE #654321 RUBBER',
      'LDConfig.ldr',
    );
    expect(file.colours[0]).toEqual({
      code: 100,
      name: 'Glitter',
      value: '#AABBCC',
      edge: 7,
      alpha: 128,
      luminance: 20,
      material: ['MATERIAL', 'GLITTER', 'VALUE', '#FFFFFF', 'ALPHA', '100', 'FRACTION', '0.5'],
    });
    expect(file.colours[1]).toMatchObject({ value: '#123456', edge: '#654321', material: ['RUBBER'], alpha: 255 });
  });

  it('diagnoses malformed numbers/lines and does not swallow valid geometry', () => {
    const parsed = parseLDraw(
      '3 16 0 0 0 NaN 1 0 1 0 0\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 ../secret\n3 16 0 0 0 1e-3 0 0 0 1 0\n9 future\n2 24 0 0 0 1 0 0 extra',
      'x.dat',
    );
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(4);
  });

  it('MPD round-trips submodels, empty steps, meta order, geometry and !DATA', () => {
    const text = `Mail preamble ignored\n0 FILE Main Model.ldr\n0 Title\n0 !FUTURE    retained\n0 BFC INVERTNEXT\n${reference}\n0 STEP\n0 STEP\n2 24 0 0 0 1 0 0\n0 NOFILE\nignored signature\n0 !DATA image.png\n0 !: YWJj\n0 !: ZGVm\n0 NOFILE\n0 FILE sub model  with spaces.dat\n0 BFC NOCERTIFY\n3 16 0 0 0 1 0 0 0 1 0`;
    const resolver = new LibraryResolver();
    const model = readModel(text, 'container.mpd', resolver);
    expect(model.submodels).toHaveLength(2);
    expect(model.submodels[0]!.steps).toHaveLength(3);
    expect(model.data).toEqual([{ fileName: 'image.png', base64: 'YWJjZGVm' }]);
    const output = writeModel(model);
    expect(output).not.toContain('\uFEFF');
    expect(output.replaceAll('\r\n', '')).not.toContain('\n');
    expect(output).toContain('1.2346 2 3');
    expect(output).toContain('0 !FUTURE    retained');
    expect(readModel(output, 'container.mpd', resolver)).toEqual(model);
  });

  it('plain LDR round-trips and writes changed instances', () => {
    const model = readModel(`0 Model\n${reference}`, 'plain.ldr');
    model.submodels[0]!.steps[0]!.instances[0]!.color = 4;
    const output = writeModel(model);
    expect(output).not.toContain('0 FILE');
    expect(readModel(output, 'plain.ldr')).toEqual(model);
  });

  it('normalizes rotation drift, precision and negative zero while retaining mirror/scale/shear', () => {
    expect(normalizeTransform([-0.00000001, 1.123456, 0, -1, 1e-11, 0, 0, 1, 0, 0, 0, 1])).toEqual([
      0, 1.1235, 0, -1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    expect(normalizeTransform([0, 0, 0, 1, 0.12345678, 0, 0, 1, 0, 0, 0, 2])).toEqual([
      0, 0, 0, 1, 0.123457, 0, 0, 1, 0, 0, 0, 2,
    ]);
  });
});
