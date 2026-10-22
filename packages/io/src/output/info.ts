import { orderedInstances, resolveContext, transformPoint } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { IoIssue } from '../issues';
import { collectScene } from './scene';
import { outputIssue, pointAt } from './geometry';
import type { GeometryContext, ScopeOptions } from './types';

export interface ModelInfoOptions extends ScopeOptions {
  lastCheck?: { errors: number; warnings: number };
}
export interface Dimensions {
  width: number;
  depth: number;
  height: number;
}
export interface ModelInfo {
  dimensions: {
    ldu: Dimensions;
    mm: Dimensions;
    cm: Dimensions;
    inches: Dimensions;
    studs: { width: number; depth: number };
    bricks: number;
    plates: number;
    includesStuds: true;
  };
  /** LDraw world axes, [minX,minY,minZ,maxX,maxY,maxZ]; null when no geometry is available. */
  boundsLdu: [number, number, number, number, number, number] | null;
  directReferences: number;
  totalParts: number;
  partTypes: number;
  colorCount: number;
  /** Definitions reachable in this scope, excluding the current model itself. */
  submodelDefinitions: number;
  submodelInstances: number;
  /** All definitions stored in the document, including unused submodels. */
  documentSubmodelDefinitions: number;
  lastCheck: { errors: number; warnings: number } | null;
  geometryComplete: boolean;
  issues: IoIssue[];
}
export async function calculateModelInfo(
  doc: BrkDocument,
  context: GeometryContext,
  options: ModelInfoOptions = {},
): Promise<ModelInfo> {
  const scene = collectScene(doc, options, true);
  const issues: IoIssue[] = [];
  const sources = new Map<string, Awaited<ReturnType<GeometryContext['meshProvider']>>>();
  const orientedBounds = new Map<string, [number, number, number, number, number, number]>();
  const bounds: [number, number, number, number, number, number] = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const node of scene.parts) {
    if (node.ref.kind !== 'part') continue;
    const partId = node.ref.partId;
    if (!sources.has(partId)) {
      const mesh = await context.meshProvider(partId);
      sources.set(partId, mesh);
      if (!mesh) issues.push(outputIssue('OUTPUT_GEOMETRY_MISSING', partId));
      else if (mesh.diagnostics.missing.length || mesh.diagnostics.cycles.length || mesh.diagnostics.warnings.length)
        issues.push(outputIssue('OUTPUT_GEOMETRY_INCOMPLETE', partId));
    }
    const mesh = sources.get(partId);
    if (!mesh) continue;
    // Exact vertex bounds depend on definition and linear transform, not translation.
    // Repeated instances share this work, including rotated/non-uniformly scaled geometry.
    const matrix = node.worldMatrix;
    const key = JSON.stringify([partId, ...Array.from(matrix.slice(0, 12))]);
    let oriented = orientedBounds.get(key);
    if (!oriented) {
      oriented = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const linear = matrix.slice();
      linear[12] = linear[13] = linear[14] = 0;
      const positions = [...mesh.batches, ...mesh.edges, mesh.conditionalEdges].map((batch) => batch.positions);
      for (const values of positions)
        for (let i = 0; i < values.length; i += 3) {
          const point = transformPoint(linear, pointAt(values, i));
          for (let axis = 0; axis < 3; axis++) {
            if (!Number.isFinite(point[axis])) throw new RangeError('Non-finite model bounds');
            oriented[axis] = Math.min(oriented[axis]!, point[axis]!);
            oriented[axis + 3] = Math.max(oriented[axis + 3]!, point[axis]!);
          }
        }
      orientedBounds.set(key, oriented);
    }
    for (let axis = 0; axis < 3; axis++) {
      const min = oriented[axis]! + matrix[12 + axis]!,
        max = oriented[axis + 3]! + matrix[12 + axis]!;
      if (oriented[0] !== Infinity && (!Number.isFinite(min) || !Number.isFinite(max)))
        throw new RangeError('Non-finite model bounds');
      bounds[axis] = Math.min(bounds[axis]!, min);
      bounds[axis + 3] = Math.max(bounds[axis + 3]!, max);
    }
  }
  const measured = bounds[0] !== Infinity;
  const dimensions = (scale: number): Dimensions =>
    measured
      ? {
          width: (bounds[3] - bounds[0]) * scale,
          depth: (bounds[5] - bounds[2]) * scale,
          height: (bounds[4] - bounds[1]) * scale,
        }
      : { width: 0, depth: 0, height: 0 };
  const ldu = dimensions(1),
    scope = options.scope ?? { kind: 'project' };
  let directReferences: number;
  if (scope.kind === 'selection') directReferences = scene.roots.length;
  else {
    const path = scope.kind === 'model' ? scope.path : [];
    const model = resolveContext(doc, { activeModelPath: path })!.model;
    directReferences = orderedInstances(model).filter(
      (instance) =>
        options.includeHidden !== false ||
        !options.workspace?.hidden.some((hidden) => {
          const full = [...path, instance.id];
          return hidden.length <= full.length && hidden.every((id, i) => full[i] === id);
        }),
    ).length;
  }
  const currentPath = scope.kind === 'model' ? JSON.stringify(scope.path) : null;
  const models = scene.models.filter((node) => JSON.stringify(node.path) !== currentPath);
  return {
    dimensions: {
      ldu,
      mm: dimensions(0.4),
      cm: dimensions(0.04),
      inches: dimensions(1 / 63.5),
      studs: { width: ldu.width / 20, depth: ldu.depth / 20 },
      bricks: ldu.height / 24,
      plates: ldu.height / 8,
      includesStuds: true,
    },
    boundsLdu: measured ? bounds : null,
    directReferences,
    totalParts: scene.parts.length,
    partTypes: new Set(scene.parts.flatMap((node) => (node.ref.kind === 'part' ? [node.ref.partId] : []))).size,
    colorCount: new Set(scene.parts.map((node) => node.colorId)).size,
    submodelDefinitions: new Set(models.flatMap((node) => (node.ref.kind === 'model' ? [node.ref.modelId] : []))).size,
    submodelInstances: models.length,
    documentSubmodelDefinitions: Object.values(doc.models).filter((model) => model.id !== doc.rootModelId).length,
    lastCheck: options.lastCheck ? { ...options.lastCheck } : null,
    geometryComplete: issues.length === 0,
    issues,
  };
}
