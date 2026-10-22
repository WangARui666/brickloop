import { expect, it } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, Ray, Vector3 } from 'three/webgpu';
import type { MeshStandardMaterial } from 'three/webgpu';
import { buildPartMesh, LibraryResolver, createMemorySource } from '@brickloop/ldraw';
import {
  createDocument,
  DocumentSession,
  identity,
  toLDraw,
  expandInstances,
  resolveContext,
  ulid,
  executeCommand,
} from '@brickloop/core';
import type { ColorDef } from '@brickloop/catalog';
import { DocumentProjection } from '../src/document-projection';
const red: ColorDef = {
  id: 'c:red',
  legoName: 'Red',
  legoColorId: 21,
  nameZh: '红',
  ldrawCode: 4,
  rgb: '#ff0000',
  edgeRgb: '#220000',
  finish: 'solid',
  alpha: 1,
};
it('shows selectable neutral placeholders and replaces them as each definition arrives', async () => {
  const { projection, session } = await setup();
  session.dispatch({ type: 'part.add', partId: 'ld:pending', colorId: 'c:red' });
  const palette = [red];
  projection.sync(session.document, session.workspace, palette);
  expect(projection.rows).toHaveLength(1);
  expect(projection.loadedCount).toBe(0);
  expect(projection.pick(new Ray(new Vector3(0, -12, 100), new Vector3(0, 0, -1)))?.partId).toBe('ld:pending');
  const placeholder = projection.batches.get('$loading/c:red/active/clear')!;
  const material = (placeholder.object.material as MeshStandardMaterial[])[0]!;
  expect(material.color.r).toBeCloseTo(material.color.g, 1);
  projection.register('ld:pending', projection.definitions.get('ld:test')!.mesh);
  projection.sync(session.document, session.workspace, palette);
  expect(projection.loadedCount).toBe(1);
  expect(projection.batches.has('$loading/c:red/active/clear')).toBe(false);
  projection.dispose();
});
it('updates only the moving occurrence during a 10000-part preview and restores it on cancel', async () => {
  const { projection, session } = await setup();
  const model = session.document.models[session.document.rootModelId]!;
  const ids = Array.from({ length: 10000 }, () => ulid());
  session.applyExternal(
    [
      {
        type: 'instance.add',
        items: ids.map((id, index) => ({
          modelId: model.id,
          instance: {
            id,
            ref: { kind: 'part' as const, partId: 'ld:test' },
            colorId: 'c:red',
            transform: [index * 20, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
            stepId: model.stepIds[0]!,
            groupId: null,
          },
        })),
      },
    ],
    'fixture',
  );
  session.setContext({ activeModelPath: [], selection: [[ids[0]!]] });
  const palette = [red];
  projection.sync(session.document, session.workspace, palette);
  const untouched = projection.rows[9999]!.matrix;
  session.begin('move');
  const result = executeCommand(session.transactionBase, session.context, {
    type: 'transform.translate',
    delta: [8, 0, 0],
  });
  if (!result.ok) throw new Error(result.error.messageKey);
  expect(session.preview(result.value.ops).ok).toBe(true);
  projection.sync(session.document, session.workspace, palette);
  expect(projection.stats.matrixWrites).toBe(1);
  expect(projection.stats.boundsRefits).toBeLessThan(20);
  expect(projection.batches.get('ld:test/c:red/active/clear')!.object.instanceMatrix.updateRanges).toHaveLength(1);
  expect(projection.rows[9999]!.matrix).toBe(untouched);
  expect(projection.rows[0]!.matrix.elements[12]).toBe(8);
  const rows = projection.rows;
  projection.previewCollisions([rows[0]!.path]);
  const collided = executeCommand(session.transactionBase, session.context, {
    type: 'transform.translate',
    delta: [16, 0, 0],
  });
  if (!collided.ok) throw new Error(collided.error.messageKey);
  expect(session.preview(collided.value.ops).ok).toBe(true);
  projection.sync(session.document, session.workspace, palette);
  expect(projection.rows).toBe(rows);
  expect(projection.stats.matrixWrites).toBe(1);
  expect(projection.rows[0]!.matrix.elements[12]).toBe(16);
  session.cancel();
  projection.sync(session.document, session.workspace, palette);
  expect(projection.rows[0]!.matrix.elements[12]).toBe(0);
  projection.dispose();
});
it('views cumulative steps and dims previous parts with the same material as editing context', async () => {
  const { projection, session } = await setup();
  const modelId = session.document.rootModelId;
  const first = session.document.models[modelId]!.stepIds[0]!;
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red', stepId: first });
  session.dispatch({ type: 'step.add' });
  const second = session.document.models[modelId]!.stepIds[1]!;
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red', stepId: second });
  session.dispatch({ type: 'step.add' });
  const third = session.document.models[modelId]!.stepIds[2]!;
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red', stepId: third });
  const workspace = structuredClone(session.workspace);
  projection.sync(session.document, { ...workspace, panelState: { stepViewing: true, stepId: second } }, [red]);
  expect(projection.rows.map((row) => [row.visible, row.dimmed])).toEqual([
    [true, true],
    [true, false],
    [false, false],
  ]);
  const materials = projection.batches.get('ld:test/c:red/context/clear')!.object.material;
  const dimmed = (Array.isArray(materials) ? materials[0]! : materials) as MeshStandardMaterial;
  const lightness = dimmed.color.getHSL({ h: 0, s: 0, l: 0 });
  expect(lightness.s).toBeLessThan(1);
  expect(lightness.s).toBeGreaterThan(0.6);
  expect(lightness.l).toBeLessThan(0.15);
  expect(dimmed.opacity).toBeCloseTo(0.85);
  expect(session.workspace).toEqual(workspace);
  projection.sync(session.document, workspace, [red]);
  expect(projection.rows.every((row) => row.visible && !row.dimmed)).toBe(true);
  projection.dispose();
});
async function setup() {
  const mesh = await buildPartMesh(
    'test.dat',
    new LibraryResolver({
      library: createMemorySource('test', {
        'parts/test.dat': '0 Test\n4 16 0 0 0 10 0 0 10 10 0 0 10 0\n2 24 0 0 0 10 0 0',
      }),
    }),
  );
  const projection = new DocumentProjection();
  projection.register('ld:test', mesh);
  const session = new DocumentSession(createDocument({ title: 'Test' }), { bboxProvider: () => mesh.bboxLdu });
  return { projection, session };
}
it('retains batches and geometry while updating only changed occurrence slots', async () => {
  const { projection, session } = await setup();
  for (let i = 0; i < 3; i++) {
    const transform = toLDraw(identity());
    transform[0] = i * 20;
    session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red', transform });
  }
  projection.sync(session.document, session.workspace, [red]);
  const object = projection.batches.get('ld:test/c:red/active/clear')!.object,
    geometry = object.geometry;
  const allocation = projection.stats.allocations;
  session.dispatch({ type: 'transform.translate', delta: [5, 0, 0] });
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.stats.matrixWrites).toBe(1);
  expect(projection.stats.allocations).toBe(allocation);
  expect(projection.batches.get('ld:test/c:red/active/clear')!.object).toBe(object);
  expect(object.geometry).toBe(geometry);
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.stats.matrixWrites).toBe(0);
  session.undo();
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.stats.matrixWrites).toBe(1);
  projection.dispose();
});
it('expands shared definitions, refreshes BVH picking after a shared edit, and hides by occurrence', async () => {
  const { projection, session } = await setup();
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red' });
  session.dispatch({ type: 'submodel.create', name: 'Shared' });
  const first = session.workspace.selection[0]!;
  const root = session.document.models[session.document.rootModelId]!,
    reference = root.instances[first[0]!]!;
  if (reference.ref.kind !== 'model') throw new Error('Expected submodel');
  const transform = toLDraw(identity());
  transform[0] = 100;
  session.dispatch({ type: 'submodel.instantiate', modelId: reference.ref.modelId, transform });
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.rows).toHaveLength(2);
  const child = expandInstances(session.document)[0]!.path;
  session.setContext({ activeModelPath: first, selection: [child] });
  const parentBefore = resolveContext(session.document, session.context)!.matrix;
  session.dispatch({ type: 'transform.translate', delta: [5, 0, 0] });
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.stats.matrixWrites).toBe(2);
  expect(resolveContext(session.document, session.context)!.matrix).toEqual(parentBefore);
  const row = projection.rows[0]!,
    center = row.bounds.getCenter(new Vector3());
  const ray = new Ray(center.clone().add(new Vector3(0, 0, 100)), new Vector3(0, 0, -1));
  expect(projection.pick(ray)?.path).toEqual(child);
  session.updateWorkspace({ hidden: [first] });
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.pick(ray)).toBeNull();
  expect(projection.rows[1]!.visible).toBe(true);
  projection.dispose();
});

it('releases removed batch geometry while sharing definition data with surviving batches and picking', async () => {
  const { projection, session } = await setup();
  const blue: ColorDef = { ...red, id: 'c:blue', rgb: '#0000ff' };
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: red.id });
  const transform = toLDraw(identity());
  transform[0] = 100;
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: blue.id, transform });
  projection.sync(session.document, session.workspace, [red, blue]);
  const retained = projection.batches.get('ld:test/c:red/active/clear')!;
  const removed = projection.batches.get('ld:test/c:blue/active/clear')!;
  const source = projection.definitions.get('ld:test')!.geometry;
  expect(removed.object.geometry).not.toBe(source);
  expect(removed.mask.geometry).not.toBe(removed.object.geometry);
  expect(retained.object.geometry.getAttribute('position')).toBe(source.getAttribute('position'));
  expect(removed.object.geometry.getAttribute('position')).toBe(source.getAttribute('position'));
  expect(removed.object.geometry.index).toBe(source.index);
  let disposed = 0;
  removed.object.geometry.addEventListener('dispose', () => disposed++);
  removed.mask.geometry.addEventListener('dispose', () => disposed++);
  session.dispatch({ type: 'color.set', colorId: red.id });
  projection.sync(session.document, session.workspace, [red, blue]);
  expect(disposed).toBe(2);
  expect(projection.batches.get('ld:test/c:red/active/clear')).toBe(retained);
  expect(projection.pick(new Ray(new Vector3(105, 5, 100), new Vector3(0, 0, -1)))?.colorId).toBe(red.id);
  expect(projection.rows).toHaveLength(2);
  projection.dispose();
});

it('refreshes culling bounds for moves, hiding, undo, and selection masks without reallocating', async () => {
  const { projection, session } = await setup();
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red' });
  projection.sync(session.document, session.workspace, [red]);
  const batch = [...projection.batches.values()][0]!;
  const camera = new OrthographicCamera(-20, 20, 20, -20, 0.1, 100);
  camera.position.set(0, 0, 50);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  expect(batch.object.frustumCulled).toBe(true);
  expect(frustum.intersectsObject(batch.object)).toBe(true);
  const allocation = projection.stats.allocations;
  session.dispatch({ type: 'transform.translate', delta: [1000, 0, 0] });
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.stats.allocations).toBe(allocation);
  expect(projection.stats.matrixWrites).toBe(1);
  expect(frustum.intersectsObject(batch.object)).toBe(false);
  expect(batch.mask.boundingSphere).toEqual(batch.object.boundingSphere);
  expect(batch.lines.geometry.boundingSphere).toEqual(batch.object.boundingSphere);
  expect(projection.bounds(session.workspace.selection).min.x).toBe(1000);
  session.undo();
  projection.sync(session.document, session.workspace, [red]);
  expect(frustum.intersectsObject(batch.object)).toBe(true);
  session.updateWorkspace({ hidden: session.workspace.selection });
  projection.sync(session.document, session.workspace, [red]);
  expect(batch.object.boundingBox?.isEmpty()).toBe(true);
  expect(batch.mask.visible).toBe(false);
  projection.dispose();
  expect(projection.rows).toHaveLength(0);
});

it('limits dormant definitions and re-registers source geometry from the desktop cache', async () => {
  const { projection, session } = await setup();
  const mesh = projection.definitions.get('ld:test')!.mesh;
  for (let i = 0; i < 70; i++) projection.register(`ld:cached-${i}`, mesh);
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.definitions.size).toBe(64);
  expect(projection.definitions.has('ld:test')).toBe(false);
  session.dispatch({ type: 'part.add', partId: 'ld:test', colorId: 'c:red' });
  projection.register('ld:test', mesh);
  projection.sync(session.document, session.workspace, [red]);
  expect(projection.rows).toHaveLength(1);
  expect(projection.pick(new Ray(new Vector3(5, 5, 100), new Vector3(0, 0, -1)))?.partId).toBe('ld:test');
  projection.dispose();
});

it('automatically hides distant subpixel edges but restores them nearby or in full-detail mode', async () => {
  const { projection, session } = await setup();
  const model = session.document.models[session.document.rootModelId]!;
  const result = session.applyExternal(
    [
      {
        type: 'instance.add',
        items: Array.from({ length: 1000 }, (_, index) => ({
          modelId: model.id,
          instance: {
            id: ulid(),
            ref: { kind: 'part' as const, partId: 'ld:test' },
            colorId: 'c:red',
            transform: [index * 20, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
            stepId: model.stepIds[0]!,
            groupId: null,
          },
        })),
      },
    ],
    'Fixture',
  );
  expect(result.ok).toBe(true);
  projection.sync(session.document, session.workspace, [red]);
  const camera = new OrthographicCamera(-10000, 10000, 10000, -10000, 0.1, 100000);
  const lines = [...projection.batches.values()][0]!.lines;
  projection.prepareRender(camera, 900);
  expect(lines.visible).toBe(false);
  projection.edgeMode = 'always';
  projection.prepareRender(camera, 900);
  expect(lines.visible).toBe(true);
  projection.edgeMode = 'auto';
  camera.zoom = 100;
  projection.prepareRender(camera, 900);
  expect(lines.visible).toBe(true);
  projection.dispose();
});
