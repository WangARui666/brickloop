import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron } from '../e2e/electron-launch';
import { EventEmitter } from 'node:events';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@playwright/test', () => ({ _electron: { launch } }));
vi.mock('../e2e/electron-test', () => ({ currentPageErrorGuards: () => [] }));
const directory = fileURLToPath(new URL('../../../.devdata/test data/', import.meta.url));
const desktop = fileURLToPath(new URL('..', import.meta.url));

beforeEach(() => {
  launch.mockReset();
  launch.mockResolvedValue(Object.assign(new EventEmitter(), { windows: () => [], close: vi.fn() }));
});

describe('A-91 launchElectron', () => {
  it('rejects omitted options before launching', () => {
    expect(() => launchElectron()).toThrow('测试启动必须指定测试数据目录');
    expect(launch).not.toHaveBeenCalled();
  });

  it('prepends the user data switch, preserves options and the first application argument, and returns the app', async () => {
    const application = Object.assign(new EventEmitter(), { windows: () => [], close: vi.fn() });
    launch.mockResolvedValue(application);
    const options = {
      args: [desktop, '--host-resolver-rules=MAP *.invalid ~NOTFOUND', 'project with spaces.brkl'],
      env: { BRICKLOOP_DATA_DIR: directory, TEST_VALUE: 'unchanged' },
      timeout: 1234,
    };
    await expect(launchElectron(options)).resolves.toBe(application);
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      ...options,
      args: [`--user-data-dir=${directory}`, ...options.args],
    });
    expect(options.args[0]).toBe(desktop);
    expect(launch.mock.calls[0]![0].args.find((arg: string) => !arg.startsWith('-'))).toBe(desktop);
  });

  it('preserves packaged executablePath and file arguments', async () => {
    const options = {
      executablePath: path.join(desktop, 'Brickloop.exe'),
      args: ['project with spaces.brkl'],
      env: { BRICKLOOP_DATA_DIR: directory },
    };
    await launchElectron(options);
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      ...options,
      args: [`--user-data-dir=${directory}`, ...options.args],
    });
  });

  it('supports omitted args for a packaged executable', async () => {
    const options = { executablePath: path.join(desktop, 'Brickloop.exe'), env: { BRICKLOOP_DATA_DIR: directory } };
    await launchElectron(options);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ ...options, args: [`--user-data-dir=${directory}`] });
  });

  it('validates reasons before launch and does not forward guard options to Electron', async () => {
    expect(() =>
      launchElectron({
        env: { BRICKLOOP_DATA_DIR: directory },
        allowPageErrors: [{ pattern: /expected/, reason: ' ' }],
      }),
    ).toThrow('non-empty reason');
    expect(launch).not.toHaveBeenCalled();
    await launchElectron({
      env: { BRICKLOOP_DATA_DIR: directory },
      allowPageErrors: [{ pattern: /expected/, reason: 'Intentional test exception' }],
    });
    expect(launch.mock.calls[0]![0]).not.toHaveProperty('allowPageErrors');
  });

  it.each([undefined, {}, { BRICKLOOP_DATA_DIR: '' }, { BRICKLOOP_DATA_DIR: '   ' }, { BRICKLOOP_DATA_DIR: './data' }])(
    'rejects missing, blank or relative data directories: %j',
    (env) => {
      expect(() => launchElectron({ ...(env ? { env } : {}), args: [desktop] })).toThrow(
        '测试启动必须指定测试数据目录',
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each([['--user-data-dir', directory], [`--user-data-dir=${directory}`]])(
    'rejects duplicate switch %j',
    (...args) => {
      expect(() => launchElectron({ args: [desktop, ...args], env: { BRICKLOOP_DATA_DIR: directory } })).toThrow(
        '请勿重复传入 --user-data-dir',
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );
});
