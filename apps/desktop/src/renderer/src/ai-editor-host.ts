import { engineUnavailable } from '../../../../../packages/buildscript/src/errors';
import { preparedPreviews } from '../../../../../packages/core/src/history/prepared-preview';
import {
  executeCommand,
  applyOps,
  isContextCurrent,
  expandInstances,
  fromLDraw,
  identity,
  invert,
  multiply,
  orderedInstances,
  pathStartsWith,
  resolveContext,
  resolvePath,
  rotationAxisAngle,
  toLDraw,
  transformPoint,
  translation,
  ulid,
  validateDocument,
} from '@brickloop/core';
import type { BrkDocument, Command, DocumentSession, EditContext, InstancePath, Op, Vec3 } from '@brickloop/core';
import { gridToLdu, lduToGrid, compareImages, toolSchemas, mutationNames } from '@brickloop/ai';
import type {
  ImageBlock,
  ImageModelInput,
  JsonValue,
  ToolInput,
  ToolName,
  ToolResult,
  ValidationIssue,
  ReferenceImagePolicy,
} from '@brickloop/ai';
import {
  ConnectionGraph,
  documentConnectorSource,
  instantiateConnectors,
  isCompatible,
  solveRotation,
  insertionRange,
  slideOffset,
  rotationStep,
} from '@brickloop/connect';
import type { ConnectorRef } from '@brickloop/connect';
import { generateMosaic, mosaicToOps } from '@brickloop/mosaic';
import type { RgbaImage } from '@brickloop/mosaic';
import type { Issue } from '@brickloop/collide';
import type { ProjectAssets } from '@brickloop/io';
import type { LibraryApi, LibraryColor, LibraryPart } from '../../shared/library-api';
import type { AssemblyCatalog, AssemblyPart } from '../../shared/assembly-api';
import { SelectionScope, mutationTargets } from './ai-scope';
import { shrinkComparisonImage } from './comparison-image';
import { selectedRows } from './ai-mentions';
import { getExample, getGuide, listExamples } from '../../../../../packages/buildscript/src/library';
import { renderLayers } from '../../../../../packages/buildscript/src/layers';
import type {
  BuildCatalog,
  BuildOptions,
  BuildResult,
  BuildError,
  BuildInstance,
  PartSize,
} from '../../shared/buildscript-catalog';
import { rawPartId } from '../../shared/buildscript-catalog';
import { referenceImagePreparationSchema } from '../../shared/ai-api';
import {
  BuildScriptFailure,
  buildModelBounds,
  buildScriptOps,
  findScript,
  prepareBuildScript,
  scriptOutputs,
} from '../../shared/buildscript-document';

export interface HostDocument {
  session: DocumentSession;
  assets: ProjectAssets;
  readOnly: boolean;
}
export interface EditorHostServices {
  buildCatalog?(): Promise<BuildCatalog>;
  runBuildScript?(code: string, options: BuildOptions): Promise<BuildResult | BuildError>;
  active(): HostDocument;
  lock(owner: 'ai' | 'mcp' | null, documentId?: string): void;
  changed(): void;
  library: Pick<LibraryApi, 'catalogSearch' | 'catalogPart' | 'catalogColors'>;
  assemblyPart(id: string): Promise<AssemblyPart>;
  catalog(): Promise<AssemblyCatalog>;
  check(doc: BrkDocument, modelPath?: string[]): Promise<Issue[]>;
  summarize?(doc: BrkDocument, modelPath?: string[]): Promise<{ summary: Record<string, unknown>; issues: Issue[] }>;
  render(doc: BrkDocument, input: ToolInput<'render_views'>): Promise<{ images: ImageBlock[]; rgba: RgbaImage[] }>;
  decode(image: ImageBlock): Promise<RgbaImage>;
  encode(image: RgbaImage, background?: 'viewport'): ImageBlock;
  prepareReferenceImage?(image: ImageBlock, policy: ReferenceImagePolicy): Promise<ImageBlock>;
  bom(doc: BrkDocument, modelPath?: string[]): Promise<unknown>;
  exportIo(tab: HostDocument): Promise<unknown>;
  documents(method: 'list_documents' | 'open_document' | 'set_active_document', input: unknown): Promise<ToolResult>;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
export const success = (value: unknown, introducedIssues: ValidationIssue[] = []): ToolResult => ({
  ok: true,
  data: json(value),
  introducedIssues,
  warnings: [],
});
const failure = (code: string): ToolResult => ({ ok: false, code, message: code });
class HostFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const requireValue = <T>(value: T | null | undefined, code: string): T => {
  if (value === null || value === undefined) throw new HostFailure(code);
  return value;
};
const grid = (p: readonly number[]) => lduToGrid({ x_ldu: p[0]!, y_ldu: p[1]!, z_ldu: p[2]! });
const issueKey = (v: ValidationIssue) => JSON.stringify([v.kind, v.paths]);
const connectorId = (ref: ConnectorRef) => (ref.cell ? `${ref.connectorId}@${ref.cell.join(',')}` : ref.connectorId);
const matchesConnector = (filter: string | undefined, ref: ConnectorRef) =>
  !filter || filter === connectorId(ref) || filter === ref.connectorId;
function normalized(issues: Issue[]): ValidationIssue[] {
  const kinds: Record<string, string> = {
    nonFactoryPart: 'non_factory_part',
    nonFactoryColor: 'non_factory_color',
    unavailableColor: 'unavailable_color',
  };
  return issues.map((v) => ({
    kind: kinds[v.kind] ?? v.kind,
    severity: v.severity,
    paths: v.paths,
    data: json(v.data),
  }));
}
function poseTransform(pose: ToolInput<'set_transform'>['pose']): number[] {
  if (pose.kind === 'matrix') return [...pose.matrix_ldu];
  const p = pose.kind === 'grid' ? gridToLdu({ x: pose.x, z: pose.z, level: pose.level }) : pose;
  return toLDraw(multiply(translation([p.x_ldu, p.y_ldu, p.z_ldu]), rotationAxisAngle([0, -1, 0], pose.rotY)));
}

/** All mutations go through core's command bus, then one session preview/commit boundary. */
export class RendererEditorHost {
  private bounds = new Map<string, readonly [number, number, number, number, number, number]>();
  private transaction: { tab: HostDocument; ops: Op[]; owner: 'ai' | 'mcp' } | undefined;
  private reserved: HostDocument | undefined;
  private lastTransactionId: string | undefined;
  private initialParts = new Map<string, string>();
  private imageConstraints: ImageModelInput | undefined;
  private scope: SelectionScope | undefined;
  private batchDepth = 0;
  private batchChanged = false;
  constructor(
    private readonly services: EditorHostServices,
    scope?: { base: BrkDocument; paths: InstancePath[] },
  ) {
    if (scope) this.scope = new SelectionScope(scope.base, scope.paths);
  }
  private get tab() {
    return this.transaction?.tab ?? this.reserved ?? this.services.active();
  }
  private get doc() {
    return this.tab.session.document;
  }
  private context(modelPath?: string[]): EditContext {
    return { activeModelPath: modelPath ?? this.tab.session.context.activeModelPath, selection: [] };
  }
  private model(modelPath?: string[]) {
    return requireValue(resolveContext(this.doc, this.context(modelPath)), 'MODEL_NOT_FOUND').model;
  }
  private paths(ids: string[], modelPath?: string[]): InstancePath[] {
    const preferred = modelPath ?? this.tab.session.context.activeModelPath;
    return ids.map((id) => {
      if (resolvePath(this.doc, [...preferred, id])) return [...preferred, id];
      const found: string[][] = [];
      const walk = (modelId: string, path: string[]) => {
        for (const item of orderedInstances(this.doc.models[modelId]!)) {
          const next = [...path, item.id];
          if (item.id === id) found.push(next);
          if (item.ref.kind === 'model') walk(item.ref.modelId, next);
        }
      };
      walk(this.doc.rootModelId, []);
      if (found.length !== 1) throw new HostFailure(found.length ? 'AMBIGUOUS_INSTANCE' : 'INSTANCE_NOT_FOUND');
      return found[0]!;
    });
  }
  private stage(ops: Op[]) {
    const tx = requireValue(this.transaction, 'NO_TRANSACTION');
    // preview cancels its transaction on failure. Check the candidate first so a rejected
    // command cannot discard successful edits from earlier in the same AI turn.
    const next = applyOps(tx.tab.session.document, ops);
    if (validateDocument(next).length) throw new HostFailure('INVALID_DOCUMENT');
    if (!isContextCurrent(tx.tab.session.transactionBase, next, tx.tab.session.context))
      throw new HostFailure('INVALID_CONTEXT');
    const all = [...tx.ops, ...ops];
    preparedPreviews.set(all, { base: tx.tab.session.transactionBase, next });
    const result = tx.tab.session.preview(all);
    if (!result.ok) throw new HostFailure(result.error.code);
    tx.ops = all;
    this.changed();
  }
  private changed() {
    if (this.batchDepth) this.batchChanged = true;
    else this.services.changed();
  }
  private command(command: Command, context = this.context()) {
    const output = executeCommand(this.doc, context, command, { bboxProvider: (id) => this.bounds.get(id) });
    if (!output.ok) throw new HostFailure(output.error.code);
    this.stage(output.value.ops);
    return output.value;
  }
  private async factory(partId: string, colorId?: string) {
    const part = await this.services.library.catalogPart(partId as LibraryPart['id']);
    requireValue(part, 'PART_NOT_FOUND');
    const catalog = await this.services.catalog();
    const factory = catalog.parts.find((p) => p.id === partId && p.factory);
    if (!factory && this.imageConstraints?.parts?.source !== 'all') throw new HostFailure('NON_FACTORY_PART');
    if (
      this.imageConstraints?.parts?.source === 'categories' &&
      !this.imageConstraints.parts.categories?.includes(part!.categoryId)
    )
      throw new HostFailure('CATEGORY_RESTRICTED');
    const palette = this.imageConstraints?.palette;
    if (colorId && palette && palette.source !== 'factory' && !palette.colorIds?.includes(colorId))
      throw new HostFailure('COLOR_RESTRICTED');
    if (colorId && (!catalog.colors.includes(colorId) || (factory && !factory.colors.includes(colorId))))
      throw new HostFailure('UNAVAILABLE_COLOR');
    return factory ?? { id: partId, factory: false, colors: catalog.colors };
  }
  private rows(modelPath?: string[]) {
    return expandInstances(this.doc).filter((v) =>
      pathStartsWith(v.path, modelPath ?? this.tab.session.context.activeModelPath),
    );
  }
  private async graph() {
    const parts = new Map(
      await Promise.all(
        [...new Set(expandInstances(this.doc).map((r) => r.partId))].map(
          async (id) => [id, await this.services.assemblyPart(id)] as const,
        ),
      ),
    );
    return new ConnectionGraph(
      documentConnectorSource(
        () => this.doc,
        (id) => parts.get(id)?.connectors.connectors ?? [],
      ),
    );
  }
  private async candidates(input: ToolInput<'find_connection_candidates'>, angle = 0) {
    const targetPath = this.paths([input.targetInstanceId])[0]!;
    const target = requireValue(resolvePath(this.doc, targetPath), 'INSTANCE_NOT_FOUND');
    if (target.instance.ref.kind !== 'part') throw new HostFailure('PART_REQUIRED');
    const [sourceData, targetData] = await Promise.all([
      this.services.assemblyPart(input.partId),
      this.services.assemblyPart(target.instance.ref.partId),
    ]);
    const targets = instantiateConnectors({
      path: targetPath,
      worldMatrix: target.worldMatrix,
      connectors: targetData.connectors.connectors,
    });
    const sources = instantiateConnectors({
      path: ['candidate'],
      worldMatrix: identity(),
      connectors: sourceData.connectors.connectors,
    });
    const graph = await this.graph();
    const results: {
      source: string;
      target: { instanceId: string; connectorId: string };
      pose: { kind: 'matrix'; matrix_ldu: number[] };
      position: ReturnType<typeof grid>;
    }[] = [];
    for (const sourceEntry of sources)
      for (const dest of targets) {
        const source = sourceEntry.connector;
        if (
          !matchesConnector(input.sourceConnectorId, sourceEntry.ref) ||
          !matchesConnector(input.targetConnectorId, dest.ref) ||
          graph.isOccupied(dest.ref, sourceEntry)
        )
          continue;
        if (!isCompatible(source, dest.connector).ok) continue;
        const solved = solveRotation(source, dest.connector);
        if (solved.residual > 0.01) continue;
        const step = rotationStep(source, dest.connector);
        if (step !== 'free' && Math.abs(angle / step - Math.round(angle / step)) > 1e-6) continue;
        const rotation = multiply(rotationAxisAngle(dest.connector.frame.axis, angle), solved.matrix);
        const origin = transformPoint(rotation, source.frame.origin);
        let offset = 0;
        const rotated = instantiateConnectors({ path: ['candidate'], worldMatrix: rotation, connectors: [source] })[0]!;
        const range = insertionRange(rotated.connector, dest.connector);
        if (range) {
          if (range.min > range.max) continue;
          offset = slideOffset({ ...range, offset: 0 }, false);
        }
        const delta = dest.connector.frame.origin.map(
          (v, i) => v + dest.connector.frame.axis[i]! * offset - origin[i]!,
        ) as [number, number, number];
        const matrix = multiply(translation(delta), rotation);
        results.push({
          source: connectorId(sourceEntry.ref),
          target: { instanceId: input.targetInstanceId, connectorId: connectorId(dest.ref) },
          pose: { kind: 'matrix', matrix_ldu: toLDraw(matrix) },
          position: grid(delta),
        });
        if (results.length >= input.limit) return results;
      }
    return results;
  }
  async request(method: string, input: unknown, owner: 'ai' | 'mcp'): Promise<unknown> {
    if (method === 'selection.context') {
      const paths = this.tab.session.workspace.selection,
        rows = selectedRows(this.doc, paths);
      const min = { x: Infinity, z: Infinity, level: Infinity },
        max = { x: -Infinity, z: -Infinity, level: -Infinity };
      const colors: Record<string, number> = {},
        parts: Record<string, number> = {};
      const partBounds = new Map<string, AssemblyPart['collider']['bounds']>();
      for (const row of rows) {
        colors[row.colorId] = (colors[row.colorId] ?? 0) + 1;
        parts[row.partId] = (parts[row.partId] ?? 0) + 1;
        let b = partBounds.get(row.partId);
        if (!b) {
          b = (await this.services.assemblyPart(row.partId)).collider.bounds;
          partBounds.set(row.partId, b);
        }
        for (const x of [b[0], b[3]])
          for (const y of [b[1], b[4]])
            for (const z of [b[2], b[5]]) {
              const p = grid(transformPoint(row.worldMatrix, [x, y, z]));
              for (const k of ['x', 'z', 'level'] as const) {
                min[k] = Math.min(min[k], p[k]);
                max[k] = Math.max(max[k], p[k]);
              }
            }
      }
      return {
        count: paths.length,
        partCount: rows.length,
        colors,
        parts,
        bounds: rows.length ? { min, max } : null,
        model: { id: this.model().id, name: this.model().name, path: this.tab.session.context.activeModelPath },
        ...(rows.length <= 200 && paths.length <= 200
          ? {
              paths,
              instances: rows.map((r) => ({
                id: r.path.at(-1),
                path: r.path,
                partId: r.partId,
                colorId: r.colorId,
                position: grid([r.worldMatrix[12]!, r.worldMatrix[13]!, r.worldMatrix[14]!]),
              })),
            }
          : {}),
      };
    }
    if (method === 'reserve') {
      if (this.reserved || this.transaction || this.services.active().readOnly) throw new HostFailure('DOCUMENT_BUSY');
      this.lastTransactionId = undefined;
      this.reserved = this.services.active();
      this.initialParts = this.partSnapshot();
      this.imageConstraints = undefined;
      return { documentId: this.doc.documentId };
    }
    if (method === 'release') {
      if (this.transaction) throw new HostFailure('TRANSACTION_ACTIVE');
      const after = this.partSnapshot();
      const changed = [...new Set([...this.initialParts.keys(), ...after.keys()])].filter(
        (id) => this.initialParts.get(id) !== after.get(id),
      ).length;
      this.reserved = undefined;
      this.imageConstraints = undefined;
      this.scope = undefined;
      return { transactionId: this.lastTransactionId, changed };
    }
    if (method === 'image.configure') {
      if (!this.reserved || owner !== 'ai') throw new HostFailure('DOCUMENT_BUSY');
      this.imageConstraints = structuredClone(input as ImageModelInput);
      if (this.imageConstraints.palette?.source === 'project')
        this.imageConstraints.palette.colorIds = [...new Set(this.rows([]).map((r) => r.colorId))];
      if (this.imageConstraints.palette?.source === 'factory')
        this.imageConstraints.palette.colorIds = (await this.services.library.catalogColors()).factory.map((c) => c.id);
      return this.imageConstraints.palette;
    }
    if (method === 'image.prepare') {
      if (!this.reserved || owner !== 'ai') throw new HostFailure('DOCUMENT_BUSY');
      const request = referenceImagePreparationSchema.parse(input);
      return requireValue(this.services.prepareReferenceImage, 'IMAGE_CODEC_UNAVAILABLE')(
        request.image,
        request.policy,
      );
    }
    if (method === 'beginTransaction') {
      if (this.transaction || (owner === 'mcp' && this.reserved) || this.tab.readOnly)
        throw new HostFailure('DOCUMENT_BUSY');
      if (owner === 'mcp') this.services.lock(owner, this.doc.documentId);
      const result = this.tab.session.begin(String(input), owner);
      if (!result.ok) {
        if (owner === 'mcp') this.services.lock(null, this.doc.documentId);
        throw new HostFailure(result.error.code);
      }
      this.transaction = { tab: this.tab, ops: [], owner };
      this.lastTransactionId = undefined;
      return;
    }
    if (method === 'commitTransaction') {
      const tx = requireValue(this.transaction, 'NO_TRANSACTION');
      if (tx.owner !== owner) throw new HostFailure('DOCUMENT_BUSY');
      const result = tx.tab.session.commit();
      this.transaction = undefined;
      this.services.changed();
      if (owner === 'mcp') this.services.lock(null, tx.tab.session.document.documentId);
      if (!result.ok) throw new HostFailure(result.error.code);
      this.lastTransactionId = result.value?.id;
      return;
    }
    if ((owner === 'mcp' && this.reserved) || (this.transaction && this.transaction.owner !== owner))
      return failure('DOCUMENT_BUSY');
    if (['list_documents', 'open_document', 'set_active_document'].includes(method)) {
      if (this.transaction || this.reserved) return failure('DOCUMENT_BUSY');
      return this.services.documents(method as 'list_documents' | 'open_document' | 'set_active_document', input);
    }
    if (!(method in toolSchemas)) return failure('UNKNOWN_TOOL');
    const name = method as ToolName,
      parsed = toolSchemas[name].safeParse(input);
    if (!parsed.success) return failure('INVALID_ARGUMENTS');
    const beforeOps = this.transaction?.ops.slice(),
      beforeAssets = { ...this.tab.assets };
    try {
      if (mutationNames.has(name) && !this.transaction) return failure('NO_TRANSACTION');
      if (owner === 'ai' && mutationNames.has(name) && this.scope) {
        const rejected = this.scope.check(
          mutationTargets(name, parsed.data as never, this.doc, this.tab.session.context.activeModelPath, (ids) =>
            this.paths(ids),
          ),
        );
        if (rejected) return rejected;
      }
      const before = mutationNames.has(name)
        ? new Set(normalized(await this.services.check(this.doc)).map(issueKey))
        : new Set<string>();
      // Each schema and handler share the discriminant; runtime validation precedes dispatch.
      const data = await this.execute(name, parsed.data as never);
      const introduced = mutationNames.has(name)
        ? normalized(await this.services.check(this.doc)).filter((v) => !before.has(issueKey(v)))
        : [];
      const response = success(data, introduced);
      if (name === 'run_build_script' && response.ok)
        response.warnings = (data as { warnings: { message: string }[] }).warnings.map((w) => w.message);
      return response;
    } catch (error) {
      if (beforeOps && this.transaction) {
        this.transaction.ops = beforeOps;
        this.tab.session.preview(beforeOps);
        this.tab.assets = beforeAssets;
        this.changed();
      }
      if (error instanceof BuildScriptFailure)
        return { ok: false, code: error.code, message: error.message, details: json(error.details) };
      if (/ENGINE_UNAVAILABLE/.test(String(error))) return engineUnavailable(error);
      return failure(
        error instanceof HostFailure
          ? error.code
          : error instanceof Error && error.message === 'RENDER_ASSET_MISSING'
            ? 'RENDER_ASSET_MISSING'
            : 'HOST_ERROR',
      );
    }
  }
  private async execute<K extends ToolName>(name: K, value: ToolInput<K>): Promise<unknown> {
    // A discriminated union retains the schema's relation between tool name and arguments.
    const call = { name, value } as { [P in ToolName]: { name: P; value: ToolInput<P> } }[ToolName];
    switch (call.name) {
      case 'list_build_examples':
        return { examples: listExamples() };
      case 'get_build_example':
        return requireValue(getExample(call.value.id), 'EXAMPLE_NOT_FOUND');
      case 'get_design_guide':
        return { category: call.value.category, guide: getGuide(call.value.category) };
      case 'list_build_scripts':
        return {
          scripts: scriptOutputs(this.doc).map(({ script: { code: _code, ...meta } }) => {
            void _code;
            return meta;
          }),
        };
      case 'get_build_script':
        return requireValue(findScript(this.doc, call.value.scriptId), 'SCRIPT_NOT_FOUND').script;
      case 'run_build_script': {
        const input = call.value,
          prepared = prepareBuildScript(
            this.doc,
            input,
            this.imageConstraints ? (this.imageConstraints.parts?.source === 'factory' ? 'factory' : 'all') : undefined,
          );
        let catalog = await requireValue(this.services.buildCatalog, 'CATALOG_UNAVAILABLE')();
        if (this.imageConstraints?.parts?.source === 'categories')
          catalog = {
            ...catalog,
            parts: catalog.parts.filter((p) => this.imageConstraints!.parts!.categories?.includes(p.category)),
          };
        const palette = this.imageConstraints?.palette;
        if (palette?.colorIds)
          catalog = { ...catalog, colors: catalog.colors.filter((c) => palette.colorIds!.includes(c.id)) };
        const result = await (async () => {
          try {
            return await requireValue(this.services.runBuildScript, 'WORKER_UNAVAILABLE')(prepared.code, {
              catalog,
              scope: prepared.scope,
              seed: prepared.seed,
            });
          } catch (error) {
            return engineUnavailable(error);
          }
        })();
        if (!result.ok)
          throw new BuildScriptFailure(result.code, result.message, {
            ...result,
            line: result.line ?? 1,
            column: result.column ?? 1,
          });
        const start = performance.now();
        const output = buildScriptOps(this.doc, input, prepared, result);
        this.stage(output.ops);
        const writeMs = performance.now() - start;
        return {
          scriptId: input.scriptId,
          stats: result.stats,
          warnings: result.warnings,
          hash: result.hash,
          createdCount: output.created.length,
          removedCount: output.removed.length,
          changed: output.created.length + output.removed.length,
          writeMs,
          rootInstanceIds: output.created.filter((id) => !!this.doc.models[prepared.target.id]!.instances[id]),
          submodels: buildModelBounds(this.doc, { root: prepared.target.id, ...output.models }, catalog),
        };
      }
      case 'view_layers': {
        const catalog = await requireValue(this.services.buildCatalog, 'CATALOG_UNAVAILABLE')();
        const ctx = requireValue(resolveContext(this.doc, this.context(call.value.modelPath)), 'MODEL_NOT_FOUND');
        const sizes: Record<string, PartSize> = Object.fromEntries(
          catalog.parts
            .filter((p) => p.size && Object.values(p.size).every((n) => Number.isInteger(n) && n > 0))
            .map((p) => [p.id, p.size!]),
        );
        const instances: BuildInstance[] = [],
          skipped: string[] = [];
        for (const row of expandInstances({ ...this.doc, rootModelId: ctx.model.id })) {
          const m = toLDraw(row.worldMatrix);
          // Text layers approximate rectangular, upright pieces. Never misrepresent tilted geometry.
          if (
            Math.abs(m[7]! - 1) > 1e-6 ||
            [m[4], m[6], m[8], m[10]].some((v) => Math.abs(v!) > 1e-6) ||
            ![m[3], m[5], m[9], m[11]].every((v) => Math.abs(v! - Math.round(v!)) < 1e-6)
          ) {
            skipped.push(row.path.join('/'));
            continue;
          }
          const turn = Math.abs(m[3]!) < 0.5;
          instances.push({
            partId: rawPartId(row.partId),
            colorId: row.colorId,
            submodel: null,
            pose: { x: m[0]! / 20, z: m[2]! / 20, level: -m[1]! / 8, rotY: turn ? 90 : 0 },
          });
        }
        return {
          layers: renderLayers(instances, sizes, call.value.fromLevel, call.value.toLevel, catalog.colors),
          skippedTransforms: skipped,
          approximation:
            'Rectangular size envelopes; unknown sizes and tilted parts are skipped. Use render_views for exact geometry.',
        };
      }
      case 'get_model_summary': {
        if (this.services.summarize) {
          const result = await this.services.summarize(this.doc, call.value.modelPath);
          return {
            ...result.summary,
            issues: normalized(result.issues),
            selection: this.tab.session.workspace.selection,
            activeModelPath: this.tab.session.context.activeModelPath,
          };
        }
        const rows = this.rows(call.value.modelPath),
          counts: Record<string, number> = {};
        for (const row of rows) counts[row.colorId] = (counts[row.colorId] ?? 0) + 1;
        const points: ReturnType<typeof grid>[] = [];
        for (const row of rows) {
          const b = (await this.services.assemblyPart(row.partId)).collider.bounds;
          for (const x of [b[0], b[3]])
            for (const y of [b[1], b[4]])
              for (const z of [b[2], b[5]]) points.push(grid(transformPoint(row.worldMatrix, [x, y, z])));
        }
        const bounds = points.length
          ? {
              min: Object.fromEntries(
                (['x', 'z', 'level'] as const).map((key) => [key, Math.min(...points.map((p) => p[key]))]),
              ),
              max: Object.fromEntries(
                (['x', 'z', 'level'] as const).map((key) => [key, Math.max(...points.map((p) => p[key]))]),
              ),
            }
          : null;
        return {
          bounds,
          documentId: this.doc.documentId,
          partCount: rows.length,
          colorCount: Object.keys(counts).length,
          connectedComponents: (await this.graph())
            .components()
            .filter((component) => component.some((path) => pathStartsWith(path, call.value.modelPath ?? []))).length,
          colors: counts,
          models: Object.values(this.doc.models).map((m) => ({
            id: m.id,
            name: m.name,
            count: Object.keys(m.instances).length,
            children: Object.values(m.instances)
              .filter((v) => v.ref.kind === 'model')
              .map((v) => ({ instanceId: v.id, ref: v.ref })),
          })),
          selection: this.tab.session.workspace.selection,
          activeModelPath: this.tab.session.context.activeModelPath,
          issues: normalized(await this.services.check(this.doc, call.value.modelPath)),
        };
      }
      case 'list_instances': {
        const p = call.value,
          rows = this.rows(p.modelPath).filter((r) => {
            const position = grid([r.worldMatrix[12]!, r.worldMatrix[13]!, r.worldMatrix[14]!]);
            const instance = resolvePath(this.doc, r.path)!.instance;
            return (
              (!p.partId || p.partId === r.partId) &&
              (!p.colorId || p.colorId === r.colorId) &&
              (!p.groupId || p.groupId === instance.groupId) &&
              (!p.bounds ||
                (['x', 'z', 'level'] as const).every(
                  (k) => position[k] >= p.bounds!.min[k] && position[k] <= p.bounds!.max[k],
                ))
            );
          });
        return {
          total: rows.length,
          offset: p.offset,
          nextOffset: p.offset + p.limit < rows.length ? p.offset + p.limit : null,
          pagination: '使用 offset 和 limit 翻页；完整变换与连接信息请调用 get_instance。',
          instances: rows.slice(p.offset, p.offset + p.limit).map((r) => ({
            instanceId: r.path.at(-1),
            path: r.path,
            partId: r.partId,
            colorId: r.colorId,
            position: grid([r.worldMatrix[12]!, r.worldMatrix[13]!, r.worldMatrix[14]!]),
          })),
        };
      }
      case 'get_instance': {
        const path = this.paths([call.value.instanceId], call.value.modelPath)[0]!,
          row = resolvePath(this.doc, path)!;
        const data =
          row.instance.ref.kind === 'part' ? await this.services.assemblyPart(row.instance.ref.partId) : undefined;
        return {
          ...row.instance,
          connections: (await this.graph()).edgesOf(path),
          path,
          position: grid([row.worldMatrix[12]!, row.worldMatrix[13]!, row.worldMatrix[14]!]),
          matrix_ldu: toLDraw(row.worldMatrix),
          connectors: data
            ? instantiateConnectors({ path, worldMatrix: row.worldMatrix, connectors: data.connectors.connectors }).map(
                (v) => ({
                  id: connectorId(v.ref),
                  type: v.connector.type,
                  position: grid(v.connector.frame.origin),
                  direction: v.connector.frame.axis,
                }),
              )
            : [],
        };
      }
      case 'get_selection':
        return {
          paths: this.tab.session.workspace.selection,
          instanceIds: this.tab.session.workspace.selection.map((p) => p.at(-1)),
        };
      case 'search_parts': {
        const p = call.value,
          parts = await this.services.library.catalogSearch(p.query, {
            includeAll: !p.factoryOnly,
            ...(p.category ? { categoryId: p.category } : {}),
          });
        const filtered = parts.filter(
          (part) =>
            !p.dimensions ||
            (part.bboxLdu &&
              Math.abs((part.bboxLdu[3] - part.bboxLdu[0]) / 20 - p.dimensions.x) < 0.01 &&
              Math.abs((part.bboxLdu[5] - part.bboxLdu[2]) / 20 - p.dimensions.z) < 0.01 &&
              Math.abs((part.bboxLdu[4] - part.bboxLdu[1]) / 8 - p.dimensions.level) < 0.01),
        );
        return {
          total: filtered.length,
          truncated: filtered.length > p.limit,
          pagination: 'search_parts 不支持 offset；用不同的过滤条件缩小范围，详情请调用 get_part_info。',
          parts: filtered.slice(0, p.limit).map(({ id, nameZh, nameEn, bboxLdu, categoryId }) => ({
            id,
            nameZh,
            nameEn,
            bboxLdu,
            categoryId,
          })),
        };
      }
      case 'get_part_info': {
        const part = requireValue(
          await this.services.library.catalogPart(call.value.partId as LibraryPart['id']),
          'PART_NOT_FOUND',
        );
        const [data, catalog] = await Promise.all([this.services.assemblyPart(part.id), this.services.catalog()]);
        const b = data.collider.bounds;
        return {
          ...part,
          dimensions: { x: (b[3] - b[0]) / 20, z: (b[5] - b[2]) / 20, level: (b[4] - b[1]) / 8 },
          footprint: { x: (b[3] - b[0]) / 20, z: (b[5] - b[2]) / 20 },
          colors: catalog.parts.find((p) => p.id === part.id)?.colors ?? [],
          connectors: data.connectors.connectors.map((v) => ({
            id: v.id,
            type: v.type,
            position: grid(v.frame.origin),
            direction: v.frame.axis,
          })),
        };
      }
      case 'list_colors': {
        const colors = await this.services.library.catalogColors();
        const used = new Set(this.rows([]).map((v) => v.colorId));
        return { colors: call.value.source === 'factory' ? colors.factory : colors.all.filter((c) => used.has(c.id)) };
      }
      case 'find_connection_candidates':
        return { candidates: await this.candidates(call.value) };
      case 'place_part': {
        const p = call.value;
        await this.factory(p.partId, p.colorId);
        let transform: number[];
        if (p.pose.kind === 'connection') {
          const candidate = requireValue(
            (
              await this.candidates(
                {
                  partId: p.partId,
                  targetInstanceId: p.pose.target.instanceId,
                  sourceConnectorId: p.pose.source,
                  targetConnectorId: p.pose.target.connectorId,
                  limit: 1,
                },
                p.pose.angle,
              )
            )[0],
            'INCOMPATIBLE_CONNECTOR',
          );
          const ctx = requireValue(resolveContext(this.doc, this.context(p.modelPath)), 'MODEL_NOT_FOUND');
          transform = toLDraw(multiply(invert(ctx.matrix), fromLDraw(candidate.pose.matrix_ldu)));
        } else transform = poseTransform(p.pose);
        const result = this.command(
          { type: 'part.add', partId: p.partId, colorId: p.colorId, transform },
          this.context(p.modelPath),
        );
        return { created: result.selection?.map((p) => p.at(-1)) ?? [], paths: result.selection ?? [] };
      }
      case 'move': {
        const p = call.value,
          d = 'x' in p.delta ? gridToLdu(p.delta) : p.delta;
        return this.onPaths(p.instanceIds, (paths) => ({
          type: 'transform.translate',
          paths,
          delta: [d.x_ldu, d.y_ldu, d.z_ldu],
          space: 'world',
        }));
      }
      case 'rotate': {
        const p = call.value,
          paths = this.paths(p.instanceIds);
        const centers = paths.map((path) => resolvePath(this.doc, path)!.worldMatrix);
        const pivot = p.pivot
          ? gridToLdu(p.pivot)
          : {
              x_ldu: centers.reduce((s, m) => s + m[12]!, 0) / centers.length,
              y_ldu: centers.reduce((s, m) => s + m[13]!, 0) / centers.length,
              z_ldu: centers.reduce((s, m) => s + m[14]!, 0) / centers.length,
            };
        const axis: Vec3 = p.axis === 'x' ? [1, 0, 0] : p.axis === 'y' ? [0, -1, 0] : [0, 0, 1];
        return this.onPaths(p.instanceIds, (paths) => ({
          type: 'transform.rotate',
          paths,
          axis,
          degrees: p.degrees,
          pivot: { kind: 'point', point: [pivot.x_ldu, pivot.y_ldu, pivot.z_ldu] },
          space: 'world',
        }));
      }
      case 'set_transform':
        return this.onPaths(
          call.value.instanceIds,
          (paths) => ({ type: 'transform.set', paths, transform: poseTransform(call.value.pose), space: 'world' }),
          true,
        );
      case 'set_color': {
        const parts = new Set<string>();
        for (const path of this.paths(call.value.instanceIds)) {
          const instance = requireValue(resolvePath(this.doc, path), 'INSTANCE_NOT_FOUND').instance;
          if (instance.ref.kind === 'part') parts.add(instance.ref.partId);
          else for (const row of expandInstances(this.doc, instance.ref.modelId)) parts.add(row.partId);
        }
        for (const partId of parts) await this.factory(partId, call.value.colorId);
        return this.onPaths(call.value.instanceIds, (paths) => ({
          type: 'color.set',
          paths,
          colorId: call.value.colorId,
        }));
      }
      case 'replace_color': {
        const p = call.value;
        const rows = this.rows(p.modelPath).filter((r) => r.colorId === p.fromColorId);
        for (const partId of new Set(rows.map((row) => row.partId))) await this.factory(partId, p.toColorId);
        // Update shared definitions once, irrespective of their number of occurrences.
        const seen = new Set<string>();
        for (const row of rows) {
          const r = resolvePath(this.doc, row.path)!;
          const key = row.path.at(-1)!;
          if (seen.has(key)) continue;
          seen.add(key);
          this.command(
            { type: 'color.set', paths: [row.path], colorId: p.toColorId },
            { activeModelPath: row.path.slice(0, -1), selection: [] },
          );
          void r;
        }
        return { changed: rows.length };
      }
      case 'delete':
        return this.onPaths(call.value.instanceIds, (paths) => ({ type: 'edit.delete', paths }));
      case 'create_group':
      case 'create_submodel': {
        const p = call.value,
          paths = this.paths(p.instanceIds),
          parent = paths[0]!.slice(0, -1);
        if (call.name === 'create_submodel')
          for (const row of expandInstances(this.doc).filter((r) => paths.some((p) => pathStartsWith(r.path, p))))
            this.bounds.set(row.partId, (await this.services.assemblyPart(row.partId)).collider.bounds);
        if (paths.some((path) => JSON.stringify(path.slice(0, -1)) !== JSON.stringify(parent)))
          throw new HostFailure('DIFFERENT_MODELS');
        const result = this.command(
          call.name === 'create_group'
            ? { type: 'group.create', name: p.name, paths }
            : { type: 'submodel.create', name: p.name, paths },
          { activeModelPath: parent, selection: paths },
        );
        const selected = result.selection?.[0],
          instance = selected ? resolvePath(this.doc, selected)?.instance : undefined;
        return call.name === 'create_group'
          ? { groupId: resolvePath(this.doc, paths[0]!)?.instance.groupId }
          : {
              submodelId: instance?.ref.kind === 'model' ? instance.ref.modelId : null,
              instanceId: instance?.id,
              modelPath: selected,
            };
      }
      case 'ungroup': {
        for (const groupId of call.value.groupIds) this.command({ type: 'group.dissolve', groupIds: [groupId] });
        return { removed: call.value.groupIds };
      }
      case 'instantiate_submodel': {
        const p = call.value,
          out = this.command(
            { type: 'submodel.instantiate', modelId: p.submodelId, transform: poseTransform(p.pose) },
            this.context(p.modelPath),
          );
        return { instanceId: out.selection?.[0]?.at(-1), modelPath: out.selection?.[0] };
      }
      case 'make_unique':
        return this.onPaths([call.value.instanceId], (paths) => ({ type: 'submodel.makeUnique', paths }));
      case 'batch': {
        const p = call.value,
          tx = requireValue(this.transaction, 'NO_TRANSACTION'),
          start = tx.ops.slice(),
          assets = { ...this.tab.assets },
          results: ToolResult[] = [];
        this.batchDepth++;
        try {
          for (const op of p.operations) {
            const output = (await this.request(op.tool, op.arguments, tx.owner)) as ToolResult;
            results.push(output);
            if (!output.ok && p.atomic) {
              tx.ops = start;
              this.tab.session.preview(start);
              this.tab.assets = assets;
              this.changed();
              while (results.length < p.operations.length) results.push(failure('BATCH_SKIPPED'));
              return { results, rolledBack: true };
            }
          }
          return { results, rolledBack: false };
        } finally {
          if (--this.batchDepth === 0 && this.batchChanged) {
            this.batchChanged = false;
            this.services.changed();
          }
        }
      }
      case 'validate': {
        const p = call.value;
        let issues = normalized(await this.services.check(this.doc, p.modelPath));
        if (p.checks) {
          const checks = new Set<string>(p.checks);
          issues = issues.filter(
            (v) =>
              checks.has(v.kind) ||
              (checks.has('collision') && v.kind === 'collisionUnknown') ||
              (checks.has('non_factory_color') && v.kind === 'unavailable_color') ||
              (checks.has('connectivity') && v.kind === 'unreviewedConnectors'),
          );
        }
        if (!p.checks || p.checks.includes('cycle'))
          issues.push(...validateDocument(this.doc).map((v) => ({ kind: 'cycle', code: v.code, path: v.path })));
        return { issues };
      }
      case 'render_views': {
        const result = await this.services.render(this.doc, call.value);
        return { images: result.images };
      }
      case 'add_reference_image': {
        const p = call.value,
          decoded = await this.services.decode(p.image),
          bytes = Uint8Array.from(atob(p.image.base64), (c) => c.charCodeAt(0));
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const path = `assets/images/${hash}`,
          referenceId = ulid();
        this.tab.assets[path] = bytes;
        this.stage([
          {
            type: 'asset.add',
            items: [
              {
                kind: 'referenceImage',
                id: referenceId,
                value: {
                  hash,
                  path,
                  name: p.name,
                  mime: p.image.mime,
                  width: decoded.width,
                  height: decoded.height,
                  ...(p.view ? { view: p.view } : {}),
                },
              },
            ],
          },
        ]);
        return { referenceId };
      }
      case 'compare_to_reference': {
        const p = call.value,
          ref = requireValue(this.doc.referenceImages[p.referenceId], 'REFERENCE_NOT_FOUND');
        if (ref.view && ref.view !== p.view) throw new HostFailure('VIEW_MISMATCH');
        const original = await this.reference(p.referenceId),
          reference = shrinkComparisonImage(original);
        const render = await this.services.render(this.doc, {
          views: [p.view],
          width: reference.width,
          height: reference.height,
          transparent: true,
          ...(p.modelPath ? { modelPath: p.modelPath } : {}),
        });
        const comparison = compareImages(reference, render.rgba[0]!);
        if (!comparison.referenceMask.pixels) throw new HostFailure('REFERENCE_EMPTY');
        return {
          iou: comparison.iou,
          colorDifference: comparison.colorDifference,
          boundsRatioDifference: comparison.boundsRatioDifference,
          referencePixels: comparison.referenceMask.pixels,
          renderedPixels: comparison.renderedMask.pixels,
          emptyModel: comparison.renderedMask.pixels === 0,
          // Also cap the wider composite for large references; preserve existing small-image output (A-114).
          images: [this.services.encode(reference, 'viewport'), this.services.encode(render.rgba[0]!, 'viewport')],
          comparisonImage: this.services.encode(
            reference === original ? comparison.comparison : shrinkComparisonImage(comparison.comparison),
            'viewport',
          ),
        };
      }
      case 'get_bom':
        return this.services.bom(this.doc, call.value.modelPath);
      case 'suggest_factory_substitutes': {
        const p = call.value,
          original = requireValue(
            await this.services.library.catalogPart(p.partId as LibraryPart['id']),
            'PART_NOT_FOUND',
          ),
          originalData = await this.services.assemblyPart(original.id),
          catalog = await this.services.catalog();
        const parts = await this.services.library.catalogSearch('', {
          includeAll: false,
          categoryId: original.categoryId,
        });
        const scored = await Promise.all(
          parts
            .filter((part) => !p.colorId || catalog.parts.find((row) => row.id === part.id)?.colors.includes(p.colorId))
            .map(async (part) => {
              const data = await this.services.assemblyPart(part.id);
              const dimensions = [0, 1, 2].reduce(
                (sum, k) =>
                  sum +
                  Math.abs(
                    data.collider.bounds[k + 3]! -
                      data.collider.bounds[k]! -
                      (originalData.collider.bounds[k + 3]! - originalData.collider.bounds[k]!),
                  ),
                0,
              );
              const types = new Set(originalData.connectors.connectors.map((v) => v.type));
              return {
                ...part,
                score: dimensions + data.connectors.connectors.filter((v) => !types.has(v.type)).length * 20,
              };
            }),
        );
        return { parts: scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, p.limit) };
      }
      case 'make_mosaic': {
        const p = call.value,
          partId = p.partId.includes(':') ? p.partId : `ld:${p.partId}`,
          factory = await this.factory(partId),
          colors = (await this.services.library.catalogColors()).factory.filter(
            (c) => factory.colors.includes(c.id) && (!p.colorIds || p.colorIds.includes(c.id)),
          );
        const part = requireValue(
          await this.services.library.catalogPart(partId as LibraryPart['id']),
          'PART_NOT_FOUND',
        );
        if (!/tile|平滑/i.test(part.nameEn + part.nameZh) || !/1 x 1|1×1/.test(part.nameEn + part.nameZh))
          throw new HostFailure('MOSAIC_TILE_REQUIRED');
        const mosaic = generateMosaic(await this.reference(p.referenceId), {
          width: p.width,
          height: p.height,
          palette: colors.map((c) => ({ id: c.id, rgb: rgb(c) })),
          tiles: [{ partId, width: 1, height: 1, colorIds: colors.map((c) => c.id) }],
          dither: p.dither,
          style: 'square',
          merge: false,
        });
        const model = this.model(),
          insertion = mosaicToOps(mosaic, { name: p.name, parentModelId: model.id, parentStepId: model.stepIds[0]! });
        this.stage(insertion.ops);
        return { submodelId: insertion.model.id, instanceId: insertion.instanceId, partCount: mosaic.pieces.length };
      }
      case 'export_io':
        return this.services.exportIo(this.tab);
      case 'job_status':
      case 'job_cancel':
        throw new HostFailure('JOB_NOT_FOUND');
    }
  }
  private async reference(id: string) {
    const ref = requireValue(this.doc.referenceImages[id], 'REFERENCE_NOT_FOUND'),
      bytes = requireValue(this.tab.assets[String(ref.path)], 'REFERENCE_NOT_FOUND');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return this.services.decode({
      type: 'image',
      mime: (ref.mime ?? 'image/png') as ImageBlock['mime'],
      base64: btoa(binary),
    });
  }
  private partSnapshot() {
    return new Map(
      expandInstances(this.doc).map((row) => [
        row.path.at(-1)!,
        JSON.stringify([row.partId, row.colorId, Array.from(row.worldMatrix)]),
      ]),
    );
  }
  private onPaths(ids: string[], command: (paths: InstancePath[]) => Command, individual = false) {
    const paths = this.paths(ids),
      groups = new Map<string, InstancePath[]>();
    for (const path of paths) {
      const key = JSON.stringify(individual ? path : path.slice(0, -1));
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    for (const group of groups.values())
      this.command(command(group), { activeModelPath: group[0]!.slice(0, -1), selection: group });
    return { changed: ids.length };
  }
}
function rgb(color: LibraryColor): [number, number, number] {
  return [1, 3, 5].map((n) => parseInt(color.rgb.slice(n, n + 2), 16)) as [number, number, number];
}
