import { expect, it } from 'vitest';
import { createDocument } from '@brickloop/core';
import { planBuildAnimation } from '@brickloop/animation';
import type { PartMesh } from '@brickloop/ldraw';
import type { ColorDef, PartId } from '@brickloop/catalog';
import { loadAnimationResources } from '../src/renderer/src/animation-resources';

const color: ColorDef = {
  id: 'ld:4',
  ldrawCode: 4,
  rgb: '#c91a09',
  edgeRgb: '#333333',
  alpha: 1,
  finish: 'solid',
  nameZh: '红色',
  legoName: null,
  legoColorId: null,
};
const mesh: PartMesh = {
  partFile: '3005.dat',
  bboxLdu: [-10, -24, -10, 10, 0, 10],
  doubleSided: false,
  batches: [
    {
      color: 'main',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
  ],
  edges: [],
  conditionalEdges: { positions: new Float32Array(), controls: new Float32Array() },
  diagnostics: { missing: [], cycles: [], warnings: [] },
  sources: [],
};
function fixture() {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  ['ld:3005', 'ld:empty', 'ld:empty', 'ld:missing'].forEach((partId, i) => {
    const id = String(i);
    root.instances[id] = {
      id,
      ref: { kind: 'part', partId: partId as PartId },
      colorId: 'ld:4',
      transform: [i * 40, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: root.stepIds[0]!,
      groupId: null,
    };
    root.steps[root.stepIds[0]!]!.instanceIds.push(id);
  });
  return doc;
}
it('skips empty/rejected geometry, counts occurrences and still plans both orders without editing the document', async () => {
  const doc = fixture(),
    before = JSON.stringify(doc),
    requested: string[] = [];
  const resources = await loadAnimationResources(
    doc,
    doc.rootModelId,
    [color],
    async (id) => {
      requested.push(id);
      if (id === 'ld:missing') throw new Error('Missing part shape');
      return id === 'ld:empty' ? { ...mesh, batches: [] } : mesh;
    },
    new AbortController().signal,
  );
  expect(resources.missingCount).toBe(3);
  expect(resources.excludedPartIds).toEqual(['ld:empty', 'ld:missing']);
  expect(requested.sort()).toEqual(['ld:3005', 'ld:empty', 'ld:missing']);
  expect(resources.instances.size).toBe(1);
  for (const order of ['layers', 'steps'] as const) {
    const timeline = planBuildAnimation(doc, doc.rootModelId, {
      order,
      localBounds: resources.bounds,
      excludedPartIds: resources.excludedPartIds,
    });
    expect(timeline.parts.map((p) => p.path)).toEqual([['0']]);
    expect(timeline.bounds).toEqual({ min: [-10, -24, -10], max: [10, 0, 10] });
  }
  expect(JSON.stringify(doc)).toBe(before);
});
it('does not turn cancellation into a missing-geometry warning', async () => {
  const doc = fixture(),
    controller = new AbortController();
  await expect(
    loadAnimationResources(
      doc,
      doc.rootModelId,
      [color],
      async () => {
        controller.abort();
        throw new Error('interrupted');
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
it('keeps an all-missing model nonblocking with an empty timeline', async () => {
  const doc = fixture();
  const resources = await loadAnimationResources(
    doc,
    doc.rootModelId,
    [color],
    async () => ({ ...mesh, batches: [] }),
    new AbortController().signal,
  );
  expect(resources.missingCount).toBe(4);
  expect(
    planBuildAnimation(doc, doc.rootModelId, {
      localBounds: resources.bounds,
      excludedPartIds: resources.excludedPartIds,
    }).parts,
  ).toEqual([]);
});
