import { describe, expect, it } from 'vitest';
import { createMcpTools } from '../src/tools.js';

/** Finds draft-7 tuple arrays (`items: [...]`), which some MCP clients reject together with the tool. */
function tuplePaths(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([key, child]) => [
    ...(key === 'items' && Array.isArray(child) ? [`${path}.items`] : []),
    ...(key === 'prefixItems' ? [`${path}.prefixItems`] : []),
    ...tuplePaths(child, `${path}.${key}`),
  ]);
}

describe('MCP tool schemas', () => {
  it('use only array schemas that every MCP client accepts', () => {
    const offenders = createMcpTools().flatMap((tool) => tuplePaths(tool.parameters).map((p) => `${tool.name} ${p}`));
    expect(offenders).toEqual([]);
  });
  it('keep the matrix pose at exactly 12 numbers', () => {
    const place = createMcpTools().find((tool) => tool.name === 'place_part')!;
    const pose = { kind: 'matrix', matrix_ldu: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] };
    expect(place.schema.safeParse({ partId: 'ld:3001', colorId: 'c:bright-red', pose }).success).toBe(true);
    const short = { ...pose, matrix_ldu: pose.matrix_ldu.slice(0, 11) };
    expect(place.schema.safeParse({ partId: 'ld:3001', colorId: 'c:bright-red', pose: short }).success).toBe(false);
  });
});
