import { expandInstances, pathStartsWith } from '@brickloop/core';
import type { BrkDocument, InstancePath } from '@brickloop/core';
import type { Aabb, CollisionResult, Vec3 } from './types.js';
import { pathKey } from './world.js';

export type IssueKind =
  | 'collision'
  | 'collisionUnknown'
  | 'floating'
  | 'nonFactoryPart'
  | 'nonFactoryColor'
  | 'unavailableColor'
  | 'duplicate'
  | 'missingGeometry'
  | 'unreviewedConnectors'
  | 'offGrid';
export interface Issue {
  kind: IssueKind;
  severity: 'error' | 'warning' | 'info';
  paths: InstancePath[];
  messageKey: `check.${IssueKind}`;
  data: Record<string, unknown>;
}
export interface CheckContext {
  catalog?: {
    isFactoryPart(partId: string): boolean;
    isFactoryColor(colorId: string): boolean;
    availableColors(partId: string): readonly (string | { id: string })[];
  };
  geometry?: (
    partId: string,
    path: InstancePath,
  ) => { missing: readonly (readonly string[])[]; bounds?: Aabb } | undefined;
  connectivity?: {
    components(scope: InstancePath[]): InstancePath[][];
    /** false means inferred; undefined means no known review state (not a false positive). */
    isConnectorDataReviewed(partId: string): boolean | undefined;
  };
  collisionWorld?: {
    queryAll(paths?: readonly InstancePath[], options?: { enabled?: boolean; budgetMs?: number }): CollisionResult;
    bounds?(path: InstancePath): Aabb | undefined;
  };
  /** Full, non-inset world geometry bounds, if not supplied by collisionWorld. */
  worldBounds?: (path: InstancePath) => Aabb | undefined;
}
export interface CheckOptions {
  scope?: 'project' | 'currentModel' | 'selection';
  activeModelPath?: InstancePath;
  selection?: readonly InstancePath[];
  visibleOnly?: boolean;
  hidden?: readonly InstancePath[];
  groundIsFixed?: boolean;
  groundY?: number;
  groundTolerance?: number;
  collisionEnabled?: boolean;
  collisionBudgetMs?: number;
  /** World-space grid; false disables this check. Defaults to 20/8/20 LDU. */
  grid?: false | { step: number | Vec3; origin?: Vec3; tolerance?: number };
  kinds?: readonly IssueKind[];
}
export const issueMessagesZh: Record<`check.${IssueKind}`, string> = {
  'check.collision': '零件发生穿模。',
  'check.collisionUnknown': '无法判断碰撞：缺少代理、代理近似或计算未完成。',
  'check.floating': '零件悬空或未与主体连接。',
  'check.nonFactoryPart': '当前工厂数据包不包含此零件，或此零件已停产。',
  'check.nonFactoryColor': '当前工厂数据包不包含此颜色。',
  'check.unavailableColor': '当前工厂无法生产此零件与颜色的组合。',
  'check.duplicate': '相同零件、颜色和位置存在重叠重复实例。',
  'check.missingGeometry': '零件几何文件缺失。',
  'check.unreviewedConnectors': '零件使用了尚未审核的连接数据。',
  'check.offGrid': '零件位置偏离当前网格。',
};

export function runChecks(doc: BrkDocument, ctx: CheckContext, options: CheckOptions = {}): Issue[] {
  const issues: Issue[] = [],
    kinds = options.kinds ? new Set(options.kinds) : undefined;
  const want = (kind: IssueKind): boolean => !kinds || kinds.has(kind);
  const emit = (
    kind: IssueKind,
    severity: Issue['severity'],
    paths: InstancePath[],
    data: Issue['data'] = {},
  ): void => {
    if (want(kind)) issues.push({ kind, severity, paths, messageKey: `check.${kind}`, data });
  };
  const rows = expandInstances(doc).filter((row) => {
    if (options.visibleOnly && options.hidden?.some((path) => pathStartsWith(row.path, path))) return false;
    if (options.scope === 'currentModel') return pathStartsWith(row.path, options.activeModelPath ?? []);
    if (options.scope === 'selection')
      return options.selection?.some((path) => pathStartsWith(row.path, path)) ?? false;
    return true;
  });
  const grid = options.grid === false ? undefined : (options.grid ?? { step: [20, 8, 20] as Vec3 });
  const steps = grid ? (typeof grid.step === 'number' ? [grid.step, grid.step, grid.step] : grid.step) : undefined;
  if (steps?.some((step) => !Number.isFinite(step) || step <= 0)) throw new RangeError('Grid steps must be positive');
  const duplicates = new Map<string, InstancePath[]>();
  for (const row of rows) {
    const { partId, colorId, path } = row;
    if (ctx.catalog && (want('nonFactoryPart') || want('nonFactoryColor') || want('unavailableColor'))) {
      const factoryPart = ctx.catalog.isFactoryPart(partId),
        factoryColor = ctx.catalog.isFactoryColor(colorId);
      if (!factoryPart) emit('nonFactoryPart', 'error', [path], { partId });
      if (!factoryColor) emit('nonFactoryColor', 'error', [path], { colorId });
      if (
        factoryPart &&
        factoryColor &&
        !ctx.catalog.availableColors(partId).some((color) => (typeof color === 'string' ? color : color.id) === colorId)
      )
        emit('unavailableColor', 'warning', [path], { partId, colorId });
    }
    if (want('missingGeometry')) {
      const geometry = ctx.geometry?.(partId, path);
      if (geometry?.missing.length)
        emit('missingGeometry', 'error', [path], {
          partId,
          files: [...new Set(geometry.missing.map((chain) => chain[chain.length - 1]))],
          chains: geometry.missing,
        });
    }
    if (want('unreviewedConnectors') && ctx.connectivity?.isConnectorDataReviewed(partId) === false)
      emit('unreviewedConnectors', 'info', [path], { partId });
    if (want('duplicate')) {
      // Document transforms are authoritative; do not silently merge nearby but different instances.
      const key = JSON.stringify([partId, colorId, Array.from(row.worldMatrix)]);
      const paths = duplicates.get(key) ?? [];
      paths.push(path);
      duplicates.set(key, paths);
    }
    if (grid && steps && want('offGrid')) {
      const position: Vec3 = [row.worldMatrix[12]!, row.worldMatrix[13]!, row.worldMatrix[14]!],
        origin = grid.origin ?? [0, 0, 0];
      if (
        position.some(
          (value, i) =>
            Math.abs(value - origin[i]! - Math.round((value - origin[i]!) / steps[i]!) * steps[i]!) >
            (grid.tolerance ?? 1e-4),
        )
      )
        emit('offGrid', 'info', [path], { position, step: steps, origin });
    }
  }
  for (const paths of duplicates.values())
    if (paths.length > 1) emit('duplicate', 'warning', paths, { count: paths.length });
  const paths = rows.map((row) => row.path);
  if (ctx.connectivity && want('floating') && paths.length) {
    const scope = new Set(paths.map(pathKey)),
      covered = new Set<string>();
    const components = ctx.connectivity
      .components(paths)
      .map((component) =>
        component.filter((path) => {
          const key = pathKey(path);
          if (!scope.has(key) || covered.has(key)) return false;
          covered.add(key);
          return true;
        }),
      )
      .filter((component) => component.length);
    for (const path of paths) if (!covered.has(pathKey(path))) components.push([path]);
    components.sort((a, b) => b.length - a.length || pathKey(a[0]!).localeCompare(pathKey(b[0]!)));
    for (const component of components.slice(1)) {
      const grounded =
        options.groundIsFixed &&
        component.some((path) => {
          const bounds = ctx.worldBounds?.(path) ?? ctx.collisionWorld?.bounds?.(path);
          return (
            bounds !== undefined && Math.abs(bounds[4] - (options.groundY ?? 0)) <= (options.groundTolerance ?? 0.5)
          );
        });
      if (!grounded) emit('floating', 'error', component, { count: component.length });
    }
  }
  if (ctx.collisionWorld && options.collisionEnabled !== false && (want('collision') || want('collisionUnknown'))) {
    const result = ctx.collisionWorld.queryAll(paths, {
      enabled: true,
      ...(options.collisionBudgetMs === undefined ? {} : { budgetMs: options.collisionBudgetMs }),
    });
    for (const pair of result.pairs)
      if (pair.status === 'hit') emit('collision', 'error', [pair.a, pair.b], { shapes: pair.shapes });
    // Unknown is a warning, separate from confirmed penetration errors; preserves partial hits.
    if (result.status === 'unknown')
      emit('collisionUnknown', 'warning', result.unknownPaths, {
        reasons: result.reasons,
        pairs: result.pairs.filter((pair) => pair.status === 'unknown'),
      });
  }
  return issues;
}
export const check = { run: runChecks };
