import { create } from 'zustand';
import { createI18n } from '@brickloop/i18n';
import type { Language } from '../../shared/api';

export const i18n = createI18n();

interface ShellState {
  language: Language;
  ready: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  rightTab: string;
  leftTab: 'parts' | 'macros';
  structureView: 'tree' | 'steps';
  leftWidth: number;
  rightWidth: number;
  initialize(): Promise<void>;
  setLanguage(language: Language): Promise<void>;
  toggleLeft(): void;
  toggleRight(): void;
  setRightTab(tab: string): void;
  setPanelWidth(side: 'left' | 'right', width: number): void;
}

export const useShellStore = create<ShellState>((set, get) => ({
  language: 'zh-CN',
  ready: false,
  saving: false,
  error: null,
  leftCollapsed: false,
  rightCollapsed: false,
  rightTab: 'palette',
  leftTab: 'parts',
  structureView: 'tree',
  leftWidth: 280,
  rightWidth: 320,
  initialize: async () => {
    try {
      const settings = await window.brickloop.getSettings();
      await i18n.changeLanguage(settings.language);
      const { initializePreferences } = await import('./preferences-store');
      initializePreferences(settings);
      set({ language: settings.language, ready: true, error: null });
    } catch {
      set({ error: 'load' });
    }
  },
  setLanguage: async (language) => {
    if (!get().ready || get().saving) return;
    set({ saving: true, error: null });
    try {
      const settings = await window.brickloop.setLanguage(language);
      await i18n.changeLanguage(settings.language);
      set({ language: settings.language });
    } catch {
      set({ error: 'save' });
    } finally {
      set({ saving: false });
    }
  },
  toggleLeft: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
  toggleRight: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),
  setRightTab: (rightTab) => set({ rightTab }),
  setPanelWidth: (side, width) =>
    set(
      side === 'left'
        ? { leftWidth: Math.min(420, Math.max(220, width)) }
        : { rightWidth: Math.min(480, Math.max(260, width)) },
    ),
}));

export function useTranslation() {
  useShellStore((state) => state.language);
  // React escapes text nodes; HTML escaping here would display entities in file paths and names.
  return (key: string, options?: Record<string, unknown>) =>
    i18n.t(key, { ...options, interpolation: { escapeValue: false } });
}
