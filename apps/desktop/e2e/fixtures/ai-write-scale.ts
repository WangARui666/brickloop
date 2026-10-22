import { createDocument, createModel, createWorkspace } from '@brickloop/core';

/** Authored synthetic layout: 15 distinct submodels, 100 repeated bricks each. */
export function aiWriteScaleFixture() {
  let serial = 0;
  const id = () => String(++serial).padStart(26, '0');
  const document = createDocument(
    { title: 'AI write scale' },
    { id, now: () => '2026-10-20T00:00:00.000Z', catalogPack: { id: 'demo', version: '1.0.0' } },
  );
  const root = document.models[document.rootModelId]!;
  const instanceIds: string[] = [];
  const colors = ['c:bright-red', 'c:bright-blue', 'c:bright-yellow'];
  for (let group = 0; group < 15; group++) {
    const model = createModel(`Synthetic ${group}`, 'submodel', id);
    document.models[model.id] = model;
    const occurrence = id();
    root.instances[occurrence] = {
      id: occurrence,
      ref: { kind: 'model', modelId: model.id },
      colorId: 'c:bright-red',
      transform: [(group % 5) * 1200, 0, Math.floor(group / 5) * 1200, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: root.stepIds[0]!,
      groupId: null,
    };
    root.steps[root.stepIds[0]!]!.instanceIds.push(occurrence);
    for (let index = 0; index < 100; index++) {
      const instanceId = id();
      model.instances[instanceId] = {
        id: instanceId,
        ref: { kind: 'part', partId: 'ld:3001' },
        colorId: colors[index % colors.length]!,
        transform: [(index % 10) * 100, -24, Math.floor(index / 10) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        stepId: model.stepIds[0]!,
        groupId: null,
      };
      model.steps[model.stepIds[0]!]!.instanceIds.push(instanceId);
      instanceIds.push(instanceId);
    }
  }
  const workspace = createWorkspace();
  workspace.camera = {
    mode: 'perspective',
    position: [9000, -8000, -8000],
    target: [2900, -24, 1700],
    up: [0, -1, 0],
    fov: 35,
  };
  const operations = Array.from({ length: 24 }, (_, index) => ({
    tool: 'set_color' as const,
    arguments: { instanceIds: instanceIds.slice(index * 5, index * 5 + 5), colorId: 'c:black' },
  }));
  return { document, workspace, instanceIds, operations };
}
