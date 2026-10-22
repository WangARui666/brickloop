import { invert } from '@brickloop/core';
import type { InstancePath, Matrix4 } from '@brickloop/core';
import { overlaps, shapeBounds, shapesBounds, transformBounds, transformShape } from './math.js';
import { intersectShapes } from './narrow.js';
import { DynamicAabbTree } from './tree.js';
import type {
  Aabb,
  Collider,
  ColliderShape,
  CollisionInstance,
  CollisionPair,
  CollisionPreview,
  CollisionResult,
  QueryOptions,
  UnknownReason,
} from './types.js';

export const pathKey = (path: readonly string[]): string => JSON.stringify(path);
interface Entry {
  path: InstancePath;
  shapes: readonly ColliderShape[];
  shapeBounds: Aabb[];
  bounds: Aabb | undefined;
  approximate: boolean;
  missing: boolean;
  localTree?: DynamicAabbTree;
  inverse?: Matrix4;
}
export interface CollisionWorldOptions extends QueryOptions {
  instances?: Iterable<CollisionInstance>;
  /** Return all leaves for a changed submodel occurrence, or undefined for a deletion. */
  resolve?: (path: InstancePath) => CollisionInstance | readonly CollisionInstance[] | undefined;
  now?: () => number;
}
const emptyResult = (): CollisionResult => ({
  status: 'none',
  pairs: [],
  unknownPaths: [],
  reasons: [],
  testedPairs: 0,
});

export class CollisionWorld {
  enabled: boolean;
  private readonly entries = new Map<string, Entry>();
  private readonly prefixes = new Map<string, Set<string>>();
  private readonly unbounded = new Set<string>();
  private readonly tree = new DynamicAabbTree();
  private readonly shapeTrees = new WeakMap<Collider, DynamicAabbTree>();
  // Persistent contacts, as in a dirty-proxy broad phase. set/remove replace
  // entries, so changing either endpoint invalidates only its incident pairs.
  // Keep direction: the first narrow-phase witness can depend on query order.
  private readonly pairs = new WeakMap<Entry, WeakMap<Entry, Omit<CollisionPair, 'a' | 'b'>>>();
  private readonly now: () => number;
  constructor(private readonly options: CollisionWorldOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => performance.now());
    for (const instance of options.instances ?? []) this.set(instance);
  }
  get size(): number {
    return this.entries.size;
  }
  /** Original geometry bounds, when supplied; used for ground contact without the 0.5 LDU inset. */
  bounds(path: InstancePath): Aabb | undefined {
    return this.geometryBounds.get(pathKey(path));
  }
  private readonly geometryBounds = new Map<string, Aabb>();
  set(instance: CollisionInstance): void {
    const key = pathKey(instance.path);
    this.removeKey(key);
    const transformed = (instance.collider?.shapes ?? []).map((shape) => transformShape(shape, instance.transform));
    const shapes = transformed.map((item) => item.shape);
    const localBounds = instance.bounds ?? instance.collider?.bounds;
    const geometryBounds = localBounds ? transformBounds(localBounds, instance.transform) : undefined;
    if (geometryBounds) this.geometryBounds.set(key, geometryBounds);
    const missing = shapes.length === 0;
    const bounds = shapesBounds(shapes) ?? geometryBounds;
    const entry: Entry = {
      path: [...instance.path],
      shapes,
      shapeBounds: shapes.map(shapeBounds),
      bounds,
      approximate: (instance.collider?.approximate ?? false) || transformed.some((item) => item.approximate),
      missing,
    };
    if (instance.collider && !missing && !transformed.some((item) => item.approximate)) {
      let localTree = this.shapeTrees.get(instance.collider);
      if (!localTree) {
        localTree = new DynamicAabbTree();
        for (const [index, shape] of instance.collider.shapes.entries())
          localTree.set(String(index), shapeBounds(shape));
        this.shapeTrees.set(instance.collider, localTree);
      }
      entry.localTree = localTree;
      entry.inverse = invert(instance.transform);
    }
    this.entries.set(key, entry);
    if (bounds) this.tree.set(key, bounds);
    else this.unbounded.add(key);
    for (let i = 0; i <= instance.path.length; i++) {
      const prefix = pathKey(instance.path.slice(0, i));
      const leaves = this.prefixes.get(prefix) ?? new Set<string>();
      leaves.add(key);
      this.prefixes.set(prefix, leaves);
    }
  }
  remove(path: InstancePath): void {
    for (const key of [...(this.prefixes.get(pathKey(path)) ?? [])]) this.removeKey(key);
  }
  private removeKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.tree.delete(key);
    this.unbounded.delete(key);
    this.geometryBounds.delete(key);
    for (let i = 0; i <= entry.path.length; i++) {
      const prefix = pathKey(entry.path.slice(0, i)),
        leaves = this.prefixes.get(prefix);
      leaves?.delete(key);
      if (leaves?.size === 0) this.prefixes.delete(prefix);
    }
  }
  /** The host supplies every affected occurrence after a shared definition edit. */
  update(changedPaths: readonly InstancePath[]): void {
    if (!this.options.resolve) throw new Error('CollisionWorld.update requires a resolve callback');
    for (const path of changedPaths) {
      const replacement = this.options.resolve(path);
      this.remove(path);
      if (replacement) {
        if (Array.isArray(replacement)) for (const instance of replacement) this.set(instance);
        else this.set(replacement as CollisionInstance);
      }
    }
  }
  query(target: InstancePath | CollisionPreview, options: QueryOptions = {}): CollisionResult {
    if (!(options.enabled ?? this.enabled)) return emptyResult();
    const started = this.now();
    if (Array.isArray(target)) {
      const leaves = this.prefixes.get(pathKey(target));
      return this.run(
        leaves
          ? [...leaves].map((key) => this.entries.get(key)!)
          : [{ path: target, shapes: [], shapeBounds: [], bounds: undefined, approximate: false, missing: true }],
        options,
        started,
      );
    }
    const entry: Entry = {
      path: target.path ?? ['$preview'],
      shapes: target.shapes,
      shapeBounds: target.shapes.map(shapeBounds),
      bounds: shapesBounds(target.shapes),
      approximate: target.approximate ?? false,
      missing: target.shapes.length === 0,
    };
    const excluded = new Set<string>();
    for (const path of target.excludePaths ?? [])
      for (const key of this.prefixes.get(pathKey(path)) ?? []) excluded.add(key);
    return this.run([entry], options, started, undefined, excluded);
  }
  /** Restricts both ends to scope, deduplicates pairs, and shares one time budget. */
  queryAll(paths?: readonly InstancePath[], options: QueryOptions = {}): CollisionResult {
    if (!(options.enabled ?? this.enabled)) return emptyResult();
    const started = this.now();
    const scope = paths ? new Set(paths.map(pathKey)) : undefined;
    const targets = paths
      ? paths.map(
          (path): Entry =>
            this.entries.get(pathKey(path)) ?? {
              path,
              shapes: [],
              shapeBounds: [],
              bounds: undefined,
              approximate: false,
              missing: true,
            },
        )
      : this.entries.values();
    return this.run(targets, options, started, scope);
  }
  private run(
    targets: Iterable<Entry>,
    options: QueryOptions,
    started: number,
    scope?: Set<string>,
    excluded = new Set<string>(),
  ): CollisionResult {
    const result = emptyResult(),
      unknown = new Map<string, InstancePath>(),
      reasons = new Set<UnknownReason>(),
      visited = new Set<string>();
    const budget = options.budgetMs ?? this.options.budgetMs ?? Infinity;
    if (Number.isNaN(budget) || budget < 0) throw new RangeError('budgetMs must be nonnegative');
    const deadline = started + budget;
    const expired = (): boolean => this.now() >= deadline;
    const mark = (reason: UnknownReason, ...paths: InstancePath[]): void => {
      reasons.add(reason);
      for (const path of paths) unknown.set(pathKey(path), path);
    };
    let outOfTime = false;
    for (const a of targets) {
      if (outOfTime || expired()) {
        outOfTime = true;
        mark('budget', a.path);
        continue;
      }
      if (a.missing) mark('missing-proxy', a.path);
      const aKey = pathKey(a.path);
      const candidates = a.bounds ? this.candidates(a.bounds) : this.entries.keys();
      for (const bKey of candidates) {
        if (expired()) {
          outOfTime = true;
          mark('budget', a.path);
          break;
        }
        if (bKey === undefined || bKey === aKey || excluded.has(bKey) || (scope && !scope.has(bKey))) continue;
        const pairKey = JSON.stringify(aKey < bKey ? [aKey, bKey] : [bKey, aKey]);
        if (visited.has(pairKey)) continue;
        visited.add(pairKey);
        const b = this.entries.get(bKey)!;
        if (a.bounds && b.bounds && !overlaps(a.bounds, b.bounds)) continue;
        result.testedPairs++;
        const committed = this.entries.get(aKey) === a;
        const cached = committed ? this.pairs.get(a)?.get(b) : undefined;
        const pair: CollisionPair = {
          a: a.path,
          b: b.path,
          status: cached?.status ?? 'hit',
          shapes: cached?.shapes.map((shape) => ({ ...shape })) ?? [],
          ...(cached?.reason ? { reason: cached.reason } : {}),
        };
        // Budget checks above still apply to cached work. Preview entries never
        // share contacts with the committed proxy at the same path.
        if (!cached && (a.missing || b.missing)) {
          pair.status = 'unknown';
          pair.reason = 'missing-proxy';
        } else if (!cached) {
          let stop = false;
          for (let i = 0; i < a.shapes.length && !stop; i++)
            for (const candidate of this.shapeCandidates(a.shapeBounds[i]!, b)) {
              if (expired()) {
                pair.status = 'unknown';
                pair.reason = 'budget';
                outOfTime = true;
                stop = true;
                break;
              }
              if (candidate === undefined) continue;
              const j = candidate;
              if (!overlaps(a.shapeBounds[i]!, b.shapeBounds[j]!)) continue;
              const status = intersectShapes(a.shapes[i]!, b.shapes[j]!);
              if (status === 'none') continue;
              pair.shapes.push({ a: i, b: j });
              if (status === 'unknown' || a.approximate || b.approximate) {
                pair.status = 'unknown';
                pair.reason = status === 'unknown' ? 'numerical' : 'approximate';
              }
              // One witness establishes collision of this pair; shape indices locate the witness.
              stop = true;
              break;
            }
        }
        if (committed && !cached && pair.reason !== 'budget') {
          let pairs = this.pairs.get(a);
          if (!pairs) this.pairs.set(a, (pairs = new WeakMap()));
          pairs.set(b, {
            status: pair.status,
            shapes: pair.shapes.map((shape) => ({ ...shape })),
            ...(pair.reason ? { reason: pair.reason } : {}),
          });
        }
        if (pair.reason) {
          mark(pair.reason, a.path, b.path);
          result.pairs.push(pair);
        } else if (pair.shapes.length) result.pairs.push(pair);
        if (outOfTime) break;
      }
    }
    result.unknownPaths = [...unknown.values()];
    result.reasons = [...reasons];
    result.status = reasons.size ? 'unknown' : result.pairs.length ? 'hit' : 'none';
    return result;
  }
  private *candidates(bounds: Aabb): Generator<string | undefined> {
    yield* this.tree.search(bounds);
    yield* this.unbounded;
  }
  private *shapeCandidates(bounds: Aabb, entry: Entry): Generator<number | undefined> {
    if (entry.localTree && entry.inverse) {
      const localBounds = transformBounds(bounds, entry.inverse);
      for (const key of entry.localTree.search(localBounds)) yield key === undefined ? undefined : Number(key);
    } else for (let index = 0; index < entry.shapes.length; index++) yield index;
  }
}
