import { describe, expect, it, vi } from 'vitest';
import {
  resolveDataDirectory,
  resolveDataDirectories,
  resolveSessionDirectories,
  migrateSessionDirectory,
} from '../src/main/data-directory';

describe('data directory resolution', () => {
  it('prefers the explicit override to APPDATA', () => {
    expect(
      resolveDataDirectory({ BRICKLOOP_DATA_DIR: 'E:/project/.devdata/dev', APPDATA: 'C:/User/AppData/Roaming' }),
    ).toBe('E:\\project\\.devdata\\dev');
  });
  it('defaults to APPDATA/Brickloop', () => {
    expect(resolveDataDirectory({ APPDATA: 'C:\\User\\AppData\\Roaming' })).toBe(
      'C:\\User\\AppData\\Roaming\\Brickloop',
    );
  });
  it('treats a blank override as absent', () => {
    expect(resolveDataDirectory({ BRICKLOOP_DATA_DIR: '  ', APPDATA: 'E:\\roaming' })).toBe('E:\\roaming\\Brickloop');
  });
  it('normalizes absolute paths, including paths with spaces', () => {
    expect(resolveDataDirectory({ BRICKLOOP_DATA_DIR: ' E:/Project Data/tmp/../dev ' })).toBe('E:\\Project Data\\dev');
  });
  it.each([{}, { BRICKLOOP_DATA_DIR: './data' }, { APPDATA: 'relative' }])(
    'rejects an unresolved directory: %j',
    (env) => {
      expect(() => resolveDataDirectory(env)).toThrow('absolute data directory');
    },
  );
});

describe('synchronous session migration', () => {
  const directories = resolveDataDirectories({ BRICKLOOP_DATA_DIR: 'E:/project/.devdata/dev' });
  const { current, legacy } = resolveSessionDirectories(directories);
  it('uses the local data root in both installed and development layouts', () => {
    expect({ current, legacy }).toEqual({
      current: 'E:\\project\\.devdata\\dev\\session',
      legacy: 'E:\\project\\.devdata\\dev\\cache\\session',
    });
    expect(
      resolveSessionDirectories(resolveDataDirectories({ APPDATA: 'E:/roaming', LOCALAPPDATA: 'E:/local' })),
    ).toEqual({
      current: 'E:\\local\\Brickloop\\session',
      legacy: 'E:\\local\\Brickloop\\cache\\session',
    });
  });
  it.each([
    { newExists: false, oldExists: true, primary: true, rename: true, create: false, selected: current },
    { newExists: true, oldExists: true, primary: true, rename: false, create: false, selected: current },
    { newExists: true, oldExists: false, primary: true, rename: false, create: false, selected: current },
    { newExists: false, oldExists: false, primary: true, rename: false, create: true, selected: current },
    { newExists: true, oldExists: true, primary: false, rename: false, create: false, selected: current },
    { newExists: true, oldExists: false, primary: false, rename: false, create: false, selected: current },
    { newExists: false, oldExists: true, primary: false, rename: false, create: false, selected: legacy },
    { newExists: false, oldExists: false, primary: false, rename: false, create: false, selected: legacy },
  ])('selects without touching another instance: %j', (state) => {
    const filesystem = {
      existsSync: vi.fn((file) => (file === current ? state.newExists : state.oldExists)),
      mkdirSync: vi.fn(() => undefined),
      renameSync: vi.fn(),
    };
    expect(migrateSessionDirectory(directories, state.primary, filesystem)).toBe(state.selected);
    expect(filesystem.renameSync).toHaveBeenCalledTimes(Number(state.rename));
    if (state.rename) expect(filesystem.renameSync).toHaveBeenCalledWith(legacy, current);
    expect(filesystem.mkdirSync).toHaveBeenCalledTimes(Number(state.create));
    if (state.create) expect(filesystem.mkdirSync).toHaveBeenCalledWith(current, { recursive: true });
  });
  it('leaves data intact on rename failure, warns once without native details and retries next launch', () => {
    const filesystem = {
      existsSync: vi.fn((file) => file === legacy),
      mkdirSync: vi.fn(() => undefined),
      renameSync: vi.fn().mockImplementationOnce(() => {
        throw new Error('private native detail');
      }),
    };
    const warn = vi.fn();
    expect(migrateSessionDirectory(directories, true, filesystem, warn)).toBe(legacy);
    expect(filesystem.mkdirSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Session directory migration deferred; using the previous location for this launch.',
    );
    expect(migrateSessionDirectory(directories, true, filesystem, warn)).toBe(current);
    expect(filesystem.renameSync).toHaveBeenCalledTimes(2);
  });
});
