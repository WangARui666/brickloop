import { describe, expect, it } from 'vitest';
import {
  applyOps,
  applyWithInverse,
  DocumentSession,
  executeCommand,
  expandInstances,
  fromLDraw,
  resolveClickSelection,
  serializeDocument,
  toLDraw,
  translation,
  validateDocument,
  worldMatrix,
} from '../src';
import type { Command, CommandServices, EditContext, Op } from '../src';
import { fixture, pairFixture, rootContext, run, unwrap } from './fixtures';

describe('group commands and click selection', () => {
  it('regrouping all members under a single nested chain never reparents an ancestor into its descendant', () => {
    const f = fixture(2);
    const first = run(f.doc, f.context, { type: 'group.create', name: 'outer' });
    const outerId = Object.keys(first.doc.groups)[0]!;
    const second = run(first.doc, f.context, { type: 'group.create', name: 'inner' });
    const innerId = Object.keys(second.doc.groups).find((gid) => gid !== outerId)!;
    const third = run(second.doc, f.context, { type: 'group.create', name: 'deepest' });
    expect(validateDocument(third.doc)).toEqual([]);
    expect(third.doc.groups[outerId]!.parentGroupId).toBeNull();
    expect(third.doc.groups[innerId]!.parentGroupId).toBe(outerId);
    const dissolved = run(third.doc, { ...f.context, activeGroupId: innerId }, { type: 'group.dissolve' });
    expect(Object.values(dissolved.doc.groups).map((group) => group.name)).toEqual(['outer', 'inner']);
  });
  it('GRP-01/02/03 group selection, group editing and reversible dissolution', () => {
    const f = fixture(10),
      session = new DocumentSession(f.doc);
    session.setContext(f.context);
    unwrap(session.dispatch({ type: 'group.create', name: '十件组' }));
    const grouped = session.document,
      gid = Object.keys(grouped.groups)[0]!;
    expect(resolveClickSelection(grouped, f.context, [f.instances[3]!.id])).toHaveLength(10);
    const inside = { ...f.context, activeGroupId: gid, selection: [[f.instances[3]!.id]] };
    expect(resolveClickSelection(grouped, inside, [f.instances[3]!.id])).toEqual(inside.selection);
    unwrap(session.dispatch({ type: 'color.set', colorId: 'c:blue' }, inside));
    expect(
      Object.values(session.document.models[f.modelId]!.instances).filter((i) => i.colorId === 'c:blue'),
    ).toHaveLength(1);
    expect(resolveClickSelection(session.document, f.context, [f.instances[3]!.id])).toHaveLength(10);
    unwrap(session.dispatch({ type: 'group.rename', groupId: gid, name: '保留名称' }, f.context));
    const beforeDissolve = session.document;
    unwrap(session.dispatch({ type: 'group.dissolve', groupIds: [gid] }, f.context));
    expect(Object.keys(session.document.groups)).toHaveLength(0);
    expect(Object.values(session.document.models[f.modelId]!.instances).every((i) => i.groupId === null)).toBe(true);
    unwrap(session.undo());
    expect(session.document).toEqual(beforeDissolve);
  });
  it('GRP-04 nests full selected groups, selects at each editing depth, and preserves transforms', () => {
    const f = fixture(4);
    const inner = run(
      f.doc,
      rootContext(
        f.doc,
        f.instances.slice(0, 2).map((i) => i.id),
      ),
      { type: 'group.create', name: 'inner' },
    );
    const innerId = Object.keys(inner.doc.groups)[0]!;
    const outer = run(inner.doc, f.context, { type: 'group.create', name: 'outer' });
    const outerId = Object.keys(outer.doc.groups).find((id) => id !== innerId)!;
    expect(outer.doc.groups[innerId]!.parentGroupId).toBe(outerId);
    expect(resolveClickSelection(outer.doc, f.context, [f.instances[0]!.id])).toHaveLength(4);
    expect(
      resolveClickSelection(outer.doc, { ...f.context, activeGroupId: outerId }, [f.instances[0]!.id]),
    ).toHaveLength(2);
    expect(
      resolveClickSelection(outer.doc, { ...f.context, activeGroupId: innerId }, [f.instances[0]!.id]),
    ).toHaveLength(1);
    expect(resolveClickSelection(outer.doc, { ...f.context, activeGroupId: innerId }, [f.instances[3]!.id])).toEqual(
      f.context.selection,
    );
    expect(Object.values(outer.doc.models[f.modelId]!.instances).map((i) => i.transform)).toEqual(
      f.instances.map((i) => i.transform),
    );
    const dissolved = run(outer.doc, f.context, { type: 'group.dissolve', groupIds: [outerId, innerId] });
    expect(validateDocument(dissolved.doc)).toEqual([]);
    const inverse = applyWithInverse(outer.doc, dissolved.ops).inverse;
    expect(applyOps(dissolved.doc, inverse)).toEqual(outer.doc);
  });
  it('Ctrl toggles a group, Shift appends, Alt bypasses grouping and hidden paths cannot be selected', () => {
    const f = fixture(3),
      context = rootContext(f.doc, [f.instances[0]!.id, f.instances[1]!.id]);
    const { doc } = run(f.doc, context, { type: 'group.create' });
    expect(resolveClickSelection(doc, context, [f.instances[0]!.id], { ctrl: true })).toEqual([]);
    expect(
      resolveClickSelection(doc, { ...context, selection: [[f.instances[2]!.id]] }, [f.instances[0]!.id], {
        shift: true,
      }),
    ).toHaveLength(3);
    expect(resolveClickSelection(doc, context, [f.instances[0]!.id], { alt: true })).toEqual([[f.instances[0]!.id]]);
    expect(
      resolveClickSelection(doc, { ...context, selection: [], hidden: [[f.instances[0]!.id]] }, [f.instances[0]!.id]),
    ).toEqual([]);
    expect(resolveClickSelection(doc, { ...context, hidden: [[f.instances[1]!.id]] }, [f.instances[0]!.id])).toEqual([
      [f.instances[0]!.id],
    ]);
  });
  it('treats a submodel occurrence as one object in the parent, with strict context boundaries', () => {
    const f = pairFixture();
    expect(resolveClickSelection(f.doc, f.context, [f.first.id, f.yellow.id])).toEqual([[f.first.id]]);
    const context = { activeModelPath: [f.first.id], selection: [] };
    expect(resolveClickSelection(f.doc, context, [f.first.id, f.yellow.id])).toEqual([[f.first.id, f.yellow.id]]);
    expect(resolveClickSelection(f.doc, context, [f.second.id, f.yellow.id])).toEqual([]);
    const invalid = executeCommand(f.doc, context, {
      type: 'group.create',
      paths: [
        [f.first.id, f.red.id],
        [f.second.id, f.yellow.id],
      ],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_CONTEXT');
  });
});

describe('remaining command primitives and coordinate semantics', () => {
  it('rotates a multiselection about all supported world pivots inside a rotated context', () => {
    const f = pairFixture(),
      context = {
        activeModelPath: [f.second.id],
        selection: [
          [f.second.id, f.red.id],
          [f.second.id, f.yellow.id],
        ],
        primaryPath: [f.second.id, f.red.id],
      };
    const center = [100, 0, 50] as const;
    const pivots = [
      { kind: 'selectionCenter' as const, point: center },
      { kind: 'point' as const, point: center },
      { kind: 'primaryOrigin' as const },
    ];
    const results = pivots.map(
      (pivot) => run(f.doc, context, { type: 'transform.rotate', axis: [0, 1, 0], degrees: 90, pivot }).doc,
    );
    for (const doc of results) {
      const a = worldMatrix(doc, context.selection[0]!)!,
        b = worldMatrix(doc, context.selection[1]!)!;
      expect(a[12]).toBeCloseTo(100, 10);
      expect(a[14]).toBeCloseTo(50, 10);
      expect(b[12]).toBeCloseTo(60, 10);
      expect(b[14]).toBeCloseTo(50, 10);
      expect(Math.hypot(b[12]! - a[12]!, b[14]! - a[14]!)).toBeCloseTo(40, 10);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });
  it('world and primary-local translation work through nested transforms; set keeps the group rigid', () => {
    const f = pairFixture(),
      context = {
        activeModelPath: [f.second.id],
        selection: [
          [f.second.id, f.red.id],
          [f.second.id, f.yellow.id],
        ],
        primaryPath: [f.second.id, f.red.id],
      };
    const world = run(f.doc, context, { type: 'transform.translate', delta: [20, 0, 0] });
    expect(worldMatrix(world.doc, context.selection[0]!)![12]).toBeCloseTo(120, 10);
    const local = run(f.doc, context, { type: 'transform.translate', delta: [20, 0, 0], space: 'primaryLocal' });
    expect(worldMatrix(local.doc, context.selection[0]!)![14]).toBeCloseTo(30, 10);
    const set = run(f.doc, context, { type: 'transform.set', transform: toLDraw(translation([200, 0, 200])) });
    const a = worldMatrix(set.doc, context.selection[0]!)!,
      b = worldMatrix(set.doc, context.selection[1]!)!;
    expect(a[12]).toBeCloseTo(200, 10);
    expect(a[14]).toBeCloseTo(200, 10);
    expect(b[12]).toBeCloseTo(240, 10);
    expect(b[14]).toBeCloseTo(200, 10);
    const snapped = run(world.doc, context, { type: 'transform.snapToGrid', step: [20, 8, 20] });
    expect(worldMatrix(snapped.doc, context.selection[0]!)![14]).toBeCloseTo(60, 10);
    expect(fromLDraw(f.red.transform)[12]).toBe(0);
  });
  it('part, color, deletion, clone, cut and every step command are reversible', () => {
    const f = fixture(3),
      services: CommandServices = { id: f.id };
    let doc = f.doc;
    const execute = (command: Command, context: EditContext = rootContext(doc)) => {
      const before = doc,
        result = run(doc, context, command, services),
        inverse = applyWithInverse(before, result.ops).inverse;
      expect(applyOps(result.doc, inverse)).toEqual(before);
      expect(validateDocument(result.doc)).toEqual([]);
      doc = result.doc;
      return result;
    };
    execute({
      type: 'part.add',
      partId: 'cu:unknown',
      colorId: 'cx:unknown',
      transform: toLDraw(translation([1, 2, 3])),
    });
    execute(
      { type: 'color.replace', from: 'c:bright-red', to: 'c:blue', scope: 'selection' },
      rootContext(doc, [f.instances[0]!.id]),
    );
    expect(Object.values(doc.models[f.modelId]!.instances).filter((i) => i.colorId === 'c:blue')).toHaveLength(1);
    execute({ type: 'color.replace', from: 'c:bright-red', to: 'c:green', scope: 'model' });
    execute({ type: 'color.replace', from: 'c:green', to: 'c:yellow', scope: 'document' });
    execute({ type: 'step.add', position: 0, description: '新增步骤' });
    const sid = doc.models[f.modelId]!.stepIds[0]!;
    execute(
      { type: 'step.assign', stepId: sid, position: 0 },
      rootContext(doc, [f.instances[2]!.id, f.instances[0]!.id]),
    );
    expect(doc.models[f.modelId]!.steps[sid]!.instanceIds).toEqual([f.instances[2]!.id, f.instances[0]!.id]);
    execute({ type: 'step.move', stepId: sid, position: 1 });
    execute({ type: 'step.remove', stepId: sid, targetStepId: f.stepId });
    expect(doc.models[f.modelId]!.stepIds).toEqual([f.stepId]);
    const cloned = execute(
      { type: 'edit.clone', placement: { offset: [20, 0, 0] } },
      rootContext(doc, [f.instances[0]!.id]),
    );
    expect(cloned.selection![0]![0]).not.toBe(f.instances[0]!.id);
    const cut = execute({ type: 'edit.cut' }, rootContext(doc, [f.instances[1]!.id]));
    expect(cut.clipboard!.instances).toHaveLength(1);
    execute({ type: 'edit.paste', clipboard: cut.clipboard!, placement: { position: [100, 0, 0] } });
    execute({ type: 'edit.delete' });
    expect(Object.keys(doc.models[f.modelId]!.instances)).toHaveLength(0);
  });
  it('returns structured errors without changing documents or creating history', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc);
    const before = serializeDocument(f.doc);
    const cases: [Command, string][] = [
      [{ type: 'part.add', partId: 'bad', colorId: 'c:red' }, 'INVALID_ARGUMENT'],
      [
        { type: 'transform.rotate', axis: [0, 0, 0], degrees: 90, pivot: { kind: 'primaryOrigin' } },
        'INVALID_ARGUMENT',
      ],
      [{ type: 'transform.snapToGrid', step: 0 }, 'INVALID_ARGUMENT'],
      [{ type: 'transform.translate', delta: [NaN, 0, 0] }, 'INVALID_ARGUMENT'],
      [{ type: 'step.remove', stepId: f.stepId }, 'INVALID_ARGUMENT'],
      [{ type: 'step.move', stepId: f.stepId, position: 10 }, 'INVALID_ARGUMENT'],
      [{ type: 'submodel.instantiate', modelId: f.id() }, 'NOT_FOUND'],
      [{ type: 'color.set', colorId: 'invalid' }, 'INVALID_ARGUMENT'],
    ];
    for (const [command, code] of cases) {
      const result = session.dispatch(command, f.context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.messageKey).toBe(`core.errors.${code}`);
      }
    }
    const empty = session.dispatch({ type: 'edit.delete' }, { activeModelPath: [], selection: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('EMPTY_SELECTION');
    expect(serializeDocument(f.doc)).toBe(before);
    expect(session.history).toHaveLength(0);
  });
  it('a compound operation can be inverted without cloning untouched definitions', () => {
    const f = pairFixture(),
      ops: Op[] = unwrap(executeCommand(f.doc, f.context, { type: 'edit.delete' })).ops;
    const next = applyOps(f.doc, ops);
    expect(next.models[f.pair.id]).toBe(f.doc.models[f.pair.id]);
    expect(expandInstances(next)).toEqual([]);
    expect(Object.keys(next.models)).toHaveLength(2);
  });
});
