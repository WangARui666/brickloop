import { revertChanges } from '@brickloop/core';
import {
  activeTab,
  documentLocked,
  documentSession,
  editorViewport,
  enterContext,
  refresh,
  reviewTargets,
  selectPaths,
  useDocumentStore,
} from './document-store';
import { endReview, reviewFor, updateReview } from './review-store';
import { i18n } from './store';

export function canUndoReview(): boolean {
  const review = reviewFor(documentSession.document.documentId);
  if (!review) return false;
  for (const transaction of [...documentSession.history].reverse()) {
    if (review.transactions.has(transaction.id)) continue;
    return transaction.id === review.transactionId;
  }
  return false;
}
export function applyReview(keys: readonly string[], to: 'before' | 'after'): boolean {
  if (documentLocked() || activeTab().readOnly) return false;
  const id = documentSession.document.documentId,
    review = reviewFor(id);
  if (!review) return false;
  const chosen = new Set(keys),
    changes = review.diff.instances.filter((change) => chosen.has(change.key));
  const result = revertChanges(documentSession.document, changes, to);
  if (!result.ok) {
    useDocumentStore.setState({
      error: i18n.t(
        result.error.details &&
          typeof result.error.details === 'object' &&
          'reason' in result.error.details &&
          result.error.details.reason === 'SUPERSEDED'
          ? 'reviewUi.supersededHint'
          : 'reviewUi.dependency',
      ),
    });
    return false;
  }
  const count = changes.filter(
    (change) => review.states[change.key] === (to === 'before' ? 'accepted' : 'rejected'),
  ).length;
  const applied = documentSession.applyExternal(
    result.value,
    i18n.t(to === 'before' ? 'reviewUi.rejectLabel' : 'reviewUi.restoreLabel', { count }),
    'ui',
  );
  if (!applied.ok) {
    useDocumentStore.setState({ error: i18n.t('reviewUi.dependency') });
    return false;
  }
  if (applied.value) updateReview(id, { transactions: new Set([...review.transactions, applied.value.id]) });
  refresh();
  return true;
}
export function undoReview(): boolean {
  if (documentLocked() || activeTab().readOnly || !canUndoReview()) return false;
  const id = documentSession.document.documentId,
    review = reviewFor(id)!;
  while (documentSession.history.length) {
    const top = documentSession.history.at(-1)!;
    const result = documentSession.undo();
    if (!result.ok) return false;
    if (top.id === review.transactionId) break;
  }
  endReview(id);
  refresh();
  return true;
}
export function focusReview(key: string, select = false) {
  const id = documentSession.document.documentId;
  updateReview(id, { focus: key });
  if (!select || useDocumentStore.getState().reviewBefore) return;
  const target = reviewTargets(key)[0],
    viewport = editorViewport();
  if (typeof target === 'number') viewport?.fitReviewGhost(target);
  else if (target) {
    enterContext(target.slice(0, -1));
    selectPaths([target]);
    viewport?.fitSelection([target]);
  }
}
