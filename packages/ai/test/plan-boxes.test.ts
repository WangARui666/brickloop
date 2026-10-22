import { expect, it } from 'vitest';
import {
  normalizePlanBoxes,
  normalizePlanColors,
  structurePlanSchema,
  type StructurePlan,
} from '../src/workflows/image-to-model/index.js';

const plan = (): StructurePlan => ({
  name: 'House',
  buildOrder: ['body'],
  components: [
    {
      id: 'body',
      name: 'Body',
      size: { width: 4, depth: 6, height: 3 },
      colors: ['red'],
      partTypes: ['brick'],
      connections: [],
      boundingBox: { min: { x: -2, y: 1, z: 5 }, max: { x: 9, y: 10, z: 11 } },
    },
  ],
});
it('repairs all axes from sizes, preserves min and leaves the input intact', () => {
  const input = plan(),
    before = structuredClone(input);
  const result = normalizePlanBoxes(input);
  expect(result.boxRepairs).toEqual([
    {
      componentId: 'body',
      from: input.components[0]!.boundingBox,
      to: { min: { x: -2, y: 1, z: 5 }, max: { x: 2, y: 4, z: 11 } },
    },
  ]);
  expect(result.plan.components[0]!.boundingBox).toEqual(result.boxRepairs[0]!.to);
  expect(input).toEqual(before);
  expect(structurePlanSchema.safeParse(input).success).toBe(false);
  expect(structurePlanSchema.safeParse(result.plan).success).toBe(true);
  expect(normalizePlanBoxes(result.plan).boxRepairs).toEqual([]);
  const near = result.plan;
  near.components[0]!.boundingBox!.max.x += 1e-7;
  expect(normalizePlanBoxes(near).plan.components[0]).toBe(near.components[0]);
});
it.each([0, -1, undefined, '4', NaN, Infinity])('does not repair invalid size %s', (value) => {
  const input = plan();
  input.components[0]!.size.width = value as number;
  const result = normalizePlanBoxes(input);
  expect(result.plan).toEqual(input);
  expect(result.boxRepairs).toEqual([]);
  expect(structurePlanSchema.safeParse(result.plan).success).toBe(false);
});
it.each(['min', 'max'] as const)('does not repair missing or invalid %s coordinates', (key) => {
  for (const value of [undefined, '1', Infinity, NaN]) {
    const input = plan();
    input.components[0]!.boundingBox![key].x = value as number;
    expect(normalizePlanBoxes(input).boxRepairs).toEqual([]);
  }
});
it('retains color and box details when both require repair', () => {
  const colored = normalizePlanColors(plan(), [{ id: 'c:red', legoName: 'Red', rgb: '#ff0000' }]);
  const boxed = normalizePlanBoxes(colored.plan);
  expect(colored.colorRepairs).toEqual([{ componentId: 'body', from: 'red', to: 'c:red' }]);
  expect(boxed.boxRepairs).toHaveLength(1);
  expect(boxed.plan.components[0]!.colors).toEqual(['c:red']);
});
