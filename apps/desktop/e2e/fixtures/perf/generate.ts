import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDocument, createWorkspace } from '@brickloop/core';
import { packProject } from '../../../../../packages/io/src/project';

export interface PerfFixture {
  name: string;
  count: number;
  definitions: number;
  file: string;
  sha256: string;
}

/** Stable IDs, layout, palette and ZIP timestamps; never writes into the LDraw junction. */
export async function generateFixtures(root: string): Promise<PerfFixture[]> {
  const directory = path.join(root, '.devdata/perf-fixtures');
  await mkdir(directory, { recursive: true });
  const library = path.join(root, 'library/ldraw/parts');
  const candidates = (await readdir(library)).filter((name) => /^\d+[a-z]?\.dat$/.test(name)).sort();
  const parts: string[] = [];
  for (const name of candidates) {
    const source = await readFile(path.join(library, name), 'utf8');
    // Official physical definitions, excluding aliases, subparts, shortcuts and printed variants.
    if (/^0 !LDRAW_ORG Part(?: UPDATE|\r?$)/m.test(source) && !/^0 [~=]/.test(source)) parts.push(name);
    if (parts.length === 2000) break;
  }
  if (parts.length !== 2000) throw new Error(`Expected 2000 LDraw definitions, found ${parts.length}`);
  await writeFile(path.join(directory, 'definitions.json'), JSON.stringify(parts, null, 2) + '\n');
  const fixtures: PerfFixture[] = [];
  for (const [count, definitions] of [
    [100, 1],
    [1000, 1],
    [10000, 1],
    [2000, 2000],
    [10000, 2000],
  ] as const) {
    const name = `${count}-${definitions === 1 ? 'repeated' : 'distinct'}`;
    let serial = 0;
    const id = () => String(++serial).padStart(26, '0');
    const doc = createDocument(
      { title: `PERF ${name}` },
      {
        id,
        now: () => '2026-10-16T00:00:00.000Z',
        catalogPack: { id: 'demo', version: '1.0.0' },
      },
    );
    const model = doc.models[doc.rootModelId]!;
    const stepId = model.stepIds[0]!;
    const columns = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      const instanceId = id();
      model.instances[instanceId] = {
        id: instanceId,
        ref: { kind: 'part', partId: `ld:${definitions === 1 ? '3001' : parts[i % definitions]!.slice(0, -4)}` },
        colorId: 'c:bright-red',
        transform: [(i % columns) * 100, -24, Math.floor(i / columns) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        stepId,
        groupId: null,
      };
      model.steps[stepId]!.instanceIds.push(instanceId);
    }
    const workspace = createWorkspace();
    const center = (columns - 1) * 50;
    workspace.camera = {
      mode: 'perspective',
      position: [center * 3 + 200, -center * 3 - 200, -center * 2 - 200],
      target: [center, -24, center],
      up: [0, -1, 0],
      fov: 35,
    };
    const bytes = packProject(doc, workspace, {}, { savedAt: '2026-10-16T00:00:00.000Z' });
    const file = path.join(directory, `${name}.brkl`);
    await writeFile(file, bytes);
    fixtures.push({ name, count, definitions, file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return fixtures;
}
