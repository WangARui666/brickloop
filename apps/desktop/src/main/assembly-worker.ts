import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLibraryResolver, createMeshCache } from '@brickloop/ldraw/node';
import { inferConnectors, parseConnectorFile, writeConnectorFile } from '@brickloop/connect';
import { parseColliderOverride, colliderFileName } from '@brickloop/collide';
import { createColliderCache, createOverrideLoader } from '@brickloop/collide/node';
import type { AnnotationSave, AssemblyPart } from '../shared/assembly-api';
import { isPartId } from '../shared/library-api';

const config = workerData as {
  library: string;
  connectors: string;
  colliders: string;
  cache: string;
  meshCache?: string;
};
const resolver = createLibraryResolver({ libraryDir: config.library });
const meshes = createMeshCache(config.meshCache ?? path.join(config.cache, 'mesh'));
const colliders = createColliderCache(path.join(config.cache, 'colliders'));
const loadOverride = createOverrideLoader(config.colliders);
function fileName(id: string) {
  if (!isPartId(id)) throw new Error('Invalid part identifier');
  return id.startsWith('ld:') ? `${id.slice(3)}.json` : `${encodeURIComponent(id)}.json`;
}
async function load(id: string): Promise<AssemblyPart> {
  const file = fileName(id);
  const partFile = `${id.slice(3)}.dat`;
  let connectors;
  try {
    const parsed = parseConnectorFile(await readFile(path.join(config.connectors, file), 'utf8'));
    if (!parsed.file) throw new Error(JSON.stringify(parsed.issues));
    connectors = parsed.file;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    connectors = await inferConnectors(partFile, resolver, { partId: id });
  }
  const { mesh } = await meshes.build(partFile, resolver);
  const { collider } = await colliders.build(partFile, resolver, mesh, { partId: id, loadOverride });
  const override = await loadOverride(id);
  return {
    connectors,
    collider,
    missing: mesh.diagnostics.missing,
    overrideVersion: override ? parseColliderOverride(override).version : 0,
  };
}
async function save(value: AnnotationSave) {
  const connectorText = writeConnectorFile(value.connectors);
  if (!['draft', 'reviewed'].includes(value.connectors.status)) throw new Error('Review status required');
  const collider = parseColliderOverride(value.collider);
  if (collider.partId !== value.connectors.partId) throw new Error('Part identifier mismatch');
  const connectorPath = path.join(config.connectors, fileName(collider.partId));
  const colliderPath = path.join(config.colliders, colliderFileName(collider.partId));
  await mkdir(config.connectors, { recursive: true });
  await mkdir(config.colliders, { recursive: true });
  // Validate both files before replacing either; rollback the first if the second write fails.
  const old = await readFile(connectorPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  await writeFile(`${connectorPath}.tmp`, connectorText);
  await writeFile(`${colliderPath}.tmp`, `${JSON.stringify(collider, null, 2)}\n`);
  await rename(`${connectorPath}.tmp`, connectorPath);
  try {
    await rename(`${colliderPath}.tmp`, colliderPath);
  } catch (error) {
    if (old) await writeFile(connectorPath, old);
    throw error;
  }
  return load(collider.partId);
}
let queue = Promise.resolve();
parentPort!.on('message', (job: { id: number; kind: string; value: string | AnnotationSave }) => {
  queue = queue.then(async () => {
    try {
      const result =
        job.kind === 'save'
          ? await save(job.value as AnnotationSave)
          : job.kind === 'infer'
            ? await inferConnectors(`${String(job.value).slice(3)}.dat`, resolver, { partId: String(job.value) })
            : await load(String(job.value));
      parentPort!.postMessage({ id: job.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
