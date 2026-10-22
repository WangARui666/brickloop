import {
  ACESFilmicToneMapping,
  Box3Helper,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  LineSegments,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { ColorDef } from '@brickloop/catalog';
import type { Workspace } from '@brickloop/core';
import { createLdrawRoot } from './coordinates';
import { presetFrame, fitBounds } from './framing';
import type { ViewPreset } from './framing';
import { createPartInstances } from './parts';
import type { PartInstance } from './parts';
import { disposeObjects, visibleContentBounds } from './scene-content';

/** Detached renderer; never changes the editor camera, selection, canvas or renderer state. */
export async function renderOffscreen(
  instances: readonly (PartInstance & { highlighted?: boolean })[],
  colors: readonly ColorDef[],
  options: {
    views: ViewPreset[];
    width: number;
    height: number;
    transparent: boolean;
    /** Instructions use the completed model and the smallest step-image slot for a stable scale. */
    instructionFrame?: { instances: readonly PartInstance[]; width: number; height: number };
    signal?: AbortSignal;
    outlinePixels?: number;
    /** Optional exact document-space camera for render comparisons and previews. */
    camera?: Workspace['camera'] & { near: number; far: number; span?: number };
  },
) {
  options.signal?.throwIfAborted();
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true });
  const scene = new Scene(),
    root = createLdrawRoot();
  try {
    await renderer.init();
    options.signal?.throwIfAborted();
    renderer.setPixelRatio(1);
    renderer.setSize(options.width, options.height);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.setClearColor('#ffffff', options.transparent ? 0 : 1);
    scene.add(root, new HemisphereLight('#ffffff', '#727e96', 2));
    const key = new DirectionalLight('#fff4e4', 3.5);
    key.position.set(-150, 250, 200);
    const fill = new DirectionalLight('#b7ceff', 1);
    fill.position.set(200, 80, -150);
    scene.add(key, fill);
    const content = new Group();
    const previous = createPartInstances(
      instances.filter((v) => !v.highlighted),
      colors,
    );
    const added = createPartInstances(
      instances.filter((v) => v.highlighted),
      colors,
    );
    content.add(previous, added);
    root.add(content);
    if (!options.instructionFrame)
      for (const instance of instances.filter((v) => v.highlighted)) {
        const object = createPartInstances([instance], colors);
        root.add(new Box3Helper(visibleContentBounds(object), new Color('#FF8A3D')));
        disposeObjects(object);
      }
    root.updateMatrixWorld(true);
    let bounds = visibleContentBounds(root);
    if (options.instructionFrame) {
      const complete = createLdrawRoot();
      complete.add(createPartInstances(options.instructionFrame.instances, colors));
      complete.updateMatrixWorld(true);
      bounds = visibleContentBounds(complete);
      disposeObjects(complete);
    }
    if (bounds.isEmpty()) bounds.set(new Vector3(-10, -10, -10), new Vector3(10, 10, 10));
    const camera =
      options.instructionFrame || options.camera?.mode === 'ortho'
        ? new OrthographicCamera()
        : new PerspectiveCamera(35, options.width / options.height, 0.1, 10000);
    const images: { png: string; width: number; height: number; data: Uint8Array }[] = [];
    for (const view of options.views) {
      const preset = presetFrame(bounds, 35, options.width / options.height, view);
      const frame = fitBounds({
        bounds,
        fov: 35,
        aspect: options.width / options.height,
        direction: preset.position.clone().sub(preset.target),
        up: preset.up,
        padding: 1.3,
      });
      camera.position.copy(frame.position);
      camera.up.copy(frame.up);
      camera.near = frame.near;
      camera.far = frame.far;
      camera.lookAt(frame.target);
      if (options.camera) {
        const saved = options.camera;
        camera.position.set(saved.position[0], -saved.position[1], -saved.position[2]);
        camera.up.set(saved.up[0], -saved.up[1], -saved.up[2]);
        camera.near = saved.near;
        camera.far = saved.far;
        camera.lookAt(new Vector3(saved.target[0], -saved.target[1], -saved.target[2]));
        if (camera instanceof PerspectiveCamera) camera.fov = saved.fov;
        else {
          const span = saved.span ?? frame.orthoHeight;
          camera.top = span / 2;
          camera.bottom = -span / 2;
          camera.right = ((span / 2) * options.width) / options.height;
          camera.left = -camera.right;
        }
      }
      camera.updateMatrixWorld(true);
      if (camera instanceof OrthographicCamera && options.instructionFrame) {
        let maxX = 0,
          maxY = 0;
        for (const x of [bounds.min.x, bounds.max.x])
          for (const y of [bounds.min.y, bounds.max.y])
            for (const z of [bounds.min.z, bounds.max.z]) {
              const point = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
              maxX = Math.max(maxX, Math.abs(point.x));
              maxY = Math.max(maxY, Math.abs(point.y));
            }
        const unitsPerPixel =
          Math.max((2 * maxX) / options.instructionFrame.width, (2 * maxY) / options.instructionFrame.height, 0.001) *
          1.08;
        camera.left = (-options.width * unitsPerPixel) / 2;
        camera.right = -camera.left;
        camera.top = (options.height * unitsPerPixel) / 2;
        camera.bottom = -camera.top;
      }
      camera.updateProjectionMatrix();
      options.signal?.throwIfAborted();
      renderer.render(scene, camera);
      const canvas = document.createElement('canvas');
      canvas.width = options.width;
      canvas.height = options.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(renderer.domElement, 0, 0);
      // Render a visibility mask with the same depth buffer geometry. Only the outline is
      // composited; both old and new parts retain their original, identical materials.
      if (options.instructionFrame && instances.some((v) => v.highlighted)) {
        const originals: { object: Mesh; material: Mesh['material'] }[] = [];
        const edges: LineSegments[] = [];
        const black = new MeshBasicMaterial({ color: '#000000' }),
          white = new MeshBasicMaterial({ color: '#ffffff' });
        for (const [group, material] of [
          [previous, black],
          [added, white],
        ] as const)
          group.traverse((object) => {
            if (object instanceof Mesh) {
              originals.push({ object, material: object.material });
              object.material = material;
            }
            if (object instanceof LineSegments) {
              edges.push(object);
              object.visible = false;
            }
          });
        renderer.setClearColor('#000000', 1);
        renderer.render(scene, camera);
        const mask = document.createElement('canvas');
        mask.width = options.width;
        mask.height = options.height;
        const maskContext = mask.getContext('2d')!;
        maskContext.drawImage(renderer.domElement, 0, 0);
        const pixels = maskContext.getImageData(0, 0, options.width, options.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i + 3] = pixels.data[i]! > 128 ? 255 : 0;
        }
        maskContext.putImageData(pixels, 0, 0);
        const outline = document.createElement('canvas');
        outline.width = options.width;
        outline.height = options.height;
        const stroke = outline.getContext('2d')!,
          radius = Math.max(1, Math.round(options.outlinePixels ?? 1));
        for (const [x, y] of [
          [-radius, 0],
          [radius, 0],
          [0, -radius],
          [0, radius],
        ])
          stroke.drawImage(mask, x!, y!);
        stroke.globalCompositeOperation = 'destination-out';
        stroke.drawImage(mask, 0, 0);
        stroke.globalCompositeOperation = 'source-in';
        stroke.fillStyle = '#FFB000';
        stroke.fillRect(0, 0, options.width, options.height);
        ctx.drawImage(outline, 0, 0);
        for (const entry of originals) entry.object.material = entry.material;
        for (const edge of edges) edge.visible = true;
        black.dispose();
        white.dispose();
        mask.width = mask.height = outline.width = outline.height = 1;
        renderer.setClearColor('#ffffff', options.transparent ? 0 : 1);
      }
      images.push({
        png: canvas.toDataURL('image/png'),
        width: options.width,
        height: options.height,
        data: new Uint8Array(ctx.getImageData(0, 0, options.width, options.height).data),
      });
      canvas.width = canvas.height = 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
    }
    return images;
  } finally {
    disposeObjects(root);
    await renderer.dispose();
  }
}
