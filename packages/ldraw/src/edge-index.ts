import type { Vec3 } from './types';

type Edge = [Vec3, Vec3];
interface Node {
  lo: number[];
  hi: number[];
  edges?: Edge[];
  children?: Node[];
}
/** Broad phase only: retain the exact collinearity/overlap predicate in smoothing. */
export function edgeCandidates(edges: Edge[]) {
  const build = (items: Edge[]): Node => {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const edge of items)
      for (const p of edge)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, p[a]!);
          hi[a] = Math.max(hi[a]!, p[a]!);
        }
    if (items.length <= 8) return { lo, hi, edges: items };
    const axis = [0, 1, 2].sort((a, b) => hi[b]! - lo[b]! - (hi[a]! - lo[a]!))[0]!;
    items.sort((a, b) => a[0][axis]! + a[1][axis]! - b[0][axis]! - b[1][axis]!);
    const mid = Math.floor(items.length / 2);
    return { lo, hi, children: [build(items.slice(0, mid)), build(items.slice(mid))] };
  };
  const root = build([...edges]);
  return (a: Vec3, b: Vec3, test: (edge: Edge) => boolean): boolean => {
    const visit = (node: Node): boolean => {
      for (let axis = 0; axis < 3; axis++)
        if (
          node.lo[axis]! > Math.max(a[axis]!, b[axis]!) + 1e-5 ||
          node.hi[axis]! < Math.min(a[axis]!, b[axis]!) - 1e-5
        )
          return false;
      return node.edges ? node.edges.some(test) : node.children!.some(visit);
    };
    return visit(root);
  };
}
