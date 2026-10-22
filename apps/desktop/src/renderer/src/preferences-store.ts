import { create } from 'zustand';
import { defaultPreferences } from '../../shared/preferences';
import type { Preferences } from '../../shared/preferences';
import type { Settings } from '../../shared/api';
import { effectiveShortcuts, shortcutFromEvent } from '../../shared/shortcuts';
import { setEditorOption, reloadEditorGeometry, documentSession, editorViewport } from './document-store';
import { reloadAssemblyCatalog, setAssemblyOption, useAssemblyStore } from './assembly-store';
import { useLibraryStore } from './library-store';
import { i18n } from './store';

export const usePreferences = create<{
  value: Preferences;
  error: boolean;
  page: string;
  about: boolean;
  pdf: boolean;
}>(() => ({ value: defaultPreferences, error: false, page: 'general', about: false, pdf: false }));
function apply(next: Preferences, previous?: Preferences) {
  if (!previous || previous.edgeMode !== next.edgeMode) editorViewport()?.setEdgeMode(next.edgeMode);
  if (!previous || previous.grid !== next.grid) setEditorOption('horizontal', next.grid);
  if (!previous || previous.angle !== next.angle) setEditorOption('angle', next.angle);
  if (!previous || previous.snap !== next.snap) setAssemblyOption('snap', next.snap);
  if (!previous || previous.collisionPolicy !== next.collisionPolicy) setAssemblyOption('policy', next.collisionPolicy);
  documentSession.endMerge();
}
export function initializePreferences(settings: Settings) {
  const value = settings.preferences ?? defaultPreferences;
  persisted = value;
  usePreferences.setState({ value });
  useAssemblyStore.setState({ maintenance: settings.maintenanceMode === true });
  apply(value);
}
let queue = Promise.resolve();
let sequence = 0;
let persisted = defaultPreferences;
export function savePreferences(patch: Partial<Preferences>): Promise<void> {
  const previous = usePreferences.getState().value,
    value = { ...previous, ...patch },
    ticket = ++sequence;
  usePreferences.setState({ value, error: false });
  apply(value, previous);
  const task = queue.then(async () => {
    try {
      const settings = await window.brickloop.preferencesSave(value);
      persisted = settings.preferences ?? value;
      if (previous.libraryPath !== value.libraryPath) {
        await useLibraryStore.getState().refresh();
        await reloadEditorGeometry();
        await reloadAssemblyCatalog(true);
      }
    } catch {
      if (ticket === sequence) {
        usePreferences.setState({ value: persisted, error: true });
        apply(persisted, value);
      }
    }
  });
  queue = task;
  return task;
}
export function shortcutText(command: string): string {
  const aliases: Record<string, string> = { 'group.rename': 'structure.rename', 'submodel.rename': 'structure.rename' };
  const groups: Record<string, string[]> = {
    'transform.translate': ['move.forward', 'move.left', 'move.back', 'move.right', 'move.up', 'move.down'],
    'transform.rotate': ['rotate.left', 'rotate.right', 'rotate.up', 'rotate.down'],
    'tool.grid.set': ['tool.grid1', 'tool.grid2', 'tool.grid3'],
  };
  if (groups[command]) return groups[command].map(shortcutText).filter(Boolean).join(' / ');
  return (effectiveShortcuts(usePreferences.getState().value.shortcuts)[aliases[command] ?? command] ?? []).join(' / ');
}
export function shortcutCommand(event: KeyboardEvent): string | undefined {
  const key = shortcutFromEvent(event);
  return key
    ? Object.entries(usePreferences.getState().value.shortcuts).find(([, keys]) => keys.includes(key))?.[0]
    : undefined;
}
export function commandLabel(command: string): string {
  const existing = `desktop.commands.${command}.label`;
  return i18n.exists(existing) ? i18n.t(existing) : i18n.t(`preferences.commands.${command}`);
}
