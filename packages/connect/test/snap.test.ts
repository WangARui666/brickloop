import { describe, expect, it } from 'vitest';
import { identity, multiply, rotationAxisAngle, translation, transformPoint } from '@brickloop/core';
import { ConnectorIndex, DEFAULT_RULES, insertionRange, solveSnap, snapSelectionToGrid } from '../src';
import type { Connector, SnapCandidate, SnapRequest } from '../src';
import { bar, connector, hole, instance } from './fixtures';

const run = (source: Connector, target: Connector, options: Partial<SnapRequest> = {}) =>
  solveSnap({
    selection: [instance('source', [source])],
    index: new ConnectorIndex([instance('target', [target])]),
    ...options,
  });
describe('snap', () => {
  it('CON-01 distant balls never enter the candidate set, regardless of signed projection', () => {
    for (const p of [
      [100, 0, 0],
      [0, -100, 0],
      [0, 0, 100],
    ] as const) {
      const result = solveSnap({
        selection: [instance('source', [connector('ball', { size: 's' })])],
        index: new ConnectorIndex([instance('target', [connector('ball.socket', { size: 's' })], p)]),
      });
      expect(result.chosen).toBeNull();
      expect(result.candidates).toEqual([]);
    }
  });
  it('CON-09 ball snapping retains orientation and rotation about its center keeps the connection', () => {
    const ball = connector('ball', { size: 's', frame: { origin: [5, 0, 0], axis: [0, -1, 0], ref: [1, 0, 0] } });
    const socket = connector('ball.socket', { size: 's' });
    const selection = [{ ...instance('s', [ball]), worldMatrix: rotationAxisAngle([1, 0, 0], 30) }];
    const result = run(ball, socket, { selection });
    expect(result.chosen?.score.rotation).toBe(0);
    const matrix = new Float64Array(result.chosen!.transform);
    expect(transformPoint(matrix, ball.frame.origin)).toEqual([0, 0, 0]);
    const tilted = multiply(rotationAxisAngle([0, 0, 1], 30), matrix);
    expect(transformPoint(tilted, ball.frame.origin).map((n) => Math.abs(n))).toEqual([0, 0, 0]);
    expect(
      run(ball, socket, { selection: [{ ...selection[0]!, worldMatrix: tilted }] }).chosen?.score.displacement,
    ).toBeCloseTo(0);
    expect(
      run(ball, socket, { selection: [{ ...selection[0]!, connectors: [{ ...ball, limits: [0, 10] }] }] }).rejected[0]
        ?.detail,
    ).toBe('limits');
  });
  it('CON-02 valid and invalid neighboring candidates keep rejection reasons; CON-03/04 collision remains unknown', () => {
    const result = solveSnap({
      selection: [instance('source', [connector('stud')], [0, 2, 0])],
      index: new ConnectorIndex([
        instance('legal', [connector('antistud')]),
        instance('invalid', [connector('ball.socket', { size: 's' })]),
      ]),
    });
    expect(result.chosen?.target.path).toEqual(['legal']);
    expect(result.chosen?.collision).toBe('unknown');
    expect(result.rejected).toContainEqual(
      expect.objectContaining({
        target: { path: ['invalid'], connectorId: 'ball.socket' },
        reason: 'incompatible',
        detail: 'type',
      }),
    );
  });
  it('uses separate screen, world and angle gates', () => {
    const a = connector('stud'),
      b = connector('antistud');
    expect(
      run(a, b, { pointer: { ray: { origin: [50, 0, 100], direction: [0, 0, -1] }, worldUnitsPerPixel: 1 } })
        .rejected[0]?.detail,
    ).toBe('screen');
    const distant = solveSnap({
      selection: [instance('source', [a], [15, 0, 0])],
      index: new ConnectorIndex([instance('target', [b])]),
    });
    expect(distant.rejected[0]?.detail).toBe('world');
    expect(run({ ...a, frame: { ...a.frame, axis: [1, 0, 0], ref: [0, 0, 1] } }, b).rejected[0]?.reason).toBe('angle');
    const projected = run(a, b, { pointer: { screen: [50, 50], viewProjection: identity(), viewport: [100, 100] } });
    expect(projected.chosen).not.toBeNull();
    expect(
      run(a, b, { pointer: { screen: [99, 99], viewProjection: identity(), viewport: [100, 100] } }).chosen,
    ).toBeNull();
  });
  it('CON-11 each configured pair solves and its invalid pair is rejected', () => {
    for (const rule of DEFAULT_RULES.pairs) {
      const a = connector(rule.a, { length: 10, diameter: 8, studDepth: 10, size: 's', tag: 'pair', role: 'a' });
      const b = connector(rule.b, {
        length: 20,
        diameter: 8,
        studDepth: 10,
        size: 's',
        tag: 'pair',
        role: 'b',
        frame: { origin: [0, 0, 0], axis: [0, 1, 0], ref: [1, 0, 0] },
      });
      expect(run(a, b).chosen, `${rule.a}/${rule.b}`).not.toBeNull();
      expect(run(a, { ...b, type: 'slider' }).rejected[0]?.reason).toBe('incompatible');
    }
  });
  it('quantizes cross axles, leaves axles in pin holes freely rotating, enforces hinge limits', () => {
    const a = connector('axle', { length: 10, rotation: 90 });
    const matrix = rotationAxisAngle([0, 1, 0], 25);
    const selection = [{ ...instance('source', [a]), worldMatrix: matrix }];
    const locked = run(a, connector('axle.hole', { length: 20, rotation: 90 }), { selection });
    expect(locked.chosen?.score.rotation).toBeCloseTo(25);
    expect(run(a, connector('pin.hole', { length: 20 }), { selection }).chosen?.score.rotation).toBeCloseTo(0);
    const hinge = connector('hinge.click', { role: 'a', size: 's', rotation: 15, limits: [30, 60] });
    const mate = { ...hinge, role: 'b' as const, frame: { ...hinge.frame, axis: [0, 1, 0] as const } };
    expect(run(hinge, mate).chosen?.score.rotation).toBeCloseTo(30);
    expect(run(hinge, { ...mate, limits: [-60, -30] }).rejected[0]?.detail).toBe('limits');
  });
  it('CON-08 replay is deterministic, hysteresis resists jitter, tie order ignores insertion order', () => {
    const targets = [
      instance('a', [connector('antistud')], [-5, 0, 0]),
      instance('b', [connector('antistud')], [5, 0, 0]),
    ];
    const trajectory = [-5, -1, 0, 0.1, -0.1, 0.1, 1, 2, 3, 4, 5];
    const replay = (reverse: boolean): string[] => {
      const index = new ConnectorIndex(reverse ? [...targets].reverse() : targets);
      let previous: SnapCandidate | null = null;
      return trajectory.map((x) => {
        const result = solveSnap({
          selection: [instance('s', [connector('stud')], [x, 1, 0])],
          index,
          previous,
          pointer: { ray: { origin: [x, 0, 100], direction: [0, 0, -1] }, worldUnitsPerPixel: 1 },
        });
        previous = result.chosen;
        return previous!.target.path[0]!;
      });
    };
    const choices = replay(false);
    expect(replay(true)).toEqual(choices);
    expect(replay(false)).toEqual(choices);
    expect(choices.slice(0, 6)).toEqual(Array(6).fill('a'));
    expect(choices.at(-1)).toBe('b');
    expect(choices.filter((c, i) => i > 0 && c !== choices[i - 1])).toHaveLength(1);
  });
  it('permits 2×4/2×2 partial overlap and rewards more mating cells', () => {
    const a = connector('stud', {
      frame: { origin: [-30, 0, -10], axis: [0, -1, 0], ref: [1, 0, 0] },
      grid: { rows: 2, cols: 4, pitch: 20, mask: null },
    });
    const b = connector('antistud', {
      frame: { origin: [-10, 0, -10], axis: [0, 1, 0], ref: [1, 0, 0] },
      grid: { rows: 2, cols: 2, pitch: 20, mask: null },
    });
    const result = run(a, b, { selection: [instance('s', [a], [20, 1, 0])] });
    expect(result.chosen?.score.overlap).toBe(4);
    expect(result.chosen?.constraint.ok).toBe(true);
  });
  it('moves a multiselection rigidly from its primary connector; grid mode returns group placement', () => {
    const selection = [instance('a', [connector('stud')], [2, 3, 0]), instance('b', [connector('stud')], [42, 3, 0])];
    const result = solveSnap({ selection, index: new ConnectorIndex([instance('target', [connector('antistud')])]) });
    const poses = result.chosen!.transforms;
    expect(poses[1]!.transform[12]! - poses[0]!.transform[12]!).toBeCloseTo(40);
    expect(solveSnap({ selection, index: new ConnectorIndex(), enabled: false }).gridTransforms).toEqual(
      snapSelectionToGrid(selection),
    );
  });
  it('CON-07 equivalent solving under arbitrary parent rotation and translation', () => {
    const s = instance('s', [connector('stud')], [1, 2, 0]),
      t = instance('t', [connector('antistud')]);
    const parent = multiply(translation([100, 55, -20]), rotationAxisAngle([1, 2, 3], 67));
    const flat = solveSnap({ selection: [s], index: new ConnectorIndex([t]) }).chosen!;
    const nested = solveSnap({
      selection: [{ ...s, worldMatrix: multiply(parent, s.worldMatrix) }],
      index: new ConnectorIndex([{ ...t, worldMatrix: multiply(parent, t.worldMatrix) }]),
    }).chosen!;
    const expected = multiply(parent, new Float64Array(flat.transform));
    nested.transform.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 8));
  });
});

describe('CON-12 linear constraints', () => {
  it('a bar longer than a two-closed-end cavity is impossible; one closed end clamps depth', () => {
    const two = { ...hole(), length: 6, ends: { start: 'closed' as const, end: 'closed' as const } };
    expect(run(bar(), two).rejected[0]?.reason).toBe('blocked_end');
    const one = { ...hole(), length: 6, ends: { start: 'open' as const, end: 'closed' as const } };
    const result = run(bar(), one);
    expect(result.chosen).not.toBeNull();
    expect(result.chosen!.transform[13]).toBeCloseTo(4);
    const fitted = { ...bar(), length: 4 };
    expect(run(fitted, two).chosen).not.toBeNull();
  });
  it('slides to 10 LDU, endpoints and stops, with continuous modifier; works when dragging the hole', () => {
    const a = bar(),
      b = { ...hole(), length: 60 };
    const result = run(a, b, { selection: [instance('s', [a], [0, -13, 0])] });
    expect(result.chosen?.transform[13]).toBeCloseTo(-10);
    const continuous = run(a, b, { selection: [instance('s', [a], [0, -13, 0])], continuous: true });
    expect(continuous.chosen?.transform[13]).toBeCloseTo(-13);
    const stop = { ...b, stops: [16] };
    expect(insertionRange(a, stop)?.min).toBe(-6);
    expect(run(a, stop, { selection: [instance('s', [a], [0, -13, 0])] }).chosen?.transform[13]).toBeCloseTo(-6);
    expect(run(b, a, { selection: [instance('s', [b], [0, 13, 0])] }).chosen?.transform[13]).toBeCloseTo(10);
  });
  it('finds a long connector midsection in the spatial index, not only its endpoints', () => {
    const b = { ...hole(), length: 200 };
    const index = new ConnectorIndex([instance('h', [b])]);
    expect(index.query([0, -100, 0], 0.1)).toHaveLength(1);
    const result = solveSnap({
      selection: [instance('s', [bar()], [2, -100, 0])],
      index,
      pointer: { ray: { origin: [0, -100, 100], direction: [0, 0, -1] }, worldUnitsPerPixel: 1 },
    });
    expect(result.chosen).not.toBeNull();
    expect(transformPoint(new Float64Array(result.chosen!.transform), [0, 0, 0])).toEqual([0, -100, 0]);
  });
});
