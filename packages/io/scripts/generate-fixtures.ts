import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachEmbeddedPart, exportIo, importLDraw } from '../src';

const root = fileURLToPath(new URL('../../../test/fixtures/io/', import.meta.url));
const out = path.join(root, 'out');
await mkdir(out, { recursive: true });
const imported = importLDraw(await readFile(path.join(root, 'mod-01.mpd'), 'utf8'), 'mod-01.mpd');
if (!imported.doc) throw new Error(JSON.stringify(imported.report));
const exported = exportIo(imported.doc);
await writeFile(path.join(out, 'mod-01.io'), exported.bytes);
const assets = {};
const custom = attachEmbeddedPart(
  imported.doc,
  assets,
  'custom-cube.dat',
  await readFile(path.join(root, 'custom-cube.dat')),
);
for (const model of Object.values(imported.doc.models))
  for (const instance of Object.values(model.instances))
    if (instance.ref.kind === 'part') instance.ref.partId = custom.id;
const customExport = exportIo(imported.doc, { parts: [custom], assets });
await writeFile(path.join(out, 'custom-parts.io'), customExport.bytes);
await writeFile(
  path.join(out, 'reports.json'),
  JSON.stringify({ mod01: exported.report, custom: customExport.report }, null, 2),
);
console.log(`Studio manual checks: ${path.join(out, 'mod-01.io')}\n${path.join(out, 'custom-parts.io')}`);
