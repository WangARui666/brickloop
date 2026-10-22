import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertDataFile } from './prepare-resources.mjs';
import { desktopRequire, root, filesIn } from './release-utils.mjs';

const { zipSync, strToU8 } = desktopRequire('fflate');
assert.throws(() => assertDataFile('renamed.dat', Buffer.from('MZfake')), /Executable content/);
assert.throws(() => assertDataFile('tool.dll', Buffer.from('data')), /Executable/);
assert.throws(() => assertDataFile('tools.zip', zipSync({ 'safe.txt': strToU8('data') })), /archive/);
assert.throws(() => assertDataFile('renamed.dat', zipSync({ 'safe.txt': strToU8('data') })), /archive/);
assert.throws(() => assertDataFile('parts.xlsx', zipSync({ 'evil.exe': strToU8('data') })), /Executable/);
assert.throws(() => assertDataFile('parts.xlsx', zipSync({ 'image.png': strToU8('MZfake') })), /Executable/);
assert.throws(() => assertDataFile('parts.xlsx', zipSync({ '../escape': strToU8('data') })), /Unsafe/);
assertDataFile('parts.xlsx', zipSync({ '[Content_Types].xml': strToU8('<Types/>') }));
assertDataFile('demo.brklpack', zipSync({ 'parts.xlsx': zipSync({ 'xl/workbook.xml': strToU8('<workbook/>') }) }));
assertDataFile('3001.dat', strToU8('0 Brick 2 x 4\n'));
console.log('Release resource checks: 10 passed');

/** Compare distributed data with the checked-in source, pinned fonts and license attribution. */
export async function checkReleaseResources(directory, manifest) {
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const required = ['fonts/fonts.json', 'fonts/OFL.txt'];
  const fonts = JSON.parse(await readFile(path.join(root, 'library/fonts/fonts.json'), 'utf8'));
  assert.equal(fonts.fonts.length, 2);
  for (const font of fonts.fonts) {
    const relative = `fonts/${font.file}`;
    required.push(relative);
    assert.equal(byPath.get(relative)?.sha256, font.sha256, `Pinned font: ${relative}`);
  }
  const macros = await filesIn(path.join(root, 'library/macros'));
  assert.equal(macros.filter((file) => /[\\/]builtin[\\/].*\.brklmacro$/.test(file)).length, 6);
  required.push(...macros.map((file) => path.relative(root, file).split(path.sep).join('/')));
  assert(required.includes('library/macros/patterns.json'));
  for (const relative of required) {
    const source = relative.startsWith('fonts/') ? `library/${relative}` : relative;
    const bytes = await readFile(path.join(directory, relative));
    assertDataFile(relative, bytes);
    assert.equal(sha256(bytes), sha256(await readFile(path.join(root, source))), `Source SHA-256: ${relative}`);
    assert.equal(sha256(bytes), byPath.get(relative)?.sha256, `Manifest SHA-256: ${relative}`);
  }
  const licenses = JSON.parse(await readFile(path.join(directory, 'licenses.json'), 'utf8'));
  const thirdParty = await readFile(path.join(root, 'docs/third-party.md'), 'utf8');
  assert.equal(await readFile(path.join(directory, licenses.thirdPartyFile), 'utf8'), thirdParty);
  assert.match(licenses.ldraw.attribution, /James Jessiman/);
  assert.equal(
    (await readFile(path.join(directory, licenses.ldraw.attributionFile), 'utf8')).trim(),
    licenses.ldraw.attribution.trim(),
  );
  const noto = licenses.fonts.find((font) => font.name === 'Noto Sans SC');
  assert.equal(noto.version, fonts.version);
  assert.equal(noto.text, await readFile(path.join(directory, 'fonts/OFL.txt'), 'utf8'));
  assert.match(noto.license, /Open Font License 1\.1/);
  for (const entry of licenses.dependencies)
    if (entry.documented) assert(thirdParty.toLowerCase().includes(entry.name.toLowerCase()), entry.name);
  for (const name of [
    'pdf-lib',
    '@pdf-lib/fontkit',
    'pdfjs-dist',
    'electron-builder',
    'koffi',
    '@modelcontextprotocol/sdk',
  ])
    assert(
      licenses.dependencies.some((entry) => entry.name === name && entry.documented),
      `License: ${name}`,
    );
  assert.equal(manifest.executableFiles, 0);
  console.log(`Release payload checks: ${required.length} required files, source/pinned SHA-256 and licenses passed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist/win-unpacked/resources');
  const { validateResources } = await import('./prepare-resources.mjs');
  await checkReleaseResources(directory, await validateResources(directory, true));
}
