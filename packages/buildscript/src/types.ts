export interface PartSize {
  w: number;
  d: number;
  h: number;
}
export interface CompactPart {
  id: string;
  name: string;
  category: string;
  kind: 'brick' | 'plate' | 'tile' | 'other';
  size?: PartSize;
  tags?: string[];
  factory: boolean;
}
export interface CompactColor {
  id: string;
  name: string;
  rgb: string;
  /** Opacity in [0, 1]; omitted means opaque (1). */
  alpha?: number;
  factory: boolean;
}
export interface BuildCatalog {
  parts: CompactPart[];
  colors: CompactColor[];
}
export interface BuildOptions {
  catalog: BuildCatalog;
  scope: 'factory' | 'all';
  seed?: number;
  limits?: { cpuMs?: number; memoryBytes?: number; maxVoxels?: number; maxParts?: number };
}
/** LDraw origin in host grid coordinates: horizontal centre, body TOP. */
export interface BuildPose {
  x: number;
  z: number;
  level: number;
  rotY: 0 | 90 | 180 | 270;
  /** Present only when a reflection cannot be represented by rotation alone.
   * Pass this directly to place_part's matrix pose; translation is already included. */
  matrixLdu?: [number, number, number, number, number, number, number, number, number, number, number, number];
}
export interface BuildInstance {
  partId: string;
  colorId: string;
  pose: BuildPose;
  submodel: string | null;
}
/** null identifies root; placements name the referenced definition. */
export interface BuildSubmodel {
  name: string | null;
  instances: { name: string; pose: BuildPose }[];
}
export interface Bounds {
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  h: number;
}
export interface BuildWarning {
  code: string;
  message: string;
  line?: number;
  bounds?: Bounds;
  submodel?: string | null;
}
export interface QualityCounts {
  singleStud: number;
  articulationPoints: number;
  total: number;
}
export interface BuildStats {
  parts: number;
  byKind: Record<string, number>;
  colors: number;
  voxels: number;
  ms: number;
  quality: {
    components: number;
    floatingComponents: number;
    connections: number;
    weakBefore: QualityCounts;
    weakAfter: QualityCounts;
    repairedRegions: number;
    bridgedRegions: number;
    hollow: {
      addedVoxels: number;
      coreVoxels: number;
      /** Stored pieces in hollow models, before internal thickening / after all repairs. */
      partsBefore: number;
      partsAfter: number;
      partsDelta: number;
    };
    /** Unit grid edges shared by seams across >= 3 consecutive part courses. */
    seamsThroughThreeCourses: number;
    maxSeamCourses: number;
    uncheckedParts: number;
  };
}
export interface BuildResult {
  ok: true;
  instances: BuildInstance[];
  submodels: BuildSubmodel[];
  stats: BuildStats;
  warnings: BuildWarning[];
  hash: string;
}
export interface BuildError {
  ok: false;
  code: 'SYNTAX' | 'RUNTIME' | 'TIMEOUT' | 'MEMORY' | 'LIMIT' | 'PART_NOT_ALLOWED' | 'ENGINE_UNAVAILABLE';
  message: string;
  line?: number;
  column?: number;
  suggestions?: string[];
}
export interface TopRegion {
  x: number;
  z: number;
  w: number;
  d: number;
  top: 'tiles' | 'studs';
}
export interface PackOptions {
  top?: 'studs' | 'tiles' | TopRegion[];
  hollow?: boolean;
  shell?: number;
  support?: false | number | { spacing: number; width?: number };
  prefer?: 'bricks' | 'plates';
}
