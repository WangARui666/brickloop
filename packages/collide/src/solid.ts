import type { PartMesh } from '@brickloop/ldraw';
import { boxFromBounds, cross, sub } from './math.js';
import type { Aabb, ColliderShape, Vec3 } from './types.js';

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normalX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}
/** Signed scan conversion retains cavities; coincident faces are deduplicated by crossing direction. */
export class SolidSampler {
  private readonly triangles: Triangle[] = [];
  private readonly bins = new Map<string, Triangle[]>();
  suspect = false;
  constructor(
    mesh: PartMesh,
    private readonly resolution: number,
  ) {
    for (const batch of mesh.batches)
      for (let i = 0; i < batch.indices.length; i += 3) {
        const points = [0, 1, 2].map((j): Vec3 => {
          const offset = batch.indices[i + j]! * 3;
          return [batch.positions[offset]!, batch.positions[offset + 1]!, batch.positions[offset + 2]!];
        });
        const [a, b, c] = points as [Vec3, Vec3, Vec3];
        const normalX = cross(sub(b, a), sub(c, a))[0];
        if (Math.abs(normalX) < 1e-10) continue;
        const triangle: Triangle = {
          a,
          b,
          c,
          normalX,
          minY: Math.min(a[1], b[1], c[1]),
          maxY: Math.max(a[1], b[1], c[1]),
          minZ: Math.min(a[2], b[2], c[2]),
          maxZ: Math.max(a[2], b[2], c[2]),
        };
        this.triangles.push(triangle);
        for (let y = Math.floor(triangle.minY / resolution); y <= Math.floor(triangle.maxY / resolution); y++)
          for (let z = Math.floor(triangle.minZ / resolution); z <= Math.floor(triangle.maxZ / resolution); z++) {
            const key = `${y},${z}`;
            const bucket = this.bins.get(key) ?? [];
            bucket.push(triangle);
            this.bins.set(key, bucket);
          }
      }
  }
  get hasFaces(): boolean {
    return this.triangles.length > 0;
  }
  intervals(y: number, z: number): [number, number][] {
    // Avoid ambiguous rays through triangle diagonals and mesh vertices.
    y += 1.234e-7;
    z += 2.345e-7;
    const hits: { x: number; sign: number }[] = [];
    for (const t of this.bins.get(`${Math.floor(y / this.resolution)},${Math.floor(z / this.resolution)}`) ?? []) {
      if (y < t.minY || y > t.maxY || z < t.minZ || z > t.maxZ) continue;
      const by = t.b[1] - t.a[1],
        bz = t.b[2] - t.a[2],
        cy = t.c[1] - t.a[1],
        cz = t.c[2] - t.a[2];
      const u = ((y - t.a[1]) * cz - (z - t.a[2]) * cy) / t.normalX;
      const v = (by * (z - t.a[2]) - bz * (y - t.a[1])) / t.normalX;
      if (u < -1e-10 || v < -1e-10 || u + v > 1 + 1e-10) continue;
      hits.push({ x: t.a[0] + u * (t.b[0] - t.a[0]) + v * (t.c[0] - t.a[0]), sign: Math.sign(t.normalX) });
    }
    hits.sort((a, b) => a.x - b.x);
    const intervals: [number, number][] = [];
    let winding = 0,
      start = 0;
    for (let i = 0; i < hits.length;) {
      const x = hits[i]!.x;
      let positive = false,
        negative = false;
      while (i < hits.length && Math.abs(hits[i]!.x - x) < 1e-5) {
        if (hits[i]!.sign > 0) positive = true;
        else negative = true;
        i++;
      }
      const next = winding + Number(positive) - Number(negative);
      if (winding === 0 && next !== 0) start = x;
      if (winding !== 0 && next === 0) intervals.push([start, x]);
      winding = next;
    }
    if (winding !== 0) this.suspect = true;
    return intervals;
  }
  contains(point: Vec3): boolean {
    return this.intervals(point[1], point[2]).some(([lo, hi]) => point[0] > lo - 1e-5 && point[0] < hi + 1e-5);
  }
}

export function voxelBoxes(
  sampler: SolidSampler,
  bounds: Aabb,
  resolution: number,
  inset: number,
  maxVoxels: number,
): ColliderShape[] | undefined {
  const origin: Vec3 = [0, 1, 2].map((i) => Math.floor(bounds[i]! / resolution) * resolution) as Vec3;
  const size = [0, 1, 2].map((i) => Math.max(1, Math.ceil((bounds[i + 3]! - origin[i]!) / resolution))) as [
    number,
    number,
    number,
  ];
  const [nx, ny, nz] = size;
  if (nx * ny * nz > maxVoxels) return undefined;
  const cells = new Uint8Array(nx * ny * nz);
  const at = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;
  // Only keep cells whose inset corners AND centre lie in solid. This avoids filling small holes.
  const h = Math.max(0, resolution / 2 - inset);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const cy = origin[1] + (y + 0.5) * resolution,
        cz = origin[2] + (z + 0.5) * resolution;
      const rows = [
        [0, 0],
        [-h, -h],
        [-h, h],
        [h, -h],
        [h, h],
      ].map(([dy, dz]) => sampler.intervals(cy + dy!, cz + dz!));
      for (let x = 0; x < nx; x++) {
        const cx = origin[0] + (x + 0.5) * resolution;
        if (rows.every((row) => row.some(([lo, hi]) => cx - h >= lo - 1e-5 && cx + h <= hi + 1e-5)))
          cells[at(x, y, z)] = 1;
      }
    }
  const shapes: ColliderShape[] = [];
  // Deterministic greedy cuboid merging, then inset the resulting primitive once.
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (!cells[at(x, y, z)]) continue;
        let ex = x + 1,
          ey = y + 1,
          ez = z + 1;
        while (ex < nx && cells[at(ex, y, z)]) ex++;
        const rowFull = (yy: number, zz: number): boolean => {
          for (let xx = x; xx < ex; xx++) if (!cells[at(xx, yy, zz)]) return false;
          return true;
        };
        while (ey < ny && rowFull(ey, z)) ey++;
        const planeFull = (zz: number): boolean => {
          for (let yy = y; yy < ey; yy++) if (!rowFull(yy, zz)) return false;
          return true;
        };
        while (ez < nz && planeFull(ez)) ez++;
        for (let zz = z; zz < ez; zz++)
          for (let yy = y; yy < ey; yy++) for (let xx = x; xx < ex; xx++) cells[at(xx, yy, zz)] = 0;
        const b: Aabb = [
          origin[0] + x * resolution,
          origin[1] + y * resolution,
          origin[2] + z * resolution,
          origin[0] + ex * resolution,
          origin[1] + ey * resolution,
          origin[2] + ez * resolution,
        ];
        const box = boxFromBounds(b, inset);
        if (box) shapes.push(box);
      }
  return shapes;
}
