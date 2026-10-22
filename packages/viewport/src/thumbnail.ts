import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import type { ColorDef } from '@brickloop/catalog';
import { createLdrawRoot } from './coordinates';
import { fitBounds } from './framing';
import { createPartInstances } from './parts';
import type { PartInstance } from './parts';
import { disposeObjects, visibleContentBounds } from './scene-content';

/** One detached 128px renderer, shared by the desktop's serial thumbnail queue. */
export async function createThumbnailRenderer() {
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true });
  await renderer.init();
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setSize(128, 128);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0, 0);
  const scene = new Scene();
  scene.add(new HemisphereLight('#ffffff', '#727e96', 2));
  const key = new DirectionalLight('#fff4e4', 3.5);
  key.position.set(-150, 250, 200);
  const fill = new DirectionalLight('#b7ceff', 1);
  fill.position.set(200, 80, -150);
  scene.add(key, fill);
  const root = createLdrawRoot();
  scene.add(root);
  const camera = new PerspectiveCamera(35, 1, 0.1, 10000);
  return {
    render(instance: PartInstance, colors: readonly ColorDef[]): string {
      const content = createPartInstances([instance], colors);
      root.add(content);
      try {
        const frame = fitBounds({
          bounds: visibleContentBounds(content),
          fov: 35,
          aspect: 1,
          direction: { x: 1, y: 0.85, z: 1 },
          padding: 1.3,
        });
        camera.position.copy(frame.position);
        camera.up.copy(frame.up);
        camera.near = frame.near;
        camera.far = frame.far;
        camera.lookAt(frame.target);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL('image/png');
      } finally {
        root.remove(content);
        disposeObjects(content);
      }
    },
    dispose: () => renderer.dispose(),
  };
}
