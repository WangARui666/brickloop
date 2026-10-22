import { create } from 'zustand';
import { activeTab, documentLocked, documentSession, useDocumentStore } from './document-store';

export const useAskStore = create<{ open: boolean }>(() => ({ open: false }));
export function canAskSelection() {
  const s = useDocumentStore.getState();
  return (
    s.workspace.selection.length > 0 &&
    !s.placement &&
    !s.clipboardPlacement &&
    !s.stepViewing &&
    !documentLocked() &&
    !activeTab().readOnly &&
    !documentSession.isPreviewing
  );
}
export function openSelectionAsk() {
  if (!canAskSelection()) return false;
  useAskStore.setState({ open: true });
  return true;
}
