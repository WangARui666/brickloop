import { describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '@brickloop/core';
import { hasSavedCamera, openingCameraAction } from '../src/renderer/src/document-store';

vi.mock('../src/renderer/src/mesh-client', () => ({
  sourceMeshes: new Map(),
  clearMeshCache: vi.fn(),
  getMesh: vi.fn(),
  retainMeshes: vi.fn(),
}));

describe('A-96 opening camera policy', () => {
  it.each([undefined, 0, -1, NaN, Infinity, -Infinity, '300'])('rejects span %s', (span) => {
    expect(hasSavedCamera({ ...createWorkspace().camera, ...{ span } })).toBe(false);
  });
  it('recognizes a UI-saved camera', () => {
    expect(hasSavedCamera({ ...createWorkspace().camera, ...{ span: 1484 } })).toBe(true);
  });
  const ready = { saved: true, imported: false, touched: false, ready: true, intersects: true };
  it('restores a visible saved camera, including a partially visible model', () => {
    expect(openingCameraAction(ready)).toBe('keep');
  });
  it.each([{ saved: false }, { imported: true }, { intersects: false }])(
    'fits %j once meshes and the viewport are ready',
    (change) => {
      expect(openingCameraAction({ ...ready, ...change })).toBe('fit');
      expect(openingCameraAction({ ...ready, ...change, ready: false })).toBe('wait');
    },
  );
  it('keeps empty or entirely hidden models at their original camera', () => {
    expect(openingCameraAction({ ...ready, intersects: null })).toBe('keep');
    expect(openingCameraAction({ ...ready, imported: true, saved: false, intersects: null })).toBe('keep');
  });
  it('user interaction cancels automatic framing even before readiness', () => {
    for (const readyValue of [false, true])
      expect(openingCameraAction({ ...ready, ready: readyValue, touched: true, saved: false, intersects: false })).toBe(
        'keep',
      );
  });
});
