import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three/webgpu';
import { float, positionWorld, smoothstep } from 'three/tsl';
import { LDU_PER_STUD } from '@brickloop/core';
import { gridLines } from './grid';
import type { GridLineKind, GridOptions } from './grid';
import { themeColor } from './theme';

/** Only document content belongs here. Future definition/color InstancedMesh batches use this group. */
export function createContentLayer(): Group {
  const content = new Group();
  content.name = 'content';
  return content;
}

export function addPlaceholder(content: Group): void {
  if (content.getObjectByName('placeholder-brick')) return;
  const geometry = new BoxGeometry(80, 24, 40);
  const material = new MeshStandardMaterial({ color: '#C91A09', roughness: 0.26, metalness: 0 });
  const brick = new Mesh(geometry, material);
  brick.name = 'placeholder-brick';
  brick.position.y = -12;
  const edges = new LineSegments(new EdgesGeometry(geometry), new LineBasicMaterial({ color: '#3F0D08' }));
  brick.add(edges);
  content.add(brick);
}

/** Excludes grid/lights/overlays and hidden descendants; supports Mesh and InstancedMesh bounds. */
export function visibleContentBounds(content: Group): Box3 {
  content.updateWorldMatrix(true, true);
  const bounds = new Box3();
  content.traverseVisible((object) => {
    if (object instanceof Mesh) {
      // expandByObject recurses, so use this object's own geometry/batch bounds only.
      if (object instanceof InstancedMesh) {
        if (!object.boundingBox) object.computeBoundingBox();
        if (object.boundingBox) bounds.union(object.boundingBox.clone().applyMatrix4(object.matrixWorld));
      } else {
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox)
          bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      }
    }
  });
  if (bounds.isEmpty()) bounds.set(new Vector3(-40, 0, -40), new Vector3(40, 24, 40));
  return bounds;
}

export function createGrid(options: GridOptions, container: HTMLElement): Group {
  const lines = gridLines(options);
  const grid = new Group();
  grid.name = 'ground-grid';
  grid.visible = options.visible;
  const half = (options.sizeStuds * LDU_PER_STUD) / 2;
  const styles: Record<GridLineKind, { color: string; opacity: number; width: number }> = {
    subdivision: { color: themeColor(container, 'grid-stud'), opacity: 0.35, width: 0.08 },
    stud: { color: themeColor(container, 'grid-stud'), opacity: 0.6, width: 0.18 },
    major: { color: themeColor(container, 'grid-major'), opacity: 0.9, width: 0.4 },
    x: { color: themeColor(container, 'axis-x'), opacity: 0.7, width: 0.3 },
    z: { color: themeColor(container, 'axis-z'), opacity: 0.7, width: 0.3 },
  };
  for (const kind of Object.keys(styles) as GridLineKind[]) {
    const positions: number[] = [];
    const { color, opacity, width } = styles[kind];
    for (const line of lines.filter((line) => line.kind === kind)) {
      const lo = line.coordinate - width / 2;
      const hi = line.coordinate + width / 2;
      const corners =
        line.parallel === 'x'
          ? [
              [-half, lo],
              [half, lo],
              [half, hi],
              [-half, hi],
            ]
          : [
              [lo, -half],
              [hi, -half],
              [hi, half],
              [lo, half],
            ];
      for (const index of [0, 1, 2, 0, 2, 3]) {
        const corner = corners[index]!;
        positions.push(corner[0]!, 0.04, corner[1]!);
      }
    }
    if (!positions.length) continue;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = new MeshBasicNodeMaterial({
      color: new Color(color),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    material.opacityNode = float(opacity).mul(float(1).sub(smoothstep(half * 0.2, half, positionWorld.xz.length())));
    grid.add(new Mesh(geometry, material));
  }
  return grid;
}

export function disposeObjects(root: Group): void {
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof LineSegments) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
      if (object instanceof InstancedMesh) object.dispose();
    }
  });
  root.clear();
}
