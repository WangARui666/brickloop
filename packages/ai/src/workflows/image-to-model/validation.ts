import { structurePlanSchema, type StructurePlan } from './plan.js';

export interface PlanIssue {
  componentId?: string;
  field:
    | 'name'
    | 'components'
    | 'component'
    | 'width'
    | 'depth'
    | 'height'
    | 'boundingBox'
    | 'colors'
    | 'partTypes'
    | 'connections'
    | 'order'
    | 'views';
}

/** Stable field identifiers for localized, clickable confirmation errors. */
export function structurePlanIssues(plan: StructurePlan, paletteColorIds: readonly string[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (issue: PlanIssue) => {
    if (!issues.some((v) => v.componentId === issue.componentId && v.field === issue.field)) issues.push(issue);
  };
  const parsed = structurePlanSchema.safeParse(plan);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const [root, index, field, axis] = issue.path;
      if (root === 'components' && typeof index === 'number') {
        const componentId = plan.components[index]!.id;
        if (field === 'size')
          add({ componentId, field: axis === 'width' || axis === 'depth' || axis === 'height' ? axis : 'boundingBox' });
        else if (field === 'colors' || field === 'partTypes' || field === 'connections' || field === 'boundingBox')
          add({ componentId, field });
        else add({ componentId, field: 'component' });
      } else if (root === 'buildOrder') {
        for (const component of plan.components)
          if (plan.buildOrder.filter((id) => id === component.id).length !== 1)
            add({ componentId: component.id, field: 'order' });
        if (!issues.some((issue) => issue.field === 'order')) add({ field: 'order' });
      } else add({ field: root === 'name' ? 'name' : root === 'components' ? 'components' : 'views' });
    }
  for (const component of plan.components)
    if (component.colors.some((id) => !paletteColorIds.includes(id)))
      add({ componentId: component.id, field: 'colors' });
  return issues;
}
