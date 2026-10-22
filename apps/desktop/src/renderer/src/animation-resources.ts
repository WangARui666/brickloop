import { expandInstances, toLDraw } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { AnimationBounds } from '@brickloop/animation';
import type { ColorDef, PartId } from '@brickloop/catalog';
import type { PartMesh, Transform } from '@brickloop/ldraw';
import type { PartInstance } from '@brickloop/viewport';

/** The player can still show the available model when individual geometry loads fail. */
export async function loadAnimationResources(
  document: BrkDocument,
  modelId: string,
  colors: readonly ColorDef[],
  loadMesh: (id: PartId) => Promise<PartMesh>,
  signal: AbortSignal,
) {
  const expanded = expandInstances(document, modelId),
    bounds: Record<string, AnimationBounds> = {};
  const meshes = new Map<string, PartMesh>();
  const excludedPartIds: string[] = [];
  await Promise.all(
    [...new Set(expanded.map((p) => p.partId))].map(async (id) => {
      signal.throwIfAborted();
      let mesh: PartMesh | undefined;
      try {
        mesh = await loadMesh(id as PartId);
      } catch {
        signal.throwIfAborted();
      }
      if (!mesh?.batches.some((batch) => batch.indices.length > 0)) {
        excludedPartIds.push(id);
        return;
      }
      meshes.set(id, mesh);
      bounds[id] = {
        min: [mesh.bboxLdu[0], mesh.bboxLdu[1], mesh.bboxLdu[2]],
        max: [mesh.bboxLdu[3], mesh.bboxLdu[4], mesh.bboxLdu[5]],
      };
    }),
  );
  signal.throwIfAborted();
  const instances = new Map<string, PartInstance>();
  for (const p of expanded) {
    const mesh = meshes.get(p.partId);
    if (!mesh) continue;
    const color = colors.find((c) => c.id === p.colorId) ?? colors.find((c) => c.ldrawCode === 16) ?? colors[0]!;
    instances.set(p.path.join('/'), {
      partId: p.partId as PartId,
      mesh,
      color,
      transform: toLDraw(p.worldMatrix) as Transform,
    });
  }
  return {
    instances,
    colors,
    bounds,
    missingCount: expanded.length - instances.size,
    excludedPartIds: excludedPartIds.sort(),
  };
}
