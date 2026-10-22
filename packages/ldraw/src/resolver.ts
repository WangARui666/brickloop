import { normalizeFileName, parseLDraw } from './parser.js';
import type { ColourDefinition } from './types.js';

/** Paths passed to sources are normalized relative paths. Return undefined only for missing files. */
export interface LibrarySource {
  id: string;
  readText(relativePath: string): Promise<string | undefined>;
}
export type ResolverLocation = 'embedded' | 'custom' | 'parts' | 'p' | 'subparts' | 'models';
export interface ResolverOptions {
  embedded?: ReadonlyMap<string, string> | Record<string, string>;
  custom?: readonly LibrarySource[];
  library?: LibrarySource;
  order?: readonly ResolverLocation[];
  highResPrimitives?: boolean;
}
export interface ResolvedFile {
  file: string;
  text: string;
  resolvedFrom: string;
  identity: string;
}
export interface ResolveOptions {
  highResPrimitives?: boolean;
  /** Per-build MPD namespace, evaluated at the configured embedded position. */
  projectFiles?: ReadonlyMap<string, ResolvedFile>;
}
export const DEFAULT_SEARCH_ORDER: readonly ResolverLocation[] = [
  'embedded',
  'custom',
  'parts',
  'p',
  'subparts',
  'models',
];

export function createMemorySource(
  id: string,
  files: ReadonlyMap<string, string> | Record<string, string>,
): LibrarySource {
  const entries = files instanceof Map ? files.entries() : Object.entries(files);
  const normalized = new Map(Array.from(entries, ([name, text]) => [normalizeFileName(name), text]));
  return { id, readText: (name) => Promise.resolve(normalized.get(normalizeFileName(name))) };
}

export class LibraryResolver {
  readonly highResPrimitives: boolean;
  readonly order: readonly ResolverLocation[];
  private readonly embedded: LibrarySource;
  private readonly custom: readonly LibrarySource[];
  private readonly library: LibrarySource | undefined;

  constructor(options: ResolverOptions = {}) {
    this.embedded = createMemorySource('embedded', options.embedded ?? {});
    this.custom = options.custom ?? [];
    this.library = options.library;
    this.order = options.order ?? DEFAULT_SEARCH_ORDER;
    this.highResPrimitives = options.highResPrimitives ?? false;
  }

  async resolve(name: string, options: ResolveOptions = {}): Promise<ResolvedFile | undefined> {
    const file = normalizeFileName(name);
    const highRes = options.highResPrimitives ?? this.highResPrimitives;
    const probe = async (source: LibrarySource, relative: string): Promise<ResolvedFile | undefined> => {
      const text = await source.readText(relative);
      const identity = `${source.id}:${relative}`;
      return text === undefined ? undefined : { file, text, identity, resolvedFrom: identity };
    };
    for (const location of this.order) {
      if (location === 'embedded') {
        const projectFile = options.projectFiles?.get(file);
        if (projectFile) return projectFile;
        const found = await probe(this.embedded, file);
        if (found) return found;
      } else if (location === 'custom') {
        for (const source of this.custom) {
          const found = await probe(source, file);
          if (found) return found;
        }
      } else if (this.library) {
        let candidates: string[] = [];
        if (location === 'parts' && !/^(s|48|8)\//.test(file)) candidates = [`parts/${file}`];
        if (location === 'p' && !file.startsWith('s/')) {
          candidates = highRes && !/^(48|8)\//.test(file) ? [`p/48/${file}`, `p/${file}`] : [`p/${file}`];
        }
        if (location === 'subparts' && file.startsWith('s/')) candidates = [`parts/${file}`];
        if (location === 'models' && !/^(s|48|8)\//.test(file)) candidates = [`models/${file}`];
        for (const relative of candidates) {
          const found = await probe(this.library, relative);
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  async colourConfiguration(): Promise<ResolvedFile | undefined> {
    for (const source of [this.embedded, ...this.custom, this.library]) {
      if (!source) continue;
      const text = await source.readText('ldconfig.ldr');
      if (text !== undefined) {
        const identity = `${source.id}:ldconfig.ldr`;
        return { file: 'ldconfig.ldr', text, identity, resolvedFrom: identity };
      }
    }
    return undefined;
  }

  async loadColours(): Promise<Map<number, ColourDefinition>> {
    const config = await this.colourConfiguration();
    return new Map(config ? parseLDraw(config.text, config.file).colours.map((colour) => [colour.code, colour]) : []);
  }
}
