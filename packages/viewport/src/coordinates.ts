import { Group, Vector3 } from 'three/webgpu';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

// The only coordinate boundary: a 180° X rotation maps LDraw -Y up to world +Y.
// Keep the exact component mapping here to avoid sin(PI) noise in pure calculations.
export function ldrawToWorld({ x, y, z }: Point3): Vector3 {
  return new Vector3(x, -y || 0, -z || 0);
}

export function worldToLdraw(point: Point3): Vector3 {
  return ldrawToWorld(point);
}

export function createLdrawRoot(): Group {
  const root = new Group();
  root.name = 'ldrawRoot';
  root.rotation.x = Math.PI;
  return root;
}

// Y in the orientation indicator denotes the upward direction, i.e. LDraw -Y.
export const documentAxes = {
  X: { x: 1, y: 0, z: 0 },
  Y: { x: 0, y: -1, z: 0 },
  Z: { x: 0, y: 0, z: 1 },
} satisfies Record<string, Point3>;
