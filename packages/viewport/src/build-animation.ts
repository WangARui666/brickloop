import {
  ACESFilmicToneMapping,
  BufferAttribute,
  CanvasTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import {
  attribute,
  cross,
  dot,
  mat3,
  mat4,
  materialColor,
  normalLocal,
  negateOnBackSide,
  positionLocal,
  transformNormalToView,
  uniform,
  vec4,
} from 'three/tsl';
import type { ColorDef } from '@brickloop/catalog';
import type { Workspace } from '@brickloop/core';
import { animationOrbit, sampleAnimationPart } from '@brickloop/animation';
import type { AnimationPart, BuildTimeline } from '@brickloop/animation';
import { createLdrawRoot } from './coordinates';
import { partMaterial } from './parts';
import type { PartInstance } from './parts';
import { viewportColors } from './theme';
import { fitAnimationOrbit } from './animation-framing';

export interface BuildAnimationViewOptions {
  width: number;
  height: number;
  preferWebGPU?: boolean;
  background?: string;
  cameraMode?: 'orbit' | 'fixed';
  camera?: Workspace['camera'] & { span?: number };
  dimCompleted?: boolean;
  overlay?: boolean;
}
interface Draw {
  geometry: InstancedBufferGeometry;
  material: MeshStandardNodeMaterial | LineBasicNodeMaterial;
  object: Mesh | LineSegments;
}
function upperBound(parts: readonly AnimationPart[], t: number) {
  let lo = 0,
    hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (parts[mid]!.start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function capacity(parts: readonly AnimationPart[]) {
  let first = 0,
    maximum = 1;
  parts.forEach((p, i) => {
    while (parts[first]!.start + 0.75 < p.start) first++;
    maximum = Math.max(maximum, i - first + 1);
  });
  return maximum;
}

/** A definition/color batch has an immutable completed prefix and a small moving pool.
 * Seeking only changes the prefix count. Completed matrices are never re-uploaded. */
class AnimationBatch {
  readonly root = new Group();
  readonly brightness = uniform(1);
  private readonly staticDraws: Draw[] = [];
  private readonly movingDraws: Draw[] = [];
  private readonly finalMatrices: Float32Array;
  private readonly movingMatrices: InstancedBufferAttribute[];
  private readonly style: InstancedBufferAttribute;
  private readonly sources: BufferAttribute[] = [];
  private last = NaN;
  constructor(
    readonly parts: AnimationPart[],
    source: PartInstance,
    colors: readonly ColorDef[],
  ) {
    const count = parts.length,
      pool = capacity(parts);
    this.finalMatrices = new Float32Array(count * 16);
    const m = new Matrix4();
    parts.forEach((p, i) => {
      const [x, y, z, a, b, c, d, e, f, g, h, j] = p.transform;
      m.set(a!, b!, c!, x!, d!, e!, f!, y!, g!, h!, j!, z!, 0, 0, 0, 1);
      m.toArray(this.finalMatrices, i * 16);
    });
    const columns = (data: Float32Array, size: number, width: number) =>
      Array.from({ length: width }, (_, c) => {
        const a = new Float32Array((data.length / size / width) * size);
        for (let i = 0; i < a.length / size; i++)
          a.set(data.subarray(i * size * width + c * size, i * size * width + (c + 1) * size), i * size);
        return new InstancedBufferAttribute(a, size);
      });
    const staticMatrices = columns(this.finalMatrices, 4, 4);
    this.movingMatrices = Array.from({ length: 4 }, () => new InstancedBufferAttribute(new Float32Array(pool * 4), 4));
    this.style = new InstancedBufferAttribute(new Float32Array(pool * 2), 2);
    const resolve = (code: number) =>
      colors.find((c) => c.ldrawCode === code) ?? {
        ...source.color,
        rgb: code >= 0x2000000 ? `#${(code & 0xffffff).toString(16).padStart(6, '0')}` : source.color.rgb,
      };
    const make = (
      position: BufferAttribute,
      normals: BufferAttribute | undefined,
      index: BufferAttribute | undefined,
      color: ColorDef,
      edgeColor?: string,
    ) => {
      for (const moving of [false, true]) {
        const geometry = new InstancedBufferGeometry();
        geometry.setAttribute('position', position);
        if (normals) geometry.setAttribute('normal', normals);
        if (index) geometry.setIndex(index);
        (moving ? this.movingMatrices : staticMatrices).forEach((a, i) => geometry.setAttribute(`animationM${i}`, a));
        if (moving) geometry.setAttribute('animationStyle', this.style);
        geometry.instanceCount = 0;
        const base = partMaterial(color, source.mesh.doubleSided);
        const material = edgeColor
          ? new LineBasicNodeMaterial({
              color: edgeColor,
              opacity: color.alpha < 1 ? 0.65 : 1,
              transparent: color.alpha < 1,
            })
          : new MeshStandardNodeMaterial().copy(base);
        base.dispose();
        const matrix = mat4(
          attribute('animationM0', 'vec4'),
          attribute('animationM1', 'vec4'),
          attribute('animationM2', 'vec4'),
          attribute('animationM3', 'vec4'),
        );
        material.positionNode = matrix.mul(vec4(positionLocal, 1)).xyz;
        if (material instanceof MeshStandardNodeMaterial) {
          // Derive the inverse-transpose from the matrix: <= 7 vertex buffers on
          // WebGPU's default limit of 8, including moving opacity/highlight.
          const a = attribute('animationM0', 'vec4').xyz,
            b = attribute('animationM1', 'vec4').xyz,
            c = attribute('animationM2', 'vec4').xyz;
          const normalMatrix = mat3(cross(b, c), cross(c, a), cross(a, b));
          const viewNormal = transformNormalToView(normalMatrix.mul(normalLocal).div(dot(a, cross(b, c))))
            .toVarying()
            .normalize();
          material.normalNode = negateOnBackSide(viewNormal);
        }
        material.colorNode = materialColor.rgb.mul(
          moving ? attribute('animationStyle', 'vec2').y.mul(0.38).add(1) : this.brightness,
        );
        if (moving) {
          const style = attribute('animationStyle', 'vec2');
          material.transparent = true;
          // Keep the source material's depth policy. For transparent parts,
          // forcing depth writes hid rear surfaces/edges only while moving.
          material.opacityNode = style.x.mul(material.opacity);
        }
        const object = edgeColor ? new LineSegments(geometry, material) : new Mesh(geometry, material);
        object.frustumCulled = false;
        this.root.add(object);
        (moving ? this.movingDraws : this.staticDraws).push({ geometry, material, object });
      }
    };
    for (const batch of source.mesh.batches) {
      const p = new BufferAttribute(batch.positions, 3),
        n = new BufferAttribute(batch.normals, 3),
        ix = new BufferAttribute(batch.indices, 1);
      this.sources.push(p, n, ix);
      make(p, n, ix, batch.color === 'main' ? source.color : resolve(batch.color));
    }
    for (const edge of source.mesh.edges) {
      const p = new BufferAttribute(edge.positions, 3);
      this.sources.push(p);
      make(
        p,
        undefined,
        undefined,
        source.color,
        edge.color === 'edge' ? source.color.edgeRgb : resolve(edge.color).rgb,
      );
    }
  }
  update(time: number, dim: boolean) {
    this.brightness.value = dim ? 0.5 : 1;
    if (time === this.last) return 0;
    this.last = time;
    const completed = upperBound(this.parts, time - 0.75),
      visible = upperBound(this.parts, time);
    this.staticDraws.forEach((d) => (d.geometry.instanceCount = completed));
    const active = visible - completed;
    this.movingDraws.forEach((d) => (d.geometry.instanceCount = active));
    for (let i = completed; i < visible; i++) {
      const slot = i - completed,
        sample = sampleAnimationPart(this.parts[i]!, time)!;
      for (let c = 0; c < 4; c++) {
        const column = this.movingMatrices[c]!;
        (column.array as Float32Array).set(this.finalMatrices.subarray(i * 16 + c * 4, i * 16 + c * 4 + 4), slot * 4);
        if (c === 3) for (let axis = 0; axis < 3; axis++) column.array[slot * 4 + axis]! += sample.offset[axis]!;
      }
      this.style.setXY(slot, sample.opacity, sample.highlight);
    }
    if (active)
      for (const a of [...this.movingMatrices, this.style]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, active * a.itemSize);
        a.needsUpdate = true;
      }
    return active;
  }
  dispose() {
    for (const d of [...this.staticDraws, ...this.movingDraws]) {
      d.geometry.dispose();
      d.material.dispose();
    }
    this.root.clear();
  }
}

/** Independent player/export surface. It owns no document, editor, selection or history state. */
export async function createBuildAnimationView(
  timeline: BuildTimeline,
  instances: ReadonlyMap<string, PartInstance>,
  colors: readonly ColorDef[],
  options: BuildAnimationViewOptions,
) {
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: options.preferWebGPU === false });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(options.width, options.height, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  // Composite the theme color outside the tone mapper, as the editor viewport does.
  // This also keeps an exported white background exactly white.
  renderer.setClearColor(0, 0);
  renderer.domElement.style.backgroundColor = options.background ?? viewportColors['viewport-bottom'];
  const scene = new Scene(),
    root = createLdrawRoot();
  scene.add(root);
  scene.add(new HemisphereLight(viewportColors['light-sky'], viewportColors['light-ground'], 2));
  const key = new DirectionalLight(viewportColors['light-key'], 3.5);
  key.position.set(-150, 250, 200);
  const fill = new DirectionalLight(viewportColors['light-fill'], 1);
  fill.position.set(200, 80, -150);
  scene.add(key, fill);
  const grouped = new Map<string, AnimationPart[]>();
  timeline.parts.forEach((p) => {
    const key = `${p.partId}/${p.colorId}`,
      list = grouped.get(key) ?? [];
    list.push(p);
    grouped.set(key, list);
  });
  const batches = [...grouped.values()].map(
    (parts) => new AnimationBatch(parts, instances.get(parts[0]!.path.join('/'))!, colors),
  );
  batches.forEach((b) => root.add(b.root));
  const { min, max } = timeline.bounds;
  const target = new Vector3((min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2);
  const radius = Math.max(30, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const saved = options.camera,
    position = new Vector3();
  let fixed = false,
    fov = 35;
  let camera: PerspectiveCamera | OrthographicCamera = new PerspectiveCamera();
  let width = options.width,
    height = options.height;
  const setProjection = () => {
    fixed = options.cameraMode === 'fixed' && !!saved;
    fov = fixed ? saved!.fov : 35;
    camera = fixed && saved!.mode === 'ortho' ? new OrthographicCamera() : new PerspectiveCamera(fov);
    if (fixed) {
      target.set(saved!.target[0], -saved!.target[1], -saved!.target[2]);
      position.set(saved!.position[0], -saved!.position[1], -saved!.position[2]).sub(target);
      camera.up.set(saved!.up[0], -saved!.up[1], -saved!.up[2]);
    } else {
      const frame = fitAnimationOrbit(timeline, options.overlay !== false, width / height);
      target.copy(frame.target);
      position.copy(frame.direction).multiplyScalar(frame.distance);
    }
    if (camera instanceof PerspectiveCamera) camera.aspect = width / height;
    else {
      const span = saved?.span ?? radius * 2.4;
      camera.top = span / 2;
      camera.bottom = -span / 2;
      camera.left = (-span * width) / height / 2;
      camera.right = -camera.left;
    }
    camera.near = Math.max(0.1, position.length() / 1000);
    camera.far = Math.max(10000, position.length() + radius * 10);
    camera.updateProjectionMatrix();
  };
  setProjection();
  // A broad ambient contact shadow stays soft at all export resolutions, without a per-frame shadow-map pass.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext('2d')!,
    gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,0.38)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const shadowTexture = new CanvasTexture(shadowCanvas),
    shadowMaterial = new MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false });
  const shadowGeometry = new PlaneGeometry(
    Math.max(60, (max[0] - min[0]) * 1.6),
    Math.max(60, (max[2] - min[2]) * 1.6),
  );
  const shadow = new Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set((min[0] + max[0]) / 2, -max[1] - 0.5, -(min[2] + max[2]) / 2);
  scene.add(shadow);
  let disposed = false;
  const metrics = {
    frames: 0,
    moving: 0,
    renderMs: 0,
    backend: 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2',
  };
  return {
    canvas: renderer.domElement,
    metrics,
    getCamera(): Workspace['camera'] & { span: number; near: number; far: number } {
      return {
        mode: camera instanceof PerspectiveCamera ? 'perspective' : 'ortho',
        position: [camera.position.x, -camera.position.y, -camera.position.z],
        target: [target.x, -target.y, -target.z],
        up: [camera.up.x, -camera.up.y, -camera.up.z],
        fov: camera instanceof PerspectiveCamera ? camera.fov : fov,
        span: camera instanceof OrthographicCamera ? camera.top - camera.bottom : 0,
        near: camera.near,
        far: camera.far,
      };
    },
    render(time: number) {
      if (disposed) return;
      const started = performance.now();
      metrics.moving = batches.reduce(
        (sum, b) => sum + b.update(time, !!options.dimCompleted && time < timeline.buildDuration),
        0,
      );
      const angle = fixed ? Math.max(0, animationOrbit(timeline, time) - Math.PI / 2) : animationOrbit(timeline, time);
      camera.position
        .copy(position)
        .applyAxisAngle(new Vector3(0, 1, 0), angle)
        .add(target);
      camera.lookAt(target);
      shadowMaterial.opacity = Math.min(1, Math.max(0, (time - 0.12) / 0.6));
      renderer.render(scene, camera);
      metrics.frames++;
      metrics.renderMs = performance.now() - started;
    },
    resize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
      renderer.setSize(width, height, false);
      setProjection();
    },
    setOptions(next: Pick<BuildAnimationViewOptions, 'cameraMode' | 'dimCompleted' | 'overlay'>) {
      const reframe =
        (next.cameraMode !== undefined && next.cameraMode !== options.cameraMode) ||
        (next.overlay !== undefined && next.overlay !== options.overlay);
      options = { ...options, ...next };
      if (reframe) setProjection();
    },
    setBackground(value: string) {
      renderer.domElement.style.backgroundColor = value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      batches.forEach((b) => b.dispose());
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      shadowTexture.dispose();
      void renderer.dispose();
    },
  };
}
export type BuildAnimationView = Awaited<ReturnType<typeof createBuildAnimationView>>;
