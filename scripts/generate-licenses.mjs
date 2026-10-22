import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { root, resources as packagedResources, run } from './release-utils.mjs';
import { fileURLToPath } from 'node:url';

const keyOf = (name, version) => `${name}@${version}`;
const repositoryUrl = (value) =>
  (typeof value === 'string' ? value : (value?.url ?? ''))
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');

export async function generateLicenses({ development = false } = {}) {
  const resources = development ? path.join(root, '.devdata/resources') : packagedResources;
  const production = JSON.parse(run(['pnpm', 'licenses', 'list', '--json', '--prod'], true));
  const all = JSON.parse(run(['pnpm', 'licenses', 'list', '--json'], true));
  const productionKeys = new Set(
    Object.values(production).flatMap((entries) =>
      entries.flatMap((entry) => entry.versions.map((version) => keyOf(entry.name, version))),
    ),
  );
  const thirdParty = await readFile(path.join(root, 'docs/third-party.md'), 'utf8');
  const entries = new Map();
  const textDirectory = path.join(resources, 'licenses/texts');
  await mkdir(textDirectory, { recursive: true });
  for (const [license, packages] of Object.entries(all)) {
    for (const item of packages) {
      for (const directory of item.paths) {
        const meta = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (meta.name.startsWith('@brickloop/')) continue;
        const key = keyOf(meta.name, meta.version);
        if (entries.has(key)) continue;
        const licenseFiles = [];
        for (const name of await readdir(directory)) {
          if (!/^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(name)) continue;
          // Some packages contain a directory named LICENSES; leave those to their bundled notices.
          let bytes;
          try {
            bytes = await readFile(path.join(directory, name));
          } catch (error) {
            if (error.code === 'EISDIR') continue;
            throw error;
          }
          const relative = `licenses/texts/${createHash('sha256').update(bytes).digest('hex')}.txt`;
          await writeFile(path.join(resources, relative), bytes);
          licenseFiles.push(relative);
        }
        entries.set(key, {
          name: meta.name,
          version: meta.version,
          license,
          repository: repositoryUrl(meta.repository) || meta.homepage || item.homepage || null,
          production: productionKeys.has(key),
          documented: thirdParty.toLowerCase().includes(meta.name.toLowerCase()),
          licenseFiles,
        });
      }
    }
  }
  // pnpm is documented and version-pinned, but is a tool rather than an installed dependency.
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  entries.set(rootPackage.packageManager, {
    name: 'pnpm',
    version: rootPackage.packageManager.split('@')[1],
    license: 'MIT',
    repository: 'https://github.com/pnpm/pnpm',
    production: false,
    documented: true,
    licenseFiles: [],
  });
  const ldrawSections = thirdParty
    .split(/(?=^## )/m)
    .filter((section) => /^## M1-1 |^## M1-2 |^## M3-1 |^## M3-2 /m.test(section));
  if (ldrawSections.length !== 4) throw new Error('Missing LDraw attribution sections in docs/third-party.md');
  const attribution = [
    'LDraw™ is a trademark owned and licensed by the Estate of James Jessiman.',
    'LDraw 零件库由 LDraw.org 作者和贡献者创建；LDraw 由 James Jessiman 创建。',
    '随包保留原始 DAT 的 Author / !HISTORY / !LICENSE，以及 CAreadme.txt、CAlicense*.txt。',
    '分发时仅裁剪目录，未修改原始几何。连接器、碰撞代理及示例包的派生与修改说明如下。',
    ...ldrawSections,
  ].join('\n\n');
  const ldraw = {
    name: 'LDraw.org Parts Library',
    version: JSON.parse(
      await readFile(path.join(development ? root : resources, 'library/ldraw/VERSION.json'), 'utf8'),
    ),
    license: 'CC-BY-2.0 AND/OR CC-BY-4.0 (see each file !LICENSE)',
    repository: 'https://library.ldraw.org/',
    attribution,
    attributionFile: 'licenses/ldraw-attribution.txt',
    licenseDirectory: 'library/ldraw',
  };
  const dependencies = [...entries.values()].sort((a, b) =>
    keyOf(a.name, a.version).localeCompare(keyOf(b.name, b.version), 'en'),
  );
  const result = {
    schemaVersion: 1,
    sources: ['pnpm licenses list --json --prod', 'pnpm licenses list --json', 'docs/third-party.md'],
    dependencies,
    ldraw,
    fonts: [
      {
        name: 'Noto Sans SC',
        version: '2.004',
        license: 'SIL Open Font License 1.1',
        repository: 'https://github.com/notofonts/noto-cjk',
        text: await readFile(path.join(root, 'library/fonts/OFL.txt'), 'utf8'),
      },
    ],
    thirdPartyFile: 'licenses/third-party.md',
    electronNotices: ['../LICENSE.electron.txt', '../LICENSES.chromium.html'],
  };
  await writeFile(path.join(resources, 'licenses.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(resources, 'licenses/third-party.md'), thirdParty);
  await writeFile(path.join(resources, ldraw.attributionFile), `${attribution}\n`);
  console.log(
    `Licenses: ${dependencies.length} dependencies (${dependencies.filter((d) => d.production).length} production)`,
  );
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateLicenses({ development: process.argv.includes('--dev') });
