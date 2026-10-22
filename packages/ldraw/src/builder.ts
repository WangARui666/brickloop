import { determinant, dot, IDENTITY, multiply, transformPoint } from './math.js';
import { parseColour } from './parser.js';
import { preparePart } from './prepare.js';
import type { PreparedPart } from './prepare.js';
import type { LibraryResolver } from './resolver.js';
import { faceNormal, indexFaces } from './smoothing.js';
import type { Face } from './smoothing.js';
import type { BuildOptions, ColourDefinition, PartMesh, Transform, Vec3 } from './types.js';

function edgeColour(color: number, colours: ReadonlyMap<number, ColourDefinition>): number {
  if (color === 16) return 24;
  const edge = colours.get(color)?.edge;
  if (typeof edge === 'number') return edge;
  if (edge) return 0x2000000 + Number.parseInt(edge.slice(1), 16);
  // Direct colours have no EDGE definition. Use the standard neutral edge fallback.
  return 0x2333333;
}

export function buildPreparedPart(prepared: PreparedPart, timing?: Record<string, number>, now = Date.now): PartMesh {
  const started = now();
  const mesh: PartMesh = {
    partFile: prepared.partFile,
    bboxLdu: [0, 0, 0, 0, 0, 0],
    batches: [],
    edges: [],
    conditionalEdges: { positions: new Float32Array(), controls: new Float32Array(), colors: [] },
    doubleSided: false,
    diagnostics: { missing: [], cycles: [], warnings: [] },
    sources: [],
  };
  const faces: Face[] = [];
  const hardEdges: [Vec3, Vec3][] = [];
  const edgeBatches = new Map<number | 'edge', number[]>();
  const conditionalPositions: number[] = [];
  const conditionalControls: number[] = [];
  const sourceIds = new Set<string>();
  const warnings = new Set<string>();
  let bounds = false;
  const include = (point: Vec3) => {
    if (!bounds) {
      mesh.bboxLdu = [...point, ...point];
      bounds = true;
    } else
      for (let axis = 0; axis < 3; axis++) {
        mesh.bboxLdu[axis] = Math.min(mesh.bboxLdu[axis]!, point[axis]!);
        mesh.bboxLdu[axis + 3] = Math.max(mesh.bboxLdu[axis + 3]!, point[axis]!);
      }
  };
  const visit = (
    name: string,
    matrix: Transform,
    main: number,
    edge: number,
    inverted: boolean,
    ancestorsCull: boolean,
    chain: string[],
    identities: string[],
    parentColours: ReadonlyMap<number, ColourDefinition>,
  ): void => {
    const path = [...chain, name];
    if (chain.length >= prepared.options.maxDepth) {
      warnings.add(`Depth limit ${prepared.options.maxDepth}: ${path.join(' -> ')}`);
      return;
    }
    const file = prepared.files.get(name);
    if (!file) {
      mesh.diagnostics.missing.push(path);
      return;
    }
    if (identities.includes(file.identity)) {
      mesh.diagnostics.cycles.push(path);
      return;
    }
    if (!sourceIds.has(file.identity)) {
      sourceIds.add(file.identity);
      mesh.sources.push({ file: name, resolvedFrom: file.resolvedFrom });
      for (const warning of file.warnings) warnings.add(warning);
    }
    const colours = new Map(parentColours);
    const nextIds = [...identities, file.identity];
    const noCertify = file.parsed.lines.some(
      (line) => line.type === 0 && line.command === 'BFC' && line.value.split(/\s+/).includes('NOCERTIFY'),
    );
    let certified = false;
    let sawOperational = false;
    let clip = true;
    let clockwise = false;
    let invertNext = false;
    for (const line of file.parsed.lines) {
      if (line.type === 0) {
        if (invertNext) {
          warnings.add(`INVERTNEXT must immediately precede a reference: ${path.join(' -> ')}`);
          invertNext = false;
        }
        if (line.command === 'BFC' && !noCertify) {
          const tokens = line.value.split(/\s+/);
          if (!sawOperational) certified = true;
          if (tokens.includes('CW')) clockwise = true;
          if (tokens.includes('CCW')) clockwise = false;
          if (tokens.includes('CLIP')) clip = true;
          if (tokens.includes('NOCLIP')) clip = false;
          if (tokens.includes('INVERTNEXT')) invertNext = true;
        } else if (line.command === '!COLOUR') {
          const colour = parseColour(line.value);
          if (colour) colours.set(colour.code, colour);
        }
        continue;
      }
      sawOperational = true;
      const color = line.color === 16 ? main : line.color === 24 ? edge : line.color;
      if (line.type === 1) {
        const composed = multiply(matrix, line.transform);
        if (!composed.every(Number.isFinite)) {
          warnings.add(`Non-finite transform: ${[...path, line.fileName].join(' -> ')}`);
          invertNext = false;
          continue;
        }
        visit(
          line.fileName,
          composed,
          color,
          line.color === 16 ? edge : edgeColour(color, colours),
          inverted !== invertNext,
          ancestorsCull && certified && clip,
          path,
          nextIds,
          colours,
        );
      } else {
        if (invertNext) warnings.add(`INVERTNEXT before non-reference: ${path.join(' -> ')}`);
        const vertices = line.vertices.map((vertex) => transformPoint(matrix, vertex));
        if (
          !vertices.every((vertex) => vertex.every((n) => Number.isFinite(n) && Math.abs(n) <= 3.4028234663852886e38))
        ) {
          warnings.add(`Coordinates exceed Float32 range: ${path.join(' -> ')}`);
          invertNext = false;
          continue;
        }
        if (line.type === 2) {
          const batchColor = color === 24 ? 'edge' : color;
          const batch = edgeBatches.get(batchColor) ?? [];
          vertices.forEach((vertex) => {
            batch.push(...vertex);
            include(vertex);
          });
          edgeBatches.set(batchColor, batch);
          hardEdges.push([vertices[0]!, vertices[1]!]);
        } else if (line.type === 5) {
          conditionalPositions.push(...vertices[0]!, ...vertices[1]!);
          conditionalControls.push(...vertices[2]!, ...vertices[3]!);
          mesh.conditionalEdges.colors!.push(color === 24 ? 'edge' : color);
          include(vertices[0]!);
          include(vertices[1]!);
        } else {
          if (!certified || !clip || !ancestorsCull) mesh.doubleSided = true;
          if ((clockwise !== inverted) !== determinant(matrix) < 0) vertices.reverse();
          const normal = faceNormal(vertices);
          if (dot(normal, normal) < 0.5) warnings.add(`Degenerate face: ${path.join(' -> ')}`);
          else {
            faces.push({ vertices, normal, color: color === 16 ? 'main' : color });
            vertices.forEach(include);
          }
        }
      }
      invertNext = false;
    }
    if (invertNext) warnings.add(`Dangling INVERTNEXT: ${path.join(' -> ')}`);
  };
  visit(prepared.partFile, IDENTITY, 16, 24, false, true, [], [], prepared.colours);
  const indexed = now();
  mesh.batches = indexFaces(faces, hardEdges, prepared.options.smoothingAngle);
  if (timing) {
    timing.expandFacesEdgesMs = indexed - started;
    timing.normalsIndexMs = now() - indexed;
  }
  mesh.edges = Array.from(edgeBatches, ([color, positions]) => ({ color, positions: new Float32Array(positions) }));
  mesh.conditionalEdges.positions = new Float32Array(conditionalPositions);
  mesh.conditionalEdges.controls = new Float32Array(conditionalControls);
  mesh.diagnostics.warnings = [...warnings];
  return mesh;
}

export async function buildPartMesh(
  partFile: string,
  resolver: LibraryResolver,
  options: BuildOptions = {},
): Promise<PartMesh> {
  return buildPreparedPart(await preparePart(partFile, resolver, options));
}
