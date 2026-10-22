import { BuildFailure, integer, record, type Budget } from './limits.js';
import { key, unkey, type Voxels } from './voxels.js';
import { standardPackingParts } from './standard-parts.js';
import type { Bounds, BuildInstance, CompactPart, PackOptions, TopRegion } from './types.js';

export interface Packed extends Bounds {
  instance: BuildInstance;
  kind: CompactPart['kind'];
  movable: boolean;
}
export interface Candidate {
  id: string;
  w: number;
  d: number;
  h: number;
  rotY: 0 | 90;
  kind: CompactPart['kind'];
}
export function candidates(parts: CompactPart[]): Candidate[] {
  const out: Candidate[] = [];
  for (const part of standardPackingParts)
    if (parts.some((p) => p.id === part.id)) {
      const { w, d, h } = part.size!;
      out.push({ id: part.id, w, d, h, rotY: 0, kind: part.kind });
      if (w !== d) out.push({ id: part.id, w: d, d: w, h, rotY: 90, kind: part.kind });
    }
  return out;
}
export function options(value: unknown): PackOptions {
  const o = record(value);
  if (o.prefer !== undefined && !['plates', 'bricks'].includes(String(o.prefer)))
    throw new BuildFailure('RUNTIME', 'Invalid pack.prefer');
  if (o.top !== undefined && o.top !== 'studs' && o.top !== 'tiles' && !Array.isArray(o.top))
    throw new BuildFailure('RUNTIME', 'Invalid pack.top');
  if (Array.isArray(o.top))
    for (const region of o.top) {
      const r = record(region);
      for (const k of ['x', 'z', 'w', 'd']) integer(r[k], `top.${k}`, k === 'w' || k === 'd' ? 1 : undefined);
      if (r.top !== 'tiles' && r.top !== 'studs') throw new BuildFailure('RUNTIME', 'Invalid region top');
    }
  if (o.shell !== undefined) integer(o.shell, 'shell', 1);
  if (o.support !== undefined && o.support !== false) {
    const s = typeof o.support === 'number' ? { spacing: o.support } : record(o.support);
    integer(s.spacing, 'support.spacing', 1);
    if (s.width !== undefined) integer(s.width, 'support.width', 1);
  }
  return o as PackOptions;
}
function tiled(v: Voxels, opts: PackOptions, x: number, y: number, z: number) {
  if (v.get(x, y + 1, z)) return false;
  if (Array.isArray(opts.top)) {
    const r = [...opts.top].reverse().find((r) => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d);
    return r?.top === 'tiles';
  }
  return opts.top === 'tiles';
}
export function makePacked(
  c: Candidate,
  x: number,
  y: number,
  z: number,
  colorId: string,
  submodel: string | null,
): Packed {
  return {
    x,
    y,
    z,
    w: c.w,
    d: c.d,
    h: c.h,
    kind: c.kind,
    movable: true,
    instance: {
      partId: c.id,
      colorId,
      submodel,
      pose: { x: x + c.w / 2, z: z + c.d / 2, level: y + c.h, rotY: c.rotY },
    },
  };
}
function ordered(cs: Candidate[], course: number, variant = 0) {
  const alongX = (course + variant) % 2 === 0;
  return [...cs].sort(
    (a, b) => b.w * b.d - a.w * a.d || (alongX ? b.w - a.w : b.d - a.d) || a.id.localeCompare(b.id) || a.rotY - b.rotY,
  );
}
/** Greedy cover; consume only cells, never add volume or bridge color boundaries. */
export function pack(v: Voxels, cs: Candidate[], opts: PackOptions, submodel: string | null): Packed[] {
  const occupied = new Map<number, Set<number>>(),
    out: Packed[] = [],
    tops = new Map<number, Map<number, number>>();
  let bookkeeping = 0;
  const used = (x: number, y: number, z: number) => occupied.get(y)?.has(key(x, z)) ?? false;
  for (const y of v.sortedLevels()) {
    for (const [level, owners] of tops)
      if (level < y - 3) {
        v.budget.memory(-owners.size * 48);
        tops.delete(level);
      }
    const rows = [...v.cells(y)].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    v.budget.memory(rows.length * 64);
    const course = opts.prefer === 'plates' ? y : Math.floor(y / 3);
    const bricks = ordered(
        cs.filter((c) => c.kind === 'brick'),
        course,
      ),
      plates = ordered(
        cs.filter((c) => c.kind === 'plate'),
        course,
      ),
      tiles = ordered(
        cs.filter((c) => c.kind === 'tile'),
        course,
      );
    for (const [x, z, color] of rows) {
      v.budget.check();
      if (used(x, y, z)) continue;
      const wantTile = tiled(v, opts, x, y, z),
        choices = wantTile ? tiles : opts.prefer !== 'plates' && y % 3 === 0 ? [...bricks, ...plates] : plates;
      const fits = (c: Candidate) => {
        for (let dy = 0; dy < c.h; dy++)
          for (let dz = 0; dz < c.d; dz++)
            for (let dx = 0; dx < c.w; dx++)
              if (
                v.get(x + dx, y + dy, z + dz) !== color ||
                used(x + dx, y + dy, z + dz) ||
                tiled(v, opts, x + dx, y + dy, z + dz) !== (c.kind === 'tile')
              )
                return false;
        return true;
      };
      const seamCost = (c: Candidate) => {
        const previous = tops.get(y),
          older = tops.get(y - c.h);
        if (!previous || !older) return 0;
        let cost = 0;
        const edge = (ax: number, az: number, bx: number, bz: number) => {
          if (v.get(bx, y, bz) !== color) return;
          const a = key(ax, az),
            b = key(bx, bz);
          if (
            previous.has(a) &&
            previous.has(b) &&
            previous.get(a) !== previous.get(b) &&
            older.has(a) &&
            older.has(b) &&
            older.get(a) !== older.get(b)
          )
            cost++;
        };
        for (let dz = 0; dz < c.d; dz++) edge(x + c.w - 1, z + dz, x + c.w, z + dz);
        for (let dx = 0; dx < c.w; dx++) edge(x + dx, z + c.d - 1, x + dx, z + c.d);
        return cost;
      };
      let c: Candidate | undefined,
        best = Infinity;
      for (const candidate of choices)
        if (fits(candidate)) {
          const cost = seamCost(candidate);
          // Preserve brick preference; within one height prefer avoiding a third aligned seam,
          // then use the largest available rectangle in the alternating direction.
          if (c && candidate.h !== c.h) break;
          if (cost < best) {
            c = candidate;
            best = cost;
          }
          if (best === 0) break;
        }
      if (!c)
        throw new BuildFailure(
          'PART_NOT_ALLOWED',
          `No available ${wantTile ? 'tile' : 'brick/plate'} covers cell (${x},${y},${z}); include 1 x 1 pieces`,
        );
      v.budget.part();
      v.budget.memory(512);
      out.push(makePacked(c, x, y, z, v.colors[color]!, submodel));
      let surface = tops.get(y + c.h);
      if (!surface) {
        surface = new Map();
        tops.set(y + c.h, surface);
      }
      for (let dz = 0; dz < c.d; dz++)
        for (let dx = 0; dx < c.w; dx++) {
          surface.set(key(x + dx, z + dz), out.length);
          v.budget.memory(48);
        }
      for (let dy = 0; dy < c.h; dy++) {
        let layer = occupied.get(y + dy);
        if (!layer) {
          layer = new Set();
          occupied.set(y + dy, layer);
        }
        for (let dz = 0; dz < c.d; dz++)
          for (let dx = 0; dx < c.w; dx++) {
            layer.add(key(x + dx, z + dz));
            bookkeeping += 40;
          }
      }
      // The next two layers remain reserved while a brick is being packed.
      if (bookkeeping > 0) {
        v.budget.memory(bookkeeping);
        bookkeeping = 0;
      }
    }
    v.budget.memory(-rows.length * 64 - (occupied.get(y)?.size ?? 0) * 40);
    occupied.delete(y);
  }
  for (const owners of tops.values()) v.budget.memory(-owners.size * 48);
  return out;
}
/** Re-cover exactly two neighboring same-height courses for one bounded repair region. */
export function repackRegion(
  parts: Packed[],
  cs: Candidate[],
  variant: number,
  budget: Budget,
  reserved?: Packed,
): Packed[] | undefined {
  const groups = new Map<string, { base: Packed; cells: Set<number> }>();
  for (const p of parts) {
    const k = JSON.stringify([p.y, p.h, p.kind, p.instance.colorId, p.instance.submodel]);
    let group = groups.get(k);
    if (!group) {
      group = { base: p, cells: new Set() };
      groups.set(k, group);
    }
    for (let dz = 0; dz < p.d; dz++)
      for (let dx = 0; dx < p.w; dx++) {
        const x = p.x + dx,
          z = p.z + dz;
        if (
          reserved &&
          p.y === reserved.y &&
          x >= reserved.x &&
          x < reserved.x + reserved.w &&
          z >= reserved.z &&
          z < reserved.z + reserved.d
        )
          continue;
        group.cells.add(key(x, z));
      }
  }
  const result: Packed[] = [];
  for (const { base, cells } of groups.values()) {
    const sorted = [...cells].sort((a, b) => {
      const [ax, az] = unkey(a),
        [bx, bz] = unkey(b);
      return variant === 2 ? bz - az || bx - ax : az - bz || ax - bx;
    });
    const choices = ordered(
      cs.filter((c) => c.kind === base.kind && c.h === base.h),
      Math.floor(base.y / base.h),
      variant,
    );
    for (const k of sorted) {
      budget.check();
      if (!cells.has(k)) continue;
      const [anchorX, anchorZ] = unkey(k);
      let chosen: Candidate | undefined,
        x = anchorX,
        z = anchorZ;
      for (const c of choices) {
        const px = variant === 2 ? anchorX - c.w + 1 : anchorX,
          pz = variant === 2 ? anchorZ - c.d + 1 : anchorZ;
        let fit = true;
        for (let dz = 0; dz < c.d && fit; dz++)
          for (let dx = 0; dx < c.w; dx++)
            if (!cells.has(key(px + dx, pz + dz))) {
              fit = false;
              break;
            }
        if (fit) {
          chosen = c;
          x = px;
          z = pz;
          break;
        }
      }
      if (!chosen) return undefined;
      for (let dz = 0; dz < chosen.d; dz++) for (let dx = 0; dx < chosen.w; dx++) cells.delete(key(x + dx, z + dz));
      result.push(makePacked(chosen, x, base.y, z, base.instance.colorId, base.instance.submodel));
    }
  }
  return result;
}
export function isTopRegion(value: PackOptions['top']): value is TopRegion[] {
  return Array.isArray(value);
}
