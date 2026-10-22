import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, orderedInstances } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import { importLDraw, packProject } from '../src';
import type { IoContext } from '../src';

export const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const fixturePath = path.join(repo, 'test/fixtures/io');
export const catalog: IoContext = {
  parts: [{ id: 'ld:3001', ldrawFile: '3001.dat' }],
  colors: [
    { id: 'c:bright-red', ldrawCode: 4, rgb: '#C91A09' },
    { id: 'c:bright-yellow', ldrawCode: 14, rgb: '#F2CD37' },
  ],
};
export async function fixture(): Promise<BrkDocument> {
  const result = importLDraw(await readFile(path.join(fixturePath, 'mod-01.mpd'), 'utf8'), 'mod-01.mpd', catalog);
  if (!result.doc) throw new Error(JSON.stringify(result.report));
  return result.doc;
}
export const packed = (doc: BrkDocument) =>
  packProject(doc, createWorkspace(), {}, { savedAt: '2026-10-16T00:00:00.000Z' });
export async function temporary(): Promise<string> {
  const parent = path.join(repo, '.devdata/tmp/io-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, 'run-'));
}
export async function cleanup(dir: string): Promise<void> {
  const parent = path.resolve(repo, '.devdata/tmp/io-tests');
  if (!path.resolve(dir).startsWith(parent + path.sep)) throw new Error('Unsafe cleanup');
  await rm(dir, { recursive: true, force: true });
}
/** Semantic structure independent of newly assigned document/model/instance ULIDs. */
export function structure(doc: BrkDocument, uids = false): unknown {
  return Object.values(doc.models).map((model) => ({
    name: model.name,
    steps: model.stepIds.map((id) => model.steps[id]!.instanceIds.length),
    instances: orderedInstances(model).map((i) => ({
      ref: i.ref.kind === 'part' ? i.ref.partId : doc.models[i.ref.modelId]!.name,
      color: i.colorId,
      transform: i.transform,
      ...(uids ? { external: i.extensions } : {}),
    })),
  }));
}
