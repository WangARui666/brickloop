import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { aggregateBom, calculateModelInfo, exportBomCsv, exportDae, exportGlb, exportObj } from '../src';
import { exportBomXlsx } from '../src/node';
import { boxMesh, fakePng, outputCatalog, outputDoc } from '../test/output-helpers';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(repo, 'packages/io/out/m4-1a');
const libraryDir = path.join(repo, 'library/ldraw');
const official = existsSync(path.join(libraryDir, 'parts/3001.dat'));
const mesh = official ? await buildPartMesh('3001.dat', createLibraryResolver({ libraryDir })) : await boxMesh();
const context = { ...outputCatalog, meshProvider: () => mesh },
  doc = outputDoc();
doc.meta.title = 'M4-1a shared pair — 4 bricks';
const obj = await exportObj(doc, context),
  dae = await exportDae(doc, context),
  glb = await exportGlb(doc, context);
const bom = aggregateBom(doc, context),
  csv = exportBomCsv(bom);
const xlsx = await exportBomXlsx(bom, { thumbnailProvider: () => fakePng });
const info = await calculateModelInfo(doc, context);
await mkdir(directory, { recursive: true });
for (const [name, data] of [
  ['model.obj', obj.obj],
  ['model.mtl', obj.mtl],
  ['model.dae', dae.text],
  ['model.glb', glb.bytes],
  ['bom.csv', csv.bytes],
  ['bom.xlsx', xlsx.bytes],
  [
    'report.json',
    JSON.stringify(
      {
        geometrySource: official ? 'read-only official LDraw 3001' : 'authored test box',
        thumbnailSource: 'injected 1x1 test PNG',
        obj: obj.stats,
        dae: dae.stats,
        glb: glb.stats,
        bom: bom.summary,
        info,
      },
      null,
      2,
    ) + '\n',
  ],
] as const)
  await writeFile(path.join(directory, name), data);
console.log(
  JSON.stringify({ directory, obj: obj.stats, dae: dae.stats, glb: glb.stats, bom: bom.summary, info }, null, 2),
);
