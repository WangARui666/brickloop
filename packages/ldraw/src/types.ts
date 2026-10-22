export type Vec3 = [number, number, number];
/** LDraw order: x y z a b c d e f g h i (row-major linear part). */
export type Transform = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface ColourDefinition {
  code: number;
  name: string;
  value: string;
  edge: string | number;
  /** LDraw byte, 0 (transparent) through 255 (opaque). */
  alpha: number;
  luminance: number;
  material: string[];
}

export interface MetaLine {
  type: 0;
  raw: string;
  command: string;
  value: string;
}
export interface ReferenceLine {
  type: 1;
  color: number;
  transform: Transform;
  fileName: string;
}
export interface GeometryLine {
  type: 2 | 3 | 4 | 5;
  color: number;
  vertices: Vec3[];
}
export type LDrawLine = MetaLine | ReferenceLine | GeometryLine;
export interface LDrawSubfile {
  fileName: string;
  title: string;
  lines: LDrawLine[];
  /** Complete type-0 lines, including unrecognised extensions. */
  meta: string[];
  colours: ColourDefinition[];
  category: string;
  keywords: string[];
  ldrawOrg: string;
}
export interface EmbeddedData {
  fileName: string;
  base64: string;
}
export interface LDrawFile extends LDrawSubfile {
  isMpd: boolean;
  /** Includes the main subfile at index 0. */
  subfiles: LDrawSubfile[];
  data: EmbeddedData[];
  warnings: string[];
}

export interface PartMesh {
  partFile: string;
  bboxLdu: [number, number, number, number, number, number];
  batches: { color: number | 'main'; positions: Float32Array; normals: Float32Array; indices: Uint32Array }[];
  edges: { color: number | 'edge'; positions: Float32Array }[];
  conditionalEdges: {
    positions: Float32Array;
    controls: Float32Array;
    /** One resolved colour per segment; optional extension to the base mesh contract. */
    colors?: (number | 'edge')[];
  };
  doubleSided: boolean;
  diagnostics: { missing: string[][]; cycles: string[][]; warnings: string[] };
  sources: { file: string; resolvedFrom: string }[];
}
export interface BuildOptions {
  highResPrimitives?: boolean;
  smoothingAngle?: number;
  maxDepth?: number;
}
