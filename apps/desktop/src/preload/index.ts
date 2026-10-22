import { ANIMATION_CHANNELS } from '../shared/animation-api';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, validateIpcArguments } from '../shared/api';
import type { AppInfo, DesktopApi, Settings } from '../shared/api';
import { LIBRARY_CHANNELS } from '../shared/library-api';
import type { MeshResult } from '../shared/library-api';
import { PROJECT_CHANNELS } from '../shared/project-api';
import { ASSEMBLY_CHANNELS } from '../shared/assembly-api';
import { AI_CHANNELS } from '../shared/ai-api';
import { MACRO_CHANNELS } from '../shared/macro-api';
import type { AiNotice, HostRequest } from '../shared/ai-api';
import { RELEASE_CHANNELS } from '../shared/release-api';

const library = Object.fromEntries(
  Object.entries({
    ...ANIMATION_CHANNELS,
    ...LIBRARY_CHANNELS,
    ...PROJECT_CHANNELS,
    ...ASSEMBLY_CHANNELS,
    ...AI_CHANNELS,
    ...MACRO_CHANNELS,
    ...RELEASE_CHANNELS,
  })
    .filter(([key]) => key !== 'meshGet')
    .map(([key, channel]) => [
      key,
      (...args: unknown[]) => {
        validateIpcArguments(channel, args);
        return ipcRenderer.invoke(channel, ...args) as Promise<unknown>;
      },
    ]),
) as Omit<
  DesktopApi,
  | 'getAppInfo'
  | 'reloadRenderer'
  | 'getSettings'
  | 'setLanguage'
  | 'meshGet'
  | 'onCloseRequested'
  | 'onRecoveryError'
  | 'droppedFilePath'
  | 'onAiNotice'
  | 'onEditorRequest'
  | 'onOpenFiles'
>;

ipcRenderer.on(IPC_CHANNELS.meshGet, (event, message: { request: string }) => {
  window.postMessage({ type: 'brickloop:mesh-port', request: message.request }, '*', event.ports);
});

const api: DesktopApi = {
  ...library,
  onOpenFiles: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, files: unknown) => {
      if (
        Array.isArray(files) &&
        files.length <= 100 &&
        files.every(
          (file) =>
            typeof file === 'string' &&
            file.length <= 32768 &&
            !file.includes('\0') &&
            /\.(brkl|brklpack)$/i.test(file),
        )
      )
        callback(files as string[]);
    };
    ipcRenderer.on('app.openFiles', listener);
    return () => {
      ipcRenderer.removeListener('app.openFiles', listener);
    };
  },
  onAiNotice: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: AiNotice) => callback(notice);
    ipcRenderer.on('ai.notice', listener);
    return () => {
      ipcRenderer.removeListener('ai.notice', listener);
    };
  },
  onEditorRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: HostRequest) => callback(request);
    ipcRenderer.on('ai.editorRequest', listener);
    return () => {
      ipcRenderer.removeListener('ai.editorRequest', listener);
    };
  },
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window.close-requested', listener);
    return () => {
      ipcRenderer.removeListener('window.close-requested', listener);
    };
  },
  onRecoveryError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('recovery.error', listener);
    return () => {
      ipcRenderer.removeListener('recovery.error', listener);
    };
  },
  droppedFilePath: (file) => webUtils.getPathForFile(file),
  // General callers can invoke the API; the viewport uses the port transport to avoid bridge copies.
  meshGet: (id) => {
    validateIpcArguments(IPC_CHANNELS.meshGet, [id]);
    return ipcRenderer.invoke(IPC_CHANNELS.meshGet, id) as Promise<MeshResult>;
  },
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo) as Promise<AppInfo>,
  reloadRenderer: () => ipcRenderer.invoke(IPC_CHANNELS.reloadRenderer) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings) as Promise<Settings>,
  setLanguage: (language) => {
    validateIpcArguments(IPC_CHANNELS.setLanguage, [language]);
    return ipcRenderer.invoke(IPC_CHANNELS.setLanguage, language) as Promise<Settings>;
  },
};

contextBridge.exposeInMainWorld('brickloop', Object.freeze(api));
contextBridge.exposeInMainWorld('brickloopMeshRequest', (request: string, id: string) => {
  validateIpcArguments(IPC_CHANNELS.meshGet, [id]);
  ipcRenderer.send(IPC_CHANNELS.meshGet, request, id);
});
