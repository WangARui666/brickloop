import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDocument, createModel, expandInstances, toLDraw } from '@brickloop/core';
import type { Instance, ModelDef } from '@brickloop/core';
import { planInstructions } from '@brickloop/instructions';
import { animationOrbit, planBuildAnimation, sampleAnimationPart, sampleBuildAnimation } from '../src';
const bounds = {
  'ld:3001': { min: [-40, -24, -20] as const, max: [40, 0, 20] as const },
  'ld:3020': { min: [-40, -8, -20] as const, max: [40, 0, 20] as const },
};
function fixture() {
  let n = 0;
  const id = () => String(++n).padStart(26, '0');
  const doc = createDocument({ title: 'Animation' }, { id, now: () => '2026-01-01T00:00:00.000Z' });
  const root = doc.models[doc.rootModelId]!;
  const add = (
    model: ModelDef,
    x: number,
    y: number,
    z = 0,
    ref: Instance['ref'] = { kind: 'part', partId: 'ld:3001' },
    step = model.stepIds[0]!,
  ) => {
    const key = id();
    model.instances[key] = {
      id: key,
      ref,
      colorId: 'ld:4',
      transform: [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: step,
      groupId: null,
    };
    model.steps[step]!.instanceIds.push(key);
    return key;
  };
  return { doc, root, id, add };
}
describe('build timeline', () => {
  it('sweeps by document-world x + z, then x and z, without applying viewport axis conversion', () => {
    const { doc, root, add } = fixture();
    const backRight = add(root, 0, 0, 0),
      frontRight = add(root, 0, 0, -40),
      backLeft = add(root, -40, 0, 0),
      frontLeft = add(root, -40, 0, -40);
    expect(planBuildAnimation(doc, root.id, { localBounds: bounds }).parts.map((p) => p.path[0])).toEqual([
      frontLeft,
      backLeft,
      frontRight,
      backRight,
    ]);
  });
  it('moves a lower connected support ahead of a same-bucket sweep predecessor', () => {
    const { doc, root, add } = fixture();
    const upper = add(root, 0, -3),
      lower = add(root, 80, 0);
    const timeline = planBuildAnimation(doc, root.id, {
      localBounds: { 'ld:3001': { min: [-40, -2, -20], max: [40, 0, 20] } },
      connections: [{ a: [upper], b: [lower] }],
    });
    expect(timeline.parts.map((p) => p.path[0])).toEqual([lower, upper]);
    expect(timeline.parts[0]!.start).toBeLessThan(timeline.parts[1]!.start);
  });
  it('ANI-01 orders three floors and a hanging plate; stable hash and immutable input', () => {
    const { doc, root, add } = fixture();
    const lower = [0, 80, 160, 240].map((x) => add(root, x, 0)),
      middle = [40, 120].map((x) => add(root, x, -24)),
      upper = add(root, 80, -48);
    const plate = add(root, 40, -16, 0, { kind: 'part', partId: 'ld:3020' });
    const original = JSON.stringify(doc);
    const opts = { localBounds: bounds, connections: [{ a: [middle[0]!], b: [plate] }] };
    const timeline = planBuildAnimation(doc, root.id, opts),
      order = timeline.parts.map((p) => p.path[0]);
    for (const p of lower) expect(order.indexOf(p)).toBeLessThan(order.indexOf(middle[0]));
    for (const p of middle) expect(order.indexOf(p)).toBeLessThan(order.indexOf(upper));
    expect(order.indexOf(plate)).toBeLessThan(order.indexOf(middle[0]));
    const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    expect(hash(timeline)).toBe(hash(planBuildAnimation(doc, root.id, opts)));
    expect(JSON.stringify(doc)).toBe(original);
  });
  it('ANI-02 consumes the same five instruction steps and expands only the first placement', () => {
    const { doc, root, add, id } = fixture();
    const a = createModel('A', 'submodel', id),
      b = createModel('B', 'submodel', id);
    doc.models[a.id] = a;
    doc.models[b.id] = b;
    const second = id();
    a.stepIds.push(second);
    a.steps[second] = { id: second, instanceIds: [] };
    add(a, 0, 0);
    add(a, 0, -24, 0, { kind: 'part', partId: 'ld:3001' }, second);
    add(b, 0, 0);
    add(root, 0, 0, 0, { kind: 'model', modelId: a.id });
    const next = id();
    root.stepIds.push(next);
    root.steps[next] = { id: next, instanceIds: [] };
    add(root, 160, 0, 0, { kind: 'model', modelId: b.id }, next);
    const repeated = add(root, 320, 0, 0, { kind: 'model', modelId: a.id }, next);
    const plan = planInstructions(doc),
      timeline = planBuildAnimation(doc, root.id, { order: 'steps', localBounds: bounds });
    expect(plan.steps).toHaveLength(5);
    expect(timeline.ticks[1]!.time - timeline.ticks[0]!.time).toBeCloseTo(1.2);
    const shortest = planBuildAnimation(doc, root.id, { order: 'steps', localBounds: bounds, durationSeconds: 5 });
    expect(shortest.ticks[1]!.time - shortest.ticks[0]!.time).toBeGreaterThanOrEqual(0.6 - 1e-10);
    expect(timeline.ticks.map((t) => t.number)).toEqual(plan.steps.map((s) => s.number));
    const last = timeline.ticks.length - 1;
    expect(timeline.parts.filter((p) => p.path[0] === repeated).map((p) => p.group)).toEqual([last, last]);
    expect(new Set(timeline.parts.map((p) => p.path.join('/'))).size).toBe(expandInstances(doc).length);
    expect(timeline.parts.filter((p) => p.group === 0)).toHaveLength(1);
  });
  it('ANI-03 random access, final transforms, fade-in, bounded rebound and highlights', () => {
    const { doc, root, add } = fixture();
    for (let i = 0; i < 30; i++) add(root, (i % 5) * 80, -Math.floor(i / 5) * 24);
    for (const motion of ['drop', 'fly', 'appear'] as const) {
      const timeline = planBuildAnimation(doc, root.id, { localBounds: bounds, motion });
      expect(sampleBuildAnimation(timeline, 0)).toEqual([]);
      const middle = sampleBuildAnimation(timeline, 4);
      sampleBuildAnimation(timeline, timeline.totalDuration);
      expect(sampleBuildAnimation(timeline, 4)).toEqual(middle);
      const complete = sampleBuildAnimation(timeline, timeline.totalDuration + 100);
      const transforms = new Map(expandInstances(doc).map((p) => [p.path.join('/'), toLDraw(p.worldMatrix)]));
      for (const p of complete) {
        expect(p.transform).toEqual(transforms.get(p.path.join('/')));
        expect(p.offset.map((v) => v || 0)).toEqual([0, 0, 0]);
        expect(p.opacity).toBe(1);
        expect(p.highlight).toBe(0);
      }
      const p = timeline.parts[0]!;
      expect(sampleAnimationPart(p, p.start + 0.45 * 0.15)?.opacity).toBeCloseTo(0.5);
      expect(sampleAnimationPart(p, p.start + 0.45 * 0.3)?.opacity).toBeCloseTo(1);
      expect(sampleAnimationPart(p, p.start + 0.45 + 0.01)?.highlight).toBeGreaterThan(0.8);
      if (motion === 'drop')
        expect(Math.abs(sampleAnimationPart(p, p.start + 0.45 * 0.9)!.offset[1])).toBeLessThanOrEqual(2.4);
      expect(animationOrbit(timeline, timeline.buildDuration)).toBeCloseTo(Math.PI / 2);
      expect(animationOrbit(timeline, timeline.totalDuration)).toBeCloseTo(Math.PI * 2.5);
    }
  });
  it('resolves nested rotation, inherited colors and real local bounds before layering', () => {
    const { doc, root, add, id } = fixture(),
      child = createModel('rotated', 'submodel', id);
    doc.models[child.id] = child;
    const p = add(child, 0, 0);
    child.instances[p]!.colorId = 'inherit';
    const placed = add(root, 20, -48, 0, { kind: 'model', modelId: child.id });
    root.instances[placed]!.transform = [20, -48, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1];
    const timeline = planBuildAnimation(doc, root.id, { localBounds: bounds });
    expect(timeline.parts[0]!.colorId).toBe('ld:4');
    expect(timeline.bounds).toEqual({ min: [20, -88, -20], max: [44, -8, 20] });
  });
  it('defaults, target clamp, fixed time, empty models and coarse-step warning', () => {
    const { doc, root, add } = fixture();
    expect(planBuildAnimation(doc, root.id, { localBounds: bounds }).parts).toEqual([]);
    add(root, 0, 0);
    expect(planBuildAnimation(doc, root.id, { localBounds: bounds }).totalDuration).toBe(11);
    for (const [duration, expected] of [
      [1, 5],
      [150, 120],
      [30, 30],
    ] as const)
      expect(planBuildAnimation(doc, root.id, { localBounds: bounds, durationSeconds: duration }).totalDuration).toBe(
        expected,
      );
    expect(
      planBuildAnimation(doc, root.id, { localBounds: bounds, order: 'steps', secondsPerGroup: 0.1 }).buildDuration,
    ).toBe(0.6);
    expect(planBuildAnimation(doc, root.id, { localBounds: bounds, order: 'steps' }).coarseSteps).toBe(true);
    for (let i = 1; i < 2000; i++) add(root, (i % 100) * 80, -Math.floor(i / 100) * 24);
    const plan = planBuildAnimation(doc, root.id, { localBounds: bounds });
    expect(plan.totalDuration).toBe(48);
    expect(new Set(plan.parts.map((p) => p.start)).size).toBeLessThan(2000);
    expect(Math.max(...plan.parts.map((p) => p.start + p.duration + p.highlightDuration))).toBeLessThan(
      plan.buildDuration,
    );
    expect(() => planBuildAnimation(doc, root.id, { localBounds: {} })).toThrow('Missing animation bounds');
    expect(() => planBuildAnimation(doc, root.id, { localBounds: bounds, durationSeconds: NaN })).toThrow();
  });
});
