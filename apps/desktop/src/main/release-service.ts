import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeExportAtomic } from './export-file';
import type { ColorDef } from '@brickloop/catalog';
import type { OutputCatalog } from '@brickloop/io';
import type { AboutInfo, LicenseEntry, ReleaseApi } from '../shared/release-api';
import type { Settings } from '../shared/api';
import type { Preferences } from '../shared/preferences';
import { preferencesSchema } from '../shared/preferences';
import { exportShortcuts, importShortcuts } from '../shared/shortcuts';
import type { DataDirectories } from './data-directory';

export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(file) : (await stat(file).catch(() => ({ size: 0 }))).size;
  }
  return bytes;
}
export async function readLicenses(resources: string): Promise<LicenseEntry[]> {
  const data = JSON.parse(await readFile(path.join(resources, 'licenses.json'), 'utf8')) as {
    dependencies: LicenseEntry[];
    ldraw: { name: string; license: string; attribution: string };
    fonts?: LicenseEntry[];
  };
  return [
    ...data.dependencies,
    { name: data.ldraw.name, version: '', license: data.ldraw.license, text: data.ldraw.attribution },
    ...(data.fonts ?? []),
  ];
}
export function createReleaseService(options: {
  directories: DataDirectories;
  resources: string;
  fonts: string;
  library(): string;
  window(): BrowserWindow | undefined;
  context(): Promise<OutputCatalog & { colors: ColorDef[] }>;
  save(preferences: Preferences): Promise<Settings>;
  filesReady(): string[];
  build: Omit<AboutInfo, 'licenses'>;
  t(key: string): string;
}): ReleaseApi {
  const { t } = options;
  const generatedCaches = ['mesh', 'thumb', 'catalog', 'assembly', 'macros'];
  async function storageInfo() {
    return {
      library: options.library(),
      cache: options.directories.cache,
      bytes: (
        await Promise.all(generatedCaches.map((name) => directoryBytes(path.join(options.directories.cache, name))))
      ).reduce((a, b) => a + b, 0),
      migrationFallback: options.directories.migrationFallback,
    };
  }
  async function saveFile(extension: string, title: string, content: Uint8Array | string) {
    const window = options.window();
    if (!window) return null;
    const name = [...title]
      .filter((letter) => letter.charCodeAt(0) >= 32)
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_');
    const result = await dialog.showSaveDialog(window, {
      title: t('files.export'),
      defaultPath: `${name}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeExportAtomic(result.filePath, typeof content === 'string' ? new TextEncoder().encode(content) : content);
    return result.filePath;
  }
  return {
    preferencesSave: (value) => options.save(preferencesSchema.parse(value)),
    storageInfo,
    async cacheClear() {
      // This path is resolved at startup, never supplied by the renderer.
      for (const entry of generatedCaches)
        await rm(path.join(options.directories.cache, entry), { recursive: true, force: true });
      await mkdir(options.directories.cache, { recursive: true });
      return storageInfo();
    },
    async libraryChoose() {
      const window = options.window();
      if (!window) return null;
      const selected = await dialog.showOpenDialog(window, {
        title: t('preferences.libraryPath'),
        properties: ['openDirectory'],
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      await access(path.join(selected.filePaths[0], 'LDConfig.ldr'));
      await access(path.join(selected.filePaths[0], 'parts'));
      return selected.filePaths[0];
    },
    async shortcutsImport() {
      const window = options.window();
      if (!window) return null;
      const selected = await dialog.showOpenDialog(window, {
        title: t('preferences.importKeys'),
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const content = await readFile(selected.filePaths[0], 'utf8');
      importShortcuts(content);
      return content;
    },
    shortcutsExport: (content) => saveFile('json', 'Brickloop-shortcuts', exportShortcuts(importShortcuts(content))),
    aboutInfo: async () => ({ ...options.build, licenses: await readLicenses(options.resources) }),
    filesReady: async () => options.filesReady(),
    async instructionResources() {
      const [regular, bold, catalog] = await Promise.all([
        readFile(path.join(options.fonts, 'NotoSansSC-Regular.otf')),
        readFile(path.join(options.fonts, 'NotoSansSC-Bold.otf')),
        options.context(),
      ]);
      return {
        regular: new Uint8Array(regular),
        bold: new Uint8Array(bold),
        catalog: {
          parts: catalog.parts ?? [],
          colors: catalog.colors,
          factoryParts: catalog.factoryParts ?? [],
          factoryColors: catalog.factoryColors ?? [],
        },
      };
    },
    instructionSave: (bytes, title) => {
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new TypeError('Invalid PDF');
      return saveFile('pdf', title, bytes);
    },
  };
}
