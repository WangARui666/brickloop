import { Box3, Vector3 } from 'three/webgpu';
import type { Ray } from 'three/webgpu';

interface Node {
  bounds: Box3;
  parent: Node | null;
  children: Node[];
  indices: number[];
}

/** Occurrence-level BVH. Transform changes refit only their leaf and ancestors;
 * insertion/deletion/reordering rebuilds the topology. Geometry BVHs remain shared. */
export class BoundsTree<T extends { bounds: Box3 }> {
  private root: Node | null = null;
  private items: readonly T[] = [];
  private leaves: Node[] = [];
  private keys: readonly string[] = [];
  private boxes: readonly Box3[] = [];
  stats = { rebuilds: 0, refits: 0, candidates: 0 };

  update(items: readonly T[], keys: readonly string[]): void {
    this.stats.refits = 0;
    if (keys.length !== this.keys.length || keys.some((key, index) => key !== this.keys[index])) {
      this.items = items;
      this.boxes = items.map((item) => item.bounds);
      this.keys = keys;
      this.leaves = [];
      const build = (indices: number[], parent: Node | null): Node => {
        const bounds = new Box3();
        for (const index of indices) bounds.union(items[index]!.bounds);
        const node: Node = { bounds, parent, children: [], indices: [] };
        if (indices.length <= 8) {
          node.indices = indices;
          for (const index of indices) this.leaves[index] = node;
        } else {
          const size = bounds.getSize(new Vector3());
          const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
          indices.sort((a, b) => {
            const x = items[a]!.bounds,
              y = items[b]!.bounds;
            return x.min[axis] + x.max[axis] - y.min[axis] - y.max[axis];
          });
          const half = Math.floor(indices.length / 2);
          node.children = [build(indices.slice(0, half), node), build(indices.slice(half), node)];
        }
        return node;
      };
      this.root = items.length
        ? build(
            items.map((_, index) => index),
            null,
          )
        : null;
      this.stats.rebuilds++;
      return;
    }
    const dirty = new Set<Node>();
    items.forEach((item, index) => {
      if (item.bounds !== this.boxes[index]) dirty.add(this.leaves[index]!);
    });
    this.items = items;
    this.boxes = items.map((item) => item.bounds);
    // Refit all leaves first, then successive parent levels (shared ancestors once per level).
    let level = dirty;
    while (level.size) {
      const parents = new Set<Node>();
      for (const node of level) {
        node.bounds.makeEmpty();
        for (const index of node.indices) node.bounds.union(items[index]!.bounds);
        for (const child of node.children) node.bounds.union(child.bounds);
        this.stats.refits++;
        if (node.parent) parents.add(node.parent);
      }
      level = parents;
    }
  }

  query(ray: Ray, visit: (item: T) => void): void {
    this.stats.candidates = 0;
    const walk = (node: Node) => {
      if (!ray.intersectsBox(node.bounds)) return;
      for (const index of node.indices) {
        this.stats.candidates++;
        const item = this.items[index]!;
        if (ray.intersectsBox(item.bounds)) visit(item);
      }
      for (const child of node.children) walk(child);
    };
    if (this.root) walk(this.root);
  }

  /** Refit explicit changed leaves without scanning every occurrence. */
  refit(indices: readonly number[]): void {
    this.stats.refits = 0;
    let level = new Set(indices.map((index) => this.leaves[index]!));
    while (level.size) {
      const parents = new Set<Node>();
      for (const node of level) {
        node.bounds.makeEmpty();
        for (const index of node.indices) node.bounds.union(this.items[index]!.bounds);
        for (const child of node.children) node.bounds.union(child.bounds);
        this.stats.refits++;
        if (node.parent) parents.add(node.parent);
      }
      level = parents;
    }
  }

  clear(): void {
    this.root = null;
    this.items = [];
    this.keys = [];
    this.boxes = [];
    this.leaves = [];
  }
}
