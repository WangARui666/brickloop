import { isLanguage } from '../shared/api';
import type { Settings } from '../shared/api';
import { isColorId } from '../shared/library-api';
import { aiSettingsSchema } from '../shared/ai-api';
import { preferencesSchema } from '../shared/preferences';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ language: 'zh-CN' });

export function parseSettings(content: string): Settings {
  const value: unknown = JSON.parse(content);
  if (typeof value !== 'object' || value === null || !('language' in value) || !isLanguage(value.language)) {
    throw new TypeError('Invalid settings language');
  }
  const settings: Settings = { language: value.language };
  if ('preferences' in value) {
    const parsed = preferencesSchema.safeParse(value.preferences);
    if (parsed.success) settings.preferences = parsed.data;
  }
  if ('ai' in value) {
    const parsed = aiSettingsSchema.safeParse(value.ai);
    if (parsed.success) {
      settings.ai = parsed.data;
      // Mark the migration so an explicitly chosen 80 / 10 stays valid on later saves.
      if (value.ai && typeof value.ai === 'object' && !('limitsVersion' in value.ai)) {
        if (settings.ai.toolLimit === 80) settings.ai.toolLimit = null;
        if (settings.ai.durationMinutes === 10) settings.ai.durationMinutes = null;
      }
    }
  }
  if ('maintenanceMode' in value && typeof value.maintenanceMode === 'boolean')
    settings.maintenanceMode = value.maintenanceMode;
  if (
    'recoveryPaths' in value &&
    value.recoveryPaths &&
    typeof value.recoveryPaths === 'object' &&
    !Array.isArray(value.recoveryPaths)
  )
    settings.recoveryPaths = Object.fromEntries(
      Object.entries(value.recoveryPaths as Record<string, unknown>).filter(
        (entry): entry is [string, string] => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(entry[0]) && typeof entry[1] === 'string',
      ),
    );
  if ('recentFiles' in value && Array.isArray(value.recentFiles))
    settings.recentFiles = value.recentFiles.filter((item): item is string => typeof item === 'string').slice(0, 12);
  if (
    'activePackId' in value &&
    typeof value.activePackId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.activePackId)
  )
    settings.activePackId = value.activePackId;
  if ('favoriteColors' in value && Array.isArray(value.favoriteColors))
    settings.favoriteColors = [...new Set(value.favoriteColors.filter(isColorId))].slice(0, 512);
  return settings;
}

export function serializeSettings(settings: Settings): string {
  if (!isLanguage(settings.language)) throw new TypeError('Invalid settings language');
  return `${JSON.stringify(parseSettings(JSON.stringify(settings)), null, 2)}\n`;
}

export function decodeSettings(content: string | undefined): { settings: Settings; corrupt: boolean } {
  if (content === undefined) return { settings: { ...DEFAULT_SETTINGS }, corrupt: false };
  try {
    return { settings: parseSettings(content), corrupt: false };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, corrupt: true };
  }
}
