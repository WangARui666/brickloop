import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession, expandInstances, toLDraw, translation } from '@brickloop/core';
import { parseConnectorFile } from '@brickloop/connect';
import { parseColliderOverride } from '@brickloop/collide';
import { AssemblyEngine } from '../src/renderer/src/assembly-engine';
import type { AssemblyPart } from '../src/shared/assembly-api';

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
function scene(positions: [number, number, number][]) {
  const session = new DocumentSession(createDocument());
  for (const position of positions) {
    const result = session.dispatch({
      type: 'part.add',
      partId: 'ld:3001',
      colorId: 'c:bright-red',
      transform: toLDraw(translation(position)),
    });
    if (!result.ok) throw new Error(result.error.messageKey);
  }
  // Correctness fixtures do not depend on scheduler load; production uses the default 4 ms budget.
  const engine = new AssemblyEngine(1000);
  const graph = engine.sync({ doc: session.document, parts: [['ld:3001', part]], collision: true });
  return { engine, session, graph };
}
it('honors the explicit collision budget for complete AI checks while reporting exhausted checks as unknown', () => {
  const { engine } = scene([
    [0, -24, 0],
    [10, -24, 0],
  ]);
  const exhausted = engine.check({
    collisionEnabled: true,
    collisionBudgetMs: 0,
    kinds: ['collision', 'collisionUnknown'],
  });
  expect(exhausted.issues.some((i) => i.kind === 'collisionUnknown')).toBe(true);
  const complete = engine.check({
    collisionEnabled: true,
    collisionBudgetMs: 5000,
    kinds: ['collision', 'collisionUnknown'],
  });
  expect(complete.issues.some((i) => i.kind === 'collision')).toBe(true);
  expect(complete.issues.some((i) => i.kind === 'collisionUnknown')).toBe(false);
});
it('checks AI issues with one collision query and skips unused graph materialization', () => {
  const { engine, session } = scene([
    [0, -24, 0],
    [10, -24, 0],
  ]);
  const queries = vi.spyOn(engine.world, 'queryAll');
  const markers = vi.spyOn(engine.graph.index, 'entriesOf');
  const edges = vi.spyOn(engine.graph, 'edgesOf');
  engine.sync({ doc: session.document, parts: [], collision: true }, false);
  expect(markers).not.toHaveBeenCalled();
  expect(edges).not.toHaveBeenCalled();
  const options = { collisionEnabled: true, collisionBudgetMs: Infinity };
  const issues = engine.checkIssues(options);
  expect(queries).toHaveBeenCalledTimes(1);
  expect(issues).toEqual(engine.check(options).issues);
});
describe('desktop connection/collision integration', () => {
  it('updates only changed collision entries after a committed move and checks the new graph', () => {
    const { engine, session } = scene([
      [0, -24, 0],
      [120, -24, 0],
      [240, -24, 0],
    ]);
    const set = vi.spyOn(engine.world, 'set');
    session.dispatch({ type: 'transform.translate', delta: [20, 0, 0] });
    const next = engine.sync({ doc: session.document, parts: [], collision: true });
    expect(set).toHaveBeenCalledTimes(1);
    expect(next.components.flat()).toHaveLength(3);
    expect(engine.check({ collisionEnabled: false }).issues.some((issue) => issue.kind === 'floating')).toBe(true);
  });
  it('does not snap to hidden occurrences while retaining them in the document graph', () => {
    const { engine, session } = scene([[0, -24, 0]]);
    const path = expandInstances(session.document)[0]!.path;
    engine.sync({ doc: session.document, parts: [], collision: true, hidden: [path] });
    const result = engine.preview({
      selection: [
        {
          path: ['$preview'],
          partId: 'ld:3001',
          matrix: Array.from(translation([0, -48, 0])),
          fallback: Array.from(translation([0, -48, 0])),
        },
      ],
      primaryPath: ['$preview'],
      enabled: true,
      collision: false,
      continuous: false,
    });
    expect(result.chosen).toBeNull();
    expect(engine.graph.components()).toEqual([[path]]);
  });
  it('reports exhausted preview budgets explicitly, and disabled collision has zero tested pairs', () => {
    const { session } = scene([[0, -24, 0]]);
    const engine = new AssemblyEngine(0);
    engine.sync({ doc: session.document, parts: [['ld:3001', part]], collision: true });
    const request = {
      selection: [
        {
          path: ['$preview'],
          partId: 'ld:3001',
          matrix: Array.from(translation([0, -48, 0])),
          fallback: Array.from(translation([0, -48, 0])),
        },
      ],
      primaryPath: ['$preview'],
      enabled: true,
      collision: true,
      continuous: false,
    };
    const result = engine.preview(request);
    expect(result.chosen?.collision).toBe('unknown');
    expect(result.collision.reasons).toEqual(['budget']);
    expect(result.collision.unknownPaths).toEqual([['$preview']]);
    const disabled = engine.preview({ ...request, collision: false });
    expect(disabled.collision.status).toBe('none');
    expect(disabled.collision.testedPairs).toBe(0);
  });
  it('snaps a half-grid offset to connector planes at -48 and fills real collision status', () => {
    const { engine } = scene([[0, -24, 0]]);
    const result = engine.preview({
      selection: [
        {
          path: ['$preview'],
          partId: 'ld:3001',
          matrix: Array.from(translation([9, -48, 0])),
          fallback: Array.from(translation([10, -48, 0])),
        },
      ],
      primaryPath: ['$preview'],
      enabled: true,
      collision: true,
      continuous: false,
    });
    expect(result.chosen).not.toBeNull();
    expect(result.transforms[0]!.transform.slice(12, 15)).toEqual([0, -48, 0]);
    expect(result.chosen!.collision).toBe('none');
    expect(result.markers.some((m) => m.connector.type === 'stud')).toBe(true);
    expect(result.markers.some((m) => m.connector.type.startsWith('antistud'))).toBe(true);
  });
  it('disabled snapping keeps the body-plane fallback and detects offset interpenetration; disabled collision does no work', () => {
    const { engine } = scene([[0, -24, 0]]);
    const request = {
      selection: [
        {
          path: ['$preview'],
          partId: 'ld:3001',
          matrix: Array.from(translation([9, -48, 0])),
          fallback: Array.from(translation([10, -48, 0])),
        },
      ],
      primaryPath: ['$preview'],
      enabled: false,
      collision: true,
      continuous: false,
    };
    const result = engine.preview(request);
    expect(result.transforms[0]!.transform.slice(12, 15)).toEqual([10, -48, 0]);
    expect(result.chosen).toBeNull();
    expect(result.collision.pairs.some((pair) => pair.status === 'hit')).toBe(true);
    const off = engine.preview({ ...request, collision: false });
    expect(off.collision.status).toBe('none');
    expect(off.collision.testedPairs).toBe(0);
  });
  it('real graph drives floating, review status, connected selection and scoped components', () => {
    const { engine, session, graph } = scene([
      [0, -24, 0],
      [0, -48, 0],
      [160, -80, 0],
    ]);
    expect(graph.components.map((c) => c.length).sort()).toEqual([1, 2]);
    const result = engine.check({ collisionEnabled: false });
    const rows = expandInstances(session.document);
    expect(result.issues.filter((i) => i.kind === 'floating').flatMap((i) => i.paths)).toEqual([rows[2]!.path]);
    expect(result.issues.filter((i) => i.kind === 'unreviewedConnectors')).toHaveLength(3);
    expect(
      engine
        .check({ scope: 'selection', selection: [rows[0]!.path], collisionEnabled: false })
        .issues.some((i) => i.kind === 'floating'),
    ).toBe(false);
  });
  it('incremental graph updates remove old connections and honor reviewed files', () => {
    const { engine, session } = scene([
      [0, -24, 0],
      [0, -48, 0],
    ]);
    session.dispatch({ type: 'transform.translate', delta: [200, 0, 0] });
    const updated = engine.sync({
      doc: session.document,
      parts: [['ld:3001', { ...part, connectors: { ...connectors, status: 'reviewed' } }]],
      collision: false,
    });
    expect(updated.components).toHaveLength(2);
    expect(engine.check({ collisionEnabled: false }).issues.some((i) => i.kind === 'unreviewedConnectors')).toBe(false);
  });
});
