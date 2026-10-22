import { BoxGeometry } from 'three/webgpu';
import type { PartMesh } from '@brickloop/ldraw';

/** Neutral solid box; collision-unknown feedback uses a separate dashed overlay. */
export function loadingMesh(): PartMesh {
  const box = new BoxGeometry(20, 24, 20).translate(0, -12, 0);
  const mesh: PartMesh = {
    partFile: '$loading',
    bboxLdu: [-10, -24, -10, 10, 0, 10],
    doubleSided: false,
    batches: [
      {
        color: 'main',
        positions: new Float32Array(box.getAttribute('position').array),
        normals: new Float32Array(box.getAttribute('normal').array),
        indices: new Uint32Array(box.index!.array),
      },
    ],
    edges: [],
    conditionalEdges: { positions: new Float32Array(), controls: new Float32Array() },
    diagnostics: { missing: [], cycles: [], warnings: [] },
    sources: [],
  };
  box.dispose();
  return mesh;
}
