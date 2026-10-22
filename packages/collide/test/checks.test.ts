import { describe, expect, it, vi } from 'vitest';
import { createModel, toLDraw, translation } from '@brickloop/core';
import { CollisionWorld, runChecks } from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { documentInstances, documentOf } from './fixtures.js';

const connectivity = (components: string[][][]): NonNullable<CheckContext['connectivity']> => ({
  components: () => components,
  isConnectorDataReviewed: () => true,
});
describe('check.run', () => {
  it('CHK-01 reports precisely the detached component, and uses actual ground bounds', () => {
    const doc = documentOf(3),
      graph = connectivity([[['part-0'], ['part-1']], [['part-2']]]);
    const ctx: CheckContext = { connectivity: graph, worldBounds: () => [-5, -10, -5, 5, 0, 5] };
    expect(runChecks(doc, ctx)).toEqual([
      { kind: 'floating', severity: 'error', paths: [['part-2']], messageKey: 'check.floating', data: { count: 1 } },
    ]);
    expect(runChecks(doc, ctx, { groundIsFixed: true })).toEqual([]);
    expect(
      runChecks(doc, { ...ctx, worldBounds: () => [-5, -10, -5, 5, 2, 5] }, { groundIsFixed: true }).map((i) => i.kind),
    ).toContain('floating');
  });
  it('CHK-02 keeps non-factory part, color and unavailable combination separate with specified severity', () => {
    const doc = documentOf(3),
      model = doc.models[doc.rootModelId]!;
    model.instances['part-0']!.ref = { kind: 'part', partId: 'cu:custom' };
    model.instances['part-1']!.colorId = 'cx:unknown';
    const ctx: CheckContext = {
      catalog: {
        isFactoryPart: (id) => id !== 'cu:custom',
        isFactoryColor: (id) => id !== 'cx:unknown',
        availableColors: () => [{ id: 'c:blue' }],
      },
    };
    expect(runChecks(doc, ctx).map(({ kind, severity, paths }) => ({ kind, severity, paths }))).toEqual([
      { kind: 'nonFactoryPart', severity: 'error', paths: [['part-0']] },
      { kind: 'nonFactoryColor', severity: 'error', paths: [['part-1']] },
      { kind: 'unavailableColor', severity: 'warning', paths: [['part-2']] },
    ]);
  });
  it('CHK-03 detects full overlapping duplicate groups independent of collision and does not mutate documents', () => {
    const doc = documentOf(3, 0),
      before = JSON.stringify(doc);
    const world = new CollisionWorld({ instances: documentInstances(doc) });
    const issues = runChecks(doc, { collisionWorld: world });
    expect(issues.filter((i) => i.kind === 'collision')).toHaveLength(3);
    expect(issues.find((i) => i.kind === 'duplicate')).toMatchObject({
      severity: 'warning',
      paths: [['part-0'], ['part-1'], ['part-2']],
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(runChecks(doc, {}, { collisionEnabled: false }).map((i) => i.kind)).toEqual(['duplicate']);
  });
  it('CON-03 aligned/connected parts still expose physical penetration alongside the established graph', () => {
    const doc = documentOf(2, 0),
      graph = connectivity([[['part-0'], ['part-1']]]);
    const world = new CollisionWorld({ instances: documentInstances(doc) });
    const issues = runChecks(doc, { connectivity: graph, collisionWorld: world });
    expect(graph.components([['part-0'], ['part-1']])).toHaveLength(1);
    expect(issues.map((i) => i.kind)).toContain('collision');
    expect(issues.map((i) => i.kind)).not.toContain('floating');
    expect(world.query(['part-0']).status).toBe('hit');
  });
  it('missing geometry, inferred connectors and grid position carry structured diagnostics', () => {
    const doc = documentOf(1),
      row = doc.models[doc.rootModelId]!.instances['part-0']!;
    row.transform = toLDraw(translation([5, 0, 0]));
    const issues = runChecks(doc, {
      geometry: () => ({ missing: [['3001.dat', 's/missing.dat']] }),
      connectivity: { components: (scope) => [scope], isConnectorDataReviewed: () => false },
    });
    expect(issues.map(({ kind, severity }) => [kind, severity])).toEqual([
      ['missingGeometry', 'error'],
      ['unreviewedConnectors', 'info'],
      ['offGrid', 'info'],
    ]);
    expect(issues[0]!.data.files).toEqual(['s/missing.dat']);
    expect(runChecks(doc, {}, { grid: { step: [5, 8, 5] } })).toEqual([]);
    expect(runChecks(doc, {}, { grid: { step: 20, origin: [5, 0, 0] } })).toEqual([]);
    expect(runChecks(doc, {}, { grid: false })).toEqual([]);
  });
  it('omits connectivity checks entirely when the optional adapter is absent', () => {
    expect(runChecks(documentOf(3), {})).toEqual([]);
    expect(
      runChecks(documentOf(1), {
        connectivity: { components: (scope) => [scope], isConnectorDataReviewed: () => undefined },
      }),
    ).toEqual([]);
  });
  it('scope follows world occurrence paths, inherited colors, selected submodels and ancestor visibility', () => {
    const doc = documentOf(2),
      root = doc.models[doc.rootModelId]!;
    const child = createModel('shared');
    doc.models[child.id] = child;
    const step = child.stepIds[0]!;
    child.instances.leaf = {
      ...root.instances['part-0']!,
      id: 'leaf',
      stepId: step,
      colorId: 'inherit',
      transform: toLDraw(translation([1, 0, 0])),
    };
    child.steps[step]!.instanceIds = ['leaf'];
    for (const row of Object.values(root.instances)) row.ref = { kind: 'model', modelId: child.id };
    const factoryColor = vi.fn(() => false);
    const ctx: CheckContext = {
      catalog: { isFactoryPart: () => true, isFactoryColor: factoryColor, availableColors: () => [] },
    };
    const options = { kinds: ['nonFactoryColor' as const] };
    expect(runChecks(doc, ctx, options).map((i) => i.paths[0])).toEqual([
      ['part-0', 'leaf'],
      ['part-1', 'leaf'],
    ]);
    expect(factoryColor).toHaveBeenCalledWith('c:red');
    expect(
      runChecks(doc, ctx, { ...options, scope: 'currentModel', activeModelPath: ['part-1'] }).map((i) => i.paths[0]),
    ).toEqual([['part-1', 'leaf']]);
    expect(
      runChecks(doc, ctx, { ...options, scope: 'selection', selection: [['part-0']] }).map((i) => i.paths[0]),
    ).toEqual([['part-0', 'leaf']]);
    expect(runChecks(doc, ctx, { ...options, visibleOnly: true, hidden: [['part-0']] }).map((i) => i.paths[0])).toEqual(
      [['part-1', 'leaf']],
    );
    expect(runChecks(doc, ctx, { scope: 'selection', selection: [] })).toEqual([]);
    expect(runChecks(doc, {}, { scope: 'currentModel', activeModelPath: ['part-1'] })[0]!.data.position).toEqual([
      21, 0, 0,
    ]);
  });
  it('collision option and item filters skip computation; unknown is a separate warning', () => {
    const queryAll = vi.fn(() => ({
      status: 'unknown' as const,
      pairs: [],
      unknownPaths: [['part-0']],
      reasons: ['budget' as const],
      testedPairs: 0,
    }));
    const ctx: CheckContext = { collisionWorld: { queryAll } },
      doc = documentOf(1);
    expect(runChecks(doc, ctx, { collisionEnabled: false })).toEqual([]);
    expect(runChecks(doc, ctx, { kinds: ['duplicate'] })).toEqual([]);
    expect(queryAll).not.toHaveBeenCalled();
    expect(runChecks(doc, ctx)).toMatchObject([
      { kind: 'collisionUnknown', severity: 'warning', paths: [['part-0']], data: { reasons: ['budget'] } },
    ]);
  });
});
