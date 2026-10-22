import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  DoubleSide,
} from 'three/webgpu';
import type { Ray, BufferGeometry } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Connector, WorldConnector } from '@brickloop/connect';
import type { ColliderShape } from '@brickloop/collide';
import { disposeObjects } from './scene-content';

export interface ConnectorMarker extends WorldConnector {
  label: string;
  connected?: boolean;
  highlight?: 'source' | 'target';
}
export function connectorStyle(c: Connector): { color: string; shape: string } {
  switch (c.type) {
    case 'stud':
      return { color: '#ef4444', shape: 'solid' };
    case 'stud.hollow':
      return { color: '#ef4444', shape: 'tube' };
    case 'antistud':
      return { color: '#3485ff', shape: 'solid' };
    case 'antistud.tube':
      return { color: '#3485ff', shape: 'tube' };
    case 'bar.post':
      return { color: '#3485ff', shape: 'post' };
    case 'bar':
      return { color: '#163d94', shape: 'rod' };
    case 'bar.thin':
      return { color: '#3485ff', shape: 'thin' };
    case 'bar.hole':
      return { color: '#ffdb3b', shape: 'solid' };
    case 'clip':
      return { color: '#ffdb3b', shape: 'clip' };
    case 'axle':
      return { color: '#163d94', shape: 'cross' };
    case 'axle.hole':
      return { color: '#ffdb3b', shape: 'cross' };
    case 'pin':
      return { color: '#163d94', shape: 'pin' };
    case 'pin.hole':
      return { color: '#ffdb3b', shape: 'depth' };
    case 'ball':
      return { color: '#ef4444', shape: 'ball' };
    case 'ball.socket':
      return { color: '#3485ff', shape: 'socket' };
    case 'hinge.click':
      return { color: c.role === 'b' ? '#89943f' : '#163d94', shape: 'gear' };
    case 'bar.thin.hole':
      return { color: '#ffdb3b', shape: 'smallHole' };
    case 'wheel.pin':
      return { color: '#163d94', shape: 'pin' };
    case 'wheel.hole':
      return { color: '#ffdb3b', shape: 'smallHole' };
    case 'fixed':
      return /wheel|tyre|tire|rim/i.test(c.tag ?? '')
        ? {
            color:
              c.size === 's' || (!c.size && Number(/(\d+)mm/.exec(c.tag ?? '')?.[1]) <= 12)
                ? '#3485ff'
                : c.size === 'l' || (!c.size && Number(/(\d+)mm/.exec(c.tag ?? '')?.[1]) > 20)
                  ? '#ef4444'
                  : '#ff8a3d',
            shape: 'ball',
          }
        : { color: c.role === 'b' ? '#ffdb3b' : '#b575ed', shape: 'post' };
    default:
      return { color: '#89943f', shape: 'tube' };
  }
}
function tube(open = false) {
  return new LatheGeometry(
    [new Vector2(1.8, -1.5), new Vector2(3, -1.5), new Vector2(3, 1.5), new Vector2(1.8, 1.5), new Vector2(1.8, -1.5)],
    16,
    open ? 0.5 : 0,
    open ? Math.PI * 1.65 : Math.PI * 2,
  );
}
function geometry(kind: string): BufferGeometry {
  if (kind === 'tube' || kind === 'depth' || kind === 'smallHole') return tube();
  if (kind === 'clip') return tube(true);
  if (kind === 'ball' || kind === 'socket') return new SphereGeometry(3.5, 16, 10);
  if (kind === 'rod' || kind === 'thin' || kind === 'post')
    return new CylinderGeometry(kind === 'thin' ? 1 : 1.6, kind === 'thin' ? 1 : 1.6, kind === 'post' ? 4 : 10, 12);
  if (kind === 'pin')
    return mergeGeometries([
      new CylinderGeometry(2, 2, 8, 16),
      new TorusGeometry(2.4, 0.7, 6, 16).rotateX(Math.PI / 2),
    ])!;
  if (kind === 'cross') {
    const shape = new Shape();
    const points = [
      [-1, -3],
      [1, -3],
      [1, -1],
      [3, -1],
      [3, 1],
      [1, 1],
      [1, 3],
      [-1, 3],
      [-1, 1],
      [-3, 1],
      [-3, -1],
      [-1, -1],
    ];
    points.forEach(([x, y], i) => (i ? shape.lineTo(x!, y!) : shape.moveTo(x!, y!)));
    shape.closePath();
    return new ExtrudeGeometry(shape, { depth: 4, bevelEnabled: false }).translate(0, 0, -2).rotateX(Math.PI / 2);
  }
  if (kind === 'gear') {
    const pieces: BufferGeometry[] = [tube()];
    for (let i = 0; i < 12; i++)
      pieces.push(new BoxGeometry(1.2, 3, 1.2).translate(3.3, 0, 0).rotateY((i * Math.PI) / 6));
    return mergeGeometries(pieces.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  }
  return new CylinderGeometry(3, 3, 3, 16);
}
export class ConnectorLayer {
  readonly root = new Group();
  private batches: { mesh: InstancedMesh; markers: ConnectorMarker[] }[] = [];
  private signature = '';
  set(markers: readonly ConnectorMarker[]) {
    const signature = JSON.stringify(markers);
    if (signature === this.signature) return;
    this.signature = signature;
    disposeObjects(this.root);
    this.batches = [];
    const groups = new Map<string, ConnectorMarker[]>();
    for (const marker of markers) {
      const style = connectorStyle(marker.connector),
        key = `${style.shape}/${style.color}/${marker.highlight ?? ''}`;
      const list = groups.get(key) ?? [];
      list.push(marker);
      groups.set(key, list);
    }
    for (const list of groups.values()) {
      const first = list[0]!,
        style = connectorStyle(first.connector);
      const object = new InstancedMesh(
        geometry(style.shape),
        new MeshBasicMaterial({
          color: style.color,
          transparent: true,
          opacity: style.shape === 'socket' ? 0.55 : 0.92,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
        list.length,
      );
      object.renderOrder = 20;
      list.forEach((marker, index) => {
        const c = marker.connector,
          scale = marker.highlight === 'source' ? 1.5 : 1;
        object.setMatrixAt(
          index,
          new Matrix4().compose(
            new Vector3(...c.frame.origin),
            new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...c.frame.axis)),
            new Vector3(scale, scale, scale),
          ),
        );
        object.setColorAt(index, new Color().setScalar(marker.connected && !marker.highlight ? 0.35 : 1));
      });
      object.instanceMatrix.needsUpdate = true;
      this.root.add(object);
      this.batches.push({ mesh: object, markers: list });
      if (style.shape === 'depth') {
        const depth = new InstancedMesh(
          new TorusGeometry(2.3, 0.5, 6, 16).rotateX(Math.PI / 2),
          new MeshBasicMaterial({ color: '#3485ff', depthTest: false, toneMapped: false }),
          list.length,
        );
        list.forEach((_, index) => {
          const m = new Matrix4();
          object.getMatrixAt(index, m);
          depth.setMatrixAt(index, m);
        });
        depth.renderOrder = 21;
        this.root.add(depth);
      }
      if (first.highlight) {
        const ring = new InstancedMesh(
          new TorusGeometry(5, 0.55, 6, 24).rotateX(Math.PI / 2),
          new MeshBasicMaterial({
            color: first.highlight === 'source' ? '#ffffff' : '#ffb33d',
            depthTest: false,
            toneMapped: false,
          }),
          list.length,
        );
        list.forEach((_, index) => {
          const m = new Matrix4();
          object.getMatrixAt(index, m);
          ring.setMatrixAt(index, m);
        });
        ring.renderOrder = 22;
        this.root.add(ring);
      }
    }
  }
  pick(ray: Ray): ConnectorMarker | null {
    this.root.updateWorldMatrix(true, true);
    const cast = new Raycaster();
    cast.ray.copy(ray).applyMatrix4(this.root.matrixWorld);
    let best: { distance: number; marker: ConnectorMarker } | undefined;
    for (const batch of this.batches) {
      const hit = cast.intersectObject(batch.mesh, false)[0];
      const marker = hit?.instanceId === undefined ? undefined : batch.markers[hit.instanceId];
      if (hit && marker && (!best || hit.distance < best.distance)) best = { distance: hit.distance, marker };
    }
    return best?.marker ?? null;
  }
  dispose() {
    disposeObjects(this.root);
    this.batches = [];
  }
}
export function colliderGeometry(shape: ColliderShape) {
  if (shape.kind === 'box') {
    const m = new Matrix4().set(
      shape.rotation[0],
      shape.rotation[3],
      shape.rotation[6],
      shape.center[0],
      shape.rotation[1],
      shape.rotation[4],
      shape.rotation[7],
      shape.center[1],
      shape.rotation[2],
      shape.rotation[5],
      shape.rotation[8],
      shape.center[2],
      0,
      0,
      0,
      1,
    );
    return new BoxGeometry(...(shape.halfSize.map((v) => v * 2) as [number, number, number])).applyMatrix4(m);
  }
  return new CylinderGeometry(shape.radius, shape.radius, shape.halfLength * 2, 20)
    .applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...shape.axis)))
    .translate(...shape.center);
}
