import { z } from 'zod';
import type { PlanColorRepair } from './colors.js';
import { normalizePlanBoxes, type PlanBoxRepair } from './boxes.js';
const id = z.string().trim().min(1).max(120);
export const designCategories = ['buildings', 'vehicles', 'plants', 'terrain', 'figures-and-props'] as const;
export type DesignCategory = (typeof designCategories)[number];
export function inferDesignCategory(value: unknown): DesignCategory {
  const text = JSON.stringify(value);
  if (/vehicle|car\b|truck|wheel|车辆|汽车|轮|飞机|船/i.test(text)) return 'vehicles';
  if (/plant|tree|leaf|flower|植物|树|叶|花/i.test(text)) return 'plants';
  if (/terrain|island|mountain|water|地形|岛|山|水/i.test(text)) return 'terrain';
  if (/figure|person|furniture|prop|人仔|人物|家具|小物件/i.test(text)) return 'figures-and-props';
  return 'buildings';
}
const point = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const boundingBox = z
  .object({ min: point, max: point })
  .refine(
    (b) => b.max.x > b.min.x && b.max.y > b.min.y && b.max.z > b.min.z,
    'Bounding box must have positive dimensions in studs.',
  );
export const standardReferenceViews = ['front', 'back', 'left', 'right', 'top', 'isometric'] as const;
export const planningReferenceId = (index: number) => `reference-${index + 1}`;
const viewEstimateSchema = z.object({
  referenceId: id,
  view: z.enum([...standardReferenceViews, 'none']),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().max(2000),
});
export type ViewEstimate = z.infer<typeof viewEstimateSchema>;
export const structurePlanSchema = z
  .object({
    name: id,
    viewEstimates: z.array(viewEstimateSchema).max(8).optional(),
    // Only confirmation from the designer may supply overrides; model output is discarded by the runtime.
    viewOverrides: z
      .array(
        z.object({
          referenceId: id,
          view: z
            .enum([...standardReferenceViews, 'auto', 'exclude', 'unknown'])
            .transform((view) => (view === 'unknown' ? ('auto' as const) : view)),
        }),
      )
      .max(8)
      .optional(),
    components: z
      .array(
        z.object({
          id,
          name: id,
          // Optional at the schema boundary for saved plans and older IPC callers.
          boundingBox: boundingBox.optional(),
          category: z.enum(designCategories).optional(),
          strategy: z.enum(['shapes', 'parts']).optional(),
          size: z.object({
            width: z.number().positive().finite(),
            depth: z.number().positive().finite(),
            height: z.number().positive().finite(),
          }),
          colors: z.array(id).min(1),
          partTypes: z.array(id).min(1),
          connections: z
            .array(
              z.object({
                target: id,
                description: z.string().trim().min(1),
                sourceConnector: id.optional(),
                targetConnector: id.optional(),
              }),
            )
            .default([]),
        }),
      )
      .min(1)
      .max(100),
    buildOrder: z.array(id).min(1),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set(plan.components.map((c) => c.id));
    if (ids.size !== plan.components.length)
      ctx.addIssue({ code: 'custom', path: ['components'], message: 'Component IDs must be unique.' });
    if (
      plan.buildOrder.length !== ids.size ||
      new Set(plan.buildOrder).size !== ids.size ||
      plan.buildOrder.some((i) => !ids.has(i))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['buildOrder'],
        message: 'Build order must contain every component exactly once.',
      });
    plan.components.forEach((c, i) =>
      c.connections.forEach((connection, j) => {
        if (!ids.has(connection.target) || connection.target === c.id)
          ctx.addIssue({
            code: 'custom',
            path: ['components', i, 'connections', j, 'target'],
            message: 'Connection target must reference another component.',
          });
      }),
    );
    plan.components.forEach((c, i) => {
      if (!c.boundingBox) return;
      const { min, max } = c.boundingBox;
      if (
        Math.abs(max.x - min.x - c.size.width) > 1e-6 ||
        Math.abs(max.y - min.y - c.size.height) > 1e-6 ||
        Math.abs(max.z - min.z - c.size.depth) > 1e-6
      )
        ctx.addIssue({
          code: 'custom',
          path: ['components', i, 'boundingBox'],
          message: 'Bounding box dimensions must match size.',
        });
    });
  });
export type StructurePlan = z.infer<typeof structurePlanSchema> & {
  /** Host-supplied review metadata; never accepted from model output or confirmation. */
  colorReview?: { repairs: PlanColorRepair[]; paletteColorIds: string[] };
};
// Keep finite, editable geometry errors visible in confirmation. Final confirmation remains strict.
const reviewPlanSchema = z
  .object({
    ...structurePlanSchema.shape,
    components: z
      .array(
        z.object({
          ...structurePlanSchema.shape.components.element.shape,
          size: z.object({ width: z.number().finite(), depth: z.number().finite(), height: z.number().finite() }),
          boundingBox: z.object({ min: point, max: point }).optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((plan, ctx) => {
    const strict = structurePlanSchema.safeParse(plan);
    if (!strict.success)
      for (const issue of strict.error.issues)
        if (!(issue.path[0] === 'components' && (issue.path[2] === 'size' || issue.path[2] === 'boundingBox')))
          ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });
// The model supplies independent geometry only. Stored plans and IPC retain the host box schema.
const modelPlanSchema = z.object({
  ...structurePlanSchema.shape,
  components: z
    .array(structurePlanSchema.shape.components.element.omit({ boundingBox: true }).extend({ origin: point }))
    .min(1)
    .max(100),
});
export const structurePlanJsonSchema = z.toJSONSchema(modelPlanSchema, { io: 'input', target: 'draft-7' });
// Overrides are designer controls, never requested from the model.
delete structurePlanJsonSchema.properties?.viewOverrides;
export type PlanParseResult =
  | { ok: true; plan: StructurePlan; repairs: string[]; boxRepairs: PlanBoxRepair[] }
  | { ok: false; issues: { path: string; message: string }[] };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Repairs formatting and excludes invalid estimates; never invents geometry or repairs dangling references. */
export function parseStructurePlan(
  input: unknown,
  expectedReferenceIds?: readonly string[],
  forConfirmation = false,
): PlanParseResult {
  const repairs: string[] = [];
  const legacyBoxes = new Map<string, NonNullable<StructurePlan['components'][number]['boundingBox']>>();
  try {
    if (typeof input === 'string') {
      const source = input;
      if (source.length > 1_000_000) throw new Error('Plan is too large.');
      try {
        input = JSON.parse(source) as unknown;
      } catch {
        const start = source.indexOf('{');
        let depth = 0,
          quoted = false,
          escaped = false,
          end = -1;
        for (let i = start; i >= 0 && i < source.length; i++) {
          const c = source[i];
          if (escaped) {
            escaped = false;
            continue;
          }
          if (quoted && c === '\\') {
            escaped = true;
            continue;
          }
          if (c === '"') quoted = !quoted;
          if (!quoted) {
            if (c === '{') depth++;
            if (c === '}') {
              depth--;
              if (depth === 0) {
                end = i + 1;
                break;
              }
            }
          }
        }
        if (end < 0) throw new Error('Expected a JSON object.');
        input = JSON.parse(source.slice(start, end)) as unknown;
        repairs.push('json_wrapper');
      }
    }
    if (object(input) && object(input.plan)) {
      input = input.plan;
      repairs.push('plan_envelope');
    }
    if (object(input) && Array.isArray(input.components)) {
      const components = input.components.map((c: unknown) => {
        if (!object(c)) return c;
        const copy = { ...c };
        if (object(c.size)) {
          copy.size = Object.fromEntries(
            Object.entries(c.size).map(([k, v]) => {
              if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
                repairs.push('numeric_size');
                return [k, Number(v)];
              }
              return [k, v];
            }),
          );
        }
        for (const key of ['colors', 'partTypes'])
          if (typeof c[key] === 'string') {
            copy[key] = [c[key]];
            repairs.push('singleton_list');
          }
        const origin =
          copy.origin !== undefined ? copy.origin : object(copy.boundingBox) ? copy.boundingBox.min : undefined;
        if (origin !== undefined && object(copy.size)) {
          const min = point.safeParse(origin);
          if (min.success) {
            if (copy.origin === undefined && object(copy.boundingBox)) {
              const max = point.safeParse(copy.boundingBox.max);
              if (max.success && typeof copy.id === 'string')
                legacyBoxes.set(copy.id, { min: min.data, max: max.data });
            }
            copy.boundingBox = {
              min: min.data,
              max: {
                x: min.data.x + Number(copy.size.width),
                y: min.data.y + Number(copy.size.height),
                z: min.data.z + Number(copy.size.depth),
              },
            };
          } else {
            // Invalid origins must not silently fall back to an older bounding box.
            copy.boundingBox = { min: origin };
          }
        } else if (copy.boundingBox === undefined && copy.origin === undefined && object(copy.size)) {
          copy.boundingBox = {
            min: { x: 0, y: 0, z: 0 },
            max: { x: copy.size.width, y: copy.size.height, z: copy.size.depth },
          };
          repairs.push('legacy_bounding_box');
        }
        if (copy.category === undefined) copy.category = inferDesignCategory(copy);
        if (copy.strategy === undefined) copy.strategy = 'shapes';
        return copy;
      });
      if (input.buildOrder === undefined) repairs.push('default_order');
      input = {
        ...input,
        components,
        buildOrder: input.buildOrder ?? components.map((c) => (object(c) ? c.id : undefined)),
      };
    }
    if (object(input) && (expectedReferenceIds !== undefined || input.viewEstimates !== undefined)) {
      const raw: unknown[] = Array.isArray(input.viewEstimates) ? input.viewEstimates : [];
      const ids = expectedReferenceIds ?? [
        ...new Set(raw.flatMap((v) => (object(v) && typeof v.referenceId === 'string' ? [v.referenceId] : []))),
      ];
      if (raw.some((v) => !object(v) || !ids.includes(String(v.referenceId)))) repairs.push('view_estimate_unmatched');
      if (input.viewEstimates !== undefined && !Array.isArray(input.viewEstimates))
        repairs.push('view_estimates_invalid');
      const viewEstimates = ids.map((referenceId) => {
        const matches = raw.filter((v) => object(v) && v.referenceId === referenceId);
        const parsed = viewEstimateSchema.safeParse(matches.length === 1 ? matches[0] : null);
        if (parsed.success && parsed.data.reason) return parsed.data;
        repairs.push(`view_estimate_${matches.length ? 'invalid' : 'missing'}:${referenceId}`);
        return { referenceId, view: 'none' as const, confidence: 0, reason: '' };
      });
      input = { ...input, viewEstimates };
    }
    // Empty reasons are allowed only on repaired estimates (the warning explains why).
    const parsed = (forConfirmation ? reviewPlanSchema : structurePlanSchema).safeParse(input);
    return parsed.success
      ? {
          ok: true,
          plan: parsed.data,
          repairs: [...new Set(repairs)],
          boxRepairs: normalizePlanBoxes({
            ...parsed.data,
            components: parsed.data.components.map((component) => ({
              ...component,
              ...(legacyBoxes.has(component.id) ? { boundingBox: legacyBoxes.get(component.id)! } : {}),
            })),
          }).boxRepairs,
        }
      : { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  } catch {
    return { ok: false, issues: [{ path: '', message: 'Expected a complete JSON structure plan.' }] };
  }
}
