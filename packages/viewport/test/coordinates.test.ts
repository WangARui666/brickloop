import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { createLdrawRoot, documentAxes, ldrawToWorld, worldToLdraw } from '../src/coordinates';

describe('LDraw boundary', () => {
  it('maps one brick upward, in LDU without a scale factor', () => {
    expect(ldrawToWorld({ x: 0, y: -24, z: 0 }).toArray()).toEqual([0, 24, 0]);
    expect(ldrawToWorld({ x: 80, y: -24, z: 40 }).toArray()).toEqual([80, 24, -40]);
  });
  it('round trips positive, negative and fractional coordinates', () => {
    for (const point of [new Vector3(), new Vector3(80, -24, 40), new Vector3(-0.5, 2.75, -1000)]) {
      expect(worldToLdraw(ldrawToWorld(point))).toEqual(point);
    }
  });
  it('matches the actual scene root rotation', () => {
    const root = createLdrawRoot();
    expect(root.rotation.x).toBe(Math.PI);
    root.updateMatrixWorld();
    const point = new Vector3(80, -24, 40);
    expect(point.clone().applyMatrix4(root.matrixWorld).distanceTo(ldrawToWorld(point))).toBeLessThan(1e-10);
    expect(ldrawToWorld(documentAxes.Y).y).toBe(1);
    expect(ldrawToWorld(documentAxes.Z).z).toBe(-1);
  });
});
