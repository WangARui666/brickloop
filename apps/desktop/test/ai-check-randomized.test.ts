import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  applyOps,
  createDocument,
  createModel,
  expandInstances,
  toLDraw,
  translation,
  validateDocument,
} from '@brickloop/core';
import type { BrkDocument, Instance, ModelDef, Op } from '@brickloop/core';
import { parseConnectorFile } from '@brickloop/connect';
import type { CheckOptions, Issue } from '@brickloop/collide';
import { AiCheckEngine } from '../src/renderer/src/ai-check-engine';
import { AssemblyEngine } from '../src/renderer/src/assembly-engine';
import type { AssemblySnapshot } from '../src/renderer/src/assembly-engine';
import type { AssemblyPart } from '../src/shared/assembly-api';

const part: AssemblyPart = {
  connectors: parseConnectorFile(readFileSync('library/connectors/3001.json', 'utf8')).file!,
  overrideVersion: 1,
  collider: {
    schema: 1,
    partId: 'ld:3001',
    generatorVersion: 'test',
    source: 'manual',
    approximate: false,
    // A body and stud exercise both narrow-phase primitives without rebuilding
    // the full authored voxel proxy hundreds of times in the default test pool.
    shapes: [
      {
        kind: 'box',
        center: [0, 12, 0],
        halfSize: [39.5, 11.5, 19.5],
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
      { kind: 'cylinder', center: [-30, -2, 0], axis: [0, 1, 0], radius: 5.5, halfLength: 1.5 },
    ],
    bounds: [-40, -4, -20, 40, 24, 20],
    diagnostics: [],
  },
};
const colors = ['c:bright-red', 'c:bright-blue', 'c:black'];
const options: CheckOptions = {
  collisionEnabled: true,
  collisionBudgetMs: Infinity,
  groundIsFixed: true,
  grid: false,
};
const key = (value: unknown) => JSON.stringify(value);
const sorted = <T>(values: T[]) => values.sort((a, b) => key(a).localeCompare(key(b)));
const normalizeIssues = (issues: Issue[]) =>
  sorted(
    issues.map((issue) => ({
      ...issue,
      paths: sorted(issue.paths),
      data: {
        ...issue.data,
        ...(Array.isArray(issue.data.pairs) ? { pairs: sorted(issue.data.pairs) } : {}),
        ...(Array.isArray(issue.data.reasons) ? { reasons: sorted(issue.data.reasons) } : {}),
      },
    })),
  );
function observe(engine: AssemblyEngine, doc: BrkDocument, scoped = false) {
  const rows = expandInstances(doc);
  const checkOptions = scoped
    ? { ...options, scope: 'selection' as const, selection: rows.filter((_, i) => i % 2 === 0).map((r) => r.path) }
    : options;
  return {
    issues: normalizeIssues(engine.checkIssues(checkOptions)),
    components: sorted(engine.graph.components().map((paths) => sorted(paths))),
    edges: sorted([
      ...new Map(rows.flatMap((row) => engine.graph.edgesOf(row.path)).map((edge) => [key(edge), edge])).values(),
    ]),
  };
}

// Mulberry32: fixed, portable seeds; no wall-clock IDs or test-order dependence.
function random(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function fixture() {
  let serial = 0;
  const id = () => String(++serial).padStart(26, '0');
  const doc = createDocument({}, { id, now: () => '2026-10-20T00:00:00.000Z' });
  const root = doc.models[doc.rootModelId]!;
  const shared = createModel('shared', 'submodel', id);
  const nested = createModel('nested', 'submodel', id);
  doc.models[shared.id] = shared;
  doc.models[nested.id] = nested;
  const instance = (model: ModelDef, ref: Instance['ref'], position: [number, number, number]): Instance => ({
    id: id(),
    ref,
    colorId: colors[0]!,
    transform: toLDraw(translation(position)),
    stepId: model.stepIds[0]!,
    groupId: null,
  });
  const insert = (model: ModelDef, ref: Instance['ref'], position: [number, number, number]) => {
    const item = instance(model, ref, position);
    model.instances[item.id] = item;
    model.steps[item.stepId]!.instanceIds.push(item.id);
  };
  for (const y of [-24, -48, -72]) insert(shared, { kind: 'part', partId: 'ld:3001' }, [0, y, 0]);
  for (const x of [0, 240]) insert(root, { kind: 'model', modelId: shared.id }, [x, 0, 0]);
  for (const x of [0, 240]) insert(nested, { kind: 'model', modelId: shared.id }, [x, 0, 0]);
  insert(root, { kind: 'model', modelId: nested.id }, [0, 0, 100]);
  insert(root, { kind: 'part', partId: 'ld:3001' }, [10, -24, 0]); // Confirmed collision.
  insert(nested, { kind: 'part', partId: 'ld:3001' }, [600, -96, 0]); // Floating island.
  return { doc, sharedId: shared.id, instance };
}

it.each([0x1216, 0x5eed, 0xc0ffee])('incremental checks equal a fresh rebuild after 60 edits (seed %i)', (seed) => {
  const rng = random(seed);
  const pick = <T>(values: T[]): T => values[Math.floor(rng() * values.length)]!;
  const initial = fixture();
  let doc = initial.doc;
  let definition = part;
  const checks = new AiCheckEngine();
  const snapshot = (): AssemblySnapshot =>
    structuredClone({
      doc,
      parts: [['ld:3001', definition]],
      collision: true,
      catalog: { parts: [{ id: 'ld:3001', factory: true, colors }], colors },
    });
  const compare = (step: number) => {
    expect(validateDocument(doc), `seed ${seed}, step ${step}: valid fixture`).toEqual([]);
    const input = snapshot();
    const incremental = checks.sync(input);
    const fresh = new AssemblyEngine();
    fresh.sync(input);
    expect(observe(incremental, doc), `seed ${seed}, step ${step}: project`).toEqual(observe(fresh, doc));
    expect(observe(incremental, doc, true), `seed ${seed}, step ${step}: selection`).toEqual(observe(fresh, doc, true));
    return incremental;
  };
  const first = compare(-1);
  expect(first.checkIssues(options).some((issue) => issue.kind === 'collision')).toBe(true);
  expect(first.checkIssues(options).some((issue) => issue.kind === 'floating')).toBe(true);
  expect(first.graph.components().some((component) => component.length > 1)).toBe(true);
  const visited = new Set<number>();
  for (let step = 0; step < 60; step++) {
    const action = step < 5 ? step : Math.floor(rng() * 5);
    visited.add(action);
    const model = pick(Object.values(doc.models));
    const item = pick(Object.values(model.instances));
    let ops: Op[];
    if (action === 0 || !item) {
      const next = initial.instance(model, { kind: 'part', partId: 'ld:3001' }, [
        pick([0, 10, 80, 160]),
        pick([-24, -48, -72]),
        pick([0, 40]),
      ]);
      ops = [{ type: 'instance.add', items: [{ modelId: model.id, instance: next }] }];
    } else if (action === 1 || action === 2) {
      ops = [
        {
          type: 'instance.update',
          items: [
            {
              modelId: model.id,
              instanceId: item.id,
              changes:
                action === 2
                  ? { colorId: pick(colors) }
                  : { transform: item.transform.map((v, i) => (i === 0 ? v + pick([-80, -10, 10, 80]) : v)) },
            },
          ],
        },
      ];
    } else if (action === 3) {
      // Keep the shared/nested occurrences so later definition edits always
      // exercise every occurrence, including ones reached through a nested model.
      const leaf = pick(Object.values(model.instances).filter((v) => v.ref.kind === 'part'));
      ops = leaf ? [{ type: 'instance.remove', items: [{ modelId: model.id, instanceId: leaf.id }] }] : [];
    } else {
      const shared = doc.models[initial.sharedId]!;
      const leaf = pick(Object.values(shared.instances));
      ops = leaf
        ? [
            {
              type: 'instance.update',
              items: [
                {
                  modelId: shared.id,
                  instanceId: leaf.id,
                  changes: {
                    transform: toLDraw(translation([pick([0, 10, 80]), pick([-24, -48, -72]), 0])),
                  },
                },
              ],
            },
          ]
        : [];
    }
    doc = applyOps(doc, ops);
    // Also replace the shared part definition: geometry and connector caches
    // must invalidate even when all occurrence transforms stay unchanged.
    if (step === 19) definition = { ...part, collider: { ...part.collider, approximate: true } };
    if (step === 39) definition = { ...part, connectors: { ...part.connectors, connectors: [] } };
    if (step === 49) definition = part;
    compare(step);
  }
  expect([...visited].sort()).toEqual([0, 1, 2, 3, 4]);
});
