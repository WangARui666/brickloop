import { describe, expect, it } from 'vitest';
import { createWorkspace, serializeDocument, ulid } from '@brickloop/core';
import { hashBytes, packProject, unpackProject } from '../src';
import { readZip, text, utf8, writeZip } from '../src/binary';
import { fixture } from './helpers';

describe('.brkl project', () => {
  it('M9-5d: explicit appVersion overrides preservation; repacking retains the recorded version', async () => {
    const doc = await fixture();
    const opened = unpackProject(packProject(doc, createWorkspace(), {}, { appVersion: '9.8.7' }));
    expect(opened.manifest!.appVersion).toBe('9.8.7');
    expect(unpackProject(packProject(doc, opened.workspace, opened.assets)).manifest!.appVersion).toBe('9.8.7');
    expect(
      unpackProject(packProject(doc, opened.workspace, {}, { preservation: opened.preservation })).manifest!.appVersion,
    ).toBe('9.8.7');
    expect(
      unpackProject(
        packProject(doc, opened.workspace, opened.assets, {
          appVersion: '9.9.0',
          preservation: opened.preservation,
        }),
      ).manifest!.appVersion,
    ).toBe('9.9.0');
    expect(unpackProject(packProject(doc, opened.workspace)).manifest!.appVersion).toBe('0.1.0');
  });
  it.each([undefined, null, '', '   ', 123])(
    'M9-5d: invalid preserved appVersion %j uses the fallback',
    async (appVersion) => {
      const bytes = packProject(
        await fixture(),
        createWorkspace(),
        {},
        {
          preservation: { manifest: { appVersion }, members: {} },
        },
      );
      expect(unpackProject(bytes).manifest!.appVersion).toBe('0.1.0');
    },
  );
  it('P01: canonical document, workspace, assets and optional members round trip', async () => {
    const doc = await fixture(),
      workspace = createWorkspace();
    workspace.hidden = [[Object.values(doc.models[doc.rootModelId]!.instances)[0]!.id]];
    doc.extensions.ai = { preserved: [1, '中文'] };
    const groupId = ulid(),
      main = doc.models[doc.rootModelId]!;
    doc.groups[groupId] = { id: groupId, modelId: main.id, name: '共享组合', parentGroupId: null };
    Object.values(main.instances)[0]!.groupId = groupId;
    const bytes = packProject(
      doc,
      workspace,
      { 'assets/images/abc': utf8('image'), 'assets/connectors/custom.json': utf8('{}') },
      { thumbnail: utf8('png'), history: '{"role":"user"}\n', instructions: { pages: [] } },
    );
    const result = unpackProject(bytes);
    expect(result.issues).toEqual([]);
    expect(serializeDocument(result.doc!)).toBe(serializeDocument(doc));
    expect(result.workspace).toEqual(workspace);
    expect(text(result.assets['ai/history.jsonl']!)).toContain('user');
    const members = readZip(bytes).members;
    const manifest = JSON.parse(text(members['manifest.json']!)) as {
      members: Record<string, { size: number; sha256: string }>;
    };
    for (const [name, info] of Object.entries(manifest.members))
      expect(info).toEqual({ size: members[name]!.length, sha256: hashBytes(members[name]!) });
  });
  it('P05: unknown members and fields survive the ordinary unpack/pack API', async () => {
    const doc = await fixture();
    doc.future = { opaque: 17 };
    const members = readZip(packProject(doc, { ...createWorkspace(), future: ['workspace'] }, {})).members;
    const manifest = JSON.parse(text(members['manifest.json']!)) as Record<string, unknown>;
    manifest.future = { nested: true };
    (manifest.members as Record<string, Record<string, unknown>>)['document.json']!.futureHashKind = 'opaque';
    members['manifest.json'] = utf8(JSON.stringify(manifest));
    members['future/data.bin'] = new Uint8Array([0, 255, 4]);
    const opened = unpackProject(writeZip(members));
    const second = unpackProject(packProject(opened.doc!, opened.workspace, opened.assets));
    expect(second.doc!.future).toEqual(doc.future);
    expect(second.workspace.future).toEqual(['workspace']);
    expect(second.manifest!.future).toEqual({ nested: true });
    expect((second.manifest!.members as Record<string, Record<string, unknown>>)['document.json']!.futureHashKind).toBe(
      'opaque',
    );
    expect(second.assets['future/data.bin']).toEqual(members['future/data.bin']);
  });
  it('reports the damaged member while retaining readable document and assets', async () => {
    const members = readZip(
      packProject(await fixture(), createWorkspace(), { 'assets/images/image': utf8('before') }),
    ).members;
    members['assets/images/image'] = utf8('after');
    const result = unpackProject(writeZip(members));
    expect(result.doc).not.toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'PROJECT_HASH_MISMATCH', file: 'assets/images/image' }),
    );
    expect(text(result.assets['assets/images/image']!)).toBe('after');
    delete members['document.json'];
    expect(unpackProject(writeZip(members)).issues).toContainEqual(
      expect.objectContaining({ code: 'PROJECT_MEMBER_MISSING', file: 'document.json' }),
    );
  });
  it('P04: explicit 0→1 migration, unsupported old versions, newer read-only preservation', async () => {
    const members = readZip(packProject(await fixture(), createWorkspace())).members;
    const manifest = JSON.parse(text(members['manifest.json']!)) as Record<string, unknown>;
    manifest.formatVersion = 0;
    members['manifest.json'] = utf8(JSON.stringify(manifest));
    const migrated = unpackProject(writeZip(members));
    expect(migrated.manifest!.formatVersion).toBe(1);
    expect(migrated.issues.some((i) => i.code === 'PROJECT_MIGRATED')).toBe(true);
    expect(
      unpackProject(writeZip(members), { migrations: {} }).issues.some((i) => i.code === 'PROJECT_VERSION_UNSUPPORTED'),
    ).toBe(true);
    manifest.formatVersion = 3;
    members['manifest.json'] = utf8(JSON.stringify(manifest));
    const newer = unpackProject(writeZip(members));
    expect(newer.readOnly).toBe(true);
    expect(newer.doc).not.toBeNull();
    expect(() => packProject(newer.doc!, newer.workspace, newer.assets)).toThrow('PROJECT_NEWER_VERSION');
  });
  it('does not throw for truncated ZIP/invalid JSON and keeps partial readable data', async () => {
    expect(unpackProject(new Uint8Array([1, 2])).doc).toBeNull();
    const members = readZip(packProject(await fixture(), createWorkspace())).members;
    members['workspace.json'] = utf8('{');
    const result = unpackProject(writeZip(members));
    expect(result.doc).not.toBeNull();
    expect(result.workspace).toEqual(createWorkspace());
    members['workspace.json'] = utf8(JSON.stringify({ ...createWorkspace(), hidden: [17], camera: {} }));
    expect(unpackProject(writeZip(members)).workspace).toEqual(createWorkspace());
  });
});
