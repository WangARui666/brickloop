import { BuildFailure, integer, number, record } from './limits.js';
import { point, type Transform } from './transform.js';
import type { Voxels } from './voxels.js';

type Point = [number, number];
function points(value: unknown, minimum: number): Point[] {
  if (!Array.isArray(value) || value.length < minimum)
    throw new BuildFailure('RUNTIME', `Expected at least ${minimum} points`);
  return value.map((p) => {
    if (!Array.isArray(p) || p.length !== 2) throw new BuildFailure('RUNTIME', 'Expected [x,z] pairs');
    return [number(p[0], 'point[0]'), number(p[1], 'point[1]')];
  });
}
/** Shape rasterization samples horizontal cell centres; y is an integer plate layer. */
export class Shapes {
  constructor(
    readonly voxels: Voxels,
    readonly t: Transform,
    readonly resolve: (v: unknown) => string,
  ) {}
  write(x: number, y: number, z: number, color: string | null) {
    const [px, pz] = point(this.t, x + 0.5, z + 0.5);
    // A transformed shape is snapped by centre to the fixed integer voxel lattice.
    this.voxels.set(Math.floor(px), y + this.t.y, Math.floor(pz), color);
  }
  raster(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number,
    h: number,
    color: string | null,
    inside: (x: number, z: number, dy: number) => boolean,
  ) {
    integer(y, 'y');
    integer(h, 'h', 0);
    integer(this.t.y, 'dy');
    for (let dy = 0; dy < h; dy++)
      for (let z = Math.ceil(z0 - 0.5); z < z1 - 0.5; z++) {
        this.voxels.budget.check();
        for (let x = Math.ceil(x0 - 0.5); x < x1 - 0.5; x++) {
          if ((x & 255) === 0) this.voxels.budget.check();
          if (inside(x + 0.5, z + 0.5, dy)) this.write(x, y + dy, z, color);
        }
      }
  }
  call(name: string, args: unknown[], erase = false): void {
    const n = (i: number, label: string) => number(args[i], label),
      c = (i: number) => (erase ? null : this.resolve(args[i]));
    if (name === 'cell') {
      this.voxels.budget.check();
      this.write(integer(args[0], 'x'), integer(args[1], 'y'), integer(args[2], 'z'), c(3));
      return;
    }
    if (name === 'box') {
      const x = n(0, 'x'),
        z = n(1, 'z'),
        y = n(2, 'y'),
        w = n(3, 'w'),
        d = n(4, 'd'),
        h = n(5, 'h');
      if (w < 0 || d < 0) throw new BuildFailure('RUNTIME', 'Box dimensions must be nonnegative');
      this.raster(x, z, x + w, z + d, y, h, c(6), () => true);
      return;
    }
    if (name === 'prism') {
      const ps = points(args[0], 3),
        y = n(1, 'y'),
        h = n(2, 'h');
      const xs = ps.map((p) => p[0]),
        zs = ps.map((p) => p[1]);
      // Even-odd scanline intersections, including concave polygons.
      const rows = new Map<number, number[]>();
      this.raster(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), y, h, c(3), (x, z) => {
        let intersections = rows.get(z);
        if (!intersections) {
          intersections = [];
          ps.forEach((p, i) => {
            const q = ps[(i + 1) % ps.length]!;
            if (p[1] > z !== q[1] > z) intersections!.push(p[0] + ((z - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
          });
          intersections.sort((a, b) => a - b);
          rows.set(z, intersections);
        }
        for (let i = 0; i < intersections.length; i += 2)
          if (x >= intersections[i]! && x < intersections[i + 1]!) return true;
        return false;
      });
      return;
    }
    if (name === 'wall') {
      const ps = points(args[0], 2),
        y = n(1, 'y'),
        h = n(2, 'h'),
        color = c(3),
        opts = record(args[4]),
        thickness = number(opts.thickness ?? 1, 'thickness');
      if (thickness <= 0) throw new BuildFailure('RUNTIME', 'Wall thickness must be positive');
      if (opts.openings !== undefined && !Array.isArray(opts.openings))
        throw new BuildFailure('RUNTIME', 'openings must be an array');
      const openings = ((opts.openings ?? []) as unknown[]).map((v) => {
        const o = record(v);
        return {
          at: number(o.at, 'at'),
          width: number(o.width, 'width'),
          y: number(o.y, 'opening.y'),
          h: number(o.h, 'opening.h'),
        };
      });
      let offset = 0;
      for (let i = 1; i < ps.length; i++) {
        const [ax, az] = ps[i - 1]!,
          [bx, bz] = ps[i]!,
          dx = bx - ax,
          dz = bz - az,
          len = Math.hypot(dx, dz),
          base = offset;
        if (!len) continue;
        this.raster(
          Math.min(ax, bx) - thickness / 2,
          Math.min(az, bz) - thickness / 2,
          Math.max(ax, bx) + thickness / 2,
          Math.max(az, bz) + thickness / 2,
          y,
          h,
          color,
          (x, z, dy) => {
            const t = ((x - ax) * dx + (z - az) * dz) / (len * len),
              at = base + t * len;
            return (
              t >= 0 &&
              t < 1 &&
              Math.abs((x - ax) * dz - (z - az) * dx) / len <= thickness / 2 &&
              !openings.some((o) => at >= o.at && at < o.at + o.width && y + dy >= o.y && y + dy < o.y + o.h)
            );
          },
        );
        offset += len;
      }
      return;
    }
    if (name === 'cylinder') {
      const cx = n(0, 'cx'),
        cz = n(1, 'cz'),
        y = n(2, 'y'),
        r = n(3, 'r'),
        h = n(4, 'h'),
        o = record(args[6]);
      if (r < 0) throw new BuildFailure('RUNTIME', 'Radius must be nonnegative');
      this.raster(cx - r, cz - r, cx + r + 1e-9, cz + r + 1e-9, y, h, c(5), (x, z) => {
        const d = Math.hypot(x - cx, z - cz);
        return d <= r && (!o.hollow || r <= 1 || d > r - 1);
      });
      return;
    }
    if (name === 'revolve') {
      const cx = n(0, 'cx'),
        cz = n(1, 'cz'),
        y = integer(args[2], 'y'),
        profile = points(args[3], 2),
        color = c(4);
      for (let i = 0; i < profile.length; i++) {
        integer(profile[i]![0], 'profile.dy', 0);
        if (profile[i]![1] < 0 || (i && profile[i]![0] <= profile[i - 1]![0]))
          throw new BuildFailure('RUNTIME', 'Profile heights must increase and radii must be nonnegative');
      }
      let segment = 0;
      for (let dy = profile[0]![0]; dy <= profile.at(-1)![0]; dy++) {
        this.voxels.budget.check();
        while (segment < profile.length - 2 && dy > profile[segment + 1]![0]) segment++;
        const [a, ra] = profile[segment]!,
          [b, rb] = profile[segment + 1]!,
          r = ra + ((rb - ra) * (dy - a)) / (b - a);
        this.raster(
          cx - r,
          cz - r,
          cx + r + 1e-9,
          cz + r + 1e-9,
          y + dy,
          1,
          color,
          (x, z) => Math.hypot(x - cx, z - cz) <= r,
        );
      }
      return;
    }
    if (name === 'sphere') {
      const cx = n(0, 'cx'),
        cy = n(1, 'cy'),
        cz = n(2, 'cz'),
        r = n(3, 'r'),
        color = c(4);
      if (r < 0) throw new BuildFailure('RUNTIME', 'Radius must be nonnegative');
      // Physical sphere: one plate is 0.4 stud (8/20 LDU).
      const y0 = Math.ceil(cy - r / 0.4 - 0.5),
        y1 = Math.floor(cy + r / 0.4 - 0.5);
      this.raster(
        cx - r,
        cz - r,
        cx + r + 1e-9,
        cz + r + 1e-9,
        y0,
        Math.max(0, y1 - y0 + 1),
        color,
        (x, z, dy) => (x - cx) ** 2 + (z - cz) ** 2 + ((y0 + dy + 0.5 - cy) * 0.4) ** 2 <= r * r,
      );
      return;
    }
    if (name === 'heightmap') {
      const x = integer(args[0], 'x'),
        z = integer(args[1], 'z'),
        rows = args[2],
        color = c(3);
      if (!Array.isArray(rows)) throw new BuildFailure('RUNTIME', 'heightmap rows must be an array');
      rows.forEach((row, i) => {
        if (!Array.isArray(row)) throw new BuildFailure('RUNTIME', 'heightmap row must be an array');
        row.forEach((v, j) => {
          const h = integer(v, 'height', 0);
          for (let y = 0; y < h; y++) {
            this.voxels.budget.check();
            this.write(x + j, y, z + i, color);
          }
        });
      });
      return;
    }
    throw new BuildFailure('RUNTIME', `Unknown shape: ${name}`);
  }
}
