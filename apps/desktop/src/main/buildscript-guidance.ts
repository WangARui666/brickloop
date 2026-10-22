import type { JsonValue, StructurePlan } from '@brickloop/ai';
import { inferDesignCategory } from '@brickloop/ai';
import { getGuide } from '../../../../packages/buildscript/src/library';
import type { GuideCategory } from '../../../../packages/buildscript/src/library';

/** Explicit confirmed categories win; legacy callers keep their keyword inference. */
export function planDesignGuides(plan: unknown): string {
  const components = (plan as Partial<StructurePlan> | null)?.components;
  const categories: GuideCategory[] = components?.length
    ? components.map((c) => c.category ?? inferDesignCategory(c))
    : (['buildings', 'vehicles', 'plants', 'terrain', 'figures-and-props'] as const).filter((category) => {
        const text = JSON.stringify(plan);
        const cues = {
          buildings: /building|house|tower|roof|建筑|房|屋|塔/i,
          vehicles: /vehicle|car|wheel|车|轮/i,
          plants: /plant|tree|leaf|植物|树|叶/i,
          terrain: /terrain|island|water|地形|岛|水/i,
          'figures-and-props': /figure|furniture|prop|人物|人仔|家具/i,
        };
        return cues[category].test(text);
      });
  return [...new Set(categories)].map((category) => `Design guide: ${category}\n${getGuide(category)}`).join('\n\n');
}
export function planBuildExamples(plan: StructurePlan, listing: JsonValue): JsonValue {
  const categories = new Set(plan.components.map((c) => c.category ?? inferDesignCategory(c)));
  const ids: Record<GuideCategory, string[]> = {
    buildings: ['cottage', 'onion-tower', 'fence-path'],
    vehicles: ['car'],
    plants: ['trees'],
    terrain: ['island', 'fence-path'],
    'figures-and-props': ['fence-path'],
  };
  const matched = new Set([...categories].flatMap((c) => ids[c]));
  const examples = listing && typeof listing === 'object' && !Array.isArray(listing) ? listing.examples : null;
  return Array.isArray(examples)
    ? examples.filter(
        (e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && matched.has(e.id),
      )
    : [];
}
