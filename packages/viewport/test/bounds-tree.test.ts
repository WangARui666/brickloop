import { expect, it } from 'vitest';
import { Box3, Ray, Vector3 } from 'three/webgpu';
import type { BufferAttribute, LineSegments } from 'three/webgpu';
import { BoundsTree } from '../src/bounds-tree';
import { BoundsOverlay } from '../src/bounds-overlay';

it('prunes 10000 occurrence bounds, refits a moved leaf and rebuilds removed/reordered topology', () => {
  let items = Array.from({ length: 10000 }, (_, id) => ({
    id,
    bounds: new Box3(
      new Vector3((id % 100) * 20, 0, Math.floor(id / 100) * 20),
      new Vector3((id % 100) * 20 + 10, 10, Math.floor(id / 100) * 20 + 10),
    ),
  }));
  const tree = new BoundsTree<(typeof items)[number]>();
  const update = () =>
    tree.update(
      items,
      items.map((item) => String(item.id)),
    );
  const query = (x: number, z: number) => {
    const ids: number[] = [];
    tree.query(new Ray(new Vector3(x, 100, z), new Vector3(0, -1, 0)), (item) => ids.push(item.id));
    return ids;
  };
  update();
  expect(query(5, 5)).toEqual([0]);
  expect(tree.stats.candidates).toBeLessThan(32);
  const rebuilds = tree.stats.rebuilds;
  items[0] = { id: 0, bounds: items[0]!.bounds.clone().translate(new Vector3(-100, 0, 0)) };
  update();
  expect(query(5, 5)).toEqual([]);
  expect(query(-95, 5)).toEqual([0]);
  expect(tree.stats.rebuilds).toBe(rebuilds);
  expect(tree.stats.refits).toBeLessThan(20);
  update();
  expect(tree.stats.refits).toBe(0);
  items = items.slice(1).reverse();
  update();
  expect(query(-95, 5)).toEqual([]);
  expect(query(25, 5)).toEqual([1]);
  tree.clear();
  expect(query(25, 5)).toEqual([]);
});

it('keeps all unknown-collision boxes in one geometry and updates only changed ranges', () => {
  const overlay = new BoundsOverlay();
  const first = new Box3(new Vector3(-5, -10, -15), new Vector3(5, 10, 15));
  const second = first.clone().translate(new Vector3(100, 0, 0));
  overlay.set([first, second]);
  expect(overlay.root.children).toHaveLength(1);
  const lines = overlay.root.children[0]!;
  expect('geometry' in lines).toBe(true);
  // Runtime class assertion keeps the buffer API typed and checks the actual render object.
  const geometry = (lines as LineSegments).geometry;
  expect(geometry.drawRange.count).toBe(48);
  const position = geometry.getAttribute('position') as BufferAttribute;
  position.clearUpdateRanges();
  overlay.set([first.clone(), second.clone()]);
  expect(position.updateRanges).toHaveLength(0);
  const moved = second.clone().translate(new Vector3(20, 0, 0));
  overlay.set([first, moved]);
  expect(position.updateRanges).toEqual([{ start: 72, count: 72 }]);
  expect(geometry.boundingBox?.containsBox(moved)).toBe(true);
  overlay.set([]);
  expect(overlay.root.visible).toBe(false);
  overlay.dispose();
});
