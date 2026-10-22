import { create } from 'zustand';
import { changeState, diffDocuments, touchedModelIds } from '@brickloop/core';
import type { BrkDocument, ChangeState, DocumentDiff, SessionChange, MergeConflict } from '@brickloop/core';

export interface Review {
  conflicts: MergeConflict[];
  resolvedConflicts: Record<string, 'ai' | 'mine'>;
  newIssues: number | null;
  transactionId: string;
  before: BrkDocument;
  after: BrkDocument;
  diff: DocumentDiff;
  states: Record<string, ChangeState>;
  transactions: Set<string>;
  grouping: 'type' | 'model' | 'step';
  visible: boolean;
  mode: 'before' | 'after';
  pages: Record<string, number>;
  collapsed: Record<string, boolean>;
  focus: string | null;
  startedAt: number;
  diffMs: number;
  firstScreenMs: number | null;
}
export const useReviewStore = create<{ reviews: Record<string, Review> }>(() => ({ reviews: {} }));
export function reviewFor(id: string) {
  return useReviewStore.getState().reviews[id];
}
export function updateReview(id: string, update: Partial<Review>) {
  const review = reviewFor(id);
  if (review) useReviewStore.setState((state) => ({ reviews: { ...state.reviews, [id]: { ...review, ...update } } }));
}
export function endReview(id: string) {
  if (!reviewFor(id)) return;
  useReviewStore.setState((state) => {
    const reviews = { ...state.reviews };
    delete reviews[id];
    return { reviews };
  });
}
export function observeReview(
  before: BrkDocument,
  current: BrkDocument,
  event: SessionChange,
  conflicts: MergeConflict[] = [],
) {
  const id = current.documentId;
  if (event.type === 'tx' && event.transaction.source === 'ai') {
    const startedAt = performance.now();
    const modelIds = touchedModelIds(event.ops);
    // Group removal/update ops carry only a group ID; resolve their owning definitions here.
    for (const op of event.ops)
      if (op.type === 'group.remove' || op.type === 'group.update')
        for (const item of op.items) {
          const group = before.groups[item.groupId] ?? current.groups[item.groupId];
          if (group) modelIds.add(group.modelId);
        }
    const diff = diffDocuments(before, current, { modelIds });
    if (!diff.instances.length && !diff.structure.length && !conflicts.length) {
      endReview(id);
      return;
    }
    const review: Review = {
      conflicts,
      resolvedConflicts: {},
      newIssues: null,
      transactionId: event.transaction.id,
      before,
      after: current,
      diff,
      states: Object.fromEntries(diff.instances.map((change) => [change.key, changeState(current, change)])),
      transactions: new Set(),
      grouping: 'type',
      visible: true,
      mode: 'after',
      pages: {},
      collapsed: {},
      focus: null,
      startedAt,
      diffMs: performance.now() - startedAt,
      firstScreenMs: null,
    };
    useReviewStore.setState((state) => ({ reviews: { ...state.reviews, [id]: review } }));
    return;
  }
  const review = reviewFor(id);
  if (!review) return;
  const states = { ...review.states };
  for (const change of review.diff.instances)
    if (before.models[change.modelId] !== current.models[change.modelId])
      states[change.key] = changeState(current, change);
  updateReview(id, { states, focus: null });
}
