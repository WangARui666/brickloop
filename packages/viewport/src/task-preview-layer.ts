import { Box3, DoubleSide, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three/webgpu';
import { fromLDraw } from '@brickloop/core';
import type { DocumentProjection } from './document-projection';
import { BoundsOverlay } from './bounds-overlay';
import { disposeObjects } from './scene-content';

export interface TaskPreview {
  color?: string;
  parts: { partId: string; transform: number[] }[];
  removed: { partId: string; transform: number[] }[];
}
/** Independent of the document projection and its picking/mask layers. */
export class TaskPreviewLayer {
  readonly root = new Group();
  private readonly parts = new Group();
  private readonly removed = new BoundsOverlay('#F0616D');
  private previous: TaskPreview | null = null;
  updates = 0;
  constructor(private readonly projection: DocumentProjection) {
    this.root.add(this.parts, this.removed.root);
  }
  set(preview: TaskPreview | null) {
    if (preview === this.previous) return;
    this.previous = preview;
    this.updates++;
    disposeObjects(this.parts);
    const batches = new Map<string, Matrix4[]>();
    for (const part of preview?.parts ?? []) {
      const matrices = batches.get(part.partId) ?? [];
      matrices.push(new Matrix4().fromArray(fromLDraw(part.transform)));
      batches.set(part.partId, matrices);
    }
    for (const [id, matrices] of batches) {
      const definition = this.projection.definitions.get(id);
      if (!definition) continue;
      // Own the attributes: disposing a preview must not invalidate the live document's GPU buffers.
      const geometry = definition.geometry.clone();
      const mesh = new InstancedMesh(
        geometry,
        new MeshBasicMaterial({
          color: preview?.color ?? '#7C9CFF',
          opacity: 0.45,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          side: DoubleSide,
          toneMapped: false,
        }),
        matrices.length,
      );
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.renderOrder = 9;
      this.parts.add(mesh);
    }
    this.removed.set(
      (preview?.removed ?? []).map((part) =>
        (
          this.projection.definitions.get(part.partId)?.bounds.clone() ??
          new Box3(new Vector3(-10, -24, -10), new Vector3(10, 0, 10))
        ).applyMatrix4(new Matrix4().fromArray(fromLDraw(part.transform))),
      ),
    );
  }
  dispose() {
    disposeObjects(this.parts);
    this.removed.dispose();
    this.root.clear();
  }
}
