import { planningReferenceId, standardReferenceViews, type StructurePlan } from './plan.js';
import type { ImageModelInput, ReferenceViewReport, StandardReferenceView } from './types.js';

export const VIEW_CONFIDENCE_THRESHOLD = 0.6;
export const isStandardReferenceView = (view: string): view is StandardReferenceView =>
  standardReferenceViews.some((value) => value === view);

/** Planning IDs are stable across confirmation; preparation replaces them with host resource IDs. */
export function resolveReferenceViews(
  input: ImageModelInput,
  plan: Pick<StructurePlan, 'viewEstimates' | 'viewOverrides'> = {},
): ReferenceViewReport[] {
  return (input.images ?? []).map((image, index) => {
    const referenceId = planningReferenceId(index);
    const selected = plan.viewOverrides?.find((v) => v.referenceId === referenceId)?.view ?? image.view;
    const estimate = plan.viewEstimates?.find((v) => v.referenceId === referenceId);
    const base = { referenceId, name: image.name, iou: null };
    if (isStandardReferenceView(selected)) return { ...base, view: selected, source: 'designer', confidence: null };
    if (
      selected !== 'exclude' &&
      estimate &&
      isStandardReferenceView(estimate.view) &&
      estimate.confidence >= VIEW_CONFIDENCE_THRESHOLD
    )
      return { ...base, view: estimate.view, source: 'ai', confidence: estimate.confidence };
    return { ...base, view: null, source: 'excluded', confidence: null };
  });
}
