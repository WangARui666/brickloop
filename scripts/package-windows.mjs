import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { root, desktop, run, filesIn, resetStaging } from './release-utils.mjs';
import { prepareResources, validateResources } from './prepare-resources.mjs';
import { checkReleaseResources } from './release-checks.mjs';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This release requires Windows x64');
// No certificate lookup, publishing, installation, or post-install launch.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
delete process.env.CSC_LINK;
delete process.env.WIN_CSC_LINK;
await resetStaging(path.join(root, 'dist/desktop'));
run(['pnpm', '-F', '@brickloop/desktop', 'build', '--outDir', '../../dist/desktop/out']);
const prepared = await prepareResources();
await checkReleaseResources(path.join(root, 'dist/packaging/resources'), prepared);
run(['pnpm', 'exec', 'electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'], false, desktop);
const packaged = await validateResources(path.join(root, 'dist/win-unpacked/resources'), true);
await checkReleaseResources(path.join(root, 'dist/win-unpacked/resources'), packaged);
// App/runtime files are outside the curated resource manifest; validate just its listed payload below.
const copied = JSON.parse(
  await readFile(path.join(root, 'dist/win-unpacked/resources/resource-manifest.json'), 'utf8'),
);
const byPath = new Map(packaged.files.map((entry) => [entry.path, entry]));
for (const file of prepared.files) {
  if (byPath.get(file.path)?.sha256 !== file.sha256) throw new Error(`Packaged resource mismatch: ${file.path}`);
}
if (copied.sha256 !== prepared.sha256) throw new Error('Packaged manifest mismatch');
if (packaged.sha256 !== prepared.sha256) throw new Error('Unexpected packaged resources');
const version = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8')).version;
const installer = path.join(root, `dist/Brickloop-${version}-win-x64-setup.exe`);
const unpacked = path.join(root, 'dist/win-unpacked');
let unpackedBytes = 0;
for (const file of await filesIn(unpacked)) unpackedBytes += (await stat(file)).size;
const report = {
  installer: {
    path: installer,
    bytes: (await stat(installer)).size,
    sha256: createHash('sha256')
      .update(await readFile(installer))
      .digest('hex'),
  },
  unpacked: { path: unpacked, bytes: unpackedBytes },
  resources: { files: prepared.fileCount, bytes: prepared.totalBytes, sha256: prepared.sha256, executableFiles: 0 },
};
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
