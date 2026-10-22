import { create } from 'zustand';
import { createMacroFromSelection, macroName } from '@brickloop/io';
import type { MacroPackage } from '@brickloop/io';
import type { MacroEntry } from '../../shared/macro-api';
import {
  documentSession,
  ensureDocumentMeshes,
  meshes,
  registerEditorActions,
  startMacroPlacement,
  useDocumentStore,
} from './document-store';
import { i18n, useShellStore } from './store';

export const macroCategories = ['furniture', 'doors-windows', 'plants', 'transport', 'other'];
interface MacroState {
  entries: MacroEntry[];
  category: string;
  mode: 'group' | 'submodel';
  query: string;
  selected: string | null;
  draft: MacroPackage | null;
  rename: MacroEntry | null;
  remove: MacroEntry | null;
  error: string | null;
}
export const useMacroStore = create<MacroState>(() => ({
  entries: [],
  category: 'all',
  mode: 'group',
  query: '',
  selected: null,
  draft: null,
  rename: null,
  remove: null,
  error: null,
}));
export async function refreshMacros() {
  try {
    useMacroStore.setState({ entries: await window.brickloop.macrosList(), error: null });
  } catch {
    useMacroStore.setState({ error: i18n.t('macroUi.loadFailed') });
  }
}
export async function placeMacro(id: string, pointer?: { x: number; y: number }) {
  const tabId = useDocumentStore.getState().activeId;
  try {
    const { pkg, availability } = await window.brickloop.macroRead(id);
    if (useDocumentStore.getState().activeId !== tabId) return;
    const { missingParts, missingColors, unavailableColors } = availability;
    const warning =
      missingParts.length || missingColors.length || unavailableColors.length
        ? i18n.t('macroUi.availability', {
            parts: missingParts.length,
            colors: missingColors.length,
            combinations: unavailableColors.length,
          })
        : null;
    await startMacroPlacement(
      pkg,
      useMacroStore.getState().mode,
      macroName(pkg.meta.name, useShellStore.getState().language),
      warning,
      pointer,
    );
  } catch {
    useMacroStore.setState({ error: i18n.t('macroUi.loadFailed') });
  }
}
export function initializeMacros() {
  registerEditorActions({
    'macro.insert': () => {
      useShellStore.setState({ leftTab: 'macros', leftCollapsed: false });
    },
    'macro.saveSelection': async () => {
      if (!documentSession.workspace.selection.length) return;
      const session = documentSession,
        doc = session.document,
        selection = session.workspace.selection;
      await ensureDocumentMeshes();
      if (session !== documentSession) return;
      try {
        const draft = createMacroFromSelection(
          doc,
          selection,
          {
            id: `user.${crypto.randomUUID()}`,
            name: i18n.t('macroUi.defaultName'),
            category: 'furniture',
            author: doc.meta.author,
            createdAt: new Date().toISOString(),
          },
          { bboxProvider: (id) => meshes.get(id)?.bboxLdu },
        );
        useMacroStore.setState({ draft, error: null });
        void refreshMacros();
      } catch {
        useDocumentStore.setState({ error: i18n.t('macroUi.saveFailed') });
      }
    },
  });
}
