import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function libraryPaths(
  packaged: boolean,
  executable: string,
  data: string,
  cache = path.join(data, 'cache'),
  override = '',
) {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const resourceRoot = process.resourcesPath ?? path.join(path.dirname(executable), 'resources');
  const library = packaged ? path.join(resourceRoot, 'library/ldraw') : path.join(repo, 'library/ldraw');
  return {
    library: override || library,
    demo: path.join(packaged ? resourceRoot : repo, 'library/packs/demo'),
    connectors: path.join(packaged ? resourceRoot : repo, 'library/connectors'),
    colliders: path.join(packaged ? resourceRoot : repo, 'library/colliders'),
    macros: path.join(packaged ? resourceRoot : repo, 'library/macros'),
    packs: path.join(data, 'packs'),
    mesh: path.join(cache, 'mesh'),
    thumb: path.join(cache, 'thumb'),
    catalog: path.join(cache, 'catalog'),
  };
}
