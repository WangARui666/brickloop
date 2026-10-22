import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { applyOps, createDocument, DocumentSession, expandInstances } from '@brickloop/core';
import { parseConnectorFile } from '@brickloop/connect';
import { parseColliderOverride } from '@brickloop/collide';
import type { CheckOptions } from '@brickloop/collide';
import { AiCheckEngine } from '../src/renderer/src/ai-check-engine';
import { AssemblyEngine } from '../src/renderer/src/assembly-engine';
import type { AssemblySnapshot } from '../src/renderer/src/assembly-engine';
import type { AssemblyPart } from '../src/shared/assembly-api';
import { aiWriteScaleFixture } from '../e2e/fixtures/ai-write-scale';

const connectors = parseConnectorFile(readFileSync('library/connectors/3001.json', 'utf8')).file!;
const override = parseColliderOverride(JSON.parse(readFileSync('library/colliders/ld%3A3001.collider.json', 'utf8')));
const part: AssemblyPart = {
  connectors,
  overrideVersion: override.version,
  collider: {
    schema: 1,
    partId: 'ld:3001',
    generatorVersion: 'test',
    source: 'manual',
    approximate: false,
    shapes: override.shapes,
    bounds: [-40, -4, -20, 40, 24, 20],
    diagnostics: [],
  },
};
const options: CheckOptions = { collisionEnabled: true, collisionBudgetMs: 5000, groundIsFixed: true, grid: false };
function snapshot(doc: AssemblySnapshot['doc'], definition = part): AssemblySnapshot {
  return structuredClone({
    doc,
    parts: [['ld:3001', definition]],
    collision: true,
    hidden: [],
    catalog: {
      parts: [
        { id: 'ld:3001', factory: true, colors: ['c:bright-red', 'c:bright-blue', 'c:bright-yellow', 'c:black'] },
      ],
      colors: ['c:bright-red', 'c:bright-blue', 'c:bright-yellow', 'c:black'],
    },
  });
}

it('updates geometry in proportion to affected occurrences, including late writes and rollback on 1500 parts', () => {
  const fixture = aiWriteScaleFixture();
  const checks = new AiCheckEngine();
  const engine = checks.sync(snapshot(fixture.document));
  const world = engine.world;
  const graph = engine.graph;
  const setCollider = vi.spyOn(world, 'set');
  const setConnectors = vi.spyOn(graph.index, 'set');
  let doc = fixture.document;
  for (let index = 0; index < 24; index++) {
    const rows = expandInstances(doc).slice(index * 5, index * 5 + 5);
    doc = applyOps(doc, [
      {
        type: 'instance.update',
        items: rows.map((row) => ({
          modelId: row.modelId,
          instanceId: row.instance.id,
          changes: { colorId: 'c:black' },
        })),
      },
    ]);
    expect(checks.sync(snapshot(doc))).toBe(engine);
  }
  expect(setCollider).not.toHaveBeenCalled();
  expect(setConnectors).not.toHaveBeenCalled();
  const before = doc;
  const rows = expandInstances(doc).slice(0, 5);
  doc = applyOps(doc, [
    {
      type: 'instance.update',
      items: rows.map((row) => ({
        modelId: row.modelId,
        instanceId: row.instance.id,
        changes: { transform: row.instance.transform.map((value, index) => (index === 0 ? value + 10 : value)) },
      })),
    },
  ]);
  checks.sync(snapshot(doc));
  expect(setCollider).toHaveBeenCalledTimes(5);
  expect(setConnectors).toHaveBeenCalledTimes(5);
  checks.sync(snapshot(before));
  expect(setCollider).toHaveBeenCalledTimes(10);
  expect(setConnectors).toHaveBeenCalledTimes(10);
  expect(engine.world).toBe(world);
  expect(engine.graph).toBe(graph);
});

it('matches fresh checks through colour, position, shared models, rejection, part updates and document switches', () => {
  const session = new DocumentSession(createDocument(), { bboxProvider: () => part.collider.bounds });
  const checks = new AiCheckEngine();
  const compare = (doc = session.document, definition = part) => {
    const input = snapshot(doc, definition);
    const fresh = new AssemblyEngine();
    fresh.sync(input);
    const reused = checks.sync(input);
    expect(reused.check(options).issues).toEqual(fresh.check(options).issues);
    expect(reused.graph.components()).toEqual(fresh.graph.components());
    const path = expandInstances(doc)[0]?.path;
    if (path) {
      const scoped = { ...options, scope: 'currentModel' as const, activeModelPath: path.slice(0, -1) };
      expect(reused.check(scoped).issues).toEqual(fresh.check(scoped).issues);
    }
  };
  const command = (command: Parameters<DocumentSession['dispatch']>[0]) => {
    expect(session.dispatch(command).ok).toBe(true);
    compare();
  };
  command({ type: 'part.add', partId: 'ld:3001', colorId: 'c:bright-red' });
  command({ type: 'part.add', partId: 'ld:3001', colorId: 'c:bright-blue' });
  command({ type: 'color.set', colorId: 'c:bright-red' });
  command({ type: 'transform.translate', delta: [0, -24, 0] });
  command({ type: 'submodel.create', name: 'shared' });
  const modelId = Object.values(session.document.models).find((model) => model.kind === 'submodel')!.id;
  command({ type: 'submodel.instantiate', modelId });
  const before = session.document;
  command({ type: 'transform.translate', delta: [20, 0, 0] });
  compare(before); // Atomic rollback and task copies may revisit the same revision.
  compare(session.document);
  compare(session.document, { ...part, missing: [['synthetic-missing.dat']] });
  compare(session.document, { ...part, connectors: { ...part.connectors, connectors: [] } });
  compare();
  command({ type: 'edit.delete' });
  compare(createDocument());
  compare();
});
