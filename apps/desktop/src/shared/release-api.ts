import { preferencesSchema } from './preferences';
import type { Preferences } from './preferences';
import type { Settings } from './api';
import type { OutputCatalog } from '@brickloop/io';
import type { ColorDef } from '@brickloop/catalog';

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repository?: string | null;
  text?: string;
}
export interface AboutInfo {
  version: string;
  commit: string;
  date: string;
  electron: string;
  chromium: string;
  node: string;
  licenses: LicenseEntry[];
}
export interface StorageInfo {
  library: string;
  cache: string;
  bytes: number;
  migrationFallback: boolean;
}
export interface ReleaseApi {
  preferencesSave(preferences: Preferences): Promise<Settings>;
  storageInfo(): Promise<StorageInfo>;
  cacheClear(): Promise<StorageInfo>;
  libraryChoose(): Promise<string | null>;
  shortcutsImport(): Promise<string | null>;
  shortcutsExport(content: string): Promise<string | null>;
  aboutInfo(): Promise<AboutInfo>;
  filesReady(): Promise<string[]>;
  instructionResources(): Promise<{
    regular: Uint8Array;
    bold: Uint8Array;
    catalog: OutputCatalog & { colors: ColorDef[] };
  }>;
  instructionSave(bytes: Uint8Array, title: string): Promise<string | null>;
}
export const RELEASE_CHANNELS = {
  preferencesSave: 'settings.preferences',
  storageInfo: 'settings.storage',
  cacheClear: 'settings.clearCache',
  libraryChoose: 'settings.library',
  shortcutsImport: 'settings.shortcutsImport',
  shortcutsExport: 'settings.shortcutsExport',
  aboutInfo: 'app.about',
  filesReady: 'app.filesReady',
  instructionResources: 'instructions.resources',
  instructionSave: 'instructions.save',
} as const;
export function validReleaseArguments(channel: string, args: readonly unknown[]): boolean {
  switch (channel) {
    case RELEASE_CHANNELS.preferencesSave:
      return args.length === 1 && preferencesSchema.safeParse(args[0]).success;
    case RELEASE_CHANNELS.shortcutsExport:
      return args.length === 1 && typeof args[0] === 'string' && args[0].length <= 65536;
    case RELEASE_CHANNELS.instructionSave:
      return (
        args.length === 2 &&
        args[0] instanceof Uint8Array &&
        args[0].length > 5 &&
        args[0].length <= 512_000_000 &&
        typeof args[1] === 'string' &&
        args[1].length <= 512
      );
    default:
      return (
        Object.values(RELEASE_CHANNELS).includes(channel as (typeof RELEASE_CHANNELS)[keyof typeof RELEASE_CHANNELS]) &&
        args.length === 0
      );
  }
}
