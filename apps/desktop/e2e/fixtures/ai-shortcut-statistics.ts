import { createDocument, createModel, createWorkspace } from '@brickloop/core';

/** 2,601 separated bricks in 17 distinct submodels; deterministic occurrence paths. */
export function shortcutStatisticsFixture() {
  let serial = 0;
  const id = () => String(++serial).padStart(26, '0');
  const document = createDocument(
    { title: 'Shortcut statistics scale' },
    {
      id,
      now: () => '2026-10-21T00:00:00.000Z',
      catalogPack: { id: 'demo', version: '1.0.0' },
    },
  );
  const root = document.models[document.rootModelId]!;
  const selection: string[][] = [];
  const colors = ['c:bright-red', 'c:bright-blue', 'c:bright-yellow'];
  for (let group = 0; group < 17; group++) {
    const model = createModel(`Module ${group + 1}`, 'submodel', id);
    document.models[model.id] = model;
    const occurrence = id();
    root.instances[occurrence] = {
      id: occurrence,
      ref: { kind: 'model', modelId: model.id },
      colorId: 'c:bright-red',
      transform: [(group % 5) * 1200, 0, Math.floor(group / 5) * 2000, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: root.stepIds[0]!,
      groupId: null,
    };
    root.steps[root.stepIds[0]!]!.instanceIds.push(occurrence);
    selection.push([occurrence]);
    for (let index = 0; index < 153; index++) {
      const instanceId = id();
      model.instances[instanceId] = {
        id: instanceId,
        ref: { kind: 'part', partId: 'ld:3001' },
        colorId: colors[index % 3]!,
        transform: [(index % 9) * 100, -24, Math.floor(index / 9) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        stepId: model.stepIds[0]!,
        groupId: null,
      };
      model.steps[model.stepIds[0]!]!.instanceIds.push(instanceId);
    }
  }
  return { document, workspace: createWorkspace(), selection };
}
