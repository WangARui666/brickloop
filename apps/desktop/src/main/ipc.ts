import { ANIMATION_CHANNELS } from '../shared/animation-api';
import { ipcMain, MessageChannelMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, validateIpcArguments } from '../shared/api';
import type { DesktopApi, IpcChannel, Language } from '../shared/api';
import { LIBRARY_CHANNELS } from '../shared/library-api';
import { PROJECT_CHANNELS } from '../shared/project-api';
import { ASSEMBLY_CHANNELS } from '../shared/assembly-api';
import type { PartId } from '@brickloop/catalog';
import { AI_CHANNELS } from '../shared/ai-api';
import { MACRO_CHANNELS } from '../shared/macro-api';
import { RELEASE_CHANNELS } from '../shared/release-api';

export function registerIpc(
  getWindow: () => BrowserWindow | undefined,
  api: Omit<
    DesktopApi,
    'onOpenFiles' | 'onCloseRequested' | 'onRecoveryError' | 'droppedFilePath' | 'onAiNotice' | 'onEditorRequest'
  >,
): void {
  for (const [method, channel] of Object.entries({
    ...ANIMATION_CHANNELS,
    ...LIBRARY_CHANNELS,
    ...PROJECT_CHANNELS,
    ...ASSEMBLY_CHANNELS,
    ...AI_CHANNELS,
    ...MACRO_CHANNELS,
    ...RELEASE_CHANNELS,
  })) {
    handle(channel, (...args) =>
      (api[method as keyof typeof api] as (...values: unknown[]) => Promise<unknown>)(...args),
    );
  }
  // Electron can transfer MessagePorts, but not ArrayBuffers, across its process boundary.
  // Deliver a port directly to the main world to avoid an additional contextBridge buffer copy.
  ipcMain.on(IPC_CHANNELS.meshGet, (event, request: unknown, id: unknown) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (typeof request !== 'string' || !/^[a-f0-9-]{36}$/.test(request)) return;
    const { port1, port2 } = new MessageChannelMain();
    port1.start();
    event.senderFrame.postMessage(IPC_CHANNELS.meshGet, { request }, [port2]);
    void (async () => {
      validateIpcArguments(IPC_CHANNELS.meshGet, [id]);
      port1.postMessage({ result: await api.meshGet(id as PartId) });
    })()
      .catch(() => port1.postMessage({ error: 'mesh' }))
      .finally(() => port1.close());
  });
  function handle(channel: IpcChannel, callback: (...args: unknown[]) => Promise<unknown>) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const window = getWindow();
      // Only our current top-level renderer may use the bridge (no child frames/other windows).
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Untrusted IPC sender');
      }
      validateIpcArguments(channel, args);
      return callback(...args);
    });
  }

  handle(IPC_CHANNELS.getAppInfo, () => api.getAppInfo());
  handle(IPC_CHANNELS.reloadRenderer, () => api.reloadRenderer());
  handle(IPC_CHANNELS.getSettings, () => api.getSettings());
  handle(IPC_CHANNELS.setLanguage, (language) => api.setLanguage(language as Language));
}
