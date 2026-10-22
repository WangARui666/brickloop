import { fromLDraw, identity, multiply, toLDraw, transformPoint } from '@brickloop/core';
import type { BrkDocument, Instance, InstancePath } from '@brickloop/core';
import type { ReviewOverlay } from '@brickloop/viewport';
import type { PartMesh } from '@brickloop/ldraw';
import type { Review } from './review-store';

interface Occurrence {
  path: InstancePath;
  transform: number[];
  colorId: string;
  instance: Instance;
}
export function reviewOccurrences(doc: BrkDocument): Map<string, Occurrence[]> {
  const result = new Map<string, Occurrence[]>();
  const visit = (modelId: string, prefix: InstancePath, parent: Float64Array, color: string) => {
    const model = doc.models[modelId];
    if (!model) return;
    for (const instance of Object.values(model.instances)) {
      const path = [...prefix, instance.id],
        matrix = multiply(parent, fromLDraw(instance.transform));
      const colorId = instance.colorId === 'inherit' ? color : instance.colorId;
      const key = `${modelId}/${instance.id}`,
        list = result.get(key) ?? [];
      list.push({ path, transform: toLDraw(matrix), colorId, instance });
      result.set(key, list);
      if (instance.ref.kind === 'model') visit(instance.ref.modelId, path, matrix, colorId);
    }
  };
  visit(doc.rootModelId, [], identity(), 'ld:16');
  return result;
}
function modelBounds(doc: BrkDocument, modelId: string, meshes: Map<string, PartMesh>): number[] {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const occurrences of reviewOccurrences({ ...doc, rootModelId: modelId }).values())
    for (const row of occurrences) {
      if (row.instance.ref.kind !== 'part') continue;
      const bounds = meshes.get(row.instance.ref.partId)?.bboxLdu ?? [-10, -24, -10, 10, 0, 10];
      for (let corner = 0; corner < 8; corner++) {
        const point = transformPoint(fromLDraw(row.transform), [
          bounds[corner & 1 ? 3 : 0]!,
          bounds[corner & 2 ? 4 : 1]!,
          bounds[corner & 4 ? 5 : 2]!,
        ]);
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
      }
    }
  return Number.isFinite(min[0]) ? [...min, ...max] : [-10, -24, -10, 10, 0, 10];
}
export function buildReviewOverlay(review: Review, current: BrkDocument, meshes: Map<string, PartMesh>) {
  const before = reviewOccurrences(review.before),
    after = reviewOccurrences(current);
  const overlay: ReviewOverlay = {
    added: [],
    changed: [],
    moved: [],
    ghosts: [],
    visible: review.visible && review.mode === 'after',
  };
  const targets = new Map<string, (InstancePath | number)[]>();
  const bounds = new Map<string, number[]>();
  for (const change of review.diff.instances) {
    const locations = after.get(change.key) ?? [],
      old = before.get(change.key) ?? [];
    targets.set(
      change.key,
      locations.map((row) => row.path),
    );
    if (review.states[change.key] !== 'accepted') continue;
    if (change.kinds.includes('added')) overlay.added.push(...locations.map((row) => row.path));
    if (change.kinds.includes('recolored') || change.kinds.includes('replaced'))
      overlay.changed.push(...locations.map((row) => row.path));
    if (change.kinds.includes('moved')) {
      const originals = new Map(old.map((row) => [row.path.join('/'), row]));
      for (const row of locations) {
        const original = originals.get(row.path.join('/'));
        if (original) overlay.moved.push({ path: row.path, from: original.transform });
      }
    }
    if (change.kinds.includes('removed') || change.kinds.includes('moved'))
      for (const row of old) {
        const ref = row.instance.ref;
        const index = overlay.ghosts.length;
        if (ref.kind === 'model' && !bounds.has(ref.modelId))
          bounds.set(ref.modelId, modelBounds(review.before, ref.modelId, meshes));
        overlay.ghosts.push({
          ...(ref.kind === 'part'
            ? { partId: ref.partId }
            : { modelId: ref.modelId, bounds: bounds.get(ref.modelId)! }),
          colorId: row.colorId,
          transform: row.transform,
          kind: change.kinds.includes('removed') ? 'removed' : 'movedFrom',
        });
        if (!locations.length) targets.set(change.key, [...(targets.get(change.key) ?? []), index]);
      }
  }
  return { overlay, targets };
}
