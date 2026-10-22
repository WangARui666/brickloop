import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clipboard, dialog, ClipboardItem } from 'electron';
import type { BrowserWindow } from 'electron';
import { applyOps, validateDocument, resolveContext } from '@brickloop/core';
import {
  aggregateBom,
  calculateModelInfo,
  exportBomCsv,
  exportDae,
  exportGlb,
  exportIo,
  exportLDraw,
  exportObj,
  hashBytes,
  unpackProject,
  importIo,
  importLDraw,
} from '@brickloop/io';
import { RecoveryStore, saveProjectAtomic, transactionFromChange, exportBomXlsx } from '@brickloop/io/node';
import type { IoContext, GeometryContext, ProjectAssets } from '@brickloop/io';
import type { ProjectApi, ProjectPayload, ClipboardPayload, OpenedProject, ExportResult } from '../shared/project-api';
import type { Settings } from '../shared/api';
import { validProjectArguments, PROJECT_CHANNELS } from '../shared/project-api';
import { defaultPreferences } from '../shared/preferences';
import { createProjectPacker } from './project-packer';

interface RecoveryMirror {
  project: ProjectPayload;
  projectPath: string | null;
  count: number;
  at: number;
  idle?: ReturnType<typeof setTimeout>;
}
export function createProjectService(options: {
  directory: string;
  appVersion: string;
  recoveryDirectory?: string;
  window(): BrowserWindow | undefined;
  context(): Promise<GeometryContext & IoContext>;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  t(key: string): string;
  close(): void;
}) {
  const { t } = options;
  const packer = createProjectPacker(options.appVersion);
  const store = new RecoveryStore(
    options.recoveryDirectory ? path.dirname(options.recoveryDirectory) : options.directory,
  );
  const mirrors = new Map<string, RecoveryMirror>();
  const rendererRecovery = new Set<string>();
  const recoveryPaths = new Map(Object.entries(options.settings().recoveryPaths ?? {}));
  const queues = new Map<string, Promise<unknown>>();
  let copied: ClipboardPayload | null = null;
  const clipboardFormat = 'electron application/osclipboard;format="org.brickloop.selection.v1"';
  function queue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) ?? Promise.resolve()).then(action);
    queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }
  function validate(project: ProjectPayload) {
    if (validateDocument(project.doc).some((issue) => issue.severity === 'error'))
      throw new Error(t('io.PROJECT_DOCUMENT_INVALID'));
  }
  async function remember(file: string) {
    await options.updateSettings({
      recentFiles: [
        file,
        ...(options.settings().recentFiles ?? []).filter((entry) => entry.toLowerCase() !== file.toLowerCase()),
      ].slice(0, 12),
    });
  }
  async function choose(extension: string, title: string, name: string) {
    const window = options.window();
    if (!window) return null;
    const result = await dialog.showSaveDialog(window, {
      title,
      defaultPath: name,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  }
  async function write(file: string, bytes: Uint8Array | string) {
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function snapshot(id: string) {
    const mirror = mirrors.get(id);
    if (!mirror || !mirror.count) return;
    await store.writeSnapshot(id, await packer.pack(mirror.project), mirror.project.doc.revision);
    mirror.count = 0;
    mirror.at = Date.now();
  }
  const periodic = setInterval(() => {
    for (const [id, mirror] of mirrors)
      if (Date.now() - mirror.at >= (options.settings().preferences ?? defaultPreferences).snapshotMinutes * 60000)
        void queue(id, () => snapshot(id)).catch((error: unknown) =>
          options.window()?.webContents.send('recovery.error', String(error)),
        );
  }, 1000);
  periodic.unref();
  const api: ProjectApi = {
    async projectOpen(file) {
      let files = file ? [file] : [];
      if (!file) {
        const window = options.window();
        if (!window) return [];
        const selected = await dialog.showOpenDialog(window, {
          title: t('files.open'),
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: t('files.supported'), extensions: ['brkl', 'io', 'ldr', 'mpd'] }],
        });
        if (selected.canceled) return [];
        files = selected.filePaths;
      }
      const opened: OpenedProject[] = [];
      for (const name of files) {
        const bytes = new Uint8Array(await readFile(name));
        if (/\.brkl$/i.test(name)) {
          const result = unpackProject(bytes);
          if (!result.doc) throw new Error(result.issues.map((issue) => t(issue.messageKey)).join('\n'));
          opened.push({ ...result, doc: result.doc, path: name, sourcePath: name, imported: false });
        } else {
          if (!/\.(io|ldr|mpd)$/i.test(name)) throw new Error(t('files.unsupported'));
          const ctx = await options.context();
          const result = /\.io$/i.test(name)
            ? importIo(bytes, ctx, path.basename(name))
            : importLDraw(new TextDecoder().decode(bytes), path.basename(name), ctx);
          if (!result.doc) throw new Error(result.report.errors.map((issue) => t(issue.messageKey)).join('\n'));
          opened.push({
            ...result,
            doc: result.doc,
            path: null,
            sourcePath: name,
            imported: true,
            readOnly: false,
            issues: [],
          });
        }
        await remember(name);
      }
      return opened;
    },
    async projectSave(project, file, saveAs) {
      validate(project);
      const target =
        !file || saveAs
          ? await choose(
              'brkl',
              t('files.saveAs'),
              file ?? `${project.doc.meta.title.replace(/\.(io|ldr|mpd|dat)$/i, '')}.brkl`,
            )
          : file;
      if (!target) return null;
      const result = await saveProjectAtomic(target, await packer.pack(project), { keepBackup: true });
      if (result.ok) {
        await remember(target);
        await queue(project.doc.documentId, async () => {
          const mirror = mirrors.get(project.doc.documentId);
          if (!mirror) return;
          // Keep the journal live during Save As: later edits may already be queued.
          // The IO store has no origin setter, so the host owns this small path overlay.
          recoveryPaths.set(project.doc.documentId, target);
          await options.updateSettings({ recoveryPaths: Object.fromEntries(recoveryPaths) });
          // Durable journal already covers subsequent edits. The regular idle/periodic
          // snapshot can compact it; saving must not encode the same project a second time.
        });
      }
      return { path: target, result };
    },
    projectRecent: async () => options.settings().recentFiles ?? [],
    async projectExport(request) {
      const { project, format } = request;
      validate(project);
      const target = await choose(
        format,
        t('files.export'),
        `${project.doc.meta.title.replace(/\.(io|ldr|mpd|brkl)$/i, '')}.${format}`,
      );
      if (!target) return null;
      const context = await options.context();
      const opts = {
        unit: request.unit,
        includeEdges: request.includeEdges,
        includeHidden: request.includeHidden,
        scope: request.scope,
        workspace: project.workspace,
      };
      const result: ExportResult = { path: target, byteLength: 0, issues: [] };
      let bytes: Uint8Array;
      if (format === 'io' || format === 'ldr' || format === 'mpd') {
        const ctx: IoContext = {
          ...context,
          assets: project.assets,
          workspace: project.workspace,
          fileName: path.basename(target),
          ...(project.thumbnail ? { thumbnail: project.thumbnail } : {}),
        };
        const encoded = format === 'io' ? exportIo(project.doc, ctx) : exportLDraw(project.doc, ctx);
        result.report = encoded.report;
        bytes = 'bytes' in encoded ? encoded.bytes : new TextEncoder().encode(encoded.text);
        if (encoded.report.errors.length)
          throw new Error(encoded.report.errors.map((issue) => t(issue.messageKey)).join('\n'));
      } else if (format === 'obj') {
        const materialFileName = `${path.basename(target, path.extname(target))}.mtl`;
        const encoded = await exportObj(project.doc, context, {
          ...opts,
          grouping: request.grouping,
          materialFileName,
        });
        await write(path.join(path.dirname(target), materialFileName), encoded.mtl);
        bytes = new TextEncoder().encode(encoded.obj);
        Object.assign(result, encoded.stats);
      } else if (format === 'dae' || format === 'glb') {
        const encoded =
          format === 'dae' ? await exportDae(project.doc, context, opts) : await exportGlb(project.doc, context, opts);
        bytes = 'bytes' in encoded ? encoded.bytes : new TextEncoder().encode(encoded.text);
        Object.assign(result, encoded.stats);
      } else if (format === 'csv' || format === 'xlsx') {
        const bom = aggregateBom(project.doc, context, opts);
        result.bom = bom;
        result.issues = bom.issues;
        const language = options.settings().language;
        if (format === 'xlsx') {
          const encoded = await exportBomXlsx(bom, {
            language,
            thumbnailProvider: async (partId, colorId) => {
              const png = request.thumbnails[JSON.stringify([partId, colorId])];
              return png
                ? new Uint8Array(Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'))
                : undefined;
            },
          });
          bytes = encoded.bytes;
          result.thumbnailCount = encoded.thumbnailCount;
          result.issues.push(...encoded.issues);
        } else bytes = exportBomCsv(bom, { language }).bytes;
      } else {
        if (!request.png?.length) throw new Error(t('files.screenshotFailed'));
        bytes = request.png;
      }
      await write(target, bytes);
      if (!result.byteLength) result.byteLength = bytes.byteLength;
      return result;
    },
    async projectBom(project, opts) {
      validate(project);
      return aggregateBom(project.doc, await options.context(), opts);
    },
    async projectInfo(project) {
      validate(project);
      const info = await calculateModelInfo(project.doc, await options.context());
      return {
        ...info,
        directReferences: Object.keys(resolveContext(project.doc, project.workspace)?.model.instances ?? {}).length,
      };
    },
    async projectReport(content) {
      const target = await choose('txt', t('files.saveReport'), `${t('files.report')}.txt`);
      if (target) await write(target, content);
      return target;
    },
    clipboardRead: async () => {
      const entry = (await clipboard.read()).find((item) => item.types.includes(clipboardFormat));
      if (!entry) return null;
      const wire: unknown = JSON.parse(await (await entry.getType(clipboardFormat)).text());
      if (!validProjectArguments(PROJECT_CHANNELS.clipboardWrite, [wire])) return null;
      const value = wire as ClipboardPayload;
      if (copied && JSON.stringify(copied.data) === JSON.stringify(value.data)) return copied;
      return {
        data: value.data,
        assets: Object.fromEntries(
          Object.entries(value.assets).map(([key, data]) => [key, new Uint8Array(Object.values(data))]),
        ),
      };
    },
    clipboardWrite: async (value) => {
      copied = value;
      await clipboard.write([
        new ClipboardItem({
          [clipboardFormat]: JSON.stringify({
            data: value.data,
            assets: Object.fromEntries(Object.entries(value.assets).map(([key, bytes]) => [key, Array.from(bytes)])),
          }),
        }),
      ]);
    },
    copyText: async (value) => {
      await clipboard.writeText(value);
    },
    recoveryScan: async () =>
      [
        ...(await store.scanRecoverable()),
        ...(await Promise.all(
          [...rendererRecovery].map(async (id) => ({
            ...(await store.recover(id)),
            documentId: id,
            title: mirrors.get(id)!.project.doc.meta.title,
            projectPath: recoveryPaths.get(id) ?? mirrors.get(id)!.projectPath,
          })),
        )),
      ].map((item) => ({
        ...item,
        projectPath: recoveryPaths.get(item.documentId) ?? item.projectPath,
      })),
    recoveryStart: (project, file) =>
      queue(project.doc.documentId, async () => {
        validate(project);
        if (mirrors.has(project.doc.documentId)) return new Date().toISOString();
        await store.startSession(project.doc.documentId, await packer.pack(project), file ?? undefined);
        mirrors.set(project.doc.documentId, { project, projectPath: file, count: 0, at: Date.now() });
        return new Date().toISOString();
      }),
    recoveryChange: (id, change, workspace, assets) =>
      queue(id, async () => {
        const mirror = mirrors.get(id);
        if (!mirror || mirror.project.doc.revision !== change.revisionBefore)
          throw new Error(t('io.RECOVERY_REVISION_GAP'));
        const doc = { ...applyOps(mirror.project.doc, change.ops), revision: change.revisionAfter };
        validate({ ...mirror.project, doc });
        const payloads: ProjectAssets = {};
        for (const value of Object.values(assets)) payloads[hashBytes(value)] = value;
        await store.appendTransaction(id, transactionFromChange(change, undefined, payloads));
        mirror.project = { ...mirror.project, doc, workspace, assets };
        mirror.count++;
        if (mirror.idle) clearTimeout(mirror.idle);
        mirror.idle = setTimeout(() => {
          void queue(id, () => snapshot(id)).catch((error: unknown) =>
            options.window()?.webContents.send('recovery.error', String(error)),
          );
        }, 30000);
        mirror.idle.unref();
        if (mirror.count >= 200) await snapshot(id);
        await store.flush(id);
        return new Date().toISOString();
      }),
    recoveryClose: (id) =>
      queue(id, async () => {
        const mirror = mirrors.get(id);
        if (mirror?.idle) clearTimeout(mirror.idle);
        await store.closeClean(id);
        mirrors.delete(id);
        rendererRecovery.delete(id);
        if (recoveryPaths.delete(id)) {
          await options.updateSettings({ recoveryPaths: Object.fromEntries(recoveryPaths) });
        }
      }),
    windowClose: async () => options.close(),
  };
  return {
    api,
    choose,
    async prepareRendererReload() {
      // RecoveryStore intentionally skips live process IDs. A renderer reload leaves
      // this main process alive, so explicitly offer only its detached documents.
      await Promise.all(
        [...mirrors.keys()].map((id) =>
          queue(id, async () => {
            await snapshot(id);
            await store.flush(id);
            rendererRecovery.add(id);
          }),
        ),
      );
    },
    async dispose() {
      clearInterval(periodic);
      for (const mirror of mirrors.values()) if (mirror.idle) clearTimeout(mirror.idle);
      await Promise.all(queues.values());
      await store.dispose();
      await packer.dispose();
    },
  };
}
