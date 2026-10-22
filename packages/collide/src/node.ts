import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { LibraryResolver, PartMesh } from '@brickloop/ldraw';
import { buildCollider, colliderFileName, partIdForFile } from './build.js';
import { GENERATOR_VERSION } from './types.js';
import type { Collider, ColliderBuildOptions } from './types.js';
import { isCollider, parseColliderOverride } from './validation.js';

const digest = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest();
const MAGIC = Buffer.from('BLCOLL01');
export function hashMesh(mesh: PartMesh): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([mesh.partFile, mesh.bboxLdu, mesh.diagnostics, mesh.sources]));
  for (const batch of mesh.batches) {
    hash.update(JSON.stringify([batch.color, batch.positions.length, batch.indices.length]));
    hash.update(new Uint8Array(batch.positions.buffer, batch.positions.byteOffset, batch.positions.byteLength));
    hash.update(new Uint8Array(batch.indices.buffer, batch.indices.byteOffset, batch.indices.byteLength));
  }
  return hash.digest('hex');
}
export function createOverrideLoader(directory: string): NonNullable<ColliderBuildOptions['loadOverride']> {
  return async (partId) => {
    let text: string;
    try {
      text = await readFile(path.join(directory, colliderFileName(partId)), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    return parseColliderOverride(value, partId);
  };
}
export interface ColliderCache {
  get(key: string): Promise<Collider | undefined>;
  set(key: string, collider: Collider): Promise<void>;
  build(
    partFile: string,
    resolver: LibraryResolver,
    mesh: PartMesh,
    options?: ColliderBuildOptions,
  ): Promise<{ collider: Collider; key: string; cacheHit: boolean }>;
}
/** Caller owns the directory and eviction policy; no default path or Worker-side filesystem. */
export function createColliderCache(directory: string): ColliderCache {
  const filename = (key: string): string => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('Collider cache key must be a SHA-256 digest');
    return path.join(directory, `${key}.collider`);
  };
  const cache: ColliderCache = {
    async get(key) {
      const file = filename(key);
      try {
        const bytes = await readFile(file);
        if (
          bytes.length < 40 ||
          !bytes.subarray(0, 8).equals(MAGIC) ||
          !digest(bytes.subarray(40)).equals(bytes.subarray(8, 40))
        )
          throw new Error('Invalid collider cache envelope');
        const value: unknown = deserialize(bytes.subarray(40));
        if (
          typeof value !== 'object' ||
          value === null ||
          !('key' in value) ||
          value.key !== key ||
          !('collider' in value) ||
          !isCollider(value.collider) ||
          value.collider.generatorVersion !== GENERATOR_VERSION
        )
          throw new Error('Invalid collider cache payload');
        return value.collider;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        await rm(file, { force: true }).catch(() => undefined);
        return undefined;
      }
    },
    async set(key, collider) {
      const file = filename(key);
      if (!isCollider(collider) || collider.generatorVersion !== GENERATOR_VERSION)
        throw new TypeError('Invalid collider');
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const payload = serialize({ key, collider });
      try {
        await writeFile(temporary, Buffer.concat([MAGIC, digest(payload), payload]));
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async build(partFile, resolver, mesh, options = {}) {
      const partId = options.partId ?? partIdForFile(partFile);
      const override = await options.loadOverride?.(partId);
      if (override !== undefined) parseColliderOverride(override, partId);
      // Mesh coordinates alone do not encode primitive names or resolution source selection.
      const sources = await Promise.all(
        mesh.sources.map(async ({ file }) => {
          const source = await resolver.resolve(
            file,
            options.highResPrimitives === undefined ? {} : { highResPrimitives: options.highResPrimitives },
          );
          return [file, source?.identity, source ? digest(source.text).toString('hex') : null];
        }),
      );
      const config = {
        resolution: options.resolution ?? 2,
        inset: options.inset ?? 0.5,
        maxVoxels: options.maxVoxels ?? 2_000_000,
        maxDepth: options.maxDepth ?? 64,
        highResPrimitives: options.highResPrimitives ?? resolver.highResPrimitives,
      };
      const key = digest(
        JSON.stringify([partId, hashMesh(mesh), GENERATOR_VERSION, config, sources, override ?? null]),
      ).toString('hex');
      const existing = await cache.get(key);
      if (existing) return { collider: existing, key, cacheHit: true };
      const collider = await buildCollider(partFile, resolver, mesh, {
        ...options,
        loadOverride: () => Promise.resolve(override),
      });
      await cache.set(key, collider);
      return { collider, key, cacheHit: false };
    },
  };
  return cache;
}
