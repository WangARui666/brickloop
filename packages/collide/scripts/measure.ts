import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogIndex, CatalogService, importPack, readColors } from '@brickloop/catalog';
import { createDocument, fromLDraw, toLDraw, translation } from '@brickloop/core';
import type { InstancePath } from '@brickloop/core';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { buildCollider, CollisionWorld, runChecks } from '../src/index.js';
import type { Collider, CollisionInstance } from '../src/index.js';
import { createOverrideLoader } from '../src/node.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const libraryDir = path.join(root, 'library/ldraw'),
  output = path.join(root, 'packages/collide/evidence');
const resolver = createLibraryResolver({ libraryDir });
const catalog = await buildCatalogIndex({ libraryDir, cacheDir: path.join(root, '.devdata/cache/catalog') });
const colors = await readColors(path.join(libraryDir, 'LDConfig.ldr'));
const imported = await importPack(path.join(root, 'library/packs/demo'), { catalog, colors });
if (!imported.pack || imported.report.errors.length) throw new Error(JSON.stringify(imported.report));
const pack = imported.pack,
  service = new CatalogService(catalog, colors, pack);
const override = createOverrideLoader(path.join(root, 'library/colliders'));
await mkdir(output, { recursive: true });
const records: {
  partId: string;
  shapes: number;
  cylinders: number;
  approximate: boolean;
  source: Collider['source'];
  diagnostics: string[];
  manual: boolean;
  elapsedMs: number;
}[] = [];
let brick: Collider | undefined;
if (!process.argv.includes('--performance-only')) {
  for (const [index, part] of pack.parts.entries()) {
    const file = part.ldrawFile;
    if (!file) throw new Error(`Missing demo part file: ${part.partId}`);
    const start = performance.now(),
      mesh = await buildPartMesh(file, resolver);
    const collider = await buildCollider(file, resolver, mesh, { partId: part.partId });
    if (!collider.shapes.length) throw new Error(`No proxy generated: ${part.partId}`);
    if (part.partId === 'ld:3001') brick = collider;
    const manual = await override(part.partId);
    records.push({
      partId: part.partId,
      shapes: collider.shapes.length,
      cylinders: collider.shapes.filter((shape) => shape.kind === 'cylinder').length,
      approximate: collider.approximate,
      source: collider.source,
      diagnostics: collider.diagnostics,
      manual: manual !== undefined,
      elapsedMs: performance.now() - start,
    });
    if ((index + 1) % 25 === 0) console.log(`Generated ${index + 1}/${pack.parts.length}`);
  }
  const summary = {
    total: records.length,
    generated: records.filter((row) => row.shapes > 0).length,
    approximate: records.filter((row) => row.approximate).length,
    manualInDemo: records.filter((row) => row.manual).length,
    records,
  };
  await writeFile(path.join(output, 'generation.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(
    JSON.stringify({
      total: summary.total,
      generated: summary.generated,
      approximate: summary.approximate,
      manualInDemo: summary.manualInDemo,
    }),
  );
}
if (!brick) brick = await buildCollider('3001.dat', resolver, await buildPartMesh('3001.dat', resolver));
const proxy = brick;
const performanceRecords: Record<string, unknown>[] = [];
for (const count of [1_000, 10_000]) {
  const doc = createDocument({ title: 'M3-2 performance' }),
    model = doc.models[doc.rootModelId]!,
    stepId = model.stepIds[0]!;
  const instances: CollisionInstance[] = [];
  for (let i = 0; i < count; i++) {
    const id = `part-${i}`,
      transform = translation([(i % 10) * 80, Math.floor(i / 100) * 24, (Math.floor(i / 10) % 10) * 40]);
    model.instances[id] = {
      id,
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: pack.colors[0]!.colorId,
      stepId,
      groupId: null,
      transform: toLDraw(transform),
    };
    model.steps[stepId]!.instanceIds.push(id);
    instances.push({ path: [id], collider: proxy, transform });
  }
  const resolve = (path: InstancePath): CollisionInstance | undefined => {
    const row = model.instances[path[0]!];
    return row ? { path, collider: proxy, transform: fromLDraw(row.transform) } : undefined;
  };
  const buildStart = performance.now(),
    world = new CollisionWorld({ instances, resolve });
  const worldBuildMs = performance.now() - buildStart;
  const times: number[] = [],
    incrementalStatuses: string[] = [];
  if (count === 1_000)
    for (let i = 0; i < 120; i++) {
      const row = model.instances['part-555']!;
      row.transform[0] = 400 + (i % 2 ? 10 : 0);
      const start = performance.now();
      world.update([['part-555']]);
      const result = world.query(['part-555']);
      if (i >= 20) {
        times.push(performance.now() - start);
        incrementalStatuses.push(result.status);
      }
    }
  model.instances['part-555']!.transform[0] = 400;
  world.update([['part-555']]);
  const before = JSON.stringify(doc);
  const start = performance.now();
  const issues = runChecks(doc, {
    catalog: service,
    collisionWorld: world,
    geometry: () => ({ missing: [] }),
    connectivity: { components: (scope) => [scope], isConnectorDataReviewed: () => true },
  });
  const fullChecksMs = performance.now() - start;
  if (JSON.stringify(doc) !== before) throw new Error('Checks mutated document');
  if (issues.length) throw new Error(JSON.stringify(issues.slice(0, 3)));
  times.sort((a, b) => a - b);
  const record = {
    count,
    shapesPerPart: proxy.shapes.length,
    worldBuildMs,
    fullChecksMs,
    issues: issues.length,
    ...(times.length
      ? {
          incremental: {
            samples: times.length,
            warmup: 20,
            medianMs: times[Math.floor(times.length / 2)],
            p95Ms: times[Math.floor(times.length * 0.95)],
            maxMs: times[times.length - 1],
            statuses: [...new Set(incrementalStatuses)],
          },
        }
      : {}),
    heapUsedMiB: process.memoryUsage().heapUsed / 1024 / 1024,
  };
  performanceRecords.push(record);
  console.log(JSON.stringify(record));
}
await writeFile(
  path.join(output, 'performance.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model,
      scenario:
        'Automatic 3001 proxies; adjacent 10x10 columns, 24 LDU vertical stacking; all checks enabled; connectivity supplied as one component; full check has no time limit; drag alternates legal and half-stud-offset positions; update plus query included; world construction measured separately.',
      records: performanceRecords,
    },
    null,
    2,
  ) + '\n',
);
