import { describe, expect, it } from 'vitest';
import {
  applyOps,
  DocumentSession,
  executeCommand,
  expandInstances,
  serializeDocument,
  toLDraw,
  translation,
} from '../src';
import type { BrkDocument, SessionChange } from '../src';
import { fixture, pairFixture, rootContext, unwrap } from './fixtures';

describe('document sessions and command acceptance', () => {
  it('keeps sparse preview snapshots immutable, enumerable, cancellable and materializes a clonable commit', () => {
    const f = fixture(10000),
      session = new DocumentSession(f.doc);
    session.setContext({ ...f.context, selection: [f.context.selection[0]!] });
    unwrap(session.begin('move'));
    const move = (x: number) =>
      unwrap(
        session.preview(
          unwrap(
            executeCommand(session.transactionBase, session.context, { type: 'transform.translate', delta: [x, 0, 0] }),
          ).ops,
        ),
      );
    move(20);
    const first = session.document;
    expect(structuredClone(first)).toEqual(first);
    move(40);
    expect(first.models[f.modelId]!.instances[f.instances[0]!.id]!.transform[0]).toBe(20);
    expect(JSON.parse(serializeDocument(first)).models[f.modelId].instances[f.instances[0]!.id].transform[0]).toBe(20);
    expect(Object.keys(first.models[f.modelId]!.instances)).toHaveLength(10000);
    expect(first.models[f.modelId]!.instances[f.instances[1]!.id]).toBe(f.instances[1]);
    unwrap(session.commit());
    expect(structuredClone(session.document)).toEqual(session.document);
    unwrap(session.undo());
    expect(session.document.models[f.modelId]!.instances[f.instances[0]!.id]!.transform[0]).toBe(0);
    unwrap(session.begin('invalid'));
    expect(
      session.preview([
        {
          type: 'instance.update',
          items: [
            {
              modelId: f.modelId,
              instanceId: f.instances[0]!.id,
              changes: { transform: [NaN, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
            },
          ],
        },
      ]).ok,
    ).toBe(false);
    expect(session.isPreviewing).toBe(false);
  });
  it('a failed transaction ID source restores the preview baseline without history or revision changes', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc, {
        id: () => {
          throw new RangeError('random source failed');
        },
      });
    session.setContext(f.context);
    unwrap(session.begin('move'));
    unwrap(
      session.preview(unwrap(executeCommand(f.doc, f.context, { type: 'transform.translate', delta: [10, 0, 0] })).ops),
    );
    expect(session.commit().ok).toBe(false);
    expect(session.document).toBe(f.doc);
    expect(session.isDirty).toBe(false);
    expect(session.history).toHaveLength(0);
  });
  it('CMD-01 button, keyboard and numeric rotations use the same command math', () => {
    const f = fixture(1);
    const results = (['button', 'keyboard', 'numeric'] as const).map((input) => {
      const session = new DocumentSession(f.doc);
      unwrap(
        session.dispatch(
          { type: 'transform.rotate', input, axis: [0, -1, 0], degrees: 90, pivot: { kind: 'primaryOrigin' } },
          f.context,
        ),
      );
      return session.document.models[f.modelId]!.instances;
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });
  it('CMD-02 100 replacement previews emit one commit and undo once to the original state', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc),
      events: SessionChange[] = [];
    session.setContext(f.context);
    session.onChange((event) => events.push(event));
    unwrap(session.begin('拖动', 'ui'));
    for (let frame = 1; frame <= 100; frame++) {
      const output = unwrap(
        executeCommand(session.transactionBase, f.context, { type: 'transform.translate', delta: [frame, 0, 0] }),
      );
      unwrap(session.preview(output.ops));
    }
    expect(session.history).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(session.document.revision).toBe(0);
    unwrap(session.commit());
    expect(session.history).toHaveLength(1);
    expect(session.history[0]!.ops).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(session.document.models[f.modelId]!.instances[f.instances[0]!.id]!.transform[0]).toBe(100);
    unwrap(session.undo());
    expect(session.document).toEqual(f.doc);
    unwrap(session.redo());
    expect(session.document.revision).toBe(1);
  });
  it('CMD-03 cancel restores document identity, dirty, revision, undo and redo lengths', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc);
    session.setContext(f.context);
    unwrap(session.dispatch({ type: 'color.set', colorId: 'c:blue' }));
    unwrap(session.undo());
    const before = session.document,
      undoLength = session.history.length,
      redoLength = session.redoHistory.length;
    unwrap(session.begin('预览'));
    unwrap(
      session.preview(
        unwrap(
          executeCommand(before, f.context, { type: 'transform.set', transform: toLDraw(translation([40, 50, 60])) }),
        ).ops,
      ),
    );
    expect(session.isDirty).toBe(true);
    session.cancel();
    expect(session.document).toBe(before);
    expect(session.isDirty).toBe(false);
    expect(session.document.revision).toBe(before.revision);
    expect(session.history).toHaveLength(undoLength);
    expect(session.redoHistory).toHaveLength(redoLength);
  });
  it('CMD-04 savepoints survive undo/redo and cannot alias a new branch revision', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc);
    session.setContext(f.context);
    unwrap(session.markSaved());
    unwrap(
      session.dispatch({
        type: 'transform.rotate',
        axis: [1, 2, 3],
        degrees: 31,
        pivot: { kind: 'point', point: [0, 0, 0] },
      }),
    );
    const rotated = session.document;
    expect(session.isDirty).toBe(true);
    unwrap(session.undo());
    expect(session.isDirty).toBe(false);
    unwrap(session.redo());
    expect(session.document).toEqual(rotated);
    expect(session.isDirty).toBe(true);
    unwrap(session.markSaved());
    unwrap(session.undo());
    unwrap(session.dispatch({ type: 'color.set', colorId: 'c:green' }));
    expect(session.document.revision).toBeGreaterThan(session.savedRevision);
    expect(session.isDirty).toBe(true);
    expect(session.canRedo).toBe(false);
  });
  it('CMD-05 separate documents have separate history, even from the same initial snapshot', () => {
    const f = fixture(1),
      a = new DocumentSession(f.doc),
      b = new DocumentSession(f.doc);
    unwrap(a.dispatch({ type: 'color.set', colorId: 'c:blue' }, f.context));
    unwrap(b.dispatch({ type: 'transform.translate', delta: [20, 0, 0] }, f.context));
    const aDoc = a.document;
    unwrap(b.undo());
    expect(a.document).toBe(aDoc);
    expect(a.history).toHaveLength(1);
    expect(b.document).toEqual(f.doc);
  });
  it('CMD-06 deleting an active shared occurrence discards its pending definition preview', () => {
    const f = pairFixture(),
      session = new DocumentSession(f.doc);
    const context = { activeModelPath: [f.first.id], selection: [[f.first.id, f.yellow.id]] };
    session.setContext(context);
    unwrap(session.begin('移动共享件'));
    unwrap(
      session.preview(unwrap(executeCommand(f.doc, context, { type: 'transform.translate', delta: [20, 0, 0] })).ops),
    );
    expect(expandInstances(session.document)[3]!.worldMatrix).not.toEqual(expandInstances(f.doc)[3]!.worldMatrix);
    unwrap(session.dispatch({ type: 'edit.delete' }, rootContext(f.doc, [f.first.id])));
    expect(session.isPreviewing).toBe(false);
    expect(session.history).toHaveLength(1);
    expect(session.document.models[f.pair.id]!.instances[f.yellow.id]).toBe(f.yellow);
    expect(expandInstances(session.document)).toHaveLength(2);
    expect(session.context.activeModelPath).toEqual([]);
    unwrap(session.undo());
    expect(session.document).toEqual(f.doc);
  });
  it('CMD-06 switching model path cancels; a preview removing its own context is rejected atomically', () => {
    const f = pairFixture(),
      session = new DocumentSession(f.doc),
      context = { activeModelPath: [f.first.id], selection: [[f.first.id, f.red.id]] };
    session.setContext(context);
    unwrap(session.begin('edit'));
    const result = session.preview([
      { type: 'instance.remove', items: [{ modelId: f.modelId, instanceId: f.first.id }] },
    ]);
    expect(result.ok).toBe(false);
    expect(session.document).toBe(f.doc);
    unwrap(session.begin('edit'));
    unwrap(session.preview(unwrap(executeCommand(f.doc, context, { type: 'color.set', colorId: 'c:blue' })).ops));
    session.setContext({ activeModelPath: [f.second.id], selection: [] });
    expect(session.document).toBe(f.doc);
    expect(session.isPreviewing).toBe(false);
  });
  it('CMD-07 keyboard repeats merge, while timeout, selection, kind, tools and savepoints end merging', () => {
    const f = fixture(2);
    let now = 0;
    const session = new DocumentSession(f.doc, { clock: () => now });
    session.setContext(rootContext(f.doc, [f.instances[0]!.id]));
    const command = {
      type: 'transform.rotate' as const,
      input: 'keyboard' as const,
      axis: [0, 1, 0] as const,
      degrees: 90,
      pivot: { kind: 'primaryOrigin' as const },
    };
    for (let i = 0; i < 4; i++) {
      unwrap(session.dispatch(command));
      now += 250;
    }
    expect(session.history).toHaveLength(1);
    unwrap(session.undo());
    expect(session.document).toEqual(f.doc);
    unwrap(session.redo());
    unwrap(session.dispatch(command));
    expect(session.history).toHaveLength(2);
    now += 1000;
    unwrap(session.dispatch(command));
    expect(session.history).toHaveLength(2);
    now += 1001;
    unwrap(session.dispatch(command));
    expect(session.history).toHaveLength(3);
    session.setContext(rootContext(session.document, [f.instances[1]!.id]));
    unwrap(session.dispatch(command));
    expect(session.history).toHaveLength(4);
    unwrap(session.dispatch({ type: 'transform.translate', delta: [20, 0, 0], input: 'keyboard' }));
    expect(session.history).toHaveLength(5);
    unwrap(session.markSaved());
    unwrap(session.dispatch({ type: 'transform.translate', delta: [20, 0, 0], input: 'keyboard' }));
    expect(session.history).toHaveLength(6);
    unwrap(session.undo());
    expect(session.isDirty).toBe(false);
    session.endMerge();
    unwrap(session.dispatch(command));
    expect(session.history).toHaveLength(6);
    const disabled = new DocumentSession(f.doc, { mergeKeyboard: false });
    for (let i = 0; i < 4; i++) unwrap(disabled.dispatch(command, f.context));
    expect(disabled.history).toHaveLength(4);
  });
  it('CMD-08 selection and hiding are workspace-only and survive a workspace JSON round trip', () => {
    const f = pairFixture(),
      session = new DocumentSession(f.doc),
      events: SessionChange[] = [];
    session.onChange((event) => events.push(event));
    session.updateWorkspace({ selection: [[f.first.id]], hidden: [[f.first.id, f.yellow.id]], snapEnabled: false });
    expect(session.document).toBe(f.doc);
    expect(session.isDirty).toBe(false);
    expect(session.history).toHaveLength(0);
    expect(events).toHaveLength(0);
    const reopened = new DocumentSession(f.doc, {
      workspace: JSON.parse(JSON.stringify(session.workspace)) as typeof session.workspace,
    });
    expect(reopened.workspace).toEqual(session.workspace);
    expect(reopened.workspace.hidden).not.toContainEqual([f.second.id, f.yellow.id]);
  });
  it('AI commands accumulate into one reversible transaction; raw imports are atomic', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc);
    session.setContext(f.context);
    unwrap(session.begin('AI：调整模型', 'ai'));
    unwrap(session.dispatch({ type: 'color.set', colorId: 'c:blue' }));
    unwrap(session.dispatch({ type: 'transform.translate', delta: [20, 0, 0] }));
    expect(session.history).toHaveLength(0);
    expect(session.markSaved().ok).toBe(false);
    unwrap(session.commit());
    expect(session.history).toHaveLength(1);
    expect(session.history[0]!.source).toBe('ai');
    unwrap(session.undo());
    expect(session.document).toEqual(f.doc);
    expect(
      session.applyExternal(
        [{ type: 'instance.remove', items: [{ modelId: f.modelId, instanceId: 'missing' }] }],
        'bad import',
        'import',
      ).ok,
    ).toBe(false);
    expect(session.document).toEqual(f.doc);
  });
  it('bounds history and publishes replayable forward/inverse events even for merged commands', () => {
    const f = fixture(1),
      session = new DocumentSession(f.doc, { historyLimit: 2 });
    let replay: BrkDocument = f.doc;
    const events: SessionChange[] = [];
    const unsubscribe = session.onChange((event) => {
      events.push(event);
      replay = { ...applyOps(replay, event.ops), revision: event.revisionAfter };
    });
    for (let i = 0; i < 4; i++)
      unwrap(session.dispatch({ type: 'transform.translate', delta: [1, 0, 0], input: 'keyboard' }, f.context));
    expect(session.history).toHaveLength(1);
    expect(events).toHaveLength(4);
    expect(serializeDocument(replay)).toBe(serializeDocument(session.document));
    unwrap(session.undo());
    expect(replay).toEqual(f.doc);
    unwrap(session.redo());
    expect(replay).toEqual(session.document);
    for (const colorId of ['c:blue', 'c:green', 'c:yellow'])
      unwrap(session.dispatch({ type: 'color.set', colorId }, f.context));
    expect(session.history).toHaveLength(2);
    unsubscribe();
  });
});
