import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, validateIpcArguments } from '../src/shared/api';
import { registerIpc } from '../src/main/ipc';
import { LIBRARY_CHANNELS } from '../src/shared/library-api';
import type { DesktopApi } from '../src/shared/api';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle, on: vi.fn() } }));

describe('IPC validation', () => {
  it.each(['zh-CN', 'en'])('accepts supported language %s', (language) => {
    expect(() => validateIpcArguments(IPC_CHANNELS.setLanguage, [language])).not.toThrow();
  });
  it.each([[], ['fr'], [undefined], [null], [1], [{ language: 'en' }], [['en']], ['en', 'extra']])(
    'rejects invalid language arguments: %j',
    (...args) => {
      expect(() => validateIpcArguments(IPC_CHANNELS.setLanguage, args)).toThrow(TypeError);
    },
  );
  it.each([IPC_CHANNELS.getSettings, IPC_CHANNELS.getAppInfo, IPC_CHANNELS.reloadRenderer])(
    'requires zero arguments for %s',
    (channel) => {
      expect(() => validateIpcArguments(channel, [])).not.toThrow();
      expect(() => validateIpcArguments(channel, ['unexpected'])).toThrow(TypeError);
    },
  );
  it('registers only the API channels and rejects other senders/frames before calling the API', async () => {
    handle.mockClear();
    const frame = {};
    const webContents = { mainFrame: frame };
    const window = { webContents } as unknown as BrowserWindow;
    const api = {
      ...Object.fromEntries(Object.keys(LIBRARY_CHANNELS).map((key) => [key, vi.fn()])),
      getAppInfo: vi.fn(),
      getSettings: vi.fn(),
      setLanguage: vi.fn(async () => ({ language: 'en' as const })),
    } as unknown as DesktopApi;
    registerIpc(() => window, api);
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(Object.values(IPC_CHANNELS));
    const call = handle.mock.calls.find(([channel]) => channel === IPC_CHANNELS.setLanguage)![1] as (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<unknown>;
    const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(() => call({ ...event, senderFrame: null }, 'en')).toThrow('Untrusted IPC sender');
    expect(() => call({ ...event, sender: {} } as IpcMainInvokeEvent, 'en')).toThrow('Untrusted IPC sender');
    expect(() => call(event, 'fr')).toThrow(TypeError);
    expect(api.setLanguage).not.toHaveBeenCalled();
    await expect(call(event, 'en')).resolves.toEqual({ language: 'en' });
    expect(api.setLanguage).toHaveBeenCalledExactlyOnceWith('en');
  });
});
