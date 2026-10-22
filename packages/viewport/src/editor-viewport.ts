import {
  Box3,
  Color,
  Group,
  Line,
  Matrix4,
  Mesh,
  Object3D,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  RenderPipeline,
  LineSegments,
  MeshBasicMaterial,
} from 'three/webgpu';
import type { Camera, OrthographicCamera, PerspectiveCamera, WebGPURenderer } from 'three/webgpu';
import { pass, uniform, vec2, vec3, vec4, max, clamp, mix, screenUV } from 'three/tsl';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BrkDocument, InstancePath, Vec3, Workspace } from '@brickloop/core';
import type { ColorDef } from '@brickloop/catalog';
import type { PartMesh } from '@brickloop/ldraw';
import { DocumentProjection } from './document-projection';
import type { EdgeMode } from './document-projection';
import { createPartInstances } from './parts';
import type { PartInstance } from './parts';
import { createLdrawRoot, ldrawToWorld } from './coordinates';
import { disposeObjects } from './scene-content';
import { snap } from './editing-math';
import { themeColor, reviewColors } from './theme';
import { ConnectorLayer, colliderGeometry } from './connector-layer';
import type { ConnectorMarker } from './connector-layer';
import type { ColliderShape } from '@brickloop/collide';
import type { SnapPointer } from '@brickloop/connect';
import { BoundsOverlay } from './bounds-overlay';
import { ReviewLayer } from './review-layer';
import type { ReviewOverlay } from './review-layer';
import { TaskPreviewLayer } from './task-preview-layer';
import { boundsCorners } from './framing';
import type { TaskPreview } from './task-preview-layer';

export interface PointerModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}
export interface EditorEvents {
  click(path: InstancePath | null, modifiers: PointerModifiers): void;
  enter(path: InstancePath): void;
  box(paths: InstancePath[], modifiers: PointerModifiers, contains: boolean): void;
  place(transform: number[], continuous: boolean): void;
  dragStart(): void;
  dragPreview(delta: number[], fallback?: number[], modifiers?: PointerModifiers, pointer?: SnapPointer): void;
  dragEnd(cancel: boolean): void;
  context(path: InstancePath | null, x: number, y: number): void;
  placementPreview?(
    raw: number[],
    fallback: number[],
    modifiers: PointerModifiers,
    pointer: SnapPointer,
  ): Promise<number[] | null>;
  supportPlane?(path: InstancePath): number | undefined;
  connectorClick?(marker: ConnectorMarker): boolean;
}
export interface EditorSettings {
  tool: 'select' | 'move' | 'rotate';
  space: 'world' | 'primaryLocal';
  horizontal: number;
  vertical: number;
  angle: number;
  pivot: Vec3 | null;
  primaryMatrix: number[] | null;
}
export interface PlacementPreview {
  partId: string;
  mesh: PartMesh;
  color: ColorDef;
  rotation: number[];
  parts?: PartInstance[];
  bounds?: readonly [number, number, number, number, number, number];
}
export interface EditorViewport {
  setTaskPreview(preview: TaskPreview | null): void;
  setReview(overlay: ReviewOverlay | null): void;
  fitReviewGhost(index: number): void;
  setEdgeMode(mode: EdgeMode): void;
  registerPart(id: string, mesh: PartMesh): void;
  syncDocument(doc: BrkDocument, workspace: Workspace, colors: readonly ColorDef[]): void;
  setEditorSettings(settings: EditorSettings): void;
  setEditorEvents(events: EditorEvents): void;
  setPlacement(preview: PlacementPreview | null): void;
  movePlacementPointer(x: number, y: number): void;
  placementPosition(): Vec3;
  cancelGesture(): void;
  cameraForward(): Vec3;
  selectionBounds(paths?: InstancePath[]): [number, number, number, number, number, number] | null;
  fitSelection(paths: InstancePath[]): void;
  projectPoint(point: Vec3): { x: number; y: number };
  metrics(): DocumentProjection['stats'] & {
    frames: number[];
    renderMs: number;
    drawCalls: number;
    triangles: number;
    lines: number;
    gpuBytes: number;
  };
  handlePoints(): { axis: string; x: number; y: number }[];
  setConnectors(markers: readonly ConnectorMarker[], transient?: readonly ConnectorMarker[]): void;
  setCollisions(hit: InstancePath[], unknown: InstancePath[], previewHit?: boolean): void;
  setColliderShapes(shapes: readonly ColliderShape[]): void;
}
const flip = new Matrix4().makeRotationX(Math.PI);
flip.set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
const modifiers = (event: MouseEvent): PointerModifiers => ({
  ctrl: event.ctrlKey,
  shift: event.shiftKey,
  alt: event.altKey,
});
function matrixToLDraw(matrix: Matrix4): number[] {
  const e = matrix.elements;
  return [e[12]!, e[13]!, e[14]!, e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!];
}
export function createEditorViewport(input: {
  canvas: HTMLCanvasElement;
  surface: HTMLElement;
  content: Group;
  scene: Scene;
  renderer: WebGPURenderer;
  camera(): PerspectiveCamera | OrthographicCamera;
  controls(): OrbitControls;
  requestRender(): void;
  fitBounds(bounds: Box3): void;
}) {
  const { canvas, surface, content, scene, renderer, requestRender } = input;
  const projection = new DocumentProjection();
  const review = new ReviewLayer(projection);
  const taskPreview = new TaskPreviewLayer(projection);
  let previewCamera:
    | { camera: PerspectiveCamera | OrthographicCamera; position: Vector3; rotation: Quaternion; zoom: number }
    | undefined;
  let previewCameraMoved = false;
  function frameTaskPreview(preview: TaskPreview | null) {
    if (!preview) {
      previewCamera = undefined;
      previewCameraMoved = false;
      return;
    }
    // An empty document has a brick-sized initial frame. A growing working copy
    // can surround that camera with blue, double-sided preview faces.
    if (projection.rows.length || !preview.parts.length || previewCameraMoved) return;
    const camera = input.camera();
    if (
      previewCamera &&
      (previewCamera.camera !== camera ||
        !previewCamera.position.equals(camera.position) ||
        !previewCamera.rotation.equals(camera.quaternion) ||
        previewCamera.zoom !== camera.zoom)
    ) {
      // Keep a designer's deliberate pan, orbit or zoom across subsequent rounds.
      previewCameraMoved = true;
      return;
    }
    camera.updateMatrixWorld();
    taskPreview.root.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(taskPreview.root);
    if (
      !bounds.isEmpty() &&
      boundsCorners(bounds).some((corner) => {
        const p = corner.project(camera);
        return Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9 || Math.abs(p.z) > 1;
      })
    )
      input.fitBounds(bounds);
    previewCamera = {
      camera,
      position: camera.position.clone(),
      rotation: camera.quaternion.clone(),
      zoom: camera.zoom,
    };
  }
  content.add(taskPreview.root);
  content.add(review.root);
  Object.assign(surface.dataset, {
    reviewAdded: '0',
    reviewChanged: '0',
    reviewMoved: '0',
    reviewGhosts: '0',
    reviewBoxGhosts: '0',
    reviewUpdates: '0',
  });
  const connectors = new ConnectorLayer();
  const snapHighlights = new ConnectorLayer();
  let lastMarkers: readonly ConnectorMarker[] | undefined;
  let persistentHighlights: ConnectorMarker[] = [];
  const unknownBoxes = new BoundsOverlay();
  const colliderLayer = new Group();
  content.add(connectors.root, snapHighlights.root, unknownBoxes.root, colliderLayer);
  let lastDocument: { doc: BrkDocument; workspace: Workspace; colors: readonly ColorDef[] } | undefined;
  content.add(projection.root);
  const maskScene = new Scene();
  maskScene.background = new Color(0);
  const maskRoot = createLdrawRoot();
  maskRoot.add(projection.maskRoot);
  maskScene.add(maskRoot);
  const scenePass = pass(scene, input.camera());
  const maskPass = pass(maskScene, input.camera());
  const mask = maskPass.getTextureNode();
  const pixel = uniform(new Vector2(1, 1));
  const uv = screenUV;
  // A full-resolution silhouette mask dilated in CSS pixels, independent of zoom and DPR.
  let selected = mask.r,
    primary = mask.g,
    hover = mask.b;
  for (const [x, y] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.707, 0.707],
    [-0.707, 0.707],
    [0.707, -0.707],
    [-0.707, -0.707],
  ]) {
    const direction = vec2(x!, y!).mul(pixel);
    selected = max(selected, mask.sample(uv.add(direction.mul(2))).r);
    primary = max(primary, mask.sample(uv.add(direction.mul(3))).g);
    hover = max(hover, mask.sample(uv.add(direction)).b);
  }
  const interior = max(mask.r, max(mask.g, mask.b));
  const selectionEdge = clamp(selected.sub(interior), 0, 1);
  const primaryEdge = clamp(primary.sub(interior), 0, 1);
  const hoverEdge = clamp(hover.sub(interior), 0, 1).mul(0.5);
  const accent = uniform(new Color(themeColor(surface, 'accent')));
  const bright = uniform(new Color(themeColor(surface, 'accent-hover')));
  const output = mix(mix(mix(scenePass.rgb, vec3(1), hoverEdge), accent, selectionEdge), bright, primaryEdge);
  const pipeline = new RenderPipeline(
    renderer,
    vec4(output, max(scenePass.a, max(selectionEdge, max(primaryEdge, hoverEdge)))),
  );
  const reviewMaskScene = new Scene();
  reviewMaskScene.background = new Color(0);
  const reviewMaskRoot = createLdrawRoot();
  reviewMaskRoot.add(review.maskRoot);
  reviewMaskScene.add(reviewMaskRoot);
  const reviewMaskPass = pass(reviewMaskScene, input.camera());
  const reviewMask = reviewMaskPass.getTextureNode();
  let reviewAdded = reviewMask.r,
    reviewChanged = reviewMask.g,
    reviewMoved = reviewMask.b;
  let reviewHalo = max(reviewMask.r, max(reviewMask.g, reviewMask.b));
  for (const [x, y] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.707, 0.707],
    [-0.707, 0.707],
    [0.707, -0.707],
    [-0.707, -0.707],
  ]) {
    const direction = vec2(x!, y!).mul(pixel);
    const inner = reviewMask.sample(uv.add(direction.mul(2.2)));
    const outer = reviewMask.sample(uv.add(direction.mul(4.2)));
    const halo = reviewMask.sample(uv.add(direction.mul(5.2)));
    const innerHalo = reviewMask.sample(uv.add(direction.mul(3.2)));
    reviewAdded = max(reviewAdded, inner.r);
    reviewChanged = max(reviewChanged, inner.g);
    reviewMoved = max(reviewMoved, outer.b);
    reviewHalo = max(reviewHalo, max(innerHalo.r, max(innerHalo.g, halo.b)));
  }
  const reviewInterior = max(reviewMask.r, max(reviewMask.g, reviewMask.b));
  const addedEdge = clamp(reviewAdded.sub(reviewInterior), 0, 1);
  const changedEdge = clamp(reviewChanged.sub(reviewInterior), 0, 1);
  const movedEdge = clamp(reviewMoved.sub(reviewInterior), 0, 1);
  const haloEdge = clamp(reviewHalo.sub(reviewInterior), 0, 1).mul(0.55);
  const reviewed = mix(
    mix(
      mix(mix(scenePass.rgb, vec3(0.015), haloEdge), uniform(new Color(reviewColors.movedFrom)), movedEdge),
      uniform(new Color(reviewColors.added)),
      addedEdge,
    ),
    uniform(new Color(reviewColors.changed)),
    changedEdge,
  );
  // Selection is composited last and selected paths are removed from the review mask.
  const reviewedOutput = mix(mix(mix(reviewed, vec3(1), hoverEdge), accent, selectionEdge), bright, primaryEdge);
  const reviewPipeline = new RenderPipeline(
    renderer,
    vec4(reviewedOutput, max(scenePass.a, max(reviewHalo, max(selectionEdge, max(primaryEdge, hoverEdge))))),
  );
  const dummy = new Object3D();
  scene.add(dummy);
  const transform = new TransformControls(input.camera(), canvas);
  transform.setSize(1.05);
  transform.setColors(
    themeColor(surface, 'axis-x'),
    themeColor(surface, 'axis-y'),
    themeColor(surface, 'axis-z'),
    themeColor(surface, 'accent'),
  );
  transform.showE = false;
  transform.showXYZE = false;
  const helper = transform.getHelper();
  scene.add(helper);
  helper.visible = false;
  let settings: EditorSettings = {
    tool: 'select',
    space: 'world',
    horizontal: 20,
    vertical: 8,
    angle: 90,
    pivot: null,
    primaryMatrix: null,
  };
  let events: EditorEvents | undefined;
  let workspace: Workspace | undefined;
  let preview: PlacementPreview | null = null;
  const ghost = new Group();
  content.add(ghost);
  let ghostMatrix = new Matrix4();
  const pointer = new Vector2(surface.clientWidth / 2, surface.clientHeight / 2);
  const dragBase = new Matrix4(),
    dragPosition = new Vector3();
  let dragging = false,
    canceled = false,
    updating = false;
  let down: { x: number; y: number; button: number; modifiers: PointerModifiers } | null = null;
  const marquee = document.createElement('div');
  marquee.className = 'selection-marquee';
  marquee.hidden = true;
  surface.append(marquee);
  const raycaster = new Raycaster();
  const frames: number[] = [];
  const renderStats = { renderMs: 0, drawCalls: 0, triangles: 0, lines: 0, gpuBytes: 0 };
  let lastFrame = 0;
  let currentModifiers: PointerModifiers = { ctrl: false, shift: false, alt: false };
  let previewTicket = 0;
  let previewPending: Promise<void> = Promise.resolve();
  const tooltip = document.createElement('div');
  tooltip.className = 'connector-tooltip';
  tooltip.hidden = true;
  surface.append(tooltip);

  function snapPointer(): SnapPointer {
    const cast = ray();
    const camera = input.camera();
    const units =
      'isOrthographicCamera' in camera
        ? (camera.top - camera.bottom) / camera.zoom / surface.clientHeight
        : (2 * camera.position.distanceTo(input.controls().target) * Math.tan((camera.fov * Math.PI) / 360)) /
          surface.clientHeight;
    return { ray: { origin: cast.origin.toArray(), direction: cast.direction.toArray() }, worldUnitsPerPixel: units };
  }

  function ray() {
    const camera = input.camera();
    camera.updateMatrixWorld();
    raycaster.setFromCamera(
      new Vector2((pointer.x / surface.clientWidth) * 2 - 1, 1 - (pointer.y / surface.clientHeight) * 2),
      camera,
    );
    return raycaster.ray.clone().applyMatrix4(flip);
  }
  function setPointer(event: MouseEvent) {
    currentModifiers = modifiers(event);
    const rect = canvas.getBoundingClientRect();
    pointer.set(event.clientX - rect.left, event.clientY - rect.top);
  }
  function updateGhost() {
    if (!preview) return;
    const cast = ray();
    const target = projection.pick(cast, false);
    const top = target ? (events?.supportPlane?.(target.path) ?? target.bounds.min.y) : 0;
    const point = cast.intersectPlane(new Plane(new Vector3(0, 1, 0), -top), new Vector3());
    if (!point) return;
    const rotation = new Matrix4().fromArray(preview.rotation);
    const [x, y, z, a, b, c] = preview.bounds ?? preview.mesh.bboxLdu;
    const bounds = new Box3(new Vector3(x, y, z), new Vector3(a, b, c)).applyMatrix4(rotation);
    // LDraw -Y is up. Round toward the free side of the support so studs never penetrate it.
    const height = Math.floor((top - bounds.max.y) / settings.vertical) * settings.vertical;
    ghostMatrix = rotation.setPosition(snap(point.x, settings.horizontal), height, snap(point.z, settings.horizontal));
    ghost.matrix.copy(ghostMatrix);
    ghost.matrixAutoUpdate = false;
    const raw = rotation.clone().setPosition(point.x, top - bounds.max.y, point.z);
    const ticket = ++previewTicket;
    if (events?.placementPreview) {
      const solving = events.placementPreview(
        raw.elements,
        ghostMatrix.elements.slice(),
        currentModifiers,
        snapPointer(),
      );
      surface.dataset.snapPending = 'true';
      previewPending = solving
        .then((result) => {
          if (ticket !== previewTicket || !preview) return;
          if (result) {
            ghostMatrix = new Matrix4().fromArray(result);
            ghost.matrix.copy(ghostMatrix);
          }
          surface.dataset.snapPending = 'false';
          requestRender();
        })
        .catch(() => {
          if (ticket === previewTicket) surface.dataset.snapPending = 'false';
        });
    }
    requestRender();
  }
  function updateHandle() {
    if (dragging) return;
    if (!settings.pivot || settings.tool === 'select' || preview) {
      transform.detach();
      helper.visible = false;
      return;
    }
    dummy.position.copy(ldrawToWorld({ x: settings.pivot[0], y: settings.pivot[1], z: settings.pivot[2] }));
    dummy.quaternion.identity();
    if (settings.space === 'primaryLocal' && settings.primaryMatrix) {
      const world = flip.clone().multiply(new Matrix4().fromArray(settings.primaryMatrix));
      world.decompose(new Vector3(), dummy.quaternion, new Vector3());
    }
    dummy.updateMatrixWorld();
    transform.setMode(settings.tool === 'move' ? 'translate' : 'rotate');
    transform.setSpace(settings.space === 'world' ? 'world' : 'local');
    transform.setRotationSnap(settings.angle ? (settings.angle * Math.PI) / 180 : null);
    transform.attach(dummy);
    helper.visible = true;
  }
  transform.addEventListener('mouseDown', () => {
    if (!events) return;
    dragging = true;
    canceled = false;
    input.controls().enabled = false;
    dummy.updateMatrixWorld();
    dragBase.copy(dummy.matrixWorld);
    dragPosition.copy(dummy.position);
    events.dragStart();
  });
  transform.addEventListener('objectChange', () => {
    if (!dragging || canceled || updating) return;
    updating = true;
    dummy.updateMatrixWorld();
    const raw = flip.clone().multiply(dummy.matrixWorld).multiply(dragBase.clone().invert()).multiply(flip);
    if (settings.tool === 'move') {
      const delta = dummy.position.clone().sub(dragPosition);
      if (settings.space === 'primaryLocal')
        delta.applyQuaternion(new Quaternion().setFromRotationMatrix(dragBase).invert());
      delta.set(
        snap(delta.x, settings.horizontal),
        snap(delta.y, settings.vertical),
        snap(delta.z, settings.horizontal),
      );
      if (settings.space === 'primaryLocal') delta.applyQuaternion(new Quaternion().setFromRotationMatrix(dragBase));
      dummy.position.copy(dragPosition).add(delta);
    }
    dummy.updateMatrixWorld();
    const delta = flip.clone().multiply(dummy.matrixWorld).multiply(dragBase.clone().invert()).multiply(flip);
    events?.dragPreview(raw.elements, delta.elements, currentModifiers, snapPointer());
    updating = false;
    requestRender();
  });
  transform.addEventListener('mouseUp', () => {
    if (dragging) events?.dragEnd(canceled);
    dragging = false;
    input.controls().enabled = true;
    updateHandle();
    requestRender();
  });
  transform.addEventListener('change', requestRender);

  function pointerDown(event: PointerEvent) {
    transform.camera = input.camera();
    setPointer(event);
    const marker = snapHighlights.pick(ray()) ?? connectors.pick(ray());
    if (event.button === 0 && marker && events?.connectorClick?.(marker)) {
      event.stopImmediatePropagation();
      down = null;
      return;
    }
    if (event.button === 0 && (!event.altKey || preview)) {
      input.controls().enabled = false;
      canvas.setPointerCapture(event.pointerId);
      if (!transform.axis && !dragging) down = { x: pointer.x, y: pointer.y, button: 0, modifiers: modifiers(event) };
    } else down = { x: pointer.x, y: pointer.y, button: event.button, modifiers: modifiers(event) };
  }
  function pointerMove(event: PointerEvent) {
    setPointer(event);
    const marker = snapHighlights.pick(ray()) ?? connectors.pick(ray());
    tooltip.hidden = !marker;
    if (marker) {
      tooltip.textContent = marker.label;
      tooltip.style.left = `${Math.min(pointer.x + 12, surface.clientWidth - 260)}px`;
      tooltip.style.top = `${pointer.y + 16}px`;
    }
    if (dragging) return;
    if (preview) {
      updateGhost();
      return;
    }
    if (down?.button === 0 && !down.modifiers.alt && pointer.distanceTo(new Vector2(down.x, down.y)) > 4) {
      marquee.hidden = false;
      Object.assign(marquee.style, {
        left: `${Math.min(down.x, pointer.x)}px`,
        top: `${Math.min(down.y, pointer.y)}px`,
        width: `${Math.abs(down.x - pointer.x)}px`,
        height: `${Math.abs(down.y - pointer.y)}px`,
      });
      marquee.dataset.contains = String(pointer.x >= down.x);
      return;
    }
    if (!down && !transform.axis) {
      const hit = projection.pick(ray());
      const path = hit?.path.slice(0, (workspace?.activeModelPath.length ?? 0) + 1) ?? null;
      if (surface.dataset.hoverPath !== (path?.join('/') ?? '')) {
        surface.dataset.hoverPath = path?.join('/') ?? '';
        projection.highlight(workspace?.selection ?? [], workspace?.selection.at(-1), path);
        requestRender();
      }
    }
  }
  function projectedBox(bounds: Box3) {
    const points: Vector2[] = [];
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const p = new Vector3(x, y, z).applyMatrix4(flip).project(input.camera());
          if (p.z < -1 || p.z > 1) continue;
          points.push(new Vector2(((p.x + 1) * surface.clientWidth) / 2, ((1 - p.y) * surface.clientHeight) / 2));
        }
    return points.length
      ? {
          minX: Math.min(...points.map((p) => p.x)),
          maxX: Math.max(...points.map((p) => p.x)),
          minY: Math.min(...points.map((p) => p.y)),
          maxY: Math.max(...points.map((p) => p.y)),
        }
      : null;
  }
  function pointerUp(event: PointerEvent) {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    setPointer(event);
    input.controls().enabled = true;
    if (!down || dragging) {
      down = null;
      return;
    }
    const start = down;
    down = null;
    const distance = pointer.distanceTo(new Vector2(start.x, start.y));
    if (start.modifiers.alt && !preview) {
      if (distance < 4 && start.button === 0) {
        const path = projection.pick(ray())?.path;
        if (path) events?.enter(path);
      }
      return;
    }
    if (start.button === 2 && distance < 4) {
      events?.context(projection.pick(ray())?.path ?? null, event.clientX, event.clientY);
      return;
    }
    if (start.button !== 0) return;
    if (preview) {
      const current = preview;
      void previewPending.then(() => {
        if (preview === current) events?.place(matrixToLDraw(ghostMatrix), event.shiftKey);
      });
      return;
    }
    if (!marquee.hidden) {
      marquee.hidden = true;
      const contains = pointer.x >= start.x;
      const loX = Math.min(start.x, pointer.x),
        hiX = Math.max(start.x, pointer.x),
        loY = Math.min(start.y, pointer.y),
        hiY = Math.max(start.y, pointer.y);
      // Aggregate occurrence bounds before testing containment, so a submodel is selected as a whole.
      const boxes = new Map<string, { path: InstancePath; bounds: Box3 }>();
      for (const row of projection.rows)
        if (row.visible && row.editable) {
          const path = row.path.slice(0, (workspace?.activeModelPath.length ?? 0) + 1),
            key = path.join('/');
          const entry = boxes.get(key) ?? { path, bounds: new Box3() };
          entry.bounds.union(row.bounds);
          boxes.set(key, entry);
        }
      const paths = [...boxes.values()]
        .filter((entry) => {
          const b = projectedBox(entry.bounds);
          return (
            b &&
            (contains
              ? b.minX >= loX && b.maxX <= hiX && b.minY >= loY && b.maxY <= hiY
              : b.maxX >= loX && b.minX <= hiX && b.maxY >= loY && b.minY <= hiY)
          );
        })
        .map((entry) => entry.path);
      events?.box(paths, modifiers(event), contains);
    } else if (distance < 4) events?.click(projection.pick(ray())?.path ?? null, modifiers(event));
    requestRender();
  }
  function doubleClick(event: MouseEvent) {
    if (!preview && event.button === 0) {
      setPointer(event);
      const hit = projection.pick(ray());
      if (hit) events?.enter(hit.path);
    }
  }
  function contextMenu(event: Event) {
    event.preventDefault();
  }
  canvas.addEventListener('pointerdown', pointerDown, true);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('dblclick', doubleClick);
  canvas.addEventListener('contextmenu', contextMenu);

  const api: EditorViewport = {
    setEdgeMode(mode) {
      projection.edgeMode = mode;
      requestRender();
    },
    setConnectors(markers, transient = []) {
      if (markers !== lastMarkers) {
        lastMarkers = markers;
        connectors.set(markers.filter((marker) => !marker.highlight));
        persistentHighlights = markers.filter((marker) => marker.highlight);
      }
      snapHighlights.set([...persistentHighlights, ...transient]);
      surface.dataset.connectorCount = String(markers.length + transient.length);
      requestRender();
    },
    setColliderShapes(shapes) {
      disposeObjects(colliderLayer);
      for (const shape of shapes)
        colliderLayer.add(
          new Mesh(
            colliderGeometry(shape),
            new MeshBasicMaterial({
              color: '#3dd68c',
              wireframe: true,
              transparent: true,
              opacity: 0.5,
              depthWrite: false,
            }),
          ),
        );
      requestRender();
    },
    setCollisions(hit, unknown, previewHit = false) {
      const next = new Set(hit.map((path) => path.join('/')));
      const changed =
        next.size !== projection.collisionPaths.size || [...next].some((key) => !projection.collisionPaths.has(key));
      if (projection.previewing) projection.previewCollisions(hit);
      else {
        projection.collisionPaths = next;
        if (changed && lastDocument) projection.sync(lastDocument.doc, lastDocument.workspace, lastDocument.colors);
      }
      const boxes: Box3[] = [];
      for (const path of unknown) {
        const bounds =
          path[0] === '$preview' && preview
            ? new Box3(
                new Vector3(...(preview.mesh.bboxLdu.slice(0, 3) as [number, number, number])),
                new Vector3(...(preview.mesh.bboxLdu.slice(3) as [number, number, number])),
              ).applyMatrix4(ghostMatrix)
            : projection.bounds([path]);
        if (bounds.isEmpty()) continue;
        boxes.push(bounds);
      }
      unknownBoxes.set(boxes);
      ghost.traverse((object) => {
        if (object instanceof Mesh || object instanceof LineSegments) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            if ('color' in material && material.color instanceof Color) {
              if (typeof material.userData.previewColor !== 'number')
                material.userData.previewColor = material.color.getHex();
              material.color.set(previewHit ? '#f0616d' : Number(material.userData.previewColor));
            }
          }
        }
      });
      surface.dataset.collisionCount = String(hit.length + (previewHit ? 1 : 0));
      surface.dataset.unknownCount = String(unknown.length);
      requestRender();
    },
    setReview(overlay) {
      review.set(overlay);
      surface.dataset.reviewAdded = String(overlay?.visible ? overlay.added.length : 0);
      surface.dataset.reviewChanged = String(overlay?.visible ? overlay.changed.length : 0);
      surface.dataset.reviewMoved = String(overlay?.visible ? overlay.moved.length : 0);
      surface.dataset.reviewGhosts = String(overlay?.visible ? overlay.ghosts.length : 0);
      surface.dataset.reviewBoxGhosts = String(overlay?.visible ? review.boxGhosts : 0);
      surface.dataset.reviewUpdates = String(review.updates);
      requestRender();
    },
    setTaskPreview(preview) {
      taskPreview.set(preview);
      frameTaskPreview(preview);
      surface.dataset.taskPreviewParts = String(preview?.parts.length ?? 0);
      surface.dataset.taskPreviewRemoved = String(preview?.removed.length ?? 0);
      surface.dataset.taskPreviewUpdates = String(taskPreview.updates);
      requestRender();
    },
    fitReviewGhost(index) {
      const bounds = review.fitGhost(index);
      if (bounds) input.fitBounds(bounds.applyMatrix4(flip));
    },
    registerPart: (id, mesh) => projection.register(id, mesh),
    syncDocument(doc, state, colors) {
      if (lastDocument?.doc.documentId !== doc.documentId) {
        previewCamera = undefined;
        previewCameraMoved = false;
      }
      lastDocument = { doc, workspace: state, colors };
      workspace = state;
      const previousRows = projection.rows;
      projection.sync(doc, state, colors);
      review.setSelection(state.selection);
      if (previousRows !== projection.rows) {
        surface.dataset.partCount = String(projection.rows.length);
        surface.dataset.loadedPartCount = String(projection.loadedCount);
        surface.dataset.stepVisibleCount = String(projection.rows.filter((row) => row.visible).length);
        surface.dataset.stepDimmedCount = String(projection.rows.filter((row) => row.visible && row.dimmed).length);
      }
      surface.dataset.selectedCount = String(state.selection.length);
      surface.dataset.hiddenCount = String(state.hidden.length);
      requestRender();
    },
    setEditorSettings(next) {
      settings = next;
      updateHandle();
      updateGhost();
      requestRender();
    },
    setEditorEvents(next) {
      events = next;
    },
    setPlacement(next) {
      if (!next) previewTicket++;
      const rebuild = next?.mesh !== preview?.mesh || next?.color !== preview?.color || next?.parts !== preview?.parts;
      preview = next;
      if (rebuild || !next) disposeObjects(ghost);
      if (next && rebuild)
        ghost.add(
          createPartInstances(
            next.parts ?? [
              { partId: next.partId as `ld:${string}`, mesh: next.mesh, color: { ...next.color, alpha: 0.42 } },
            ],
          ),
        );
      ghost.visible = !!next;
      surface.dataset.placing = String(!!next);
      updateGhost();
      updateHandle();
      requestRender();
    },
    movePlacementPointer(x, y) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(x - rect.left, y - rect.top);
      updateGhost();
    },
    placementPosition() {
      const cast = ray();
      const target = projection.pick(cast, false);
      const top = target ? (events?.supportPlane?.(target.path) ?? target.bounds.min.y) : 0;
      const point = cast.intersectPlane(new Plane(new Vector3(0, 1, 0), -top), new Vector3()) ?? new Vector3();
      return [snap(point.x, settings.horizontal), snap(top, settings.vertical), snap(point.z, settings.horizontal)];
    },
    cancelGesture() {
      down = null;
      marquee.hidden = true;
      if (dragging) {
        canceled = true;
        transform.reset();
        events?.dragEnd(true);
        dragging = false;
        transform.dragging = false;
        input.controls().enabled = true;
        updateHandle();
        requestRender();
      }
    },
    cameraForward() {
      const camera = input.camera();
      const direction = camera.getWorldDirection(new Vector3());
      if (Math.hypot(direction.x, direction.z) < 1e-6) direction.set(0, 1, 0).applyQuaternion(camera.quaternion);
      return [direction.x, -direction.y, -direction.z];
    },
    selectionBounds(paths) {
      const bounds = projection.bounds(paths);
      return bounds.isEmpty()
        ? null
        : ([...bounds.min.toArray(), ...bounds.max.toArray()] as [number, number, number, number, number, number]);
    },
    fitSelection(paths) {
      const bounds = projection.bounds(paths);
      if (!bounds.isEmpty()) input.fitBounds(bounds.applyMatrix4(flip));
    },
    projectPoint(point) {
      input.camera().updateMatrixWorld();
      const p = new Vector3(...point).applyMatrix4(flip).project(input.camera());
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) * rect.width) / 2, y: rect.top + ((1 - p.y) * rect.height) / 2 };
    },
    metrics: () => ({ ...projection.stats, ...renderStats, frames: [...frames] }),
    handlePoints() {
      transform.camera = input.camera();
      helper.updateMatrixWorld(true);
      const points: { axis: string; x: number; y: number }[] = [];
      helper.traverseVisible((object) => {
        if (
          !(object instanceof Mesh || object instanceof Line) ||
          !['X', 'Y', 'Z', 'XY', 'YZ', 'XZ'].includes(object.name)
        )
          return;
        object.geometry.computeBoundingBox();
        const point =
          object instanceof Line
            ? new Vector3()
                .fromBufferAttribute(
                  object.geometry.getAttribute('position'),
                  Math.floor(object.geometry.getAttribute('position').count / 4),
                )
                .applyMatrix4(object.matrixWorld)
                .project(input.camera())
            : object.geometry.boundingBox
                ?.getCenter(new Vector3())
                .applyMatrix4(object.matrixWorld)
                .project(input.camera());
        const rect = canvas.getBoundingClientRect();
        if (point)
          points.push({
            axis: object.name,
            x: rect.left + ((point.x + 1) * rect.width) / 2,
            y: rect.top + ((1 - point.y) * rect.height) / 2,
          });
      });
      return points;
    },
  };
  return {
    api,
    capture() {
      const visible = helper.visible,
        placing = ghost.visible;
      helper.visible = false;
      ghost.visible = false;
      try {
        projection.prepareRender(input.camera(), renderer.domElement.height);
        renderer.render(scene, input.camera());
      } finally {
        helper.visible = visible;
        ghost.visible = placing;
      }
    },
    render() {
      const now = performance.now();
      if (lastFrame && now - lastFrame < 200) {
        frames.push(now - lastFrame);
        if (frames.length > 600) frames.shift();
      }
      lastFrame = now;
      transform.camera = input.camera() as Camera;
      scenePass.camera = input.camera();
      maskPass.camera = input.camera();
      reviewMaskPass.camera = input.camera();
      pixel.value.set(1 / surface.clientWidth, 1 / surface.clientHeight);
      helper.updateMatrixWorld(true);
      projection.prepareRender(input.camera(), surface.clientHeight);
      review.prepareRender(
        input.camera(),
        surface.clientHeight,
        input.camera().position.distanceTo(input.controls().target),
      );
      if (review.hasOutline) reviewPipeline.render();
      else if (projection.hasHighlight) pipeline.render();
      else renderer.render(scene, input.camera());
      Object.assign(renderStats, {
        renderMs: performance.now() - now,
        drawCalls: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
        lines: renderer.info.render.lines,
        gpuBytes: renderer.info.memory.total,
      });
    },
    dispose() {
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('dblclick', doubleClick);
      canvas.removeEventListener('contextmenu', contextMenu);
      transform.dispose();
      scene.remove(dummy, helper);
      projection.dispose();
      connectors.dispose();
      snapHighlights.dispose();
      unknownBoxes.dispose();
      review.dispose();
      taskPreview.dispose();
      disposeObjects(colliderLayer);
      tooltip.remove();
      disposeObjects(ghost);
      pipeline.dispose();
      reviewPipeline.dispose();
      reviewMaskPass.dispose();
      scenePass.dispose();
      maskPass.dispose();
      marquee.remove();
    },
  };
}
