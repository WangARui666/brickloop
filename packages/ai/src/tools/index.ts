import { z } from 'zod';
import type { ImageBlock, JsonValue, ToolResultBlock, ToolSpec } from '../types.js';
import { mutationNames, toolSchemas, type ToolInput, type ToolName } from './schemas.js';
export * from './schemas.js';

export type ValidationIssue = { kind: string; [key: string]: JsonValue };
export type ToolResult<T = JsonValue> =
  | { ok: true; data: T; introducedIssues: ValidationIssue[]; warnings: string[] }
  | { ok: false; code: string; message: string; details?: JsonValue };
export type ToolOutput<K extends ToolName> = K extends 'render_views' | 'compare_to_reference'
  ? ToolResult<{ images: ImageBlock[]; [key: string]: JsonValue }>
  : ToolResult;
export type EditorHost = {
  [K in ToolName]: (input: ToolInput<K>) => Promise<ToolOutput<K>>;
} & {
  beginTransaction(label: string): Promise<void>;
  commitTransaction(): Promise<void>;
};
export interface EditorTool extends ToolSpec { execute(host: EditorHost, input: unknown): Promise<ToolResult> }
const descriptions: Record<ToolName, string> = {
  run_build_script: 'Build large or repeated structures (walls, floors, towers, roofs, terrain, rows of plants) with sandboxed JavaScript in one transaction. Read relevant examples and design guides first. Use per-part tools for individual adjustments. Returns statistics, connectivity and weak-connection warnings, output hash and submodel bounds; inspect warnings and check with render_views or view_layers after every run. replace deletes only this script previous output and respects selection scope. Errors include source line and column.',
  get_build_script: 'Read saved build script code, settings and last run statistics before editing it or applying a unified diff.',
  list_build_scripts: 'List scripts saved in the current project, including targets, scope, seed and last output hash.',
  list_build_examples: 'List reusable build-script examples and their intended use before writing large or repeated structures.',
  get_build_example: 'Read a build-script example and its code before adapting it to the design.',
  get_design_guide: 'Read the English design guide for buildings, vehicles, plants, terrain, or figures and props before scripting that category.',
  view_layers: 'Inspect inclusive plate-height levels as compact top-down text maps in the requested model local coordinates. Use after run_build_script to check layout; use render_views for exact geometry.',
  get_model_summary: 'Get submodel tree, counts, grid bounds, colors, selection and recent validation.',
  list_instances: 'List instances using filters and pagination; all positions use grid units.',
  get_instance: 'Get a single instance, grid pose, groups, submodel and connections.',
  get_selection: 'Get the current selected instances.',
  search_parts: 'Search parts by name, category or dimensions; factory parts only by default.',
  get_part_info: 'Inspect dimensions, footprint, connectors in local grid units and factory colors before placement.',
  list_colors: 'List factory colors or colors used in the project.',
  find_connection_candidates: 'Find compatible connector pairs and resulting grid poses for a part and target instance.',
  place_part: 'Place a factory part by connector alignment, grid position or a 12-number LDraw matrix.',
  move: 'Translate instances by grid displacement (level is positive upward) or explicit LDU displacement.',
  rotate: 'Rotate instances around an axis in grid coordinates (Y is upward), optionally around a grid pivot.',
  set_transform: 'Set absolute instance poses; matrix_ldu uses LDraw coordinates, negative Y upward.',
  set_color: 'Set factory color on selected instances.',
  replace_color: 'Replace every occurrence of a color within the requested model path.',
  delete: 'Delete instances.', create_group: 'Create a named group of instances.', ungroup: 'Dissolve groups without deleting parts.',
  create_submodel: 'Create a named submodel from instances.', instantiate_submodel: 'Place an instance of an existing submodel.',
  make_unique: 'Make the selected submodel instance independent.',
  batch: 'Execute validated mutations together; atomic=true requires the host to roll back all items on failure and return per-item results and validation.',
  validate: 'Check collisions, floating parts, connectivity, factory constraints and cycles.',
  render_views: 'Render specified views and return base64 images with optional instance highlights.',
  compare_to_reference: 'Compare matching views: silhouette IoU, color difference, bounds and side-by-side images.',
  get_bom: 'Get the bill of materials.', suggest_factory_substitutes: 'Suggest factory substitutes by shape, size and connector similarity.',
  add_reference_image: 'Add a user-provided image as a named reference with an optional view.',
  make_mosaic: 'Create a mosaic submodel from a reference image using factory colors.',
  export_io: 'Export Studio .io through the host; use a configured output directory or request host path confirmation.',
  job_status: 'Get asynchronous job progress and result.', job_cancel: 'Cancel an asynchronous job.',
};
function define<K extends ToolName>(name: K): EditorTool {
  const schema = toolSchemas[name];
  const parameters = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });
  delete parameters.$schema;
  return {
    name, namespace: 'editor', description: descriptions[name], schema, parameters, mutating: mutationNames.has(name),
    async execute(host, input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { ok: false, code: 'INVALID_ARGUMENTS', message: 'Tool arguments do not match the schema.' };
      try {
        // The indexed method and schema share K; TS loses that correlation through mapped types.
        const method = host[name] as (value: ToolInput<K>) => Promise<ToolResult>;
        return await method.call(host, parsed.data as ToolInput<K>);
      } catch { return { ok: false, code: 'HOST_ERROR', message: 'The editor could not complete the operation.' }; }
    },
  };
}
export function createEditorTools(): EditorTool[] {
  return (Object.keys(toolSchemas) as ToolName[]).sort().map(define);
}
export function resultContent(result: ToolResult): ToolResultBlock['content'] {
  const images: ImageBlock[] = [];
  let data = result;
  if (result.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    const parsed = z.array(toolSchemas.add_reference_image.shape.image).safeParse(result.data.images);
    if (parsed.success) {
      const comparison = toolSchemas.add_reference_image.shape.image.safeParse(result.data.comparisonImage);
      // The desktop keeps originals for independent previews. Send the composite once to the model,
      // and never serialize its base64 into the text payload or count the originals a second time.
      images.push(...(comparison.success ? [comparison.data] : parsed.data));
      const { images: _images, comparisonImage: _comparisonImage, ...rest } = result.data;
      void _images;
      void _comparisonImage;
      data = { ...result, data: rest };
    }
  }
  return [{ type: 'text', text: JSON.stringify(data) }, ...images];
}
