import { it, expect } from 'vitest';
import { getExample, listExamples, getGuide, renderLayers, standardPackingParts } from '../src/index.js';
import { build, catalog } from './fixtures.js';

for (const example of listExamples())
  it(`example ${example.id} executes with documented metadata`, async () => {
    const data = getExample(example.id)!;
    const r = await build(data.code);
    expect(r.stats.parts).toBeGreaterThan(0);
    expect(data.partCount).toBe(r.stats.parts);
    expect(data.parameters.length).toBeGreaterThan(0);
    expect(r.stats.quality.floatingComponents).toBe(0);
    expect(r.warnings.filter((w) => w.code === 'FLOATING_COMPONENT')).toEqual([]);
  });
it('five original English guides stay below 600 words and cover techniques and errors', () => {
  for (const category of ['buildings', 'vehicles', 'plants', 'terrain', 'figures-and-props'] as const) {
    const text = getGuide(category);
    expect(text.split(/\s+/).length).toBeLessThan(600);
    expect(text).toMatch(/300\d|302\d/);
    expect(text.length).toBeGreaterThan(500);
  }
});
it('layer maps have coordinates, colors, gaps, rotation and inclusive vertical bounds', async () => {
  const r = await build(`box(-2,1,0,2,4,3,'red');cell(2,0,2,'blue')`);
  const sizes = Object.fromEntries(standardPackingParts.map((p) => [p.id, p.size!]));
  const text = renderLayers(r.instances, sizes, 0, 3, catalog.colors);
  expect(text).toContain('A 1 Blue');
  expect(text).toContain('B 4 Red');
  expect(text).toContain('x → -2');
  expect(text).toContain('BB..A');
  expect(text).toContain('level 3');
  expect(text).toContain('.....');
});
it('large maps reduce 2×2 repeatedly to stay <=64×64', async () => {
  const r = await build(`box(0,0,0,130,2,1,'red')`),
    sizes = Object.fromEntries(standardPackingParts.map((p) => [p.id, p.size!]));
  const text = renderLayers(r.instances, sizes, 0, 0, catalog.colors);
  expect(text).toContain('Merged 4×4');
  expect(text).toContain('column step 4');
  const row = text.split('\n').find((s) => s.includes('|'))!;
  expect(row.split('|')[1]!.length).toBeLessThanOrEqual(64);
});
