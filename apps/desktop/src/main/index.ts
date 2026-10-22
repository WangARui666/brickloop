import { createAnimationExports } from './animation-export';
import { contentSecurityPolicy } from '../shared/content-security-policy';
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, session } from 'electron';
import { createI18n } from '@brickloop/i18n';
import { resolveDataDirectories, migrateDataDirectories, migrateSessionDirectory } from './data-directory';
import { createSettingsFile } from './settings-file';
import { registerIpc } from './ipc';
import { createLibraryService } from './library-service';
import { libraryPaths } from './library-paths';
import type { Settings } from '../shared/api';
import { createProjectService } from './project-service';
import { createAssemblyService } from './assembly-service';
import { createAiService } from './ai-service';
import { createEditorRpc } from './editor-host';
import { createMacroService } from './macro-service';
import { createReleaseService } from './release-service';
import { associatedFiles, createOpenFileQueue } from './open-files';
import { defaultPreferences } from '../shared/preferences';

declare const __BRICKLOOP_BUILD__: { commit: string; date: string };

let directories = resolveDataDirectories(process.env);
let dataDirectory = directories.config;
// Keep the instance-lock identity stable while the development config directory migrates.
mkdirSync(directories.legacy, { recursive: true });
app.setPath('userData', directories.legacy);
const primary = app.requestSingleInstanceLock();
const paths = {
  sessionData: migrateSessionDirectory(directories, primary),
  crashDumps: path.join(directories.cache, 'crash-dumps'),
  logs: path.join(directories.cache, 'logs'),
};
for (const [name, directory] of Object.entries(paths)) {
  if (name !== 'sessionData') mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.setAppLogsPath(paths.logs);
app.enableSandbox();

const i18n = createI18n();
let mainWindow: BrowserWindow | undefined;
const files = createOpenFileQueue((paths) => mainWindow?.webContents.send('app.openFiles', paths));
files.enqueue(associatedFiles(process.argv, process.cwd()));
if (!primary) app.quit();
app.on('second-instance', (_event, argv, cwd) => {
  files.enqueue(associatedFiles(argv, cwd));
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

async function start(): Promise<void> {
  directories = await migrateDataDirectories(directories);
  dataDirectory = directories.config;
  app.setPath('userData', dataDirectory);
  const settingsFile = createSettingsFile(dataDirectory);
  let settings = await settingsFile.load();
  await i18n.changeLanguage(settings.language);
  app.setName(i18n.t('app.name'));
  await app.whenReady();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const development = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy(development)],
      },
    });
  });

  let settingsWrite = Promise.resolve();
  function updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const task = settingsWrite.then(async () => {
      const next = { ...settings, ...patch };
      await settingsFile.save(next);
      settings = next;
      return { ...settings };
    });
    settingsWrite = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  const getLibraryPaths = () =>
    libraryPaths(
      app.isPackaged,
      app.getPath('exe'),
      dataDirectory,
      directories.cache,
      settings.preferences?.libraryPath,
    );
  const makeLibrary = () =>
    createLibraryService(
      getLibraryPaths(),
      () => mainWindow,
      () => settings,
      updateSettings,
      (key) => i18n.t(key),
    );
  let library = makeLibrary();
  let closing = false;
  const makeAssembly = () =>
    createAssemblyService(
      {
        library: getLibraryPaths().library,
        connectors: getLibraryPaths().connectors,
        colliders: getLibraryPaths().colliders,
        cache: path.join(directories.cache, 'assembly'),
        meshCache: getLibraryPaths().mesh,
      },
      () => settings.maintenanceMode === true,
    );
  let assembly = makeAssembly();
  const projects = createProjectService({
    directory: dataDirectory,
    appVersion: app.getVersion(),
    recoveryDirectory: directories.recovery,
    window: () => mainWindow,
    context: () => library.outputContext(),
    settings: () => settings,
    updateSettings,
    t: (key) => i18n.t(key),
    close: () => {
      closing = true;
      mainWindow?.close();
    },
  });
  const animationExports = createAnimationExports(projects.choose, (key) => i18n.t(key));
  const editorRpc = createEditorRpc((request) => {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) throw new Error('EDITOR_UNAVAILABLE');
    mainWindow.webContents.send('ai.editorRequest', request);
  });
  const ai = await createAiService({
    directory: dataDirectory,
    shim: app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'brickloop-mcp.cmd')
      : fileURLToPath(new URL('../../../../packages/mcp/bin/brickloop-mcp.mjs', import.meta.url)),
    settings: () => settings,
    update: updateSettings,
    call: editorRpc.call,
    emit: (notice) => mainWindow?.webContents.send('ai.notice', notice),
  });
  app.once('will-quit', () => {
    animationExports.dispose();
    void library.dispose();
    void projects.dispose();
    void assembly.dispose();
    void ai.close().finally(() => editorRpc.close());
  });
  registerIpc(() => mainWindow, {
    ...createReleaseService({
      directories,
      resources: app.isPackaged
        ? process.resourcesPath
        : fileURLToPath(new URL('../../../../.devdata/resources/', import.meta.url)),
      fonts: app.isPackaged
        ? path.join(process.resourcesPath, 'fonts')
        : fileURLToPath(new URL('../../../../library/fonts/', import.meta.url)),
      library: () => getLibraryPaths().library,
      window: () => mainWindow,
      context: () => library.outputContext(),
      filesReady: () => files.ready(),
      build: {
        version: app.getVersion(),
        ...__BRICKLOOP_BUILD__,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
      },
      t: (key) => i18n.t(key),
      save: async (preferences) => {
        const old = settings.preferences ?? defaultPreferences;
        const saved = await updateSettings({ preferences });
        if (old.libraryPath !== preferences.libraryPath) {
          await library.dispose();
          await assembly.dispose();
          library = makeLibrary();
          assembly = makeAssembly();
        }
        if (preferences.developerMode) mainWindow?.webContents.openDevTools({ mode: 'detach' });
        else mainWindow?.webContents.closeDevTools();
        if (preferences.logging)
          await appendFile(path.join(paths.logs, 'activity.log'), `${new Date().toISOString()} Settings updated\n`);
        return saved;
      },
    }),
    ...createMacroService({
      builtin: path.join(getLibraryPaths().macros, 'builtin'),
      directory: path.join(dataDirectory, 'macros'),
      cache: path.join(directories.cache, 'macros'),
      pack: async () => {
        const data = await library.outputContext();
        return { parts: data.factoryParts, colors: data.factoryColors };
      },
      t: (key) => i18n.t(key),
    }),
    ...(Object.fromEntries(
      Object.keys(library.api).map((key) => [
        key,
        (...args: unknown[]) =>
          (library.api[key as keyof typeof library.api] as (...values: unknown[]) => Promise<unknown>)(...args),
      ]),
    ) as unknown as typeof library.api),
    ...projects.api,
    ...animationExports.api,
    ...(Object.fromEntries(
      Object.keys(assembly.api).map((key) => [
        key,
        (...args: unknown[]) =>
          (assembly.api[key as keyof typeof assembly.api] as (...values: unknown[]) => Promise<unknown>)(...args),
      ]),
    ) as unknown as typeof assembly.api),
    ...ai.api,
    editorReply: async (reply) => {
      editorRpc.reply(reply);
    },
    assemblyCatalog: async () => {
      const data = await library.outputContext();
      return {
        parts: data.factoryParts.map((part) => ({
          id: part.partId,
          factory: part.status === 'active',
          colors: part.colors,
        })),
        colors: data.factoryColors.map((color) => color.colorId),
      };
    },
    setMaintenanceMode: async (enabled) => {
      await updateSettings({ maintenanceMode: enabled });
      return enabled;
    },
    getAppInfo: async () => ({ name: i18n.t('app.name'), version: app.getVersion(), dataDirectory }),
    reloadRenderer: async () => {
      await projects.prepareRendererReload();
      mainWindow?.webContents.reload();
    },
    getSettings: async () => ({ ...settings }),
    setLanguage: async (language) => {
      await updateSettings({ language });
      await i18n.changeLanguage(language);
      app.setName(i18n.t('app.name'));
      mainWindow?.setTitle(i18n.t('app.name'));
      return { ...settings };
    },
  });

  async function createWindow(): Promise<void> {
    files.reset();
    const window = new BrowserWindow({
      title: i18n.t('app.name'),
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      backgroundColor: '#121418',
      show: false,
      webPreferences: {
        preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    mainWindow = window;
    closing = false;
    window.on('close', (event) => {
      if (!closing) {
        event.preventDefault();
        window.webContents.send('window.close-requested');
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    const invalidate = () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.invalidate();
    };
    window.on('maximize', invalidate);
    window.on('unmaximize', invalidate);
    window.on('restore', invalidate);
    window.on('resized', invalidate);
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = undefined;
    });
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devUrl) await window.loadURL(devUrl);
    else await window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }

  await createWindow();
  if (settings.preferences?.developerMode) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  if (settings.preferences?.logging)
    await appendFile(path.join(paths.logs, 'activity.log'), `${new Date().toISOString()} Application started\n`);
  await ai.start();
  app.on('activate', () => {
    if (!mainWindow) void createWindow().catch(failStartup);
  });
}

function failStartup(error: unknown): void {
  console.error(error);
  app.exit(1);
}

app.on('window-all-closed', () => app.quit());
if (primary) void start().catch(failStartup);
