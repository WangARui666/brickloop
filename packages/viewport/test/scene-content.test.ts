/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three/webgpu';
import { createLdrawRoot } from '../src/coordinates';
import { addPlaceholder, createContentLayer, disposeObjects, visibleContentBounds } from '../src/scene-content';

describe('document content layer', () => {
  it('places the exact placeholder above ground and excludes hidden content and grid siblings', () => {
    const root = createLdrawRoot();
    const content = createContentLayer();
    root.add(content);
    addPlaceholder(content);
    addPlaceholder(content);
    expect(content.children).toHaveLength(1);
    const hidden = new Mesh(new BoxGeometry(10000, 10000, 10000));
    hidden.visible = false;
    content.add(hidden);
    root.add(new Mesh(new BoxGeometry(100000, 1, 100000)));
    const bounds = visibleContentBounds(content);
    const size = bounds.getSize(new Vector3());
    expect(size.x).toBeCloseTo(80);
    expect(size.y).toBeCloseTo(24);
    expect(size.z).toBeCloseTo(40);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(24);
    disposeObjects(root);
  });
  it('includes instance matrices in framing and disposes geometries and materials', () => {
    const root = createLdrawRoot();
    const content = createContentLayer();
    root.add(content);
    const geometry = new BoxGeometry(20, 24, 20);
    const material = new MeshStandardMaterial();
    const batch = new InstancedMesh(geometry, material, 2);
    batch.setMatrixAt(0, new Matrix4().makeTranslation(0, -12, 0));
    batch.setMatrixAt(1, new Matrix4().makeTranslation(100, -12, 0));
    content.add(batch);
    expect(visibleContentBounds(content).getSize(new Vector3()).x).toBeCloseTo(120);
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    disposeObjects(root);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(root.children).toHaveLength(0);
  });
});
