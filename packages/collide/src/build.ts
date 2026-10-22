import { fromLDraw, identity, multiply } from '@brickloop/core';
import type { Matrix4 } from '@brickloop/core';
import { normalizeFileName, parseLDraw } from '@brickloop/ldraw';
import type { LibraryResolver, PartMesh, ResolvedFile } from '@brickloop/ldraw';
import { add, boxFromBounds, cross, perpendicular, scale, transformShape } from './math.js';
import { SolidSampler, voxelBoxes } from './solid.js';
import { GENERATOR_VERSION } from './types.js';
import type { Collider, ColliderBuildOptions, ColliderShape, Vec3 } from './types.js';
import { parseColliderOverride } from './validation.js';

/** URL encoding avoids the ':' in PartId on Windows and keeps namespaces distinct. */
export const colliderFileName = (partId: string): string => `${encodeURIComponent(partId)}.collider.json`;
export const partIdForFile = (file: string): string => `ld:${normalizeFileName(file).replace(/\.dat$/i, '')}`;

function insetCylinder(shape: Extract<ColliderShape, { kind: 'cylinder' }>, inset: number): ColliderShape[] {
  return shape.radius > inset && shape.halfLength > inset
    ? [{ ...shape, radius: shape.radius - inset, halfLength: shape.halfLength - inset }]
    : [];
}

function cylinderInside(sampler: SolidSampler, candidate: Extract<ColliderShape, { kind: 'cylinder' }>): boolean {
  const u = perpendicular(candidate.axis),
    v = cross(candidate.axis, u);
  const samples: Vec3[] = [];
  for (const height of [-0.95, 0, 0.95]) {
    const center = add(candidate.center, scale(candidate.axis, candidate.halfLength * height));
    samples.push(center);
    for (let i = 0; i < 16; i++)
      samples.push(
        add(
          center,
          add(
            scale(u, candidate.radius * Math.cos((i * Math.PI) / 8)),
            scale(v, candidate.radius * Math.sin((i * Math.PI) / 8)),
          ),
        ),
      );
  }
  return samples.every((point) => sampler.contains(point));
}

async function primitiveCylinders(
  partFile: string,
  resolver: LibraryResolver,
  sampler: SolidSampler,
  options: ColliderBuildOptions,
): Promise<ColliderShape[]> {
  const shapes: ColliderShape[] = [];
  const inset = options.inset ?? 0.5;
  const resolved = new Map<string, Promise<ResolvedFile | undefined>>();
  const projectFiles = new Map<string, ResolvedFile>();
  const visit = async (name: string, matrix: Matrix4, chain: Set<string>): Promise<void> => {
    name = normalizeFileName(name);
    if (chain.has(name) || chain.size >= (options.maxDepth ?? 64)) return;
    let promise = resolved.get(name);
    if (!promise) {
      promise = resolver.resolve(name, {
        projectFiles,
        ...(options.highResPrimitives === undefined ? {} : { highResPrimitives: options.highResPrimitives }),
      });
      resolved.set(name, promise);
    }
    const source = await promise;
    if (!source) return;
    const parsed = parseLDraw(source.text, name);
    if (parsed.isMpd)
      for (const subfile of parsed.subfiles)
        projectFiles.set(normalizeFileName(subfile.fileName), {
          file: subfile.fileName,
          text: source.text,
          resolvedFrom: source.resolvedFrom,
          identity: source.identity,
        });
    const base = name.split('/').pop()!;
    if (base === 'wpin.dat') {
      // wpin's Ø8 shaft (y=-11..0) has an axial slot separating the two
      // z lobes. A 2-LDU voxel grid loses most of those thin lobes. Inscribed
      // cylinders retain them while leaving the slot open; mesh samples also
      // reject a clipped or inverted use of the primitive.
      for (const x of [-1.5, 0, 1.5])
        for (const z of [-2.5, 2.5]) {
          const transformed = transformShape(
            { kind: 'cylinder', center: [x, -5.5, z], axis: [0, 1, 0], radius: 1.5, halfLength: 5.5 },
            matrix,
          );
          if (transformed.approximate || transformed.shape.kind !== 'cylinder') continue;
          const candidate = insetCylinder(transformed.shape, inset)[0];
          if (candidate?.kind === 'cylinder' && cylinderInside(sampler, candidate)) shapes.push(candidate);
        }
    }
    // Known dimensions are LDraw primitive dimensions, not connector clearance rules.
    let outer = 0,
      inner = 0,
      center: Vec3 = [0, -2, 0],
      halfLength = 2;
    if (base === 'stud.dat') outer = 6;
    if (['stud2.dat', 'stud2a.dat'].includes(base)) {
      outer = 6;
      inner = 4;
    }
    if (base === 'stud4.dat') {
      outer = 8;
      inner = 6;
    }
    if (/^4-4cyli\.dat$/.test(base)) {
      outer = 1;
      center = [0, 0.5, 0];
      halfLength = 0.5;
    }
    // Axle primitives retain the cross-shaped arms in the voxel body; a core cylinder is safe.
    if (/^axlehol[0-9]*\.dat$/.test(base)) {
      outer = 2;
      center = [0, 0.5, 0];
      halfLength = 0.5;
    }
    if (outer > 0) {
      const transformed = transformShape(
        { kind: 'cylinder', center, axis: [0, 1, 0], radius: outer, halfLength },
        matrix,
      );
      if (!transformed.approximate && transformed.shape.kind === 'cylinder') {
        const cylinder = transformed.shape;
        const u = perpendicular(cylinder.axis),
          v = cross(cylinder.axis, u);
        if (inner > 0) {
          // A hollow tube cannot be represented by one solid cylinder. Tile only its wall.
          const innerRadius = (cylinder.radius * inner) / outer;
          const wallRadius = (cylinder.radius - innerRadius) / 2;
          const ringRadius = (cylinder.radius + innerRadius) / 2;
          const count = Math.ceil((2 * Math.PI * ringRadius) / Math.max(wallRadius, 0.5));
          for (let i = 0; i < count; i++) {
            const angle = (i * 2 * Math.PI) / count;
            shapes.push(
              ...insetCylinder(
                {
                  ...cylinder,
                  center: add(
                    cylinder.center,
                    add(scale(u, ringRadius * Math.cos(angle)), scale(v, ringRadius * Math.sin(angle))),
                  ),
                  radius: wallRadius,
                },
                inset,
              ),
            );
          }
          return;
        }
        const candidate = insetCylinder(cylinder, inset)[0];
        if (candidate?.kind === 'cylinder') {
          // Reject inner hole surfaces and clipped/partial cylinders. Actual mesh is authoritative.
          if (cylinderInside(sampler, candidate)) {
            shapes.push(candidate);
            return;
          }
        }
      }
    }
    const nextChain = new Set(chain).add(name);
    const file = parsed.subfiles.find((subfile) => normalizeFileName(subfile.fileName) === name) ?? parsed;
    for (const line of file.lines)
      if (line.type === 1) await visit(line.fileName, multiply(matrix, fromLDraw(line.transform)), nextChain);
  };
  await visit(partFile, identity(), new Set());
  return shapes;
}

export async function buildCollider(
  partFile: string,
  resolver: LibraryResolver,
  mesh: PartMesh,
  options: ColliderBuildOptions = {},
): Promise<Collider> {
  const partId = options.partId ?? partIdForFile(partFile);
  const base = {
    schema: 1 as const,
    partId,
    generatorVersion: GENERATOR_VERSION,
    bounds: [...mesh.bboxLdu] as Collider['bounds'],
  };
  const override = await options.loadOverride?.(partId);
  if (override !== undefined) {
    const manual = parseColliderOverride(override, partId);
    return { ...base, source: 'manual', approximate: manual.approximate, shapes: manual.shapes, diagnostics: [] };
  }
  const resolution = options.resolution ?? 2,
    inset = options.inset ?? 0.5,
    maxVoxels = options.maxVoxels ?? 2_000_000;
  if (
    !Number.isFinite(resolution) ||
    resolution <= 0 ||
    !Number.isFinite(inset) ||
    inset < 0 ||
    resolution <= inset * 2 ||
    !Number.isSafeInteger(maxVoxels) ||
    maxVoxels < 1 ||
    (options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 1))
  )
    throw new RangeError('Invalid collider generation options');
  const incomplete =
    mesh.diagnostics.missing.length > 0 ||
    mesh.diagnostics.cycles.length > 0 ||
    mesh.diagnostics.warnings.some((warning) => /depth/i.test(warning));
  const hasFaces = mesh.batches.some((batch) => batch.indices.length >= 3);
  const cells = [0, 1, 2]
    .map((i) => Math.max(1, Math.ceil(mesh.bboxLdu[i + 3]! / resolution) - Math.floor(mesh.bboxLdu[i]! / resolution)))
    .reduce((a, b) => a * b, 1);
  // Check before constructing the triangle projection index (very large flat faces also consume bins).
  if (incomplete || !hasFaces || cells > maxVoxels) {
    const box = boxFromBounds(mesh.bboxLdu, inset);
    return {
      ...base,
      source: 'bbox',
      approximate: true,
      shapes: box ? [box] : [],
      diagnostics: [incomplete ? 'incomplete-geometry' : hasFaces ? 'voxel-limit' : 'missing-solid'],
    };
  }
  const sampler = new SolidSampler(mesh, resolution);
  const boxes = sampler.hasFaces ? voxelBoxes(sampler, mesh.bboxLdu, resolution, inset, maxVoxels) : undefined;
  if (!boxes) {
    const box = boxFromBounds(mesh.bboxLdu, inset);
    return {
      ...base,
      source: 'bbox',
      approximate: true,
      shapes: box ? [box] : [],
      diagnostics: [sampler.hasFaces ? 'voxel-limit' : 'missing-solid'],
    };
  }
  const cylinders = await primitiveCylinders(partFile, resolver, sampler, options);
  const shapes = [...cylinders, ...boxes];
  if (sampler.suspect) {
    // An open surface can leave unobserved solid regions. Bound the whole mesh rather than
    // allowing partial voxels to certify those unobserved regions as clear.
    const box = boxFromBounds(mesh.bboxLdu, inset);
    return { ...base, source: 'bbox', approximate: true, shapes: box ? [box] : [], diagnostics: ['open-surface'] };
  }
  if (shapes.length === 0) {
    const box = boxFromBounds(mesh.bboxLdu, inset);
    return {
      ...base,
      source: 'bbox',
      approximate: true,
      shapes: box ? [box] : [],
      diagnostics: ['empty-voxelization'],
    };
  }
  return {
    ...base,
    source: 'generated',
    approximate: false,
    shapes,
    diagnostics: [],
  };
}
