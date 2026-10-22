import { expect, it } from 'vitest';
import { InstancedMesh, LineSegments } from 'three/webgpu';
import { buildPartMesh, LibraryResolver, createMemorySource } from '@brickloop/ldraw';
import type { ColorDef } from '@brickloop/catalog';
import { createPartInstances, partMaterial } from '../src/parts';
import { disposeObjects } from '../src/scene-content';

const red: ColorDef = {
  id: 'c:red',
  legoName: 'Red',
  legoColorId: 21,
  nameZh: '红',
  ldrawCode: 4,
  rgb: '#ff0000',
  edgeRgb: '#220000',
  finish: 'solid',
  alpha: 1,
};
it('batches matching part/color instances and transforms LDraw edges', async () => {
  const mesh = await buildPartMesh(
    'test.dat',
    new LibraryResolver({
      library: createMemorySource('test', { 'parts/test.dat': '0 Test\n3 16 0 0 0 10 0 0 0 10 0\n2 24 0 0 0 10 0 0' }),
    }),
  );
  const root = createPartInstances([
    { partId: 'ld:test', mesh, color: red },
    { partId: 'ld:test', mesh, color: red, transform: [20, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { partId: 'ld:test', mesh, color: { ...red, id: 'c:blue', rgb: '#0000ff' } },
  ]);
  const batches = root.children.filter((object) => object instanceof InstancedMesh);
  expect(batches.map((object) => object.count)).toEqual([2, 1]);
  const lines = root.children.find((object) => object instanceof LineSegments)!;
  expect(lines.geometry.getAttribute('position').getX(2)).toBe(20);
  disposeObjects(root);
  expect(root.children).toHaveLength(0);
});
it('distinguishes plastic, transparent, metallic, rubber materials', () => {
  const plastic = partMaterial(red, false);
  expect(plastic.metalness).toBe(0);
  const glass = partMaterial({ ...red, alpha: 0.5, finish: 'transparent' }, false);
  expect(glass.transparent).toBe(true);
  expect(glass.depthWrite).toBe(false);
  const metal = partMaterial({ ...red, finish: 'metallic' }, false);
  expect(metal.metalness).toBeGreaterThan(plastic.metalness);
  const rubber = partMaterial({ ...red, finish: 'rubber' }, false);
  expect(rubber.roughness).toBeGreaterThan(plastic.roughness);
  [plastic, glass, metal, rubber].forEach((material) => material.dispose());
});
