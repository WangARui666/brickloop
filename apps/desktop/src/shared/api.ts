import { ANIMATION_CHANNELS, validAnimationArguments } from './animation-api';
import type { AnimationExportApi } from './animation-api';
import { LIBRARY_CHANNELS, validLibraryArguments } from './library-api';
import type { LibraryApi } from './library-api';
import type { ColorId } from '@brickloop/catalog';
import { PROJECT_CHANNELS, validProjectArguments } from './project-api';
import type { ProjectApi } from './project-api';
import { ASSEMBLY_CHANNELS, validAssemblyArguments } from './assembly-api';
import type { AssemblyApi } from './assembly-api';
import { AI_CHANNELS, validAiArguments } from './ai-api';
import type { AiApi, AiSettings } from './ai-api';
import { MACRO_CHANNELS, validMacroArguments } from './macro-api';
import type { MacroApi } from './macro-api';
import type { Preferences } from './preferences';
import { RELEASE_CHANNELS, validReleaseArguments } from './release-api';
import type { ReleaseApi } from './release-api';
export type Language = 'zh-CN' | 'en';

export interface Settings {
  preferences?: Preferences;
  ai?: AiSettings;
  maintenanceMode?: boolean;
  language: Language;
  activePackId?: string;
  favoriteColors?: ColorId[];
  recentFiles?: string[];
  recoveryPaths?: Record<string, string>;
}

export interface AppInfo {
  name: string;
  version: string;
  dataDirectory: string;
}

export interface DesktopApi
  extends AnimationExportApi, LibraryApi, ProjectApi, AssemblyApi, AiApi, MacroApi, ReleaseApi {
  getAppInfo(): Promise<AppInfo>;
  reloadRenderer(): Promise<void>;
  getSettings(): Promise<Settings>;
  setLanguage(language: Language): Promise<Settings>;
  onCloseRequested(callback: () => void): () => void;
  onRecoveryError(callback: (message: string) => void): () => void;
  onOpenFiles(callback: (files: string[]) => void): () => void;
  droppedFilePath(file: File): string;
}

export const IPC_CHANNELS = {
  ...ANIMATION_CHANNELS,
  ...LIBRARY_CHANNELS,
  ...PROJECT_CHANNELS,
  ...ASSEMBLY_CHANNELS,
  ...AI_CHANNELS,
  ...MACRO_CHANNELS,
  ...RELEASE_CHANNELS,
  getAppInfo: 'brickloop:app-info',
  reloadRenderer: 'brickloop:renderer-reload',
  getSettings: 'brickloop:settings-get',
  setLanguage: 'brickloop:language-set',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export function isLanguage(value: unknown): value is Language {
  return value === 'zh-CN' || value === 'en';
}

export function validateIpcArguments(channel: IpcChannel, args: readonly unknown[]): void {
  if (validAnimationArguments(channel, args)) return;
  if (validReleaseArguments(channel, args)) return;
  if (validMacroArguments(channel, args)) return;
  if (validAiArguments(channel, args)) return;
  if (validAssemblyArguments(channel, args)) return;
  if (validLibraryArguments(channel, args)) return;
  if (validProjectArguments(channel, args)) return;
  switch (channel) {
    case IPC_CHANNELS.getAppInfo:
    case IPC_CHANNELS.reloadRenderer:
    case IPC_CHANNELS.getSettings:
      if (args.length === 0) return;
      break;
    case IPC_CHANNELS.setLanguage:
      if (args.length === 1 && isLanguage(args[0])) return;
      break;
  }
  throw new TypeError(`Invalid IPC arguments: ${channel}`);
}
