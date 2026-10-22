import { describe, expect, it } from 'vitest';
import {
  apply,
  createDocument,
  createModel,
  createUlidGenerator,
  expandInstances,
  multiply,
  rotationAxisAngle,
  toLDraw,
  translation,
  serializeDocument,
  parseDocument,
  copySelection,
  pasteInto,
  applyOps,
} from '@brickloop/core';
import type { Instance } from '@brickloop/core';
import brickJson from '../../../library/connectors/3001.json';
import { ConnectionGraph, documentConnectorSource, parseConnectorFile, solveSnap, instantiateConnectors } from '../src';
import { bar, connector, instance } from './fixtures';

const brick = parseConnectorFile(brickJson).file!.connectors;
describe('connection graph', () => {
  it('two stacked 3001 form one component; removing the middle of three splits components', () => {
    let scene = [
      instance('top', brick, [0, -48, 0]),
      instance('middle', brick, [0, -24, 0]),
      instance('bottom', brick),
    ];
    const graph = new ConnectionGraph({ instances: () => scene });
    expect(graph.components()).toHaveLength(1);
    expect(graph.connectedTo(['middle'])).toHaveLength(3);
    expect(graph.edgesOf(['top'])).toHaveLength(8);
    scene = scene.filter((i) => i.path[0] !== 'middle');
    expect(graph.update([['middle']])).toEqual({ updatedInstances: 0, removedInstances: 1 });
    expect(graph.components()).toEqual([[['bottom']], [['top']]]);
    scene = [instance('a', brick, [0, -24, 0]), instance('b', brick)];
    expect(new ConnectionGraph(scene).components()).toHaveLength(1);
  });
  it('respects graph tolerances and rejects misaligned grid rotations', () => {
    const a = instance('a', [connector('stud')], [0, 0.6, 0]),
      b = instance('b', [connector('antistud')]);
    expect(new ConnectionGraph([a, b]).components()).toHaveLength(2);
    expect(new ConnectionGraph([a, b], { positionTolerance: 0.7 }).components()).toHaveLength(1);
    const grid = connector('stud', { grid: { rows: 1, cols: 1, pitch: 20, mask: null } });
    const tilted = { ...instance('a', [grid]), worldMatrix: rotationAxisAngle([0, 1, 0], 10) };
    expect(new ConnectionGraph([tilted, b]).components()).toHaveLength(2);
  });
  it('separates hollow-stud inner and outer occupancy, excluding the dragged group', () => {
    const hollow = connector('stud.hollow', { diameter: 8 });
    const scene = [instance('h', [hollow]), instance('outer', [connector('antistud')])];
    const graph = new ConnectionGraph({ instances: () => scene });
    const inner = instantiateConnectors(instance('bar', [bar()]))[0]!;
    const ref = { path: ['h'], connectorId: 'stud.hollow' };
    expect(graph.isOccupied(ref, inner)).toBe(false);
    const outer = instantiateConnectors(instance('next', [connector('antistud')]))[0]!;
    expect(graph.isOccupied(ref, outer)).toBe(true);
    expect(graph.isOccupied(ref, outer, [['outer']])).toBe(false);
    expect(
      solveSnap({
        selection: [instance('s', [connector('antistud')])],
        index: graph.index,
        isOccupied: graph.isOccupied,
      }).rejected.some((r) => r.reason === 'occupied'),
    ).toBe(true);
  });
});

function sharedFixture() {
  let time = 1700000000000;
  const id = createUlidGenerator({ clock: () => time++, random: () => 0.3 });
  let doc = createDocument({ title: 'shared' }, { id });
  const root = doc.models[doc.rootModelId]!,
    pair = createModel('pair', 'submodel', id);
  const part = (y: number): Instance => ({
    id: id(),
    ref: { kind: 'part', partId: 'ld:3001' },
    colorId: 'ld:4',
    transform: toLDraw(translation([0, y, 0])),
    stepId: pair.stepIds[0]!,
    groupId: null,
  });
  const top = part(-24),
    bottom = part(0);
  pair.instances = { [top.id]: top, [bottom.id]: bottom };
  pair.steps[pair.stepIds[0]!]!.instanceIds = [top.id, bottom.id];
  const visit = (rotation: number, x: number): Instance => ({
    id: id(),
    ref: { kind: 'model', modelId: pair.id },
    colorId: 'ld:4',
    transform: toLDraw(multiply(translation([x, 0, 0]), rotationAxisAngle([1, 2, 3], rotation))),
    stepId: root.stepIds[0]!,
    groupId: null,
  });
  const a = visit(0, 0),
    b = visit(67, 300);
  doc = applyOps(doc, [
    { type: 'model.add', items: [pair] },
    { type: 'instance.add', items: [a, b].map((instance) => ({ modelId: root.id, instance })) },
  ]);
  return { doc, pair, top, bottom, a, b, part };
}
describe('shared document occurrences', () => {
  it('CON-07/MOD-06 updates every shared visit and keeps unaffected index entries', () => {
    const f = sharedFixture();
    let doc = f.doc;
    const graph = new ConnectionGraph(
      documentConnectorSource(
        () => doc,
        () => brick,
      ),
    );
    expect(graph.components()).toHaveLength(2);
    expect(graph.edgesOf([f.a.id, f.top.id])).toHaveLength(8);
    expect(graph.edgesOf([f.b.id, f.top.id])).toHaveLength(8);
    const unaffected = graph.index.entriesOf([f.a.id, f.bottom.id]);
    doc = apply(doc, {
      type: 'instance.update',
      items: [{ modelId: f.pair.id, instanceId: f.top.id, changes: { transform: toLDraw(translation([0, -60, 0])) } }],
    });
    expect(graph.update([[f.a.id, f.top.id]]).updatedInstances).toBe(2);
    expect(graph.components()).toHaveLength(4);
    expect(graph.index.entriesOf([f.a.id, f.bottom.id])).toBe(unaffected);
    const fresh = new ConnectionGraph(
      expandInstances(doc).map((e) => ({ path: e.path, worldMatrix: e.worldMatrix, connectors: brick })),
    );
    expect(graph.components()).toEqual(fresh.components());
    const inserted = f.part(-24);
    doc = apply(doc, { type: 'instance.add', items: [{ modelId: f.pair.id, instance: inserted }] });
    expect(graph.update([[f.a.id, inserted.id]]).updatedInstances).toBe(2);
    expect(graph.edgesOf([f.b.id, inserted.id])).toHaveLength(8);
    doc = apply(doc, { type: 'instance.remove', items: [{ modelId: f.pair.id, instanceId: inserted.id }] });
    expect(graph.update([[f.a.id, inserted.id]]).removedInstances).toBe(2);
  });
  it('handles additions into shared empty submodels', () => {
    const f = sharedFixture();
    let doc = apply(f.doc, {
      type: 'instance.remove',
      items: [f.top, f.bottom].map((i) => ({ modelId: f.pair.id, instanceId: i.id })),
    });
    const graph = new ConnectionGraph(
      documentConnectorSource(
        () => doc,
        () => brick,
      ),
    );
    const inserted = f.part(0);
    doc = apply(doc, { type: 'instance.add', items: [{ modelId: f.pair.id, instance: inserted }] });
    expect(graph.update([[f.a.id, inserted.id]]).updatedInstances).toBe(2);
    expect(graph.index.size).toBe(2);
  });
  it('CON-06 copy shared hinge metadata, serialize, parse, instantiate under mirrored transforms', () => {
    const f = sharedFixture();
    let doc = f.doc;
    const hinge = connector('hinge.click', {
      size: 'small',
      role: 'a',
      limits: [-30, 45],
      tag: 'hinge-fixture',
      rotation: 15,
    });
    doc = apply(doc, {
      type: 'instance.update',
      items: [{ modelId: f.pair.id, instanceId: f.top.id, changes: { connectorData: [hinge] } }],
    });
    const context = { activeModelPath: [], selection: [[f.b.id]] };
    const copied = copySelection(doc, context.selection);
    const pasted = pasteInto(doc, context, copied, { offset: [0, 100, 0] });
    doc = applyOps(doc, pasted);
    const restored = parseDocument(serializeDocument(doc)).doc!;
    const rows = expandInstances(restored).filter((row) => row.instance.connectorData);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.instance.connectorData).toEqual([hinge]);
      const world = instantiateConnectors({ path: row.path, worldMatrix: row.worldMatrix, connectors: [hinge] });
      expect(world[0]!.connector.limits).toEqual([-30, 45]);
      expect(world[0]!.connector.role).toBe('a');
    }
  });
});
