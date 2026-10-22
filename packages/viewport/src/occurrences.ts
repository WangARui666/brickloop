import { Matrix4 } from 'three/webgpu';
import type { BrkDocument, Instance, InstancePath } from '@brickloop/core';

interface Occurrence {
  path: InstancePath;
  instance: Instance;
  parent: Matrix4;
  matrix: Matrix4;
  colorId: string;
}
const identity = new Matrix4();

/** Core edits retain unchanged instance/transform objects. Cache by occurrence, not definition:
 * one shared-model edit still updates every affected world transform. */
export class Occurrences {
  private entries = new Map<string, Occurrence>();

  expand(document: BrkDocument): Occurrence[] {
    const next = new Map<string, Occurrence>();
    const leaves: Occurrence[] = [];
    const ancestors = new Set<string>();
    const visit = (modelId: string, prefix: InstancePath, parent: Matrix4, inherited: string) => {
      if (ancestors.has(modelId)) throw new RangeError('Cyclic model reference');
      const model = document.models[modelId];
      if (!model) throw new RangeError('Missing model reference');
      ancestors.add(modelId);
      for (const step of model.stepIds)
        for (const id of model.steps[step]?.instanceIds ?? []) {
          const instance = model.instances[id];
          if (!instance) continue;
          const key = prefix.length ? `${prefix.join('/')}/${id}` : id;
          const before = this.entries.get(key);
          const colorId = instance.colorId === 'inherit' ? inherited : instance.colorId;
          let matrix = before?.matrix;
          if (!before || before.parent !== parent || before.instance.transform !== instance.transform) {
            const [x, y, z, a, b, c, d, e, f, g, h, i] = instance.transform;
            matrix = new Matrix4().set(a!, b!, c!, x!, d!, e!, f!, y!, g!, h!, i!, z!, 0, 0, 0, 1).premultiply(parent);
            // Equivalent edits (including undo and preview resets) do not invalidate descendants.
            if (before?.matrix.equals(matrix)) matrix = before.matrix;
          }
          const entry =
            before?.instance === instance && before.parent === parent && before.colorId === colorId
              ? before
              : { path: before?.path ?? [...prefix, id], instance, parent, matrix: matrix!, colorId };
          next.set(key, entry);
          if (instance.ref.kind === 'model') visit(instance.ref.modelId, entry.path, entry.matrix, colorId);
          else leaves.push(entry);
        }
      ancestors.delete(modelId);
    };
    visit(document.rootModelId, [], identity, 'ld:16');
    this.entries = next;
    return leaves;
  }

  clear(): void {
    this.entries.clear();
  }
}
