import type { MacroAvailability, MacroMeta, MacroPackage } from '@brickloop/io';

export interface MacroEntry {
  id: string;
  hash: string;
  builtin: boolean;
  meta: MacroMeta;
}
export interface MacroApi {
  macrosList(): Promise<MacroEntry[]>;
  macroRead(id: string): Promise<{ pkg: MacroPackage; availability: MacroAvailability }>;
  macroSave(bytes: Uint8Array): Promise<MacroEntry>;
  macroRename(id: string, name: string): Promise<void>;
  macroRemove(id: string): Promise<void>;
  macroReveal(id: string): Promise<void>;
  macroThumbGet(id: string): Promise<{ key: string; png: string | null }>;
  macroThumbPut(key: string, png: string): Promise<void>;
}
export const MACRO_CHANNELS = {
  macrosList: 'macros.list',
  macroRead: 'macros.read',
  macroSave: 'macros.save',
  macroRename: 'macros.rename',
  macroRemove: 'macros.remove',
  macroReveal: 'macros.reveal',
  macroThumbGet: 'macros.thumbGet',
  macroThumbPut: 'macros.thumbPut',
} as const;

export function validMacroArguments(channel: string, args: readonly unknown[]): boolean {
  const [id, value] = args;
  const validId = typeof id === 'string' && /^(builtin\.[a-z]+|user\.[a-f0-9-]{36})$/.test(id);
  switch (channel) {
    case MACRO_CHANNELS.macrosList:
      return args.length === 0;
    case MACRO_CHANNELS.macroRead:
    case MACRO_CHANNELS.macroRemove:
    case MACRO_CHANNELS.macroReveal:
    case MACRO_CHANNELS.macroThumbGet:
      return args.length === 1 && validId;
    case MACRO_CHANNELS.macroRename:
      return args.length === 2 && validId && typeof value === 'string' && !!value.trim() && value.length <= 120;
    case MACRO_CHANNELS.macroSave:
      return args.length === 1 && id instanceof Uint8Array && id.byteLength > 0 && id.byteLength <= 64 * 1024 * 1024;
    case MACRO_CHANNELS.macroThumbPut:
      return (
        args.length === 2 &&
        typeof id === 'string' &&
        /^[a-f0-9]{64}$/.test(id) &&
        typeof value === 'string' &&
        value.length <= 512_000 &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)
      );
    default:
      return false;
  }
}
