import { overlaps, union } from './math.js';
import type { Aabb } from './types.js';

interface Node {
  bounds: Aabb;
  parent: Node | undefined;
  left: Node | undefined;
  right: Node | undefined;
  height: number;
  key: string | undefined;
}
const area = (b: Aabb): number => {
  const x = b[3] - b[0],
    y = b[4] - b[1],
    z = b[5] - b[2];
  return 2 * (x * y + y * z + z * x);
};
const branch = (left: Node, right: Node, parent?: Node): Node => ({
  bounds: union(left.bounds, right.bounds),
  parent,
  left,
  right,
  height: 1 + Math.max(left.height, right.height),
  key: undefined,
});

/** Incremental, height-balanced bounding volume hierarchy. Leaves are actual world AABBs. */
export class DynamicAabbTree {
  private root: Node | undefined;
  private readonly leaves = new Map<string, Node>();
  get size(): number {
    return this.leaves.size;
  }
  set(key: string, bounds: Aabb): void {
    this.delete(key);
    const leaf: Node = { key, bounds, parent: undefined, left: undefined, right: undefined, height: 0 };
    this.leaves.set(key, leaf);
    if (!this.root) {
      this.root = leaf;
      return;
    }
    let sibling = this.root;
    while (sibling.left && sibling.right) {
      const leftCost = area(union(sibling.left.bounds, bounds)) - area(sibling.left.bounds);
      const rightCost = area(union(sibling.right.bounds, bounds)) - area(sibling.right.bounds);
      sibling = leftCost <= rightCost ? sibling.left : sibling.right;
    }
    const oldParent = sibling.parent;
    const parent = branch(sibling, leaf, oldParent);
    sibling.parent = parent;
    leaf.parent = parent;
    this.replaceChild(oldParent, sibling, parent);
    this.refit(parent);
  }
  delete(key: string): void {
    const leaf = this.leaves.get(key);
    if (!leaf) return;
    this.leaves.delete(key);
    const parent = leaf.parent;
    if (!parent) {
      this.root = undefined;
      return;
    }
    const sibling = parent.left === leaf ? parent.right! : parent.left!;
    this.replaceChild(parent.parent, parent, sibling);
    sibling.parent = parent.parent;
    this.refit(sibling.parent);
  }
  /** Yield traversal work as well as candidates so budget checks also cover sparse searches. */
  *search(bounds: Aabb): Generator<string | undefined> {
    const pending = this.root ? [this.root] : [];
    while (pending.length) {
      const node = pending.pop()!;
      if (!overlaps(bounds, node.bounds)) {
        yield undefined;
        continue;
      }
      if (node.key !== undefined) yield node.key;
      else {
        pending.push(node.right!, node.left!);
        yield undefined;
      }
    }
  }
  private replaceChild(parent: Node | undefined, old: Node, next: Node): void {
    if (!parent) this.root = next;
    else if (parent.left === old) parent.left = next;
    else parent.right = next;
  }
  private refresh(node: Node): void {
    if (!node.left || !node.right) return;
    node.height = 1 + Math.max(node.left.height, node.right.height);
    node.bounds = union(node.left.bounds, node.right.bounds);
  }
  private refit(start: Node | undefined): void {
    let node = start;
    while (node) {
      this.refresh(node);
      const left = node.left,
        right = node.right;
      if (left && right && right.height - left.height > 1) {
        const parent = node.parent;
        this.replaceChild(parent, node, right);
        right.parent = parent;
        const rl = right.left!,
          rr = right.right!;
        right.left = node;
        node.parent = right;
        if (rl.height > rr.height) {
          right.right = rl;
          node.right = rr;
          rr.parent = node;
        } else {
          right.right = rr;
          node.right = rl;
          rl.parent = node;
        }
        this.refresh(node);
        this.refresh(right);
        node = right;
      } else if (left && right && left.height - right.height > 1) {
        const parent = node.parent;
        this.replaceChild(parent, node, left);
        left.parent = parent;
        const ll = left.left!,
          lr = left.right!;
        left.right = node;
        node.parent = left;
        if (ll.height > lr.height) {
          left.left = ll;
          node.left = lr;
          lr.parent = node;
        } else {
          left.left = lr;
          node.left = ll;
          ll.parent = node;
        }
        this.refresh(node);
        this.refresh(left);
        node = left;
      }
      node = node.parent;
    }
  }
}
