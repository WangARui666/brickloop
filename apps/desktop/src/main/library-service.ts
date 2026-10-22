import path from 'node:path';
import { access, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { PackStore, CatalogService, importPack, exportTemplate, diffPacks, writePack } from '@brickloop/catalog';
import type { Pack, PartId } from '@brickloop/catalog';
import type { Settings } from '../shared/api';
import type { LibraryApi, LibraryPart, LibraryStatus, ImportReview } from '../shared/library-api';
import type { libraryPaths } from './library-paths';
import { createMeshService } from './mesh-service';
import { createThumbCache, thumbnailKey } from './thumb-cache';
import { loadCatalogSnapshot } from './catalog-cache';
import { shapeCategories, shapeCategory } from '../shared/catalog-categories';
import { PatternCatalog, parsePatternRules } from '@brickloop/catalog';
import { compactBuildCatalog } from '../shared/buildscript-catalog';
import type { BuildCatalog } from '../shared/buildscript-catalog';

export function createLibraryService(
  paths: ReturnType<typeof libraryPaths>,
  getWindow: () => BrowserWindow | undefined,
  getSettings: () => Settings,
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>,
  t: (key: string) => string,
) {
  const started = performance.now();
  const meshes = createMeshService(paths.library, paths.mesh);
  const thumbs = createThumbCache(paths.thumb);
  let patterns: { catalog: object; value: PatternCatalog } | undefined;
  let buildCatalog: { service: CatalogService; value: BuildCatalog } | undefined;
  async function patternCatalog() {
    const { catalog } = await context();
    if (patterns?.catalog !== catalog)
      patterns = {
        catalog,
        value: new PatternCatalog(
          catalog,
          parsePatternRules(JSON.parse(await readFile(path.join(paths.macros, 'patterns.json'), 'utf8'))),
        ),
      };
    return patterns.value;
  }
  let status: LibraryStatus = { state: 'missing', pack: null, startupMs: 0 };
  let candidate: { token: string; source: string; pack?: Pack | undefined; review?: ImportReview } | undefined;
  const ready = (async () => {
    try {
      await access(path.join(paths.library, 'LDConfig.ldr'));
    } catch {
      return null;
    }
    try {
      const snapshot = await loadCatalogSnapshot(paths);
      const { catalog, colors, demo } = snapshot;
      const options = { catalog, colors, demoDir: paths.demo };
      const store = new PackStore(paths.packs, options);
      const active = getSettings().activePackId;
      const pack = !active || active === 'demo' ? demo : await store.resolveActive(active);
      const service = new CatalogService(catalog, colors, pack);
      status = { state: 'ready', pack: pack.manifest, startupMs: performance.now() - started };
      console.info(
        '[library-ready]',
        JSON.stringify({ startupMs: status.startupMs, cacheHit: snapshot.cacheHit, parts: catalog.parts.length }),
      );
      const state = { catalog, colors, store, demo, pack, service };
      const validation = setTimeout(() => {
        void snapshot
          .validate()
          .then((updated) => {
            if (!updated) return;
            state.catalog = updated.catalog;
            state.colors = updated.colors;
            state.demo = updated.demo;
            state.store = new PackStore(paths.packs, {
              catalog: updated.catalog,
              colors: updated.colors,
              demoDir: paths.demo,
            });
            if (state.pack.manifest.id === 'demo') state.pack = updated.demo;
            state.service = new CatalogService(state.catalog, state.colors, state.pack);
          })
          .catch((error) => console.error('Catalog cache validation failed', error));
      }, 2500);
      validation.unref();
      return state;
    } catch (error) {
      console.error('Library initialization failed', error);
      status = { state: 'error', pack: null, startupMs: performance.now() - started };
      return null;
    }
  })();
  async function context() {
    const state = await ready;
    if (!state) throw new Error(t('libraryUi.unavailable'));
    return state;
  }
  async function readPack(id: string) {
    const state = await context();
    return id === 'demo' ? state.demo : state.store.read(id);
  }
  function present(service: CatalogService, id: PartId): LibraryPart | null {
    const part = service.getPart(id);
    return part ? { ...part, factoryNo: service.factoryInfo(id)?.factoryNo ?? null } : null;
  }
  async function activate(id: string) {
    const state = await context();
    const pack = await readPack(id);
    const service = new CatalogService(state.catalog, state.colors, pack);
    await updateSettings({ activePackId: id });
    state.pack = pack;
    state.service = service;
    status = { ...status, pack: pack.manifest };
  }
  const api: LibraryApi = {
    async buildScriptCatalog() {
      const { service } = await context();
      if (buildCatalog?.service !== service) {
        const parts = service.search('', { includeAll: true, limit: 100_000 }).map((p) => present(service, p.id)!);
        buildCatalog = { service, value: compactBuildCatalog(parts, (await api.catalogColors()).all) };
      }
      return buildCatalog.value;
    },
    async packsImpact(target, documents) {
      const state = await context();
      const pack = target.token
        ? candidate?.token === target.token
          ? candidate.pack
          : undefined
        : target.id
          ? await readPack(target.id)
          : undefined;
      if (!pack) throw new Error(t('libraryUi.expired'));
      return documents.map((doc) => ({
        title: doc.title,
        impact: state.service.impactOf(doc.references, state.pack, pack),
      }));
    },
    async patternGroups() {
      return (await patternCatalog()).groups.map((group) => ({ groupId: group.groupId, count: group.parts.length }));
    },
    async patternSearch(query, group) {
      const patterns = await patternCatalog(),
        { service } = await context();
      const groups = new Map(patterns.groups.flatMap((entry) => entry.parts.map((id) => [id, entry.groupId] as const)));
      return patterns.searchPatterns(query, group).map((part) => ({
        ...present(service, part.id)!,
        factory: service.isFactoryPart(part.id),
        patternGroup: groups.get(part.id)!,
      }));
    },
    async catalogStatus() {
      await ready;
      return status;
    },
    async catalogSearch(query, options) {
      const { service } = await context();
      // Parent categories include their descendants; the catalog public search API filters exact IDs.
      const categories = new Set(options.categoryId ? [options.categoryId] : []);
      let size = -1;
      while (size !== categories.size) {
        size = categories.size;
        for (const category of service.categories)
          if (category.parentId && categories.has(category.parentId)) categories.add(category.id);
      }
      const results = service
        .search(query, { includeAll: options.includeAll, limit: 100_000 })
        .filter(
          (part) =>
            !categories.size ||
            categories.has(options.categoryId?.startsWith('shape-') ? shapeCategory(part) : part.categoryId),
        )
        .map((part) => present(service, part.id)!);
      // The factory's numbering keeps common demo parts together when browsing without a query.
      if (!query.trim() && !options.includeAll)
        results.sort((a, b) => (a.factoryNo ?? '').localeCompare(b.factoryNo ?? '', 'en', { numeric: true }));
      return results;
    },
    async catalogCategories() {
      const { service } = await context();
      return [
        ...shapeCategories,
        ...service.categories.map((category) => ({ ...category, parentId: category.parentId ?? 'shape-other' })),
      ];
    },
    async catalogPart(id) {
      return present((await context()).service, id);
    },
    async catalogColors() {
      const { service, pack, colors } = await context();
      const codes = new Map(pack.colors.map((color) => [color.colorId, color.factoryCode]));
      const all = [...new Set([...colors.map((color) => color.id), ...codes.keys()])].map((id) => ({
        ...service.getColor(id)!,
        factoryCode: codes.get(id) ?? null,
      }));
      return { factory: all.filter((color) => codes.has(color.id)), all };
    },
    async packsList() {
      const state = await context();
      const manifests = (await state.store.list()).filter((pack) => pack.id !== 'demo');
      return Promise.all(
        [state.demo.manifest, ...manifests].map(async (manifest) => {
          const pack = await readPack(manifest.id);
          return {
            ...manifest,
            partCount: pack.parts.length,
            colorCount: pack.colors.length,
            active: manifest.id === state.pack.manifest.id,
          };
        }),
      );
    },
    async packsImport(request) {
      const state = await context();
      if (request.action === 'choose') {
        const window = getWindow();
        if (!window) return null;
        const result = request.file
          ? { canceled: false, filePaths: [request.file] }
          : await dialog.showOpenDialog(window, {
              title: t('libraryUi.importPack'),
              properties: [request.kind === 'directory' ? 'openDirectory' : 'openFile'],
              filters: [{ name: t('libraryUi.packFiles'), extensions: ['brklpack', 'xlsx'] }],
            });
        if (result.canceled || !result.filePaths[0]) return null;
        const selected = result.filePaths[0];
        candidate = { token: randomUUID(), source: /\.xlsx$/i.test(selected) ? path.dirname(selected) : selected };
      } else if (!candidate || request.token !== candidate.token) throw new Error(t('libraryUi.expired'));
      if (!candidate) return null;
      if (request.action === 'cancel') {
        candidate = undefined;
        return null;
      }
      if (request.action === 'commit') {
        const approved = candidate;
        if (!approved.pack || !approved.review) throw new Error(t('libraryUi.invalidPack'));
        const staging = path.join(paths.packs, `.review-${approved.token}`);
        try {
          await writePack(staging, approved.pack);
          const result = await state.store.import(staging);
          if (!result.pack) return { ...approved.review, manifest: null, report: result.report, imported: false };
          if (request.activate) await activate(result.pack.manifest.id);
          candidate = undefined;
          return { ...approved.review, imported: true };
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
      const result = await importPack(candidate.source, {
        catalog: state.catalog,
        colors: state.colors,
        skipInvalidRows: request.skipInvalidRows ?? false,
      });
      if (result.pack?.manifest.id === 'demo') {
        result.report.errors.push({
          file: 'pack.json',
          sheet: '',
          row: 0,
          column: 'id',
          reason: t('libraryUi.reservedDemo'),
        });
        delete result.pack;
      }
      candidate.pack = result.pack;
      candidate.review = {
        token: candidate.token,
        report: result.report,
        manifest: result.pack?.manifest ?? null,
        diff: result.pack ? diffPacks(state.pack, result.pack) : null,
        imported: false,
      };
      return candidate.review;
    },
    async packsExportTemplate(id) {
      const window = getWindow();
      if (!window) return null;
      const pack = id ? await readPack(id) : undefined;
      const result = await dialog.showSaveDialog(window, {
        title: t('libraryUi.exportBlank'),
        defaultPath: 'factory-template.brklpack',
        filters: [{ name: t('libraryUi.packFiles'), extensions: ['brklpack'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await exportTemplate(result.filePath, pack ? { from: pack } : {});
      return result.filePath;
    },
    packsActivate: activate,
    async packsRemove(id) {
      const state = await context();
      if (id === 'demo' || id === state.pack.manifest.id) throw new Error(t('libraryUi.protectedPack'));
      await state.store.delete(id);
    },
    async packsDiff(id) {
      return diffPacks((await context()).pack, await readPack(id));
    },
    async meshGet(id) {
      const { service, pack } = await context();
      const part = service.getPart(id);
      if (!part) throw new Error(t('libraryUi.partMissing'));
      const customDir =
        part.geometry.source === 'custom'
          ? path.join(pack.manifest.id === 'demo' ? paths.demo : path.join(paths.packs, pack.manifest.id), 'custom')
          : undefined;
      return meshes.get(part.geometry.ref.replace(/^custom\//, ''), customDir);
    },
    async thumbGet(partId, colorId, colored) {
      const mesh = await api.meshGet(partId);
      const color = colored ? (await context()).service.getColor(colorId) : undefined;
      const key = thumbnailKey(partId, mesh.key, color ? JSON.stringify(color) : undefined);
      return { key, png: await thumbs.get(key) };
    },
    thumbPut: (key, png) => thumbs.put(key, png),
    async setFavoriteColors(ids) {
      const unique = [...new Set(ids)];
      await updateSettings({ favoriteColors: unique });
      return unique;
    },
  };
  // Mutations share a queue so activation/import/delete cannot race with each other.
  let mutation = Promise.resolve();
  for (const key of ['packsImport', 'packsActivate', 'packsRemove'] as const) {
    const original = api[key].bind(api) as (...args: unknown[]) => Promise<unknown>;
    Object.assign(api, {
      [key]: (...args: unknown[]) => {
        const task = mutation.then(() => original(...args));
        mutation = task.then(
          () => undefined,
          () => undefined,
        );
        return task;
      },
    });
  }
  return {
    api,
    dispose: meshes.dispose,
    async outputContext() {
      const state = await ready;
      if (!state)
        return { parts: [], colors: [], factoryParts: [], factoryColors: [], meshProvider: async () => undefined };
      return {
        parts: state.catalog.parts.map((part) => state.service.getPart(part.id) ?? part),
        colors: (await api.catalogColors()).all,
        factoryParts: state.pack.parts,
        factoryColors: state.pack.colors,
        meshProvider: async (id: string) => {
          if (!state.service.getPart(id as PartId)) return undefined;
          return (await api.meshGet(id as PartId)).mesh;
        },
      };
    },
  };
}
