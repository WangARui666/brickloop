import path from 'node:path';
import { Buffer } from 'node:buffer';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { root, resources, desktopRequire, filesIn, resetStaging } from './release-utils.mjs';
import { generateLicenses } from './generate-licenses.mjs';

const { unzipSync } = desktopRequire('fflate');
const forbidden =
  /\.(exe|dll|com|scr|msi|msp|sys|ocx|cpl|bat|cmd|ps1|vbs|vbe|wsf|wsh|hta|sh|bash|py|pyc|js|mjs|cjs|jar|wasm|so|dylib|zip|7z|rar|tar|gz|bz2|xz|cab|appx|msix)$/i;
const dataArchive = /\.(xlsx|brklpack|brklmacro)$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const portable = (value) => value.split(path.sep).join('/');

export function assertDataFile(name, bytes, depth = 0) {
  if (forbidden.test(name)) throw new Error(`Executable/archive resource: ${name}`);
  const magic = Buffer.from(bytes.subarray(0, 4)).toString('hex');
  if (
    magic.startsWith('4d5a') ||
    ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic) ||
    magic.startsWith('2321')
  )
    throw new Error(`Executable content: ${name}`);
  if (magic.startsWith('504b') || dataArchive.test(name)) {
    if (!dataArchive.test(name) || depth >= 2) throw new Error(`Unexpected archive: ${name}`);
    for (const [member, content] of Object.entries(unzipSync(bytes))) {
      if (member.endsWith('/')) continue;
      if (member.split(/[\\/]/).includes('..') || /^[\\/]|^[a-z]:/i.test(member)) {
        throw new Error(`Unsafe archive member: ${name}!${member}`);
      }
      assertDataFile(`${name}!${member}`, content, depth + 1);
    }
  }
}

export async function validateResources(directory, packaged = false) {
  const files = [];
  const groups = {};
  for (const file of await filesIn(directory)) {
    const relative = portable(path.relative(directory, file));
    if (relative === 'resource-manifest.json') continue;
    if (packaged && !/^(library\/|fonts\/|licenses\/|licenses\.json$)/.test(relative)) continue;
    if (/^library\/ldraw\/models\//i.test(relative)) throw new Error('LDraw models must not be packaged');
    const bytes = await readFile(file);
    assertDataFile(relative, bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    const group = relative.startsWith('library/')
      ? relative.split('/').slice(0, 2).join('/')
      : relative.startsWith('fonts/')
        ? 'fonts'
        : 'licenses';
    groups[group] ??= { files: 0, bytes: 0 };
    groups[group].files++;
    groups[group].bytes += bytes.length;
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {
    schemaVersion: 1,
    hashAlgorithm: 'SHA-256',
    aggregateFormat: 'UTF-8: sha256 + two spaces + path + two spaces + decimal bytes + LF; paths sorted en locale',
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: digest(files.map((f) => `${f.sha256}  ${f.path}  ${f.bytes}\n`).join('')),
    executableFiles: 0,
    groups,
    files,
  };
}

export async function prepareResources() {
  await resetStaging(resources);
  const excluded = [];
  async function copy(source, relative, ldraw = false) {
    if (forbidden.test(relative) || (ldraw && !/\.(dat|png)$/i.test(relative))) {
      excluded.push(relative);
      return;
    }
    const bytes = await readFile(source);
    assertDataFile(relative, bytes);
    const target = path.join(resources, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const library = path.join(root, 'library');
  const ldraw = path.join(library, 'ldraw');
  for (const directory of ['parts', 'p']) {
    for (const file of await filesIn(path.join(ldraw, directory))) {
      await copy(file, `library/ldraw/${portable(path.relative(ldraw, file))}`, true);
    }
  }
  const names = await readdir(ldraw);
  const licenses = names.filter((name) => /^CAlicense.*\.txt$/i.test(name));
  if (!licenses.length) throw new Error('LDraw license text is missing');
  const metadata = ['LDConfig.ldr', 'CAreadme.txt', 'VERSION.json', ...licenses];
  for (const name of metadata) await copy(path.join(ldraw, name), `library/ldraw/${name}`);
  excluded.push(
    ...names.filter((name) => !['parts', 'p', ...metadata].includes(name)).map((name) => `library/ldraw/${name}`),
  );
  for (const directory of ['packs/demo', 'connectors', 'colliders', 'macros']) {
    const source = path.join(library, directory);
    for (const file of await filesIn(source)) {
      await copy(file, `library/${directory}/${portable(path.relative(source, file))}`);
    }
  }
  for (const name of ['NotoSansSC-Regular.otf', 'NotoSansSC-Bold.otf', 'fonts.json', 'OFL.txt'])
    await copy(path.join(library, 'fonts', name), `fonts/${name}`);
  await generateLicenses();
  const manifest = { ...(await validateResources(resources)), excluded };
  await writeFile(path.join(resources, 'resource-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Resources: ${manifest.fileCount} files, ${manifest.totalBytes} bytes, SHA-256 ${manifest.sha256}, executables 0`,
  );
  return manifest;
}
