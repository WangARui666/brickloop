# @brickloop/buildscript

Pure TypeScript build-script engine for Brickloop M9-1. JavaScript runs in an isolated
QuickJS WebAssembly runtime; the host rasterizes shapes, packs the voxels, checks
connections, and returns data. There is no desktop, document mutation, filesystem,
network, or UI dependency in the package. The only direct runtime dependency is
`quickjs-emscripten@0.32.0`, licensed under MIT (including its QuickJS runtime).
All examples and guides are original; the dimension table uses public LDraw IDs and sizes.

```ts
import { runBuildScript, standardPackingParts } from '@brickloop/buildscript';

const result = await runBuildScript("box(0,0,0,10,6,9,'Red')", {
  catalog: {
    // The real host must set factory flags from its active catalog.
    parts: standardPackingParts.map((p) => ({ ...p, factory: true })),
    colors: [{ id: '4', name: 'Red', rgb: '#C91A09', factory: true }],
  },
  scope: 'factory',
  seed: 42,
});
```

## Host coordinates and dimensions

`ai-editor-host.ts` passes grid poses through `gridToLdu` without a part-size offset,
then rotates about LDraw `[0,-1,0]`. A pose describes the **LDraw origin**, not the
bottom of the part. For the standard rectangular packing pieces the origin is at
the horizontal center of the body top. Studs above that plane are not part of the
voxel body volume.

For a piece covering `[x0,x0+w) × [z0,z0+d) × [y0,y0+h)`:

```text
pose.x     = x0 + w/2
pose.z     = z0 + d/2
pose.level = y0 + h
LDraw translation = [20*pose.x, -8*pose.level, 20*pose.z]
```

`w,d` here are the rotated footprint. In `standardPackingParts`, dimensions are
unrotated local X/Z sizes: **3001 and 3020 are w=4,d=2**, despite their names saying
“2 x 4”. 3068b is w=2,d=2. At 90°/270° the footprint swaps. The pose tests cover all
three IDs at 0° and 90°, use the real AI coordinate converter and core rotation
functions, and check all eight body corners against the desired voxel bounds. They
also check the unchanged host helper so a convention change fails the tests.

`part(id,{x,z,y,rotY},color)` uses that origin convention directly: a 3001 standing
on the ground has `y:3`. A submodel placement has an ordinary local origin and
receives no automatic height offset. Positive 90° maps `(x,z)` to `(-z,x)`.

## Public interfaces

See `src/types.ts` and `src/index.ts`. The proposed `runBuildScript`, catalog,
instance, error, and standard-part interfaces are retained. Additions/clarifications:

- `BuildSubmodel.name` is `string | null`; **null is the root placement list**. This
  is necessary to represent `instance()` calls at script root without inventing a
  reserved user-visible model name. Other entries are reusable definitions.
- `BuildPose.matrixLdu` is an optional 12-number LDraw matrix for reflected
  asymmetric explicit parts and reflected model placements. Rotation alone cannot
  describe a reflection. When present, the host must use its existing
  `{kind:'matrix', matrix_ldu:pose.matrixLdu}` pose variant. Translation is already
  included. All ordinary/packed poses retain the proposed grid representation.
- `stats.quality` exposes connections, components, floating components, single-stud
  connections and articulation points before/after repair, repaired-region count,
  seam counts, and unchecked explicit parts. Warning objects can contain bounds
  and a submodel name. Bounds are half-open grid coordinates.
- `stats.quality.bridgedRegions` counts accepted connectivity re-covers. The
  `hollow` statistics report `addedVoxels` restored relative to the original thin
  shell with configured columns, `coreVoxels` (a subset of that total), and
  `partsBefore`, `partsAfter`, `partsDelta` for stored parts in hollow models.
  `partsBefore` is the thin-shell greedy cover; `partsAfter` includes connectivity
  and weak-connection repair. The delta is signed: thicker regions can sometimes
  pack into fewer larger pieces. Non-hollow builds report zeros for this object.
- `stats.parts` counts stored part definitions, not repeated occurrences. Graph
  statistics and floating bounds use the fully instantiated world; seam statistics
  sum definition-local seams. Both stored output (including placement records) and
  expanded occurrences are bounded by the part limit.
- `stats.voxels` counts retained shape voxels after hollowing, excluding explicit
  parts. `stats.ms` includes initialization through result construction. The
  benchmark measures the entire awaited call, including disposal.
- `listExamples()` returns metadata without script text; `getExample(id)` returns
  metadata and code, or `undefined`. Returned metadata is copied.
- `getGuide(category)` takes `buildings`, `vehicles`, `plants`, `terrain`, or
  `figures-and-props` and returns an English string, each under 600 words.
- `renderLayers(instances, partSizes, fromLevel, toLevel, colors)` returns one string.
  `partSizes` is a record of IDs to `{w,d,h}`; colors are `CompactColor[]`. Pass
  instances already flattened into the coordinate system being viewed. Levels are
  inclusive. There are at most 128 levels and 62 legend colors per call. Unknown
  sizes are listed. Large maps repeatedly merge 2×2 cells until at most 64×64 remain;
  each bin shows its dominant occupied color. Axes, stride and information loss are
  explicitly labeled.

## Script API conventions

All chapter 10 shape functions are available: `box`, `prism`, `wall`, `cylinder`,
`revolve`, `sphere`, `heightmap`, `cell`, and `clear`. Writes overwrite previous
colors within the current model; later shape calls do not affect other definitions.

- Voxels occupy the integer grid. Horizontal rasterization samples cell centers.
  Shape boundaries and centers may use half studs. Transformed cell centers snap
  onto the same integer lattice; a half-stud translation does not increase resolution.
  Cell indices and shape layer heights are integers.
- `prism` uses even-odd scanline intersections, including concave polygons.
  `wall` uses a centerline and default thickness 1; place a one-cell wall on a
  half-stud centerline. Opening `at` is distance along the complete polyline;
  opening `y` is absolute local plate height. Openings remove that wall's writes,
  rather than erasing earlier geometry.
- `revolve` takes strictly increasing integer profile heights and nonnegative radii,
  linearly interpolates each integer layer, and includes both endpoint layers.
  A zero radius only contains a cell if its center lies exactly on the axis.
  For a visible one-cell tip, use a half-stud axis and radius 0.5.
- `sphere(cx,cy,cz,r,color)` uses physical proportions: radius is in studs; `cy`
  is in plates and vertical distance is multiplied by 8/20. `heightmap` callback
  arguments are `(x,z,y)` in the shape's local coordinates.
- Clear forms: `clear(x,y,z)`, `clear(x,z,y,w,d,h)`, or
  `clear('shapeName', ...sameShapeArguments)`. A color argument in the named form
  is ignored. This disambiguates the otherwise unspecified multi-shape overload.
- `transform` composes translation, 90° rotations, and X/Z mirrors. It restores
  scope even after an exception. Mirrors work on every voxel shape and on standard
  rectangular explicit parts (using an equivalent rotation). A reflection of an
  asymmetric explicit part or a model placement emits `pose.matrixLdu` for the
  host's matrix pose variant. Nested mirrored placements are included in the
  world-space connection analysis. Reflected asymmetric geometry is a geometric
  operation; it does not certify that a corresponding manufactured part exists.
- `submodel(name,fn)` defines local geometry; `instance(name,pose)` places it.
  Forward references are resolved after execution. Duplicate names, unknown names,
  cycles and nesting beyond 128 levels are errors. Definitions are not implicitly
  instantiated. `pack()` configures the current model.
- `parts.find({category,size,tags})` filters the current scope and returns at most
  50 compact records. Size fields match local dimensions exactly; all requested
  tags must match. Explicit parts outside scope fail atomically with up to three
  same-category/nearest-dimension suggestions.
- Colors accept catalog names/IDs, `#rrggbb`, or common basic English names.
  Unavailable colors map to the nearest allowed Lab color; distance over 15 emits
  `COLOR_DISTANCE`. Scope filters apply to colors as well as parts.

## Packing and quality

Only IDs in the intersection of `standardPackingParts` and the allowed catalog can
be packed. The standard table supplies their authoritative geometry. No unavailable
piece is silently invented. An uncovered cell returns `PART_NOT_ALLOWED`; include
1×1 bricks, plates and tiles when arbitrary shapes need them.

Three matching layers aligned to multiples of three use bricks. Remaining regions
use plates. `prefer:'plates'` disables bricks. Exposed top cells use tiles when
`top:'tiles'`; `top:[{x,z,w,d,top:'tiles'|'studs'}]` selects regions, with the last
matching region winning and studs elsewhere. A partially exposed three-layer
region is split into plates when needed to reserve its tiled surface.

Horizontal coverage greedily chooses large rectangles, alternating preferred
orientation between courses. Among candidates of the same height, a seam penalty
prefers boundaries that do not repeat the preceding two courses. A course is a
part-height layer, not each of the three plate levels inside one brick.

The **20×10×9** reference box packs into **41 bricks**, with **0** unit grid edges
continuing through three or more courses, maximum seam run **2**, and one connected
component. The BS-01 10×6×9 box also has zero such seams. These are measured fixture
results, not a universal bound: restricted dimensions, color boundaries, narrow
shapes, mixed heights and greedy local choices can force longer seams. A test with
only 2×2 bricks demonstrates that limit. Seams are unit horizontal boundaries
between different pieces, followed vertically; runs count changes in the adjacent
piece pair. Internal levels of a single brick pair do not add courses.

Connection edges join upper/lower surfaces at the same height with shared stud
positions. Edge weight is the number of overlapping studs. Side contact is not an
edge, and tiles have no upward studs. Iterative Tarjan traversal detects articulation
points without host recursion. Components lacking a piece with its bottom at level
0 generate warnings with world-space bounds and support suggestions.

Before weak-connection repair, disconnected covers are joined with catalog plates
that cross horizontal seams. Intersected bricks can split into plate courses so a
bridge and the adjacent courses overlap vertically. The patch preserves every
occupied cell and its color, keeps tiles as tiles, and leaves explicit pieces alone.
Candidates prefer larger plates and grounded neighbors. A candidate must decrease
floating voxel volume, or merge floating groups at equal volume, without making
any previously grounded cell float. Search is bounded to 50,000 candidate positions
and 8–512 graph evaluations per cover, scaled by part count. Unresolved geometry,
unavailable bridge sizes or exhausted search still produce coordinate warnings.

The subsequent weak-connection pass tries at most 24 bounded two-course regions (at most 96 pieces each),
two alternative orientations/scan directions per region. It preserves every voxel,
color, height and model assignment. It accepts only a strict decrease in
`singleStud + articulationPoints`, with no increase in part count, disconnected
components or global seam measures. A final world-space check rolls back repairs
that harm attachments of shared definitions. The narrow 2×5×4 plate strip fixture
improves from 3 to 2 weak points. This is local strengthening, not a proof of optimal
packing or mechanical strength.

Hollowing starts with a shell measured along all six grid axes. `shell` defaults to 1.
Interior support defaults to one-stud columns every 6×6 studs, anchored to multiples
of six in local coordinates. Set `support:false`, a spacing number, or
`support:{spacing,width}`.

For curved or sloping surfaces, scanline boundaries in both X and Z are compared
with the layers above and below. A boundary moving by delta retains an inward band
of `shell + |delta|` cells, providing vertical overlap across the transition. If
the resulting packed shell still has floating groups and support is enabled, an
internal core is first restored only at their levels and the immediately adjacent
levels. If necessary, the remaining original interior is tried as a final core.
Core trials are accepted only when they reduce the floating-component count;
rejected trials restore both voxels and resource accounting. `support:false` keeps
adaptive shell thickening but disables these extra cores and the periodic columns.

Only cells removed from the original, fully enclosed interior can be restored,
with their original colors. Source air, door/window openings, exterior faces and
silhouette are never filled or recolored. The tower fixture retains its shaft
cavity after repair. Tests compare all exterior cells and every retained color
against the solid source, and verify zero floating groups for hollow onions and
spheres of radii 2, 3, 4, 6 and 8. Impossible or catalog-limited connections remain
warnings; a connectivity pass is not a load-bearing guarantee.

Explicit nonstandard parts with dimensions use a rectangular footprint approximation;
parts without dimensions are reported as unchecked. Arbitrary clips, pins, slopes,
collision detection, balance, clutch forces and load capacity need the host's richer
geometry/connector system or a future solver.

## Resource isolation and determinism

The package's runtime source uses only ECMAScript/Web APIs. It can be imported in a
browser Worker; M9-3 is responsible for creating the dedicated Worker and wiring
document transactions. Node tests exercise the same engine. Worker/desktop wiring
is intentionally outside this task.

Each invocation creates a fresh QuickJS runtime/context. Only script APIs and standard
JavaScript built-ins are present: no fetch, require, process, Worker, timers, DOM,
application globals or module loader. The private bridge is removed from global
scope before user code. `Math.random` and `rand` share a seeded generator. No-argument
Date construction and `Date.now()` are fixed at Unix epoch; explicit Date values
remain useful. Hashes cover only instances and placements, excluding timings and
warnings. The 16-hex-character hash is a deterministic change detector, not a
cryptographic signature.

Defaults are 10,000 ms, 256 MiB, 2,000,000 voxels and 50,000 parts. Options can lower
but not raise those hard ceilings. The elapsed deadline includes host algorithms
and is checked by the QuickJS interrupt handler and bounded host loops. This is a
wall-clock bound, conservatively stronger than allowing 10 seconds of active CPU.

Half the memory allowance caps the QuickJS heap; half budgets host structures,
including conservative chunk, part, graph, seam and bridge allocations. The host
accounting is an estimate, not an operating-system RSS limit; the WASM module, JS
engine baseline and garbage collector are outside per-build accounting. Small limits
below 512 KiB fail before context creation. Sparse 16×16 Uint32 chunks use about
19.2 MiB of accounted host storage for the 2,000,000-cell test (raw values about
9.6 MiB). Hollow deletion buffers and seam sweeps avoid per-voxel object graphs.

Limits and disallowed explicit parts remain fatal even if the script catches an API
exception. Failure returns no instances. QuickJS source locations are preserved;
when it omits a column, the returned column is the first non-whitespace token on
that line. Errors discovered after execution use line/column 1 as no single call
site is responsible.

## Examples and validation

Six examples are stored under `examples/`; the tree example includes both a broadleaf
and a conifer definition. Metadata counts use all standard packing parts marked as
factory parts, the reference palette in `test/fixtures.ts`, and seed 42. Counts can
change with a different catalog. All six examples assert zero floating components;
their script geometry is unchanged by the review fix. The engine repairs the hollow
tower internally and re-covers the solid tree canopies without adding voxels.

The hollow tower now restores 140 internal cells: 84 in adaptive shell bands and
56 in its local core. It has 236 parts, up 34 from the 202-part thin-shell cover.
The radius-4 hollow sphere restores 86 cells and has 153 parts, up 15 from 138.
The solid tree pair changes from 180 to 184 pieces while retaining all 1,013 voxels.

Measured on this Windows worktree with Node v26.5.1 (2026-10-18), full awaited build:

| Script                |  Parts |                              Time |
| --------------------- | -----: | --------------------------------: |
| 160×100×6 box, 3 runs |  2,000 |       226.38 / 140.44 / 121.82 ms |
| 400×400×6 box, 3 runs | 20,000 | 1,909.23 / 1,755.86 / 1,654.45 ms |
| Cottage               |    154 |                          83.09 ms |
| Onion tower           |    236 |                          52.95 ms |
| Two trees             |    184 |                          43.68 ms |
| Car                   |     40 |                           4.41 ms |
| Terrain island        |    211 |                          26.61 ms |
| Fence and path        |     66 |                           6.75 ms |

Timing varies with JIT, GC and other repository tests. The benchmark verifies counts,
hash equality across three runs and the 2/10-second thresholds. Run from repo root:

```powershell
node scripts/devenv.mjs pnpm typecheck
node scripts/devenv.mjs pnpm lint
node scripts/devenv.mjs pnpm test
node scripts/devenv.mjs pnpm exec tsx --no-cache packages/buildscript/scripts/benchmark.ts
```

Final verification: `pnpm typecheck` and `pnpm lint` pass; `pnpm test` passes all
99 files (1,025 tests passed, one existing skip). The buildscript project contains
64 passing tests. The worktree's missing test fonts were verified against the
repository manifest and cached under `.devdata/fonts`; no font binaries are committed.

BS-01/02/03/05, BS-04 determinism/performance, all shapes, pose conversion, factory
scope, repairs, hollow support, model expansion, 2M voxel storage, examples and layer
maps have automated coverage. BS-04 document replacement/transactions and BS-06/07
desktop/MCP behavior belong to M9-3. Workspace discovery already uses `packages/*`,
so no root package/TypeScript change was necessary. The root Vitest configuration
adds a separate buildscript project after the existing suite, with serial files,
so other test workers do not distort the two-second wall-clock acceptance check.
