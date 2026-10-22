import { z } from 'zod';

const id = z.string().min(1);
const ids = z.array(id).min(1);
const scalar = z.number().finite();
const stud = scalar.multipleOf(0.5);
export const gridPositionSchema = z.strictObject({ x: stud, z: stud, level: scalar });
export const lduPositionSchema = z.strictObject({ x_ldu: scalar, y_ldu: scalar, z_ldu: scalar });
type Matrix12 = [number, number, number, number, number, number, number, number, number, number, number, number];
// A fixed-length array, not z.tuple: tuple `items` arrays make some MCP clients (Codex) drop the whole tool.
export const matrixSchema = z
  .array(scalar)
  .length(12)
  .transform((m) => m as Matrix12);
export const poseSchema = z.union([
  z.strictObject({ kind: z.literal('grid'), ...gridPositionSchema.shape, rotY: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0) }),
  z.strictObject({ kind: z.literal('matrix'), matrix_ldu: matrixSchema }),
  z.strictObject({ kind: z.literal('ldu'), ...lduPositionSchema.shape, rotY: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0) }),
]);
const connection = z.strictObject({ kind: z.literal('connection'), source: id, target: z.strictObject({ instanceId: id, connectorId: id }), angle: scalar.default(0) });
const image = z.strictObject({ type: z.literal('image'), base64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']) });
const view = z.enum(['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric']);
const modelPath = z.array(id).optional();
const empty = z.strictObject({});
const scriptId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const buildScriptSchema = z.strictObject({
  scriptId,
  name: z.string().min(1).max(200).optional(),
  code: z.string().max(1_000_000).optional(),
  patch: z.string().min(1).max(1_000_000).optional(),
  target: z.string().min(1).max(200).optional().describe('Target submodel name, or root for the root model. Defaults to the saved target, then root.'),
  mode: z.enum(['replace', 'add']).default('replace').describe('Replace removes this script output only; add retains and tracks previous output.'),
  scope: z.enum(['factory', 'all']).optional().describe('Defaults to factory in chat and all in image building. all uses the complete LDraw catalog.'),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
}).refine((v) => !(v.code !== undefined && v.patch !== undefined), 'Supply code or a unified diff patch, never both. Omit both to rerun a saved script.');
const mutationSchemas = {
  run_build_script: buildScriptSchema,
  place_part: z.strictObject({ partId: id, colorId: id, modelPath, pose: z.union([poseSchema, connection]) }),
  move: z.strictObject({ instanceIds: ids, delta: z.union([gridPositionSchema, lduPositionSchema]) }),
  rotate: z.strictObject({ instanceIds: ids, axis: z.enum(['x', 'y', 'z']), degrees: scalar, pivot: gridPositionSchema.optional() }),
  set_transform: z.strictObject({ instanceIds: ids, pose: poseSchema }),
  set_color: z.strictObject({ instanceIds: ids, colorId: id }),
  replace_color: z.strictObject({ fromColorId: id, toColorId: id, modelPath }),
  delete: z.strictObject({ instanceIds: ids }),
  create_group: z.strictObject({ instanceIds: ids, name: id }),
  ungroup: z.strictObject({ groupIds: ids }),
  create_submodel: z.strictObject({ instanceIds: ids, name: id }),
  instantiate_submodel: z.strictObject({ submodelId: id, modelPath, pose: poseSchema }),
  make_unique: z.strictObject({ instanceId: id }),
  add_reference_image: z.strictObject({ image, name: id, view: view.optional() }),
  make_mosaic: z.strictObject({ referenceId: id, width: z.number().int().positive(), height: z.number().int().positive(), colorIds: ids.optional(), partId: id.default('3070b'), dither: z.boolean().default(false), name: id }),
};
// Explicit union keeps nested batches impossible and every operation independently validated.
const batchOperation = z.union([
  z.strictObject({ tool: z.literal('run_build_script'), arguments: mutationSchemas.run_build_script }),
  z.strictObject({ tool: z.literal('place_part'), arguments: mutationSchemas.place_part }),
  z.strictObject({ tool: z.literal('move'), arguments: mutationSchemas.move }),
  z.strictObject({ tool: z.literal('rotate'), arguments: mutationSchemas.rotate }),
  z.strictObject({ tool: z.literal('set_transform'), arguments: mutationSchemas.set_transform }),
  z.strictObject({ tool: z.literal('set_color'), arguments: mutationSchemas.set_color }),
  z.strictObject({ tool: z.literal('replace_color'), arguments: mutationSchemas.replace_color }),
  z.strictObject({ tool: z.literal('delete'), arguments: mutationSchemas.delete }),
  z.strictObject({ tool: z.literal('create_group'), arguments: mutationSchemas.create_group }),
  z.strictObject({ tool: z.literal('ungroup'), arguments: mutationSchemas.ungroup }),
  z.strictObject({ tool: z.literal('create_submodel'), arguments: mutationSchemas.create_submodel }),
  z.strictObject({ tool: z.literal('instantiate_submodel'), arguments: mutationSchemas.instantiate_submodel }),
  z.strictObject({ tool: z.literal('make_unique'), arguments: mutationSchemas.make_unique }),
  z.strictObject({ tool: z.literal('add_reference_image'), arguments: mutationSchemas.add_reference_image }),
  z.strictObject({ tool: z.literal('make_mosaic'), arguments: mutationSchemas.make_mosaic }),
]);
export const toolSchemas = {
  get_build_script: z.strictObject({ scriptId }),
  list_build_scripts: empty,
  list_build_examples: empty,
  get_build_example: z.strictObject({ id }),
  get_design_guide: z.strictObject({ category: z.enum(['buildings', 'vehicles', 'plants', 'terrain', 'figures-and-props']) }),
  view_layers: z.strictObject({ modelPath, fromLevel: z.number().int(), toLevel: z.number().int() }).refine((v) => v.toLevel >= v.fromLevel && v.toLevel - v.fromLevel < 128, 'Request at most 128 inclusive levels.'),
  get_model_summary: z.strictObject({ modelPath }),
  list_instances: z.strictObject({ modelPath, partId: id.optional(), colorId: id.optional(), groupId: id.optional(), bounds: z.strictObject({ min: gridPositionSchema, max: gridPositionSchema }).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100) }),
  get_instance: z.strictObject({ instanceId: id, modelPath }),
  get_selection: empty,
  search_parts: z.strictObject({ query: z.string(), category: id.optional(), dimensions: gridPositionSchema.optional(), factoryOnly: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(20) }),
  get_part_info: z.strictObject({ partId: id }),
  list_colors: z.strictObject({ source: z.enum(['factory', 'project']).default('factory') }),
  find_connection_candidates: z.strictObject({ partId: id, targetInstanceId: id, sourceConnectorId: id.optional(), targetConnectorId: id.optional(), limit: z.number().int().min(1).max(100).default(20) }),
  ...mutationSchemas,
  batch: z.strictObject({ operations: z.array(batchOperation).min(1).max(80), atomic: z.boolean().default(true) }),
  validate: z.strictObject({ modelPath, checks: z.array(z.enum(['collision', 'floating', 'connectivity', 'non_factory_part', 'non_factory_color', 'cycle'])).optional() }),
  render_views: z.strictObject({ views: z.array(view).min(1).max(7), width: z.number().int().min(32).max(4096).default(768), height: z.number().int().min(32).max(4096).default(768), transparent: z.boolean().default(false), highlightInstanceIds: ids.optional(), modelPath }),
  compare_to_reference: z.strictObject({ referenceId: id, view, modelPath }),
  get_bom: z.strictObject({ modelPath }),
  suggest_factory_substitutes: z.strictObject({ partId: id, colorId: id.optional(), limit: z.number().int().min(1).max(100).default(10) }),
  export_io: z.strictObject({ destination: z.enum(['default', 'ask_host']).default('ask_host') }),
  job_status: z.strictObject({ jobId: id }),
  job_cancel: z.strictObject({ jobId: id }),
};
export type ToolName = keyof typeof toolSchemas;
export type ToolInput<K extends ToolName> = z.output<(typeof toolSchemas)[K]>;
export const mutationNames: ReadonlySet<ToolName> = new Set([...Object.keys(mutationSchemas) as (keyof typeof mutationSchemas)[], 'batch']);
