import { describe, expect, it } from 'vitest';
import { buildPartMesh, createMemorySource, LibraryResolver } from '../src/index.js';
import type { PartMesh } from '../src/index.js';

const certified = '0 BFC CERTIFY CCW\n';
const triangle = '3 16 0 0 0 1 0 0 0 1 0';
const ref = (file: string, color = 16, matrix = '0 0 0 1 0 0 0 1 0 0 0 1') => `1 ${color} ${matrix} ${file}`;
const resolver = (files: Record<string, string>) => new LibraryResolver({ embedded: files });
function expanded(mesh: PartMesh): number[] {
  return mesh.batches.flatMap((batch) =>
    Array.from(batch.indices).flatMap((index) => Array.from(batch.positions.slice(index * 3, index * 3 + 3))),
  );
}

describe('mesh acceptance', () => {
  it('G02 composes multi-level transforms identically to direct geometry', async () => {
    const nested = await buildPartMesh(
      'root.dat',
      resolver({
        'root.dat': certified + ref('middle.dat', 16, '10 20 30 0 -1 0 1 0 0 0 0 1'),
        'middle.dat': certified + ref('leaf.dat', 16, '2 3 4 2 0 0 0 3 0 0 0 4'),
        'leaf.dat': certified + triangle,
      }),
    );
    const direct = await buildPartMesh(
      'direct.dat',
      resolver({ 'direct.dat': certified + '3 16 7 22 34 7 24 34 4 22 34' }),
    );
    expanded(nested).forEach((n, i) => expect(Math.abs(n - expanded(direct)[i]!)).toBeLessThan(1e-4));
    expect(nested.batches[0]!.normals).toEqual(direct.batches[0]!.normals);
  });

  it('G03 reports the full missing chain and keeps remaining geometry', async () => {
    const mesh = await buildPartMesh(
      'root.dat',
      resolver({ 'root.dat': `${certified}${triangle}\n${ref('mid.dat')}`, 'mid.dat': ref('gone.dat') }),
    );
    expect(mesh.diagnostics.missing).toEqual([['root.dat', 'mid.dat', 'gone.dat']]);
    expect(mesh.batches[0]!.indices).toHaveLength(3);
    expect((await buildPartMesh('absent.dat', resolver({}))).bboxLdu).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('G04 terminates cycles and reports the cycle path', async () => {
    const mesh = await buildPartMesh(
      'a.dat',
      resolver({ 'a.dat': `${triangle}\n${ref('b.dat')}`, 'b.dat': ref('a.dat') }),
    );
    expect(mesh.diagnostics.cycles).toEqual([['a.dat', 'b.dat', 'a.dat']]);
    expect(mesh.batches[0]!.indices).toHaveLength(3);
  });

  it('enforces the default 64-depth limit and configurable depth', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`${i}.dat`, `${triangle}\n${ref(`${i + 1}.dat`)}`]),
    );
    const mesh = await buildPartMesh('0.dat', resolver(files));
    expect(mesh.sources).toHaveLength(64);
    expect(mesh.diagnostics.warnings[0]).toContain('Depth limit 64: 0.dat -> 1.dat');
    expect(mesh.diagnostics.missing).toEqual([]);
    expect((await buildPartMesh('0.dat', resolver(files), { maxDepth: 2 })).sources).toHaveLength(2);
  });

  it('G05 mirrors winding, inverse-transposes normals and composes INVERTNEXT', async () => {
    const mesh = await buildPartMesh(
      'mirror.dat',
      resolver({
        'mirror.dat': certified + ref('face.dat', 16, '0 0 0 -2 0 0 0 3 0 0 0 4'),
        'face.dat': certified + '3 16 0 0 0 1 0 0 0 1 1',
      }),
    );
    const batch = mesh.batches[0]!;
    expect(batch.normals[0]).toBeCloseTo(0);
    expect(batch.normals[1]).toBeCloseTo(-0.8);
    expect(batch.normals[2]).toBeCloseTo(0.6);
    const points = expanded(mesh);
    const crossZ =
      (points[3]! - points[0]!) * (points[7]! - points[1]!) - (points[4]! - points[1]!) * (points[6]! - points[0]!);
    expect(crossZ).toBeGreaterThan(0);
    const inverted = await buildPartMesh(
      'root.dat',
      resolver({
        'root.dat': `${certified}0 BFC INVERTNEXT\n${ref('mid.dat', 16, '0 0 0 -1 0 0 0 1 0 0 0 1')}`,
        'mid.dat': `${certified}0 BFC INVERTNEXT\n${ref('face.dat')}`,
        'face.dat': certified + triangle,
      }),
    );
    expect(inverted.batches[0]!.normals[2]).toBe(1);
  });

  it('BFC handles CW, NOCLIP/CLIP, uncertified ancestors and NOCERTIFY', async () => {
    const cw = await buildPartMesh('x.dat', resolver({ 'x.dat': `0 BFC CERTIFY CW\n${triangle}` }));
    expect(cw.batches[0]!.normals[2]).toBe(-1);
    expect(cw.doubleSided).toBe(false);
    for (const header of ['', '0 BFC NOCERTIFY\n0 BFC CERTIFY CCW\n', `${certified}0 BFC NOCLIP\n`]) {
      const mesh = await buildPartMesh(
        'x.dat',
        resolver({ 'x.dat': header + ref('child.dat'), 'child.dat': certified + triangle }),
      );
      expect(mesh.doubleSided).toBe(true);
    }
    const clipped = await buildPartMesh(
      'x.dat',
      resolver({ 'x.dat': `${certified}0 BFC NOCLIP\n0 BFC CLIP\n${triangle}` }),
    );
    expect(clipped.doubleSided).toBe(false);
  });

  it('G06 preserves main/edge inheritance, explicit and direct colours, and conditional edge colours', async () => {
    const mesh = await buildPartMesh(
      'root.dat',
      resolver({
        'ldconfig.ldr': '0 !COLOUR Red CODE 4 VALUE #FF0000 EDGE #123456',
        'root.dat': `${certified}${ref('child.dat')}\n${ref('child.dat', 4, '10 0 0 1 0 0 0 1 0 0 0 1')}\n3 0x2ABCDEF 0 0 1 1 0 1 0 1 1`,
        'child.dat': certified + ref('leaf.dat'),
        'leaf.dat': `${certified}${triangle}\n2 24 0 0 0 1 0 0\n2 16 0 0 0 0 1 0\n5 24 0 0 0 1 0 0 0 100 0 0 -100 0`,
      }),
    );
    expect(mesh.batches.map((batch) => batch.color)).toEqual(['main', 4, 0x2abcdef]);
    expect(mesh.edges.map((batch) => batch.color)).toEqual(['edge', 16, 0x2123456, 4]);
    expect(mesh.conditionalEdges.colors).toEqual(['edge', 0x2123456]);
    expect(mesh.conditionalEdges.positions).toHaveLength(12);
    expect(mesh.conditionalEdges.controls[4]).toBe(-100);
    expect(mesh.bboxLdu).toEqual([0, 0, 0, 11, 1, 1]);
  });

  it('G07 resolves source priority and records the actual source', async () => {
    const library = createMemorySource('official', {
      'parts/x.dat': triangle,
      'p/x.dat': triangle,
      'models/x.dat': triangle,
    });
    const custom = createMemorySource('custom-dir', { 'X.DAT': triangle });
    const embedded = { 'x.dat': triangle };
    for (const [options, source] of [
      [{ library, custom: [custom], embedded }, 'embedded:x.dat'],
      [{ library, custom: [custom] }, 'custom-dir:x.dat'],
      [{ library }, 'official:parts/x.dat'],
      [{ library, order: ['p', 'parts'] as const }, 'official:p/x.dat'],
    ] as const) {
      const mesh = await buildPartMesh(
        'X.DAT',
        new LibraryResolver({ ...options, ...('order' in options ? { order: [...options.order] } : {}) }),
      );
      expect(mesh.sources[0]!.resolvedFrom).toBe(source);
    }
  });

  it('G08 handles s/, explicit 48/ and 8/, high-resolution preference and fallback', async () => {
    const library = createMemorySource('official', {
      'p/cyl.dat': triangle,
      'p/48/cyl.dat': triangle,
      'p/8/cyl.dat': triangle,
      'p/fallback.dat': triangle,
      'parts/part.dat': triangle,
      'p/48/part.dat': triangle,
      'parts/s/sub.dat': triangle,
      'models/model.ldr': triangle,
    });
    const r = new LibraryResolver({ library, highResPrimitives: true });
    expect((await r.resolve('CYL.DAT'))!.resolvedFrom).toBe('official:p/48/cyl.dat');
    expect((await r.resolve('48\\CYL.DAT', { highResPrimitives: false }))!.resolvedFrom).toBe('official:p/48/cyl.dat');
    expect((await r.resolve('8/cyl.dat'))!.resolvedFrom).toBe('official:p/8/cyl.dat');
    expect((await r.resolve('cyl.dat', { highResPrimitives: false }))!.resolvedFrom).toBe('official:p/cyl.dat');
    expect((await r.resolve('fallback.dat'))!.resolvedFrom).toBe('official:p/fallback.dat');
    expect((await r.resolve('part.dat'))!.resolvedFrom).toBe('official:parts/part.dat');
    expect((await r.resolve('s\\sub.dat'))!.resolvedFrom).toBe('official:parts/s/sub.dat');
    expect((await r.resolve('model.ldr'))!.resolvedFrom).toBe('official:models/model.ldr');
    expect((await buildPartMesh('cyl.dat', r, { highResPrimitives: false })).sources[0]!.resolvedFrom).toBe(
      'official:p/cyl.dat',
    );
  });

  it('MPD embedded geometry wins over library files and cycle aliases terminate', async () => {
    const mpd = `0 FILE main.ldr\n${certified}${ref('local.dat')}\n0 FILE local.dat\n${certified}${triangle}\n${ref('main.ldr')}`;
    const mesh = await buildPartMesh(
      'container.mpd',
      new LibraryResolver({
        embedded: { 'container.mpd': mpd },
        library: createMemorySource('library', { 'parts/local.dat': '' }),
      }),
    );
    expect(mesh.batches[0]!.indices).toHaveLength(3);
    expect(mesh.diagnostics.cycles).toEqual([['container.mpd', 'local.dat', 'main.ldr']]);
    expect(mesh.sources[1]!.resolvedFrom).toContain('#local.dat');
  });

  it('MPD files respect a configured custom-before-embedded search order', async () => {
    const mpd = `0 FILE main.ldr\n${certified}${ref('local.dat')}\n0 FILE local.dat\n${triangle}`;
    const mesh = await buildPartMesh(
      'container.mpd',
      new LibraryResolver({
        embedded: { 'container.mpd': mpd },
        custom: [createMemorySource('custom', { 'local.dat': certified + triangle })],
        order: ['custom', 'embedded', 'parts', 'p', 'subparts', 'models'],
      }),
    );
    expect(mesh.sources[1]!.resolvedFrom).toBe('custom:local.dat');
  });
});

describe('normal smoothing and indexing', () => {
  const fold = `${certified}3 16 0 0 0 1 0 0 0 1 0\n3 16 1 0 0 0 0 0 0 -1 0.2`;
  it('smooths connected faces below 30 degrees and deduplicates shared vertices', async () => {
    const smooth = await buildPartMesh('fold.dat', resolver({ 'fold.dat': fold }));
    expect(smooth.batches[0]!.positions.length / 3).toBe(4);
    expect(smooth.batches[0]!.normals[1]).toBeGreaterThan(0);
    const sharp = await buildPartMesh('fold.dat', resolver({ 'fold.dat': fold }), { smoothingAngle: 5 });
    expect(sharp.batches[0]!.positions.length / 3).toBe(6);
  });
  it('type-2 hard edges prevent smoothing, including longer collinear segments', async () => {
    for (const edge of ['2 24 0 0 0 1 0 0', '2 24 -1 0 0 2 0 0']) {
      const mesh = await buildPartMesh('fold.dat', resolver({ 'fold.dat': `${fold}\n${edge}` }));
      expect(mesh.batches[0]!.positions.length / 3).toBe(6);
      expect(mesh.batches[0]!.normals[1]).toBe(0);
    }
  });
  it('triangulates quads without introducing diagonal creases', async () => {
    const mesh = await buildPartMesh('quad.dat', resolver({ 'quad.dat': `${certified}4 16 0 0 0 1 0 0 1 1 0 0 1 0` }));
    expect(mesh.batches[0]!.positions).toHaveLength(12);
    expect(mesh.batches[0]!.indices).toHaveLength(6);
    expect(mesh.batches[0]!.normals).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  });
});
