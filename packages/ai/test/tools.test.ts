import { describe, expect, it, vi } from 'vitest';
import { createEditorTools, toolSchemas, resultContent, type ToolName } from '../src/tools/index.js';
import { gridToLdu, lduToGrid } from '../src/coordinates.js';
import { fakeHost, image, ok } from './helpers.js';

const pose = { kind: 'grid', x: 0.5, z: 1, level: 3, rotY: 90 };
it('sends one comparison image to the model and excludes all preview base64 from tool text', () => {
  const comparison = { ...image, base64: 'Y29tcGFyaXNvbg==' };
  const content = resultContent(ok({ images: [image, image], comparisonImage: comparison, iou: 0.7 }));
  expect(content).toEqual([{ type: 'text', text: JSON.stringify(ok({ iou: 0.7 })) }, comparison]);
  expect(JSON.stringify(content[0])).not.toContain('base64');
  expect(resultContent(ok({ images: [image] }))).toEqual([{ type: 'text', text: JSON.stringify(ok({})) }, image]);
});
const instances = { instanceIds: ['i1'] };
const samples: Record<ToolName, unknown> = {
  run_build_script: { scriptId: 'house', code: 'box(0,0,0,4,4,3,"Red")' },
  get_build_script: { scriptId: 'house' },
  list_build_scripts: {},
  list_build_examples: {},
  get_build_example: { id: 'cottage' },
  get_design_guide: { category: 'buildings' },
  view_layers: { modelPath: [], fromLevel: 0, toLevel: 5 },
  get_model_summary: {},
  list_instances: {},
  get_instance: { instanceId: 'i1' },
  get_selection: {},
  search_parts: { query: 'brick' },
  get_part_info: { partId: '3001' },
  list_colors: {},
  find_connection_candidates: { partId: '3001', targetInstanceId: 'i1' },
  place_part: { partId: '3001', colorId: 'S031', pose },
  move: { ...instances, delta: { x: 0.5, z: 0, level: 1 } },
  rotate: { ...instances, axis: 'y', degrees: 90 },
  set_transform: { ...instances, pose },
  set_color: { ...instances, colorId: 'S031' },
  replace_color: { fromColorId: 'red', toColorId: 'S031' },
  delete: instances,
  create_group: { ...instances, name: 'roof' },
  ungroup: { groupIds: ['g1'] },
  create_submodel: { ...instances, name: 'roof' },
  instantiate_submodel: { submodelId: 'm1', pose },
  make_unique: { instanceId: 'i1' },
  batch: { operations: [{ tool: 'delete', arguments: instances }] },
  validate: {},
  render_views: { views: ['front', 'isometric'] },
  compare_to_reference: { referenceId: 'ref1', view: 'front' },
  get_bom: {},
  suggest_factory_substitutes: { partId: '3001' },
  add_reference_image: { image, name: 'house' },
  make_mosaic: { referenceId: 'ref1', width: 16, height: 16, name: 'mosaic' },
  export_io: {},
  job_status: { jobId: 'j1' },
  job_cancel: { jobId: 'j1' },
};
describe.each(createEditorTools())('$name', (tool) => {
  it('validates its parameters and delegates exactly once with defaults', async () => {
    const host = fakeHost();
    const name = tool.name as ToolName;
    expect(await tool.execute(host, samples[name])).toEqual(ok());
    expect(host[name]).toHaveBeenCalledExactlyOnceWith(toolSchemas[name].parse(samples[name]));
    expect(tool.parameters).toMatchObject({ type: 'object' });
  });
  it('rejects unknown parameters before touching the host', async () => {
    const host = fakeHost();
    expect(await tool.execute(host, { unsupported: true })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(host[tool.name as ToolName]).not.toHaveBeenCalled();
  });
});
it('covers all 38 tools with deterministic serialization and structured host errors', async () => {
  const tools = createEditorTools();
  expect(tools).toHaveLength(38);
  expect(tools.map((t) => t.name)).toEqual([...tools.map((t) => t.name)].sort());
  expect(JSON.stringify(tools)).toEqual(JSON.stringify(createEditorTools()));
  const host = fakeHost();
  vi.mocked(host.place_part).mockRejectedValue(new Error('sk-secret-from-host'));
  const tool = tools.find((t) => t.name === 'place_part')!;
  expect(await tool.execute(host, samples.place_part)).toEqual({
    ok: false,
    code: 'HOST_ERROR',
    message: 'The editor could not complete the operation.',
  });
});
it('requires a single placement form, rejects nested/read-only batches and arbitrary export paths', () => {
  expect(
    toolSchemas.place_part.safeParse({
      partId: '3001',
      colorId: 'S031',
      pose: { ...pose, matrix_ldu: new Array<number>(12).fill(0) },
    }).success,
  ).toBe(false);
  expect(toolSchemas.batch.safeParse({ operations: [{ tool: 'get_selection', arguments: {} }] }).success).toBe(false);
  expect(toolSchemas.batch.safeParse({ operations: [{ tool: 'batch', arguments: { operations: [] } }] }).success).toBe(
    false,
  );
  expect(toolSchemas.export_io.safeParse({ path: 'C:/secret' }).success).toBe(false);
});
it('converts grid positions and negative-up LDraw coordinates without flipping Z', () => {
  const grid = { x: -1.5, z: 2, level: 3 };
  expect(gridToLdu(grid)).toEqual({ x_ldu: -30, y_ldu: -24, z_ldu: 40 });
  expect(lduToGrid(gridToLdu(grid))).toEqual(grid);
  expect(lduToGrid({ x_ldu: 1, y_ldu: -4, z_ldu: 3 })).toEqual({ x: 0.05, level: 0.5, z: 0.15 });
  expect(gridToLdu({ x: 0, z: 0, level: 0 })).toEqual({ x_ldu: 0, y_ldu: 0, z_ldu: 0 });
  expect(() => gridToLdu({ x: 0.1, z: 0, level: 0 })).toThrow();
  expect(() => gridToLdu({ x: Infinity, z: 0, level: 0 })).toThrow();
});
