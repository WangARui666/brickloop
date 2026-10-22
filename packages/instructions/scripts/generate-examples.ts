import { mkdir, writeFile } from 'node:fs/promises';
import { planInstructions, renderInstructionsPdf } from '../src';
import { catalog, fixture, loadFonts } from '../test/fixtures';
import { exampleRenderer } from './example-renderer';

const { doc, root, child, setSteps } = fixture(true);
// Four consecutive root steps make the landscape example exercise all slots.
setSteps(root, [
  [
    { ref: { kind: 'model', modelId: child.id }, x: -90 },
    { ref: { kind: 'model', modelId: child.id }, x: 90 },
  ],
  [{ ref: { kind: 'part', partId: 'ld:3001' } }],
  [{ ref: { kind: 'part', partId: 'ld:3020' }, y: -32 }],
  [{ ref: { kind: 'part', partId: 'ld:3001' }, color: 'c:blue', y: -56 }],
]);
doc.meta.title = '积木组合 · 中文搭建说明';
const fonts = await loadFonts();
const output = new URL('../test-output/', import.meta.url);
await mkdir(output, { recursive: true });
for (const [paper, stepsPerPage, filename] of [
  ['A4-portrait', 1, '中文说明书-A4竖版-1步每页.pdf'],
  ['A4-landscape', 4, '中文说明书-A4横版-4步每页.pdf'],
  ['A5', 2, '中文说明书-A5竖版-2步每页.pdf'],
] as const) {
  const plan = planInstructions(doc, { paper, stepsPerPage, catalog, dpi: 150 });
  const bytes = await renderInstructionsPdf(plan, { ...exampleRenderer(doc), fonts });
  await writeFile(new URL(filename, output), bytes);
  console.log(`${filename}: ${plan.pages.length} pages, ${bytes.length} bytes`);
}
