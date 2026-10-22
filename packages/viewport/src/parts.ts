import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
} from 'three/webgpu';
import type { ColorDef, PartId } from '@brickloop/catalog';
import type { PartMesh, Transform } from '@brickloop/ldraw';

export interface PartInstance {
  partId: PartId;
  mesh: PartMesh;
  color: ColorDef;
  transform?: Transform;
}
export function partMaterial(color: ColorDef, doubleSided: boolean): MeshStandardMaterial {
  const metalness =
    color.finish === 'chrome' ? 1 : color.finish === 'metallic' ? 0.75 : color.finish === 'pearl' ? 0.3 : 0;
  return new MeshStandardMaterial({
    color: color.rgb,
    opacity: color.alpha,
    transparent: color.alpha < 1,
    depthWrite: color.alpha >= 1,
    metalness,
    roughness:
      color.finish === 'rubber' ? 0.78 : color.finish === 'chrome' ? 0.12 : color.finish === 'metallic' ? 0.24 : 0.28,
    side: doubleSided ? DoubleSide : FrontSide,
    emissive: color.finish === 'glow' ? color.rgb : 0,
    emissiveIntensity: color.finish === 'glow' ? 0.2 : 0,
  });
}
function matrix(transform?: Transform): Matrix4 {
  if (!transform) return new Matrix4();
  const [x, y, z, a, b, c, d, e, f, g, h, i] = transform;
  return new Matrix4().set(a, b, c, x, d, e, f, y, g, h, i, z, 0, 0, 0, 1);
}
export function createPartInstances(instances: readonly PartInstance[], colors: readonly ColorDef[] = []): Group {
  const root = new Group();
  root.name = 'part-instances';
  const definitions = new Map(
    colors.filter((color) => color.ldrawCode !== null).map((color) => [color.ldrawCode!, color]),
  );
  const groups = new Map<string, PartInstance[]>();
  for (const instance of instances) {
    const key = `${instance.partId}/${instance.color.id}`;
    const batch = groups.get(key) ?? [];
    batch.push(instance);
    groups.set(key, batch);
  }
  for (const [key, group] of groups) {
    const { mesh, color } = group[0]!;
    const matrices = group.map((instance) => matrix(instance.transform));
    const resolved = (code: number): ColorDef =>
      definitions.get(code) ?? {
        ...color,
        rgb: code >= 0x2000000 ? `#${(code & 0xffffff).toString(16).padStart(6, '0')}` : color.rgb,
      };
    for (const batch of mesh.batches) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(batch.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(batch.normals, 3));
      geometry.setIndex(new BufferAttribute(batch.indices, 1));
      const object = new InstancedMesh(
        geometry,
        partMaterial(batch.color === 'main' ? color : resolved(batch.color), mesh.doubleSided),
        group.length,
      );
      object.name = key;
      matrices.forEach((transform, index) => object.setMatrixAt(index, transform));
      object.instanceMatrix.needsUpdate = true;
      object.computeBoundingBox();
      object.computeBoundingSphere();
      root.add(object);
    }
    for (const edge of mesh.edges) {
      const positions = new Float32Array(edge.positions.length * group.length);
      const point = new Vector3();
      matrices.forEach((transform, instance) => {
        for (let index = 0; index < edge.positions.length; index += 3)
          point
            .fromArray(edge.positions, index)
            .applyMatrix4(transform)
            .toArray(positions, instance * edge.positions.length + index);
      });
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const rgb = edge.color === 'edge' ? color.edgeRgb : edge.color === 16 ? color.rgb : resolved(edge.color).rgb;
      const lines = new LineSegments(
        geometry,
        new LineBasicMaterial({ color: rgb, transparent: color.alpha < 1, opacity: color.alpha < 1 ? 0.65 : 1 }),
      );
      root.add(lines);
    }
  }
  return root;
}
