import { normalizeFileName, parseLDraw } from './parser.js';
import type { LibraryResolver, ResolvedFile } from './resolver.js';
import type { BuildOptions, ColourDefinition, LDrawSubfile } from './types.js';

export const BUILDER_VERSION = '1';
export interface PreparedFile extends ResolvedFile {
  parsed: LDrawSubfile;
  warnings: string[];
}
export interface PreparedPart {
  partFile: string;
  files: Map<string, PreparedFile | undefined>;
  dependencies: ResolvedFile[];
  colours: Map<number, ColourDefinition>;
  options: Required<BuildOptions>;
}
export function normalizedOptions(resolver: LibraryResolver, options: BuildOptions): Required<BuildOptions> {
  const result = {
    highResPrimitives: options.highResPrimitives ?? resolver.highResPrimitives,
    smoothingAngle: options.smoothingAngle ?? 30,
    maxDepth: options.maxDepth ?? 64,
  };
  if (!Number.isFinite(result.smoothingAngle) || result.smoothingAngle < 0 || result.smoothingAngle > 180)
    throw new Error('smoothingAngle must be in [0, 180]');
  if (!Number.isInteger(result.maxDepth) || result.maxDepth < 1 || result.maxDepth > 1024)
    throw new Error('maxDepth must be an integer in [1, 1024]');
  return result;
}

/** A fresh dependency snapshot per build lets caches see edited, newly added and shadowing files. */
export async function preparePart(
  partFile: string,
  resolver: LibraryResolver,
  options: BuildOptions = {},
): Promise<PreparedPart> {
  const prepared: PreparedPart = {
    partFile: normalizeFileName(partFile),
    files: new Map(),
    dependencies: [],
    colours: new Map(),
    options: normalizedOptions(resolver, options),
  };
  const embedded = new Map<string, PreparedFile>();
  const expandedAtDepth = new Map<string, number>();
  const config = await resolver.colourConfiguration();
  if (config) {
    prepared.dependencies.push(config);
    prepared.colours = new Map(parseLDraw(config.text, config.file).colours.map((colour) => [colour.code, colour]));
  }
  const load = async (name: string, depth: number): Promise<void> => {
    if (depth >= prepared.options.maxDepth) return;
    const previous = expandedAtDepth.get(name);
    if (previous !== undefined && previous <= depth) return;
    expandedAtDepth.set(name, depth);
    let file = prepared.files.get(name);
    if (!prepared.files.has(name)) {
      const source = await resolver.resolve(name, { ...prepared.options, projectFiles: embedded });
      const local = embedded.get(name);
      if (source && local?.identity === source.identity) file = local;
      else {
        if (source) {
          prepared.dependencies.push(source);
          const parsed = parseLDraw(source.text, source.file);
          file = { ...source, parsed, warnings: parsed.warnings };
          if (parsed.isMpd) {
            for (const subfile of parsed.subfiles) {
              if (!embedded.has(subfile.fileName))
                embedded.set(subfile.fileName, {
                  ...source,
                  file: subfile.fileName,
                  identity: `${source.identity}#${subfile.fileName}`,
                  resolvedFrom: `${source.resolvedFrom}#${subfile.fileName}`,
                  parsed: subfile,
                  warnings: [],
                });
            }
            file = { ...file, identity: `${source.identity}#${parsed.fileName}` };
          }
        }
      }
      prepared.files.set(name, file);
    }
    if (!file) return;
    for (const line of file.parsed.lines) if (line.type === 1) await load(line.fileName, depth + 1);
  };
  await load(prepared.partFile, 0);
  return prepared;
}
