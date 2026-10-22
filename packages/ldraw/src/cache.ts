import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { buildPreparedPart } from './builder.js';
import { BUILDER_VERSION, preparePart } from './prepare.js';
import type { LibraryResolver } from './resolver.js';
import type { BuildOptions, PartMesh } from './types.js';

// Binary envelope: magic/version (8 bytes), SHA-256 payload checksum (32), V8 binary payload.
const MAGIC = Buffer.from('BLMESH01');
const digest = (data: string | Uint8Array): Buffer => createHash('sha256').update(data).digest();
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const floats = (value: unknown, multiple: number): value is Float32Array =>
  value instanceof Float32Array && value.length % multiple === 0 && value.every(Number.isFinite);
const color = (value: unknown, sentinel: string): boolean =>
  value === sentinel || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function validMesh(value: unknown): value is PartMesh {
  if (
    !object(value) ||
    typeof value.partFile !== 'string' ||
    typeof value.doubleSided !== 'boolean' ||
    !Array.isArray(value.bboxLdu) ||
    value.bboxLdu.length !== 6 ||
    !value.bboxLdu.every(Number.isFinite) ||
    !Array.isArray(value.batches) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.sources)
  )
    return false;
  if (
    !value.batches.every(
      (batch: unknown) =>
        object(batch) &&
        color(batch.color, 'main') &&
        floats(batch.positions, 3) &&
        floats(batch.normals, 3) &&
        batch.positions.length === batch.normals.length &&
        batch.indices instanceof Uint32Array &&
        batch.indices.length % 3 === 0 &&
        batch.indices.every((index) => index < (batch.positions as Float32Array).length / 3),
    )
  )
    return false;
  if (!value.edges.every((edge: unknown) => object(edge) && color(edge.color, 'edge') && floats(edge.positions, 6)))
    return false;
  const conditional = value.conditionalEdges;
  if (
    !object(conditional) ||
    !floats(conditional.positions, 6) ||
    !floats(conditional.controls, 6) ||
    conditional.positions.length !== conditional.controls.length
  )
    return false;
  if (
    conditional.colors !== undefined &&
    (!Array.isArray(conditional.colors) ||
      conditional.colors.length !== conditional.positions.length / 6 ||
      !conditional.colors.every((c) => color(c, 'edge')))
  )
    return false;
  const diagnostics = value.diagnostics;
  return (
    object(diagnostics) &&
    strings(diagnostics.warnings) &&
    Array.isArray(diagnostics.missing) &&
    diagnostics.missing.every(strings) &&
    Array.isArray(diagnostics.cycles) &&
    diagnostics.cycles.every(strings) &&
    value.sources.every(
      (source: unknown) => object(source) && typeof source.file === 'string' && typeof source.resolvedFrom === 'string',
    )
  );
}

export interface MeshCache {
  get(key: string): Promise<PartMesh | undefined>;
  set(key: string, mesh: PartMesh): Promise<void>;
  build(
    partFile: string,
    resolver: LibraryResolver,
    options?: BuildOptions,
  ): Promise<{ mesh: PartMesh; key: string; cacheHit: boolean }>;
}

export function createMeshCache(directory: string): MeshCache {
  const filename = (key: string): string => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Mesh cache key must be a SHA-256 hex digest');
    return path.join(directory, `${key}.mesh`);
  };
  const cache: MeshCache = {
    async get(key) {
      const file = filename(key);
      try {
        const data = await readFile(file);
        if (
          data.length < 40 ||
          !data.subarray(0, 8).equals(MAGIC) ||
          !digest(data.subarray(40)).equals(data.subarray(8, 40))
        )
          throw new Error('Invalid cache envelope');
        const payload: unknown = deserialize(data.subarray(40));
        if (
          !object(payload) ||
          payload.version !== 1 ||
          payload.builder !== BUILDER_VERSION ||
          payload.key !== key ||
          !validMesh(payload.mesh)
        )
          throw new Error('Invalid mesh cache');
        return payload.mesh;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        await rm(file, { force: true }).catch(() => undefined);
        return undefined;
      }
    },
    async set(key, mesh) {
      const file = filename(key);
      if (!validMesh(mesh)) throw new Error('Cannot cache an invalid mesh');
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const payload = serialize({ version: 1, builder: BUILDER_VERSION, key, mesh });
      try {
        await writeFile(temporary, Buffer.concat([MAGIC, digest(payload), payload]));
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async build(partFile, resolver, options = {}) {
      const prepared = await preparePart(partFile, resolver, options);
      const chain = [...prepared.files].map(([file, source]) => [
        file,
        source?.identity ?? null,
        source ? digest(source.text).toString('hex') : null,
      ]);
      const dependencies = prepared.dependencies.map((source) => [
        source.identity,
        digest(source.text).toString('hex'),
      ]);
      const key = digest(
        JSON.stringify([prepared.partFile, BUILDER_VERSION, prepared.options, chain, dependencies]),
      ).toString('hex');
      const cached = await cache.get(key);
      if (cached) return { mesh: cached, key, cacheHit: true };
      const mesh = buildPreparedPart(prepared);
      await cache.set(key, mesh);
      return { mesh, key, cacheHit: false };
    },
  };
  return cache;
}
