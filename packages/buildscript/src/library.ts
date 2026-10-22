import { cottage } from '../examples/cottage.js';
import { onionTower } from '../examples/onion-tower.js';
import { trees } from '../examples/trees.js';
import { car } from '../examples/car.js';
import { island } from '../examples/island.js';
import { fencePath } from '../examples/fence-path.js';
import buildings from '../guides/buildings.js';
import vehicles from '../guides/vehicles.js';
import plants from '../guides/plants.js';
import terrain from '../guides/terrain.js';
import figuresAndProps from '../guides/figures-and-props.js';
import type { BuildExample } from '../examples/types.js';

const examples = [cottage, onionTower, trees, car, island, fencePath];
const guides = { buildings, vehicles, plants, terrain, 'figures-and-props': figuresAndProps };
export type GuideCategory = keyof typeof guides;
export function listExamples(): Omit<BuildExample, 'code'>[] {
  return examples.map((e) => ({
    id: e.id,
    name: e.name,
    useCases: e.useCases,
    partCount: e.partCount,
    parameters: e.parameters.map((p) => ({ ...p })),
  }));
}
export function getExample(id: string): BuildExample | undefined {
  const example = examples.find((e) => e.id === id);
  return example ? { ...example, parameters: example.parameters.map((p) => ({ ...p })) } : undefined;
}
export function getGuide(category: GuideCategory): string {
  return guides[category];
}
