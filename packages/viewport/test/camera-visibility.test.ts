import { expect, it } from 'vitest';
import { Box3, Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import { cameraBoundsVisibility } from '../src/index';

it.each([new OrthographicCamera(-5, 5, 5, -5, 1, 100), new PerspectiveCamera(60, 1, 1, 100)])(
  'checks full and partial intersections, offscreen content and depth clipping (%s)',
  (camera) => {
    camera.updateMatrixWorld();
    const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const bounds = new Box3(new Vector3(-1, -1, -11), new Vector3(1, 1, -9));
    const original = bounds.clone();
    expect(cameraBoundsVisibility(bounds, matrix)).toMatchObject({ intersects: true, contained: true });
    const partial = new Box3(new Vector3(0, 0, -10), new Vector3(100, 100, -9));
    expect(cameraBoundsVisibility(partial, matrix)).toMatchObject({ intersects: true, contained: false });
    for (const delta of [new Vector3(1000, 0, 0), new Vector3(0, 0, 20), new Vector3(0, 0, -200)])
      expect(cameraBoundsVisibility(bounds.clone().translate(delta), matrix)).toMatchObject({
        intersects: false,
        contained: false,
      });
    expect(bounds.equals(original)).toBe(true);
  },
);

it('uses WebGPU depth conventions when checking the near plane', () => {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 1, 100);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const clipped = new Box3(new Vector3(-1, -1, -0.5), new Vector3(1, 1, -0.25));
  expect(cameraBoundsVisibility(clipped, matrix, camera.coordinateSystem)).toMatchObject({
    intersects: false,
    contained: false,
  });
});
