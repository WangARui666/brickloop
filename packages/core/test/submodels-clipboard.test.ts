import { describe, expect, it } from 'vitest';
import {
  applyOps,
  copySelection,
  createModel,
  DocumentSession,
  executeCommand,
  expandInstances,
  parseDocument,
  pasteInto,
  serializeDocument,
  toLDraw,
  translation,
  validateDocument,
} from '../src';
import type { BrkDocument, Instance } from '../src';
import { fixture, instance, pairFixture, rootContext, run, unwrap } from './fixtures';

describe('shared models and clipboard acceptance', () => {
  it('MOD-02/06 definition edits immediately update every occurrence, preserve root transforms and undo once', () => {
    const f = pairFixture(),
      session = new DocumentSession(f.doc);
    const context = { activeModelPath: [f.first.id], selection: [[f.first.id, f.yellow.id]] };
    const oldRows = expandInstances(f.doc);
    unwrap(session.dispatch({ type: 'transform.translate', delta: [20, 0, 0] }, context));
    const rows = expandInstances(session.document);
    expect(rows[1]!.worldMatrix[12]).toBeCloseTo(60, 10);
    expect(rows[3]!.worldMatrix[14]).toBeCloseTo(-10, 10);
    expect(oldRows[1]!.worldMatrix[12]).toBe(40);
    expect(session.document.models[f.modelId]!.instances).toBe(f.doc.models[f.modelId]!.instances);
    unwrap(session.undo());
    expect(expandInstances(session.document)).toEqual(oldRows);
  });
  it('MOD-03 makeUnique recursively copies nested definitions once and survives save/reopen', () => {
    const f = pairFixture(),
      leaf = createModel('leaf', 'submodel', f.id),
      piece = instance(f.id, leaf);
    leaf.instances[piece.id] = piece;
    leaf.steps[piece.stepId]!.instanceIds = [piece.id];
    const childA: Instance = { ...instance(f.id, f.pair), ref: { kind: 'model', modelId: leaf.id } };
    const childB: Instance = { ...instance(f.id, f.pair, [20, 0, 0]), ref: { kind: 'model', modelId: leaf.id } };
    const grouped = run(
      f.doc,
      {
        activeModelPath: [f.first.id],
        selection: [
          [f.first.id, f.red.id],
          [f.first.id, f.yellow.id],
        ],
      },
      { type: 'group.create', name: 'inside' },
    );
    const doc = applyOps(grouped.doc, [
      { type: 'model.add', items: [leaf] },
      { type: 'instance.add', items: [childA, childB].map((child) => ({ modelId: f.pair.id, instance: child })) },
    ]);
    const session = new DocumentSession(doc);
    unwrap(session.dispatch({ type: 'submodel.makeUnique' }, rootContext(doc, [f.second.id])));
    const unique = session.document.models[f.modelId]!.instances[f.second.id]!;
    expect(unique.transform).toEqual(f.second.transform);
    expect(unique.id).toBe(f.second.id);
    if (unique.ref.kind !== 'model') throw new Error('model expected');
    expect(unique.ref.modelId).not.toBe(f.pair.id);
    const definition = session.document.models[unique.ref.modelId]!;
    expect(Object.keys(session.document.models)).toHaveLength(5);
    const nested = Object.values(definition.instances).filter((i) => i.ref.kind === 'model');
    expect(nested[0]!.ref).toEqual(nested[1]!.ref);
    expect(nested[0]!.ref).not.toEqual(childA.ref);
    const yellow = Object.values(definition.instances).find((i) => i.colorId === 'c:yellow')!;
    unwrap(
      session.dispatch(
        { type: 'color.set', colorId: 'c:blue' },
        { activeModelPath: [f.second.id], selection: [[f.second.id, yellow.id]] },
      ),
    );
    const saved = serializeDocument(session.document),
      reopened = parseDocument(saved);
    expect(reopened.issues).toEqual([]);
    expect(serializeDocument(reopened.doc!)).toBe(saved);
    expect(reopened.doc!.models[f.pair.id]!.instances[f.yellow.id]!.colorId).toBe('c:yellow');
    expect(reopened.doc!.models[definition.id]!.instances[yellow.id]!.colorId).toBe('c:blue');
    unwrap(session.undo());
    unwrap(session.undo());
    expect(session.document).toEqual(doc);
  });
  it('MOD-04 round-trips two references and produces red 2 / yellow 2 BOM counts', () => {
    const f = pairFixture(),
      restored = parseDocument(serializeDocument(f.doc)).doc!;
    expect(Object.keys(restored.models)).toHaveLength(2);
    const bom = new Map<string, number>();
    for (const row of expandInstances(restored)) bom.set(row.colorId, (bom.get(row.colorId) ?? 0) + row.multiplicity);
    expect([...bom]).toEqual([
      ['c:bright-red', 2],
      ['c:yellow', 2],
    ]);
  });
  it('MOD-05 rejects instantiate or paste into self/descendants without mutations', () => {
    const f = pairFixture(),
      context = { activeModelPath: [f.first.id], selection: [] };
    for (const modelId of [f.pair.id, f.modelId]) {
      const result = executeCommand(f.doc, context, { type: 'submodel.instantiate', modelId });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CYCLE');
    }
    const clipboard = copySelection(f.doc, [[f.first.id]]);
    const result = executeCommand(f.doc, context, { type: 'edit.paste', clipboard });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CYCLE');
    expect(validateDocument(f.doc)).toEqual([]);
  });
  it('MOD-07 cross-document copy keeps shared definitions, unique names, groups, assets and world placement', () => {
    const f = pairFixture(),
      target = fixture(0);
    const collision = createModel('pair', 'submodel', target.id);
    const targetDoc = applyOps(target.doc, [{ type: 'model.add', items: [collision] }]);
    const grouped = run(f.doc, f.context, { type: 'group.create', name: 'assembly' });
    const clipboard = copySelection(grouped.doc, [[f.first.id], [f.second.id]]);
    const output = run(targetDoc, rootContext(targetDoc), {
      type: 'edit.paste',
      clipboard,
      placement: { offset: [200, 0, 0] },
    });
    const instances = Object.values(output.doc.models[target.modelId]!.instances);
    expect(instances[0]!.ref).toEqual(instances[1]!.ref);
    expect(instances[0]!.ref).not.toEqual(f.first.ref);
    expect(Object.values(output.doc.models).map((m) => m.name)).toContain('pair (2)');
    expect(Object.keys(output.doc.models)).toHaveLength(3);
    expect(instances[0]!.groupId).toBe(instances[1]!.groupId);
    expect(validateDocument(output.doc)).toEqual([]);
    const rows = expandInstances(output.doc);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.worldMatrix[12]).toBeCloseTo(200, 10);
    expect(rows[2]!.worldMatrix[12]).toBeCloseTo(300, 10);
    const same = run(grouped.doc, f.context, { type: 'edit.paste', clipboard });
    expect(Object.keys(same.doc.models)).toHaveLength(2);
    expect(
      Object.values(same.doc.models[f.modelId]!.instances).every(
        (i) => i.ref.kind === 'model' && i.ref.modelId === f.pair.id,
      ),
    ).toBe(true);
  });
  it('clipboard captures a definition snapshot, includes embedded parts, and coalesces overlapping paths', () => {
    const f = pairFixture();
    const doc = applyOps(f.doc, [
      {
        type: 'instance.update',
        items: [
          {
            modelId: f.pair.id,
            instanceId: f.red.id,
            changes: { ref: { kind: 'part', partId: 'cu:test' }, colorId: 'inherit' },
          },
        ],
      },
      {
        type: 'asset.add',
        items: [{ kind: 'embeddedPart', id: 'cu:test', value: { hash: 'custom-hash', unknown: { preserved: true } } }],
      },
    ]);
    const clipboard = copySelection(doc, [[f.first.id], [f.first.id, f.red.id], [f.first.id]]);
    expect(clipboard.instances).toHaveLength(1);
    expect(clipboard.embeddedParts['cu:test']!.hash).toBe('custom-hash');
    const target = fixture(0),
      pasted = applyOps(target.doc, pasteInto(target.doc, target.context, clipboard));
    expect(pasted.embeddedParts).toEqual(clipboard.embeddedParts);
    const later = run(
      doc,
      { activeModelPath: [f.first.id], selection: [[f.first.id, f.red.id]] },
      { type: 'color.set', colorId: 'c:green' },
    );
    expect(clipboard.models[f.pair.id]!.instances[f.red.id]!.colorId).toBe('inherit');
    expect(later.doc.models[f.pair.id]!.instances[f.red.id]!.colorId).toBe('c:green');
  });
  it('copies separate occurrences of a shared group without merging their group identities', () => {
    const f = pairFixture(),
      inside = {
        activeModelPath: [f.first.id],
        selection: [
          [f.first.id, f.red.id],
          [f.first.id, f.yellow.id],
        ],
      };
    const { doc } = run(f.doc, inside, { type: 'group.create', name: 'pair group' });
    const clipboard = copySelection(doc, [
      [f.first.id, f.red.id],
      [f.second.id, f.red.id],
    ]);
    const output = run(doc, f.context, { type: 'edit.paste', clipboard });
    const added = output.selection!.map((path) => output.doc.models[f.modelId]!.instances[path[0]!]!);
    expect(added[0]!.groupId).not.toBe(added[1]!.groupId);
    expect(added[0]!.transform[0]).toBeCloseTo(0, 10);
    expect(added[1]!.transform[0]).toBeCloseTo(100, 10);
  });
  it('creates a grid-aligned bottom-centred submodel without changing world poses or group metadata', () => {
    const f = pairFixture(),
      context = {
        activeModelPath: [f.second.id],
        selection: [
          [f.second.id, f.red.id],
          [f.second.id, f.yellow.id],
        ],
      };
    const grouped = run(f.doc, context, { type: 'group.create', name: 'pair' });
    const before = expandInstances(grouped.doc),
      session = new DocumentSession(grouped.doc, { bboxProvider: () => [-10, -24, -10, 10, 0, 10] });
    unwrap(session.dispatch({ type: 'submodel.create', name: 'nested' }, context));
    const after = expandInstances(session.document);
    for (let i = 0; i < before.length; i++) {
      expect([...after[i]!.worldMatrix]).toEqual([...before[i]!.worldMatrix]);
      expect(after[i]!.colorId).toBe(before[i]!.colorId);
    }
    const newRef = Object.values(session.document.models[f.pair.id]!.instances)[0]!;
    expect(newRef.transform.slice(0, 3)).toEqual([20, 0, 0]);
    if (newRef.ref.kind !== 'model') throw new Error('model expected');
    const nested = session.document.models[newRef.ref.modelId]!;
    expect(Object.keys(nested.instances)).toEqual([f.red.id, f.yellow.id]);
    expect(
      Object.values(nested.instances).every(
        (i) => i.groupId && session.document.groups[i.groupId]!.modelId === nested.id,
      ),
    ).toBe(true);
    expect(validateDocument(session.document)).toEqual([]);
    unwrap(session.undo());
    expect(session.document).toEqual(grouped.doc);
  });
  it('instantiate and rename are reversible; explode preserves order, world poses, inherited colors and unused definitions', () => {
    const f = pairFixture(),
      session = new DocumentSession(f.doc);
    unwrap(session.dispatch({ type: 'submodel.rename', modelId: f.pair.id, name: 'new pair' }, f.context));
    expect(session.document.models[f.pair.id]!.name).toBe('new pair');
    unwrap(session.undo());
    unwrap(
      session.dispatch(
        { type: 'submodel.instantiate', modelId: f.pair.id, transform: toLDraw(translation([200, 0, 0])) },
        f.context,
      ),
    );
    expect(expandInstances(session.document)).toHaveLength(6);
    unwrap(session.undo());
    const before = session.document;
    unwrap(session.dispatch({ type: 'submodel.explode' }, f.context));
    const after = expandInstances(session.document),
      original = expandInstances(before);
    expect(after.map((row) => [...row.worldMatrix])).toEqual(original.map((row) => [...row.worldMatrix]));
    expect(Object.keys(session.document.models)).toHaveLength(2);
    unwrap(session.undo());
    expect(session.document).toEqual(before);
  });
  it('placing a copied selection inside a rotated target context maintains its world matrices', () => {
    const f = pairFixture(),
      clipboard = copySelection(f.doc, [
        [f.first.id, f.red.id],
        [f.first.id, f.yellow.id],
      ]);
    const context = { activeModelPath: [f.second.id], selection: [] };
    const pasted = run(f.doc, context, { type: 'edit.paste', clipboard, placement: { position: [200, 0, 200] } });
    const firstId = pasted.selection![0]![1]!;
    const occurrence = expandInstances(pasted.doc).find(
      (row) => row.path[0] === f.second.id && row.instance.id === firstId,
    )!;
    expect(occurrence.worldMatrix[12]).toBeCloseTo(200, 10);
    expect(occurrence.worldMatrix[14]).toBeCloseTo(200, 10);
  });
  it('copy data is plain JSON and restores equivalent cross-document behavior', () => {
    const f = pairFixture(),
      clipboard = copySelection(f.doc, f.context.selection),
      target = fixture(0);
    const restored = JSON.parse(JSON.stringify(clipboard)) as typeof clipboard;
    const pasted = applyOps(target.doc, pasteInto(target.doc, target.context, restored));
    expect(expandInstances(pasted)).toHaveLength(4);
    expect(validateDocument(pasted as BrkDocument)).toEqual([]);
  });
});
