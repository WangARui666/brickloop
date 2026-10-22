import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandInstances } from '@brickloop/core';
import { ConnectionGraph, documentConnectorSource, parseConnectorFile } from '@brickloop/connect';
import type { ConnectorFile } from '@brickloop/connect';
import { buildCollider, CollisionWorld, runChecks } from '@brickloop/collide';
import type { Collider } from '@brickloop/collide';
import { createOverrideLoader } from '@brickloop/collide/node';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { importPack } from '@brickloop/catalog';
import type { Pack } from '@brickloop/catalog/types';
import { macroAvailability, readMacro } from '../src';
import type { MacroPackage } from '../src';
import { readZip } from '../src/binary';
import { repo } from './helpers';

interface Entry {
  id: string;
  file: string;
  nameZh: string;
  nameEn: string;
  category: string;
  partCount: number;
  dimensionsLdu: number[];
}
const directory = path.join(repo, 'library/macros/builtin');
const names = ['table', 'chair', 'bed', 'bookshelf', 'door', 'streetlight'];
const macros = new Map<string, MacroPackage>();
let entries: Entry[];
beforeAll(async () => {
  entries = (JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as { macros: Entry[] }).macros;
  for (const name of names) {
    const bytes = await readFile(path.join(directory, `${name}.brklmacro`));
    const result = readMacro(bytes);
    expect(result.ok, name + JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) throw new Error(name);
    macros.set(name, result.value);
    expect(Object.keys(readZip(bytes).members).sort()).toEqual(['macro.json', 'manifest.json', 'model.json']);
  }
});
it.each(names)('built-in %s is readable with matching index and no thumbnail', (name) => {
  const pkg = macros.get(name)!;
  const entry = entries.find((entry) => entry.id === pkg.meta.id)!;
  expect(entries).toHaveLength(6);
  expect(entry.partCount).toBe(expandInstances(pkg.document).length);
  expect(entry.nameZh).toBe((pkg.meta.name as Record<string, string>)['zh-CN']);
  expect(entry.nameEn).toBe((pkg.meta.name as Record<string, string>).en);
  expect(entry.category).toBe(pkg.meta.category);
  expect(entry.dimensionsLdu).toEqual([0, 1, 2].map((axis) => pkg.meta.bboxLdu[axis + 3]! - pkg.meta.bboxLdu[axis]!));
  expect(pkg.meta.bboxLdu[4]).toBe(0);
  expect(pkg.thumbnail).toBeUndefined();
});

describe.skipIf(!existsSync(path.join(repo, 'library/ldraw/LDConfig.ldr')))(
  'built-in physical and demo-pack acceptance',
  () => {
    const connectors = new Map<string, ConnectorFile>(),
      colliders = new Map<string, Collider>();
    let pack: Pack;
    beforeAll(async () => {
      const result = await importPack(path.join(repo, 'library/packs/demo'));
      expect(result.report.errors).toEqual([]);
      pack = result.pack!;
      const resolver = createLibraryResolver({ libraryDir: path.join(repo, 'library/ldraw') });
      const loadOverride = createOverrideLoader(path.join(repo, 'library/colliders'));
      const ids = new Set([...macros.values()].flatMap((pkg) => pkg.meta.partIds));
      for (const id of ids) {
        const file = `${id.slice(3)}.dat`;
        const parsed = parseConnectorFile(
          await readFile(path.join(repo, `library/connectors/${id.slice(3)}.json`), 'utf8'),
        );
        expect(parsed.issues).toEqual([]);
        connectors.set(id, parsed.file!);
        const mesh = await buildPartMesh(file, resolver);
        expect(mesh.diagnostics.missing).toEqual([]);
        const collider = await buildCollider(file, resolver, mesh, { loadOverride });
        expect(collider.approximate, id).toBe(false);
        colliders.set(id, collider);
      }
    }, 60_000);
    it.each(names)('%s: zero collisions, no unknowns, one connected component, demo-only parts/colors', (name) => {
      const pkg = macros.get(name)!,
        rows = expandInstances(pkg.document);
      expect(macroAvailability(pkg, pack)).toEqual({ missingParts: [], missingColors: [], unavailableColors: [] });
      // Odd/even stud counts use the standard half-stud horizontal grid; heights are whole plates.
      expect(
        rows.every(
          (row) => row.worldMatrix[12]! % 10 === 0 && row.worldMatrix[14]! % 10 === 0 && row.worldMatrix[13]! % 8 === 0,
        ),
      ).toBe(true);
      const graph = new ConnectionGraph(
        documentConnectorSource(
          () => pkg.document,
          (partId) => connectors.get(partId)!.connectors,
        ),
      );
      const world = new CollisionWorld({
        instances: rows.map((row) => ({
          path: row.path,
          transform: row.worldMatrix,
          collider: colliders.get(row.partId)!,
        })),
      });
      const collision = world.queryAll(undefined, { budgetMs: Infinity });
      expect(collision, name).toMatchObject({ status: 'none', pairs: [], unknownPaths: [] });
      expect(graph.components(), name).toHaveLength(1);
      expect(graph.components()[0]).toHaveLength(pkg.meta.partCount);
      expect(
        runChecks(
          pkg.document,
          {
            collisionWorld: world,
            connectivity: { components: () => graph.components(), isConnectorDataReviewed: () => undefined },
          },
          { kinds: ['collision', 'collisionUnknown', 'floating'], collisionBudgetMs: Infinity },
        ),
      ).toEqual([]);
      expect(rows.some((row) => Math.abs(world.bounds(row.path)![4]) < 1e-6)).toBe(true);
      console.log(
        `MACRO ${name}: parts=${rows.length}, collisions=${collision.pairs.length}, floating=0, components=${graph.components().length}`,
      );
    });
    it('generator reproduces checked-in bytes and is deterministic on repeated generation', () => {
      const result = spawnSync(
        process.execPath,
        ['scripts/devenv.mjs', 'pnpm', 'exec', 'tsx', '--no-cache', 'scripts/build-macros.mjs', '--check'],
        { cwd: repo, encoding: 'utf8' },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }, 30_000);
  },
);
