import { type Budget, BuildFailure, integer, record } from './limits.js';
import { ColorMapper } from './colors.js';
import { Shapes } from './shapes.js';
import { Voxels } from './voxels.js';
import { compose, identity, point, pose, placementTransform, transform, type Transform } from './transform.js';
import { candidates, options, pack, type Packed } from './packing.js';
import { floatingWarnings, graph, repair, seams } from './quality.js';
import { hollow } from './hollow.js';
import { bridgePacking } from './bridging.js';
import { standardPackingParts } from './standard-parts.js';
import type {
  BuildOptions,
  BuildInstance,
  BuildResult,
  BuildSubmodel,
  BuildWarning,
  CompactPart,
  PackOptions,
} from './types.js';

interface Model {
  name: string | null;
  voxels: Voxels;
  explicit: BuildInstance[];
  placements: BuildSubmodel['instances'];
  opts: PackOptions;
}
export class Engine {
  readonly warnings: BuildWarning[] = [];
  readonly parts: CompactPart[];
  readonly colors: ColorMapper;
  readonly models = new Map<string | null, Model>();
  private current: Model;
  private readonly stack: { model: Model; t: Transform }[] = [];
  private t: Transform = { ...identity };
  constructor(
    readonly options: BuildOptions,
    readonly budget: Budget,
  ) {
    this.parts = options.catalog.parts.filter((p) => options.scope === 'all' || p.factory);
    this.colors = new ColorMapper(
      options.catalog.colors.filter((c) => options.scope === 'all' || c.factory),
      options.catalog.colors,
      this.warnings,
      budget,
    );
    this.current = this.newModel(null);
  }
  private newModel(name: string | null): Model {
    this.budget.memory(1024);
    const model = { name, voxels: new Voxels(this.budget), explicit: [], placements: [], opts: {} };
    this.models.set(name, model);
    return model;
  }
  invoke(name: string, args: unknown[]): unknown {
    this.budget.check();
    if (name === 'color') return this.colors.resolve(args[0]);
    if (name === 'find') {
      const q = record(args[0]),
        size = record(q.size);
      return this.parts
        .filter(
          (p) =>
            (q.category === undefined || p.category.toLowerCase() === String(q.category).toLowerCase()) &&
            Object.entries(size).every(([k, v]) => p.size?.[k as keyof typeof p.size] === v) &&
            (q.tags === undefined || (Array.isArray(q.tags) && q.tags.every((tag) => p.tags?.includes(String(tag))))),
        )
        .slice(0, 50)
        .map((p) => ({ id: p.id, name: p.name, ...(p.size ? { size: p.size } : {}), tags: p.tags ?? [] }));
    }
    if (name === 'part') {
      const id = String(args[0]),
        p = this.parts.find((p) => p.id === id);
      if (!p) {
        const requested =
          this.options.catalog.parts.find((p) => p.id === id) ?? standardPackingParts.find((p) => p.id === id);
        const distance = (p: CompactPart) => {
          const a = p.size,
            b = requested?.size;
          return (
            (p.category === requested?.category ? 0 : 1000) +
            (a && b ? Math.abs(a.w - b.w) + Math.abs(a.d - b.d) + Math.abs(a.h - b.h) : 100)
          );
        };
        const suggestions = [...this.parts]
          .sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id))
          .slice(0, 3)
          .map((p) => p.id);
        this.budget.fatal = new BuildFailure(
          'PART_NOT_ALLOWED',
          `Part ${id} is outside the selected scope`,
          suggestions,
        );
        throw this.budget.fatal;
      }
      const placed: BuildInstance = {
        partId: id,
        colorId: this.colors.resolve(args[2]),
        pose: pose(
          args[1],
          this.t,
          standardPackingParts.some((p) => p.id === id),
        ),
        submodel: this.current.name,
      };
      this.budget.part();
      this.budget.memory(512);
      this.current.explicit.push(placed);
      return null;
    }
    if (name === 'enterModel') {
      if (typeof args[0] !== 'string' || !args[0] || args[0].length > 128)
        throw new BuildFailure('RUNTIME', 'Submodel name must contain 1–128 characters');
      if (this.models.has(args[0])) throw new BuildFailure('RUNTIME', `Duplicate submodel: ${args[0]}`);
      this.stack.push({ model: this.current, t: this.t });
      this.current = this.newModel(args[0]);
      this.t = { ...identity };
      return null;
    }
    if (name === 'enterTransform') {
      const next = compose(this.t, transform(args[0]));
      this.stack.push({ model: this.current, t: this.t });
      this.t = next;
      return null;
    }
    if (name === 'leave') {
      const previous = this.stack.pop();
      if (!previous) throw new BuildFailure('RUNTIME', 'Unbalanced scope');
      this.current = previous.model;
      this.t = previous.t;
      return null;
    }
    if (name === 'instance') {
      if (typeof args[0] !== 'string') throw new BuildFailure('RUNTIME', 'Instance name must be a string');
      const placed = pose(args[1], this.t);
      this.budget.memory(256);
      this.budget.part();
      this.current.placements.push({ name: args[0], pose: placed });
      return null;
    }
    if (name === 'pack') {
      this.current.opts = options(args[0]);
      return null;
    }
    const shapes = new Shapes(this.current.voxels, this.t, (v) => this.colors.resolve(v));
    if (name === 'clear') {
      if (typeof args[0] === 'string') shapes.call(args[0], args.slice(1), true);
      else shapes.call(args.length >= 6 ? 'box' : 'cell', args, true);
    } else shapes.call(name, args);
    return null;
  }
  finish(): BuildResult {
    this.budget.check();
    const cs = candidates(this.parts),
      packed = new Map<string | null, Packed[]>(),
      beforePacked = new Map<string | null, Packed[]>(),
      instances: BuildInstance[] = [];
    let voxels = 0,
      repairedRegions = 0,
      bridgedRegions = 0;
    const hollowStats = { addedVoxels: 0, coreVoxels: 0, partsBefore: 0, partsAfter: 0, partsDelta: 0 };
    for (const model of this.models.values()) {
      const plan = hollow(model.voxels, model.opts);
      let shapeParts = pack(model.voxels, cs, model.opts, model.name);
      if (plan) {
        hollowStats.partsBefore += shapeParts.length + model.explicit.length;
        const added = plan.thicken();
        hollowStats.addedVoxels += added;
        if (added) {
          this.budget.parts -= shapeParts.length;
          this.budget.memory(-shapeParts.length * 512);
          shapeParts = pack(model.voxels, cs, model.opts, model.name);
        }
      }
      const explicit: Packed[] = [];
      for (const i of model.explicit) {
        const p = this.parts.find((p) => p.id === i.partId)!,
          s = standardPackingParts.find((p) => p.id === i.partId)?.size ?? p.size;
        if (!s) {
          this.warnings.push({
            code: 'CONNECTIVITY_UNKNOWN',
            message: `No footprint for explicit part ${p.id}; connectivity not checked`,
            submodel: model.name,
          });
          instances.push(i);
          continue;
        }
        integer(s.w, 'part.size.w', 1);
        integer(s.d, 'part.size.d', 1);
        integer(s.h, 'part.size.h', 1);
        const rotated = i.pose.rotY % 180 !== 0,
          w = rotated ? s.d : s.w,
          d = rotated ? s.w : s.d;
        explicit.push({
          x: i.pose.x - w / 2,
          z: i.pose.z - d / 2,
          y: i.pose.level - s.h,
          w,
          d,
          h: s.h,
          kind: p.kind,
          movable: false,
          instance: i,
        });
      }
      let connected = bridgePacking([...shapeParts, ...explicit], cs, this.budget);
      if (plan && model.opts.support !== false)
        for (const local of [true, false]) {
          if (!connected.graph.floating.length || connected.graph.floating.length === connected.graph.components.length)
            break;
          const levels = new Set<number>();
          if (local)
            for (const ids of connected.graph.floating)
              for (const id of ids) {
                const p = connected.parts[id]!;
                for (let y = p.y - 1; y <= p.y + p.h; y++) levels.add(y);
              }
          const added = plan.restoreCore(local ? levels : undefined);
          if (added) {
            const previous = connected.parts.length - explicit.length;
            this.budget.parts -= previous;
            this.budget.memory(-previous * 512);
            const core = bridgePacking(
              [...pack(model.voxels, cs, model.opts, model.name), ...explicit],
              cs,
              this.budget,
            );
            if (core.graph.floating.length < connected.graph.floating.length) {
              hollowStats.addedVoxels += added;
              hollowStats.coreVoxels += added;
              connected = core;
              plan.acceptCore();
            } else {
              const delta = connected.parts.length - core.parts.length;
              this.budget.parts += delta;
              this.budget.memory(delta * 512);
              plan.removeCore();
            }
          }
        }
      plan?.release();
      voxels += model.voxels.size;
      bridgedRegions += connected.regions;
      const raw = connected.parts;
      beforePacked.set(model.name, raw);
      const fixed = repair(raw, cs, this.budget);
      repairedRegions += fixed.repairedRegions;
      instances.push(...fixed.parts.map((p) => p.instance));
      packed.set(model.name, fixed.parts);
    }
    // Validate all definitions (including unused ones) and expand placements for world-space connectivity.
    const visiting = new Set<string | null>(),
      visited = new Set<string | null>();
    const validate = (name: string | null, depth: number) => {
      this.budget.check();
      if (depth > 128 || visiting.has(name))
        throw new BuildFailure('RUNTIME', 'Submodel cycle or nesting deeper than 128');
      if (visited.has(name)) return;
      const m = this.models.get(name);
      if (!m) throw new BuildFailure('RUNTIME', `Unknown submodel: ${name}`);
      visiting.add(name);
      for (const p of m.placements) validate(p.name, depth + 1);
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of this.models.keys()) validate(name, 0);
    let expandedCount = 0;
    const expand = (name: string | null, t: Transform, source: Map<string | null, Packed[]>, world: Packed[]) => {
      this.budget.check();
      const model = this.models.get(name)!;
      expandedCount +=
        (source.get(name)?.length ?? 0) +
        model.explicit.filter(
          (i) =>
            !this.parts.find((p) => p.id === i.partId)?.size &&
            !standardPackingParts.find((p) => p.id === i.partId)?.size,
        ).length;
      if (expandedCount > this.budget.limits.maxParts) this.budget.fail('LIMIT', 'Expanded model part limit exceeded');
      for (const p of source.get(name) ?? []) {
        this.budget.check();
        if (world.length >= this.budget.limits.maxParts)
          this.budget.fail('LIMIT', 'Expanded model part limit exceeded');
        const [a, b] = point(t, p.x + p.w / 2, p.z + p.d / 2),
          turn = t.a === 0,
          w = turn ? p.d : p.w,
          d = turn ? p.w : p.d;
        world.push({ ...p, x: a - w / 2, z: b - d / 2, y: p.y + t.y, w, d });
      }
      for (const p of model.placements) expand(p.name, compose(t, placementTransform(p.pose)), source, world);
    };
    const world: Packed[] = [],
      beforeWorld: Packed[] = [];
    expand(null, identity, packed, world);
    expandedCount = 0;
    expand(null, identity, beforePacked, beforeWorld);
    const initialGraph = graph(beforeWorld, this.budget);
    let finalGraph = graph(world, this.budget);
    // Shared definitions can attach to surrounding geometry at multiple placements.
    // Reject locally beneficial repairs if they weaken those world-space attachments.
    if (
      finalGraph.weak.total > initialGraph.weak.total ||
      finalGraph.floating.length > initialGraph.floating.length ||
      finalGraph.components.length > initialGraph.components.length
    ) {
      repairedRegions = 0;
      finalGraph = initialGraph;
      world.splice(0, world.length, ...beforeWorld);
      const unknown = instances.filter(
        (i) =>
          !this.parts.find((p) => p.id === i.partId)?.size &&
          !standardPackingParts.find((p) => p.id === i.partId)?.size,
      );
      instances.length = 0;
      instances.push(...unknown);
      for (const [name, rows] of beforePacked) {
        packed.set(name, rows);
        instances.push(...rows.map((p) => p.instance));
      }
    }
    this.warnings.push(...floatingWarnings(world, finalGraph));
    for (const instance of instances) if (this.models.get(instance.submodel)!.opts.hollow) hollowStats.partsAfter++;
    hollowStats.partsDelta = hollowStats.partsAfter - hollowStats.partsBefore;
    // Count repair quality in instantiated world space, including explicit parts.
    const seamCounts = { seamsThroughThreeCourses: 0, maxSeamCourses: 0 };
    for (const rows of packed.values()) {
      const s = seams(rows, this.budget);
      seamCounts.seamsThroughThreeCourses += s.seamsThroughThreeCourses;
      seamCounts.maxSeamCourses = Math.max(seamCounts.maxSeamCourses, s.maxSeamCourses);
    }
    const submodels = [...this.models.values()].map((m) => ({ name: m.name, instances: m.placements }));
    const byKind: Record<string, number> = {};
    for (const i of instances) {
      const kind = this.parts.find((p) => p.id === i.partId)!.kind;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const canonical = JSON.stringify({ instances, submodels });
    // Two independent 32-bit FNV-style streams; timings and diagnostics do not enter the hash.
    let a = 0x811c9dc5,
      b = 0x9e3779b9;
    for (let i = 0; i < canonical.length; i++) {
      if ((i & 8191) === 0) this.budget.check();
      const c = canonical.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x85ebca6b);
    }
    return {
      ok: true,
      instances,
      submodels,
      hash: [a, b].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join(''),
      warnings: this.warnings,
      stats: {
        parts: instances.length,
        byKind,
        colors: new Set(instances.map((i) => i.colorId)).size,
        voxels,
        ms: performance.now() - this.budget.started,
        quality: {
          components: finalGraph.components.length,
          floatingComponents: finalGraph.floating.length,
          connections: finalGraph.connections,
          weakBefore: initialGraph.weak,
          weakAfter: finalGraph.weak,
          repairedRegions,
          bridgedRegions,
          hollow: hollowStats,
          ...seamCounts,
          uncheckedParts: this.warnings.filter((w) => w.code === 'CONNECTIVITY_UNKNOWN').length,
        },
      },
    };
  }
}
