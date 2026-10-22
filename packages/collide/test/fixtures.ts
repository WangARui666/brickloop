import { createDocument, fromLDraw, identity, toLDraw, translation } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { PartMesh } from '@brickloop/ldraw';
import { GENERATOR_VERSION, IDENTITY_ROTATION } from '../src/index.js';
import type { Collider, ColliderShape, CollisionInstance, Vec3 } from '../src/index.js';

export const box = (center: Vec3 = [0, 0, 0], halfSize: Vec3 = [5, 5, 5]): ColliderShape => ({
  kind: 'box',
  center,
  halfSize,
  rotation: [...IDENTITY_ROTATION],
});
export const cylinder = (
  center: Vec3 = [0, 0, 0],
  axis: Vec3 = [0, 1, 0],
  radius = 3,
  halfLength = 5,
): ColliderShape => ({ kind: 'cylinder', center, axis, radius, halfLength });
export const proxy = (shapes: ColliderShape[] = [box()], approximate = false): Collider => ({
  schema: 1,
  partId: 'ld:3001',
  generatorVersion: GENERATOR_VERSION,
  source: 'generated',
  shapes,
  approximate,
  bounds: [-5, -5, -5, 5, 5, 5],
  diagnostics: [],
});
export const instance = (
  id: string,
  collider: Collider | undefined = proxy(),
  position: Vec3 = [0, 0, 0],
): CollisionInstance => ({
  path: [id],
  transform: translation(position),
  ...(collider === undefined ? {} : { collider }),
});
export function documentOf(count: number, spacing = 20): BrkDocument {
  const doc = createDocument({ title: 'collide fixture' });
  const model = doc.models[doc.rootModelId]!;
  const stepId = model.stepIds[0]!;
  for (let i = 0; i < count; i++) {
    const id = `part-${i}`;
    model.instances[id] = {
      id,
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: 'c:red',
      transform: toLDraw(translation([i * spacing, 0, 0])),
      stepId,
      groupId: null,
    };
    model.steps[stepId]!.instanceIds.push(id);
  }
  return doc;
}
export const documentInstances = (doc: BrkDocument, collider = proxy()): CollisionInstance[] =>
  Object.values(doc.models[doc.rootModelId]!.instances).map((row) => ({
    path: [row.id],
    transform: fromLDraw(row.transform),
    collider,
  }));
export const emptyMesh = (): PartMesh => ({
  partFile: 'fixture.dat',
  bboxLdu: [-10, -10, -10, 10, 10, 10],
  batches: [],
  edges: [],
  conditionalEdges: { positions: new Float32Array(), controls: new Float32Array() },
  doubleSided: false,
  diagnostics: { missing: [], cycles: [], warnings: [] },
  sources: [],
});
export const UNIT = identity();
