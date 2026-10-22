import {
  apply,
  applyOps,
  createDocument,
  createModel,
  createUlidGenerator,
  executeCommand,
  identity,
  multiply,
  rotationAxisAngle,
  toLDraw,
  translation,
} from '../src';
import type {
  BrkDocument,
  Command,
  CommandServices,
  EditContext,
  IdGenerator,
  Instance,
  ModelDef,
  Result,
  Vec3,
} from '../src';

let fixtureTime = 1700000000000;
export function testIds(): IdGenerator {
  return createUlidGenerator({ clock: () => fixtureTime++, random: () => 0.25 });
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
export function rootContext(doc: BrkDocument, ids = Object.keys(doc.models[doc.rootModelId]!.instances)): EditContext {
  return { activeModelPath: [], selection: ids.map((id) => [id]) };
}
export function instance(
  id: IdGenerator,
  model: ModelDef,
  position: Vec3 = [0, 0, 0],
  colorId = 'c:bright-red',
): Instance {
  return {
    id: id(),
    ref: { kind: 'part', partId: 'ld:3001' },
    colorId,
    transform: toLDraw(translation(position)),
    stepId: model.stepIds[0]!,
    groupId: null,
  };
}
export function fixture(count = 3) {
  const id = testIds();
  let doc = createDocument({ title: 'test', author: 'fixture', createdAt: '2026-10-16T00:00:00Z' }, { id });
  const model = doc.models[doc.rootModelId]!;
  const instances = Array.from({ length: count }, (_, i) => instance(id, model, [i * 40, 0, 0]));
  doc = apply(doc, { type: 'instance.add', items: instances.map((item) => ({ modelId: model.id, instance: item })) });
  return { doc, id, instances, modelId: model.id, stepId: model.stepIds[0]!, context: rootContext(doc) };
}
export function pairFixture() {
  const base = fixture(0),
    { id } = base;
  const pair = createModel('pair', 'submodel', id);
  const red = instance(id, pair),
    yellow = instance(id, pair, [40, 0, 0], 'c:yellow');
  pair.instances = { [red.id]: red, [yellow.id]: yellow };
  pair.steps[pair.stepIds[0]!]!.instanceIds = [red.id, yellow.id];
  const main = base.doc.models[base.modelId]!;
  const first: Instance = { ...instance(id, main), ref: { kind: 'model', modelId: pair.id } };
  const second: Instance = {
    ...instance(id, main),
    ref: { kind: 'model', modelId: pair.id },
    transform: toLDraw(multiply(translation([100, 0, 50]), rotationAxisAngle([0, 1, 0], 90))),
  };
  const doc = applyOps(base.doc, [
    { type: 'model.add', items: [pair] },
    { type: 'instance.add', items: [first, second].map((item) => ({ modelId: main.id, instance: item })) },
  ]);
  return { ...base, doc, pair, red, yellow, first, second, context: rootContext(doc) };
}
export function run(doc: BrkDocument, context: EditContext, command: Command, services: CommandServices = {}) {
  const output = unwrap(executeCommand(doc, context, command, services));
  return { ...output, doc: applyOps(doc, output.ops) };
}
export const unitTransform = toLDraw(identity());
