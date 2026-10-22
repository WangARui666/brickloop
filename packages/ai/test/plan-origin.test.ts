import { expect, it } from 'vitest';
import { parseStructurePlan, structurePlanJsonSchema } from '../src/workflows/image-to-model/plan.js';
import { structurePlanPrompt } from '../src/workflows/image-to-model/prompts.js';

const component = {
  id: 'body',
  name: 'Body',
  size: { width: 4, depth: 6, height: 3 },
  colors: ['c:red'],
  partTypes: ['brick'],
  connections: [],
};
const parse = (extra: object) =>
  parseStructurePlan({ name: 'Model', components: [{ ...component, ...extra }], buildOrder: ['body'] });
it('asks the model for origin and size, omitting the redundant box and designer overrides', () => {
  const schema = JSON.stringify(structurePlanJsonSchema);
  expect(schema).toContain('"origin"');
  expect(schema).not.toContain('boundingBox');
  expect(schema).not.toContain('viewOverrides');
  expect(structurePlanPrompt).toContain('origin {x,y,z}');
});
it('derives all box axes, gives origin priority, and keeps the IPC structure unchanged', () => {
  const result = parse({
    origin: { x: -2, y: 1, z: 5 },
    boundingBox: { min: { x: 100, y: 100, z: 100 }, max: 'ignored' },
  });
  expect(result).toMatchObject({
    ok: true,
    repairs: [],
    boxRepairs: [],
    plan: {
      components: [
        {
          boundingBox: { min: { x: -2, y: 1, z: 5 }, max: { x: 2, y: 4, z: 11 } },
        },
      ],
    },
  });
  if (result.ok) expect(result.plan.components[0]).not.toHaveProperty('origin');
});
it.each([{ x: 99, y: -1, z: 0 }, 'invalid', null, undefined])('ignores legacy max %j and preserves min', (max) => {
  expect(parse({ boundingBox: { min: { x: -2, y: 1, z: 5 }, max } })).toMatchObject({
    ok: true,
    plan: { components: [{ boundingBox: { min: { x: -2, y: 1, z: 5 }, max: { x: 2, y: 4, z: 11 } } }] },
  });
});
it('keeps the legacy missing-box marker', () => {
  expect(parse({})).toMatchObject({ ok: true, repairs: ['legacy_bounding_box'] });
});
it.each([0, -1, undefined, null, 'invalid', Infinity])('rejects invalid width %s', (width) => {
  expect(parse({ origin: { x: 1, y: 2, z: 3 }, size: { ...component.size, width } }).ok).toBe(false);
});
it('rejects an invalid origin even if a valid legacy box is present', () => {
  expect(
    parse({ origin: { x: 'bad', y: 1, z: 2 }, boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 6 } } })
      .ok,
  ).toBe(false);
});
