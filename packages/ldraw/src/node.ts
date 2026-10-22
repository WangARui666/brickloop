import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeFileName } from './parser.js';
import { LibraryResolver } from './resolver.js';
import type { LibrarySource, ResolverOptions } from './resolver.js';

export { createMeshCache } from './cache.js';
export type { MeshCache } from './cache.js';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** Case-insensitive on every OS, even when a mixed-case directory is read from Linux CI. */
export function createDirectorySource(directory: string, id = path.resolve(directory)): LibrarySource {
  const root = path.resolve(directory);
  return {
    id,
    async readText(relative) {
      const name = normalizeFileName(relative);
      let target = path.join(root, ...name.split('/'));
      try {
        return await readFile(target, 'utf8');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      // Windows has already done the case-insensitive lookup; avoid scanning the whole parts directory on a miss.
      if (process.platform === 'win32') return undefined;
      target = root;
      for (const segment of name.split('/')) {
        let entries: string[];
        try {
          entries = await readdir(target);
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
        const found = entries.find((entry) => entry.toLowerCase() === segment);
        if (!found) return undefined;
        target = path.join(target, found);
      }
      try {
        return await readFile(target, 'utf8');
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
  };
}

export interface NodeResolverOptions extends Omit<ResolverOptions, 'library' | 'custom'> {
  libraryDir: string;
  customDirs?: string[];
}
export function createLibraryResolver(options: NodeResolverOptions): LibraryResolver {
  const { libraryDir, customDirs = [], ...rest } = options;
  return new LibraryResolver({
    ...rest,
    library: createDirectorySource(libraryDir, `library:${path.resolve(libraryDir)}`),
    custom: customDirs.map((dir) => createDirectorySource(dir, `custom:${path.resolve(dir)}`)),
  });
}
