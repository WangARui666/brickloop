import type { StructurePlan } from './plan.js';

type Box = NonNullable<StructurePlan['components'][number]['boundingBox']>;
export interface PlanBoxRepair {
  componentId: string;
  from: Box;
  to: Box;
}

/** A-117 compatibility for saved/legacy plans. New model plans derive their boxes from origin + size. */
export function normalizePlanBoxes(plan: StructurePlan) {
  const boxRepairs: PlanBoxRepair[] = [];
  const components = plan.components.map((component) => {
    const box = component.boundingBox,
      size = component.size;
    const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    if (
      !box ||
      !size ||
      ![size.width, size.depth, size.height].every((n) => finite(n) && n > 0) ||
      ![box.min?.x, box.min?.y, box.min?.z, box.max?.x, box.max?.y, box.max?.z].every(finite)
    )
      return component;
    const { min, max } = box;
    if (
      Math.abs(max.x - min.x - size.width) <= 1e-6 &&
      Math.abs(max.y - min.y - size.height) <= 1e-6 &&
      Math.abs(max.z - min.z - size.depth) <= 1e-6
    )
      return component;
    const to = { min: { ...min }, max: { x: min.x + size.width, y: min.y + size.height, z: min.z + size.depth } };
    if (!Object.values(to.max).every(finite)) return component;
    boxRepairs.push({ componentId: component.id, from: structuredClone(box), to: structuredClone(to) });
    return { ...component, boundingBox: to };
  });
  return { plan: { ...plan, components }, boxRepairs };
}
