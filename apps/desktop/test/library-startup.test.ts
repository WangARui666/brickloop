import { expect, it, vi } from 'vitest';
import path from 'node:path';
import { createLibraryService } from '../src/main/library-service';
import { libraryPaths } from '../src/main/library-paths';
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('../src/main/mesh-service', () => ({ createMeshService: () => ({ get: vi.fn(), dispose: vi.fn() }) }));

it('returns a recoverable missing-library state without rejecting startup', async () => {
  const paths = libraryPaths(false, 'E:/Brickloop/Brickloop.exe', path.resolve('.devdata/desktop-unit'));
  const service = createLibraryService(
    { ...paths, library: path.join(paths.library, 'missing-test-directory') },
    () => undefined,
    () => ({ language: 'zh-CN' }),
    async () => ({ language: 'zh-CN' }),
    (key) => key,
  );
  await expect(service.api.catalogStatus()).resolves.toMatchObject({ state: 'missing', pack: null });
  await expect(service.api.catalogCategories()).rejects.toThrow('libraryUi.unavailable');
});
it('centralizes development and installed library/cache paths', () => {
  const data = path.resolve('.devdata/dev');
  expect(libraryPaths(false, '', data).mesh).toBe(path.join(data, 'cache/mesh'));
  expect(libraryPaths(false, '', data).library).toBe(path.resolve('library/ldraw'));
  // Outside Electron process.resourcesPath is undefined, so the packaged layout falls back to
  // <exe dir>/resources, matching electron-builder's extraResources location.
  expect(libraryPaths(true, path.resolve('installed/Brickloop.exe'), data).library).toBe(
    path.resolve('installed/resources/library/ldraw'),
  );
});
