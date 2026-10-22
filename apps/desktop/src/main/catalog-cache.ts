import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { buildCatalogIndex, importPack, readColors } from '@brickloop/catalog';
import type { CatalogIndex, ColorDef, Pack } from '@brickloop/catalog';

interface Snapshot {
  version: 1;
  fingerprint: string;
  catalog: CatalogIndex;
  colors: ColorDef[];
  demo: Pack;
}
export interface CatalogCachePaths {
  library: string;
  catalog: string;
  demo: string;
}
async function fingerprint(paths: CatalogCachePaths): Promise<string> {
  const files = [
    path.join(paths.library, 'LDConfig.ldr'),
    path.join(paths.library, 'parts'),
    ...(await readdir(paths.demo)).sort().map((name) => path.join(paths.demo, name)),
  ];
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file);
      return [file, info.size, info.mtimeMs];
    }),
  );
  return createHash('sha256')
    .update(JSON.stringify(['desktop-catalog-1', stamps]))
    .digest('hex');
}
async function save(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, serialize(snapshot));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Binary snapshots skip directory scans and spreadsheet parsing on the startup path.
 * A full source validation runs after ready, detecting in-place edits missed by directory mtimes. */
export async function loadCatalogSnapshot(paths: CatalogCachePaths) {
  const file = path.join(paths.catalog, 'desktop-snapshot.bin'),
    stamp = await fingerprint(paths);
  let cached: Snapshot | undefined;
  try {
    const value = deserialize(await readFile(file)) as Snapshot;
    if (
      value.version === 1 &&
      value.fingerprint === stamp &&
      value.catalog.schemaVersion === 1 &&
      Array.isArray(value.catalog.parts) &&
      value.demo.manifest.id === 'demo'
    )
      cached = value;
  } catch {
    /* Missing or interrupted cache is rebuilt through public catalog APIs. */
  }
  async function build(): Promise<Snapshot> {
    const [catalog, colors] = await Promise.all([
      buildCatalogIndex({ libraryDir: paths.library, cacheDir: paths.catalog }),
      readColors(path.join(paths.library, 'LDConfig.ldr')),
    ]);
    const result = await importPack(paths.demo, { catalog, colors });
    if (!result.pack) throw new Error('Invalid bundled catalog pack');
    const snapshot: Snapshot = { version: 1, fingerprint: stamp, catalog, colors, demo: result.pack };
    await save(file, snapshot);
    return snapshot;
  }
  const snapshot = cached ?? (await build());
  return {
    ...snapshot,
    cacheHit: !!cached,
    async validate(): Promise<Snapshot | null> {
      if (!cached) return null;
      const catalog = await buildCatalogIndex({ libraryDir: paths.library, cacheDir: paths.catalog });
      if (catalog.libraryVersion === cached.catalog.libraryVersion) return null;
      return build();
    },
  };
}
