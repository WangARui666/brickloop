import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWorkspace,
  expandInstances,
  orderedInstances,
  serializeDocument,
  parseDocument,
  ulid,
} from '@brickloop/core';
import { attachEmbeddedPart, exportIo, exportLDraw, importIo, importLDraw, STUDIO_INFO_VERSION } from '../src';
import { readZip, text, utf8, writeZip } from '../src/binary';
import { catalog, fixture, fixturePath, structure } from './helpers';

describe('LDraw and Studio', () => {
  it('M9-5d: the source .io filename changes only the title and preserves Studio round trips', async () => {
    const bytes = exportIo(await fixture(), catalog).bytes;
    const original = importIo(bytes, catalog);
    const named = importIo(bytes, catalog, '彩色积木.io');
    expect(original.doc!.meta.title).toBe('model.ldr');
    expect(named.doc!.meta.title).toBe('彩色积木.io');
    expect(structure(named.doc!, true)).toEqual(structure(original.doc!, true));
    expect(named.report).toEqual(original.report);
    const exported = exportIo(named.doc!, { ...catalog, workspace: named.workspace });
    const originalExport = exportIo(original.doc!, { ...catalog, workspace: original.workspace });
    expect(readZip(exported.bytes).members).toEqual(readZip(originalExport.bytes).members);
    const again = importIo(exported.bytes, catalog);
    expect(again.doc!.meta.title).toBe('model.ldr');
    expect(structure(again.doc!, true)).toEqual(structure(named.doc!, true));
  });
  it('does not turn a closing 0 STEP into an extra empty step', () => {
    const text = [
      '0 FILE main.ldr',
      '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '0 STEP',
      '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '0 STEP',
      '0 NOFILE',
    ].join('\n');
    const doc = importLDraw(text, 'steps.mpd', catalog).doc!;
    const model = doc.models[doc.rootModelId]!;
    expect(model.stepIds.map((id) => model.steps[id]!.instanceIds.length)).toEqual([1, 1]);
  });
  it('IO-02: MPD hierarchy, colours, instances, steps and unknown meta survive', async () => {
    const doc = await fixture();
    const exported = exportLDraw(doc, catalog),
      result = importLDraw(exported.text, 'test.mpd', catalog);
    expect(structure(result.doc!)).toEqual(structure(doc));
    expect(exported.text).toContain('0 !BRICKLOOP_TEST unknown step metadata');
    expect(expandInstances(result.doc!)).toHaveLength(4);
  });
  it('IO-05/08: generated MOD-01 exports Studio fields, stable UID, editable shared models', async () => {
    const doc = await fixture(),
      workspace = createWorkspace();
    workspace.hidden = [[orderedInstances(doc.models[doc.rootModelId]!)[0]!.id]];
    const first = exportIo(doc, { ...catalog, workspace }),
      second = exportIo(doc, { ...catalog, workspace });
    expect(first.report.counts).toMatchObject({ parts: 4, models: 2, submodels: 1 });
    const members = readZip(first.bytes).members;
    expect(Object.keys(members).sort()).toEqual(['.info', 'errorPartList.err', 'model.ldr', 'modelv2.ldr']);
    expect(JSON.parse(text(members['.info']!))).toEqual({
      version: STUDIO_INFO_VERSION,
      total_parts: 4,
      parts_db_version: 200,
    });
    expect(text(members['modelv2.ldr']!)).toMatch(/11 16 \d+ True 0 0\.000000/);
    expect(text(members['modelv2.ldr']!)).toBe(text(readZip(second.bytes).members['modelv2.ldr']!));
    const result = importIo(first.bytes, catalog);
    expect(result.report.errors).toEqual([]);
    expect(structure(result.doc!)).toEqual(structure(doc));
    expect(result.workspace.hidden).toHaveLength(1);
    const again = importIo(exportIo(result.doc!, { ...catalog, workspace: result.workspace }).bytes, catalog);
    expect(structure(again.doc!, true)).toEqual(structure(result.doc!, true));
  });
  it('IO-07: custom geometry, p/s dependencies, reference images and ignored Studio data', async () => {
    const doc = await fixture(),
      assets = {};
    const part = attachEmbeddedPart(
      doc,
      assets,
      'custom-cube.dat',
      await readFile(path.join(fixturePath, 'custom-cube.dat')),
    );
    attachEmbeddedPart(doc, assets, 'p/primitive.dat', utf8('0 Primitive'));
    attachEmbeddedPart(doc, assets, 's/subpart.dat', utf8('0 Subpart'));
    for (const model of Object.values(doc.models))
      for (const instance of Object.values(model.instances))
        if (instance.ref.kind === 'part') instance.ref.partId = part.id;
    const exported = exportIo(doc, { ...catalog, parts: [part], assets });
    expect(exported.report.errors).toEqual([]);
    const members = readZip(exported.bytes).members;
    expect(members['CustomParts/p/primitive.dat']).toBeDefined();
    expect(members['CustomParts/s/subpart.dat']).toBeDefined();
    members['ReferenceImages/test.png'] = utf8('image');
    members['referenceImages.json'] = utf8('{"position":[1,2,3]}');
    members['CustomParts/connectivity/test.conn'] = utf8('opaque');
    members['model.ins'] = utf8('opaque');
    const imported = importIo(writeZip(members), catalog);
    expect(imported.doc!.embeddedParts[part.id]).toBeDefined();
    expect(Object.keys(imported.doc!.referenceImages)).toHaveLength(1);
    expect(imported.report.omitted.map((i) => i.file)).toEqual(
      expect.arrayContaining(['model.ins', 'CustomParts/connectivity/test.conn']),
    );
    const again = exportIo(imported.doc!, { ...catalog, assets: imported.assets });
    expect(readZip(again.bytes).members['ReferenceImages/test.png']).toEqual(utf8('image'));
  });
  it('IO-09: encrypted flag in local OR central header returns structured unsupported error', () => {
    for (const central of [false, true]) {
      const bytes = writeZip({ 'model.ldr': utf8('0 Empty') });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      if (central) {
        while (view.getUint32(offset, true) !== 0x02014b50) offset++;
      }
      const flag = offset + (central ? 8 : 6);
      view.setUint16(flag, view.getUint16(flag, true) | 1, true);
      const result = importIo(bytes);
      expect(result.doc).toBeNull();
      expect(result.report.errors[0]!.code).toBe('IO_ENCRYPTED_UNSUPPORTED');
    }
  });
  it('prefers v2, falls back on malformed candidate, supports BOM/spaces and case', () => {
    const standard =
      '0 FILE Main\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 child name\n0 NOFILE\n0 FILE Child Name\n1 14 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 NOFILE';
    const bytes = writeZip({ 'modelv2.ldr': utf8('11 BAD'), 'model.ldr': utf8('\uFEFF' + standard) });
    const result = importIo(bytes, catalog);
    expect(result.report.counts.parts).toBe(1);
    expect(result.report.warnings.some((i) => i.code === 'IO_MODEL_FALLBACK')).toBe(true);
    expect(result.doc).not.toBeNull();
  });
  it('reports colour fallback, group comments, missing custom geometry and cyclic models', async () => {
    const doc = await fixture(),
      root = doc.models[doc.rootModelId]!,
      groupId = ulid();
    doc.groups[groupId] = { id: groupId, modelId: root.id, name: '组', parentGroupId: null };
    orderedInstances(root)[0]!.groupId = groupId;
    const part = Object.values(doc.models)
      .flatMap((m) => Object.values(m.instances))
      .find((i) => i.ref.kind === 'part')!;
    part.colorId = 'cx:test';
    part.ref = { kind: 'part', partId: 'cu:missing' };
    const result = exportIo(doc, {
      ...catalog,
      colors: [...catalog.colors!, { id: 'cx:test', ldrawCode: null, rgb: '#C91A09' }],
    });
    expect(result.report.degradations.map((i) => i.code)).toEqual(
      expect.arrayContaining(['IO_GROUPS_AS_COMMENTS', 'IO_COLOR_FALLBACK']),
    );
    expect(result.report.errors[0]!.code).toBe('IO_PART_GEOMETRY_MISSING');
    expect(text(readZip(result.bytes).members['model.ldr']!)).toContain('BRICKLOOP GROUP');
    expect(importLDraw('0 FILE main\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 main\n0 NOFILE', 'cycle.mpd').doc).toBeNull();
  });
});

const banana = process.env.BRICKLOOP_STUDIO_BANANA;
const bananaStatus = !banana
  ? 'SKIP: BRICKLOOP_STUDIO_BANANA is not set'
  : existsSync(banana)
    ? 'available'
    : `SKIP: sample missing at ${banana}`;
describe('read-only external Banana sample', () => {
  it.skipIf(bananaStatus !== 'available')(
    `IO-01/06: 186 parts / 21 definitions and unchanged UID/colour/position (${bananaStatus})`,
    async () => {
      const imported = importIo(await readFile(banana!), catalog);
      expect(imported.report.errors).toEqual([]);
      expect(imported.report.counts).toMatchObject({ parts: 186, models: 21, instances: 192 });
      expect(imported.report.omitted.map((i) => i.file)).toEqual(
        expect.arrayContaining(['model.ins', 'model2.ldr', 'model.lxfml']),
      );
      const exported = exportIo(imported.doc!, { ...catalog, workspace: imported.workspace });
      const again = importIo(exported.bytes, catalog);
      expect(again.report.errors).toEqual([]);
      expect(structure(again.doc!, true)).toEqual(structure(imported.doc!, true));
      // A .brkl save normalizes core transforms; the Studio extension still retains precise source values.
      const normalized = parseDocument(serializeDocument(imported.doc!)).doc!;
      const afterProject = importIo(exportIo(normalized, catalog).bytes, catalog);
      expect(structure(afterProject.doc!, true)).toEqual(structure(imported.doc!, true));
    },
  );
});
