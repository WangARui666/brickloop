import { expect, it } from 'vitest';
import { createDocument, DocumentSession, expandInstances, serializeDocument, toLDraw, translation } from '../src';
import type { Instance } from '../src';
import { testIds, unwrap } from './fixtures';

it('PERF records expansion of 10,000 occurrences and a 1,000-instance batch translate/undo', () => {
  const id = testIds(),
    doc = createDocument({ title: '10k perf', createdAt: '2026-10-16T00:00:00Z' }, { id });
  const model = doc.models[doc.rootModelId]!,
    step = model.steps[model.stepIds[0]!]!;
  for (let i = 0; i < 10000; i++) {
    const item: Instance = {
      id: id(),
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: i % 2 ? 'c:yellow' : 'c:bright-red',
      transform: toLDraw(translation([(i % 100) * 80, 0, Math.floor(i / 100) * 40])),
      stepId: step.id,
      groupId: null,
    };
    model.instances[item.id] = item;
    step.instanceIds.push(item.id);
  }
  const selection = step.instanceIds.slice(0, 1000).map((iid) => [iid]);
  const session = new DocumentSession(doc);
  const snapshot = serializeDocument(doc);
  const start = performance.now(),
    expanded = expandInstances(doc),
    expandMs = performance.now() - start;
  const translateStart = performance.now();
  const result = unwrap(
    session.dispatch({ type: 'transform.translate', delta: [20, -8, 0] }, { activeModelPath: [], selection }),
  );
  const translateMs = performance.now() - translateStart;
  const undoStart = performance.now();
  unwrap(session.undo());
  const undoMs = performance.now() - undoStart;
  expect(expanded).toHaveLength(10000);
  expect(result.ops).toHaveLength(1);
  if (result.ops[0]!.type === 'instance.update') expect(result.ops[0]!.items).toHaveLength(1000);
  expect(serializeDocument(session.document)).toBe(snapshot);
  console.log(
    `[M2-1 PERF] instances=10000 selected=1000 expandInstances=${expandMs.toFixed(3)}ms batchTranslate=${translateMs.toFixed(3)}ms undo=${undoMs.toFixed(3)}ms`,
  );
});
