// Run with: node scripts/devenv.mjs pnpm exec tsx --no-cache scripts/build-macros.mjs [--check]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { format, resolveConfig } from 'prettier';
import {
  applyOps,
  createDocument,
  createUlidGenerator,
  multiply,
  rotationAxisAngle,
  toLDraw,
  translation,
} from '../packages/core/src/index.ts';
import { buildPartMesh } from '../packages/ldraw/src/index.ts';
import { createLibraryResolver } from '../packages/ldraw/src/node.ts';
import { createMacroFromSelection, writeMacro } from '../packages/io/src/macro/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const createdAt = '2026-10-16T00:00:00.000Z';
const brown = 'c:reddish-brown',
  white = 'c:white',
  blue = 'c:bright-blue',
  black = 'c:black';
const models = [];
function model(id, nameZh, nameEn, category, build) {
  const parts = [];
  const add = (part, x, y, z, color = brown, rotation = 0) => parts.push({ part, x, y, z, color, rotation });
  build(add);
  models.push({ id: `builtin.${id}`, file: id, nameZh, nameEn, category, parts });
}

model('table', '桌子', 'Table', 'furniture', (add) => {
  for (const x of [-40, 40]) for (const z of [-20, 20]) for (const y of [-24, -48]) add('3003', x, y, z);
  add('3032', 0, -56, 0);
  for (const x of [-40, 0, 40]) for (const z of [-20, 20]) add('3068b', x, -64, z);
});
model('chair', '椅子', 'Chair', 'furniture', (add) => {
  add('3003', 0, -24, 0);
  add('3022', 0, -32, 0);
  add('3021', 10, -40, 0);
  for (const y of [-64, -88]) add('3004', -10, y, 0, brown, 90);
  add('3069b', -10, -96, 0, brown, 90);
  add('3068b', 20, -48, 0, blue);
});
model('bed', '床', 'Bed', 'furniture', (add) => {
  for (const x of [-60, 60]) for (const z of [-20, 20]) add('3003', x, -24, z);
  add('3035', 0, -32, 0);
  for (const x of [-40, 0, 40]) for (const z of [-20, 20]) add('3068b', x, -40, z, x === -40 ? white : blue);
  for (const y of [-56, -80]) add('3010', -70, y, 0, brown, 90);
  add('2431', -70, -88, 0, brown, 90);
  add('3010', 70, -56, 0, brown, 90);
  add('2431', 70, -64, 0, brown, 90);
});
model('bookshelf', '书架', 'Bookshelf', 'furniture', (add) => {
  for (const y of [-8, -64, -120]) add('3795', 0, y, 0);
  for (const x of [-40, 40]) for (const y of [-32, -56, -88, -112]) add('3003', x, y, 0);
  for (const x of [-40, 0, 40]) add('3068b', x, -128, 0);
  for (const y of [-32, -56, -88, -112]) add('3004', -10, y, 0, 'c:bright-red', 90);
  for (const y of [-32, -88]) add('3004', 10, y, 0, blue, 90);
});
// A fixed brick-built door: all joints are ordinary studs, without unmodelled hinge data.
model('door', '门', 'Door', 'doors-windows', (add) => {
  add('3795', 0, -8, 0, 'c:medium-stone-grey');
  for (const y of [-32, -56, -80, -104, -128, -152]) {
    for (const x of [-50, 50]) add('3004', x, y, 0, 'c:medium-stone-grey', 90);
    add('3001', 0, y, 0);
  }
  add('2456', 0, -176, 0, 'c:medium-stone-grey');
  for (const x of [-40, 0, 40]) add('3068b', x, -184, 0, 'c:medium-stone-grey');
});
model('streetlight', '路灯', 'Streetlight', 'other', (add) => {
  add('3031', 0, -8, 0, black);
  add('3003', 0, -32, 0, black);
  for (const y of [-56, -80, -104, -128, -152]) add('3003', 0, y, 0, black);
  add('3003', 0, -176, 0, 'c:transparent-yellow');
  add('3031', 0, -184, 0, black);
  for (const x of [-20, 20]) for (const z of [-20, 20]) add('3068b', x, -192, z, black);
});

const resolver = createLibraryResolver({ libraryDir: path.join(root, 'library/ldraw') });
const bounds = new Map();
for (const part of new Set(models.flatMap((model) => model.parts.map((part) => part.part)))) {
  const mesh = await buildPartMesh(`${part}.dat`, resolver);
  if (mesh.diagnostics.missing.length || mesh.diagnostics.cycles.length) throw new Error(`Missing geometry: ${part}`);
  bounds.set(`ld:${part}`, mesh.bboxLdu);
}
function generate(description) {
  const id = createUlidGenerator({ clock: () => 1_792_108_800_000, random: () => 0.25 });
  let doc = createDocument(
    { title: description.nameZh, createdAt },
    { id, catalogPack: { id: 'demo', version: '1.0.0' } },
  );
  const rootModel = doc.models[doc.rootModelId];
  const instances = description.parts.map((part) => ({
    id: id(),
    ref: { kind: 'part', partId: `ld:${part.part}` },
    colorId: part.color,
    transform: toLDraw(multiply(translation([part.x, part.y, part.z]), rotationAxisAngle([0, 1, 0], part.rotation))),
    stepId: rootModel.stepIds[0],
    groupId: null,
  }));
  doc = applyOps(doc, [
    { type: 'instance.add', items: instances.map((instance) => ({ modelId: rootModel.id, instance })) },
  ]);
  return createMacroFromSelection(
    doc,
    instances.map((instance) => [instance.id]),
    {
      id: description.id,
      name: { 'zh-CN': description.nameZh, en: description.nameEn },
      category: description.category,
      author: 'Brickloop',
      createdAt,
    },
    { id, bboxProvider: (partId) => bounds.get(partId) },
  );
}
const output = path.join(root, 'library/macros/builtin');
const check = process.argv.includes('--check');
if (!check) await mkdir(output, { recursive: true });
async function deliver(name, bytes) {
  if (check) {
    if (!Buffer.from(bytes).equals(await readFile(path.join(output, name))))
      throw new Error(`Built-in macro out of date: ${name}`);
  } else await writeFile(path.join(output, name), bytes);
}
const index = [];
for (const description of models) {
  const pkg = generate(description),
    bytes = writeMacro(pkg);
  if (!Buffer.from(bytes).equals(Buffer.from(writeMacro(generate(description)))))
    throw new Error('Non-deterministic macro');
  await deliver(`${description.file}.brklmacro`, bytes);
  const dimensionsLdu = [0, 1, 2].map(
    (axis) => Math.round((pkg.meta.bboxLdu[axis + 3] - pkg.meta.bboxLdu[axis]) * 10000) / 10000,
  );
  index.push({
    id: description.id,
    file: `${description.file}.brklmacro`,
    nameZh: description.nameZh,
    nameEn: description.nameEn,
    category: description.category,
    partCount: pkg.meta.partCount,
    dimensionsLdu,
  });
}
await deliver(
  'index.json',
  Buffer.from(
    await format(JSON.stringify({ version: 1, macros: index }), {
      ...(await resolveConfig(path.join(root, 'package.json'))),
      parser: 'json',
    }),
  ),
);
console.log(JSON.stringify({ mode: check ? 'check' : 'write', macros: index }, null, 2));
