import type { PartMesh } from '@brickloop/ldraw';

/** V8 cache views may share a larger backing buffer. Transfer only owned, exact-size buffers. */
export function ownMesh(mesh: PartMesh): PartMesh {
  return {
    ...mesh,
    batches: mesh.batches.map((batch) => ({
      ...batch,
      positions: new Float32Array(batch.positions),
      normals: new Float32Array(batch.normals),
      indices: new Uint32Array(batch.indices),
    })),
    edges: mesh.edges.map((edge) => ({ ...edge, positions: new Float32Array(edge.positions) })),
    conditionalEdges: {
      ...mesh.conditionalEdges,
      positions: new Float32Array(mesh.conditionalEdges.positions),
      controls: new Float32Array(mesh.conditionalEdges.controls),
    },
  };
}
export function meshBuffers(mesh: PartMesh): ArrayBuffer[] {
  return [
    ...new Set([
      ...mesh.batches.flatMap((batch) => [batch.positions.buffer, batch.normals.buffer, batch.indices.buffer]),
      ...mesh.edges.map((edge) => edge.positions.buffer),
      mesh.conditionalEdges.positions.buffer,
      mesh.conditionalEdges.controls.buffer,
    ]),
  ] as ArrayBuffer[];
}
