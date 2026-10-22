import { describe, expect, it, vi } from 'vitest';
import { translation } from '@brickloop/core';
import { CollisionWorld } from '../src/index.js';
import { DynamicAabbTree } from '../src/tree.js';
import { overlaps } from '../src/math.js';
import * as math from '../src/math.js';
import type { Aabb } from '../src/index.js';
import { box, instance, proxy } from './fixtures.js';

describe('CollisionWorld', () => {
  it('reuses completed contacts and invalidates only pairs incident to replaced proxies', () => {
    const rows = [instance('a'), instance('b'), instance('c', proxy(), [50, 0, 0]), instance('d', proxy(), [50, 0, 0])];
    const world = new CollisionWorld({ instances: rows });
    const transform = vi.spyOn(math, 'transformBounds');
    try {
      const first = world.queryAll();
      const baseline = structuredClone(first);
      const queries = transform.mock.calls.length;
      expect(queries).toBeGreaterThan(0);
      transform.mockClear();
      // Consumers may annotate their result; they cannot change stored contacts.
      first.pairs[0]!.shapes[0]!.a = 100;
      expect(world.queryAll()).toEqual(baseline);
      expect(transform).not.toHaveBeenCalled();
      expect(world.queryAll([['a']]).pairs).toEqual([]);

      world.set(instance('b', proxy(), [1, 0, 0]));
      transform.mockClear();
      expect(world.queryAll().pairs).toHaveLength(2);
      expect(transform.mock.calls.length).toBeGreaterThan(0);
      expect(transform.mock.calls.length).toBeLessThan(queries);
      world.remove(['b']);
      expect(world.queryAll().pairs).toHaveLength(1);
      world.set(instance('b', proxy([box()], true)));
      expect(world.queryAll().reasons).toContain('approximate');
      // A preview at an existing path uses its supplied shapes.
      expect(world.query({ path: ['a'], shapes: [box([200, 0, 0])] }).status).toBe('none');
      expect(world.queryAll(undefined, { budgetMs: 0 }).reasons).toEqual(['budget']);
    } finally {
      transform.mockRestore();
    }
  });
  it('does not retain budget failures as completed contacts', () => {
    let time = 0;
    const world = new CollisionWorld({ instances: [instance('a'), instance('b')], now: () => time++ });
    expect(world.queryAll(undefined, { budgetMs: 3 }).reasons).toEqual(['budget']);
    expect(world.queryAll(undefined, { budgetMs: Infinity })).toMatchObject({ status: 'hit', reasons: [] });
    expect(world.queryAll(undefined, { budgetMs: 0 }).reasons).toEqual(['budget']);
  });
  it('incrementally moves, adds and removes leaf and submodel occurrences', () => {
    let rows = [instance('a'), instance('b', proxy(), [100, 0, 0])];
    const resolve = vi.fn((path: string[]) => rows.filter((row) => row.path[0] === path[0]));
    const world = new CollisionWorld({ instances: rows, resolve });
    expect(world.query(['a']).status).toBe('none');
    rows[1] = instance('b', proxy(), [1, 0, 0]);
    world.update([['b']]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(world.query(['a']).status).toBe('hit');
    rows = [rows[0]!];
    world.update([['b']]);
    expect(world.query(['a']).status).toBe('none');
    world.set({ ...instance('leaf'), path: ['parent', 'leaf'] });
    world.remove(['parent']);
    expect(world.size).toBe(1);
  });
  it('COL-04 does no traversal, clock or narrow work while disabled', () => {
    const now = vi.fn(() => 0),
      world = new CollisionWorld({ instances: [instance('a'), instance('b')], enabled: false, now });
    expect(world.query(['a'])).toMatchObject({ status: 'none', testedPairs: 0 });
    expect(world.queryAll()).toMatchObject({ status: 'none', testedPairs: 0 });
    expect(now).not.toHaveBeenCalled();
    expect(world.query(['a'], { enabled: true }).status).toBe('hit');
  });
  it('CON-04 missing proxies, empty proxies and approximate intersections remain unknown', () => {
    const world = new CollisionWorld({
      instances: [instance('a'), { path: ['missing'], transform: translation([0, 0, 0]) }],
    });
    expect(world.query(['a'])).toMatchObject({ status: 'unknown', reasons: ['missing-proxy'] });
    expect(world.query(['absent']).status).toBe('unknown');
    world.remove(['missing']);
    world.set(instance('approximate', proxy([box()], true)));
    expect(world.query(['a']).reasons).toContain('approximate');
    world.set(instance('approximate', proxy([box()], true), [100, 0, 0]));
    expect(world.query(['a']).status).toBe('none');
    world.set(instance('empty', proxy([])));
    expect(world.query(['empty']).status).toBe('unknown');
  });
  it('retains confirmed hits when a different pair is unknown', () => {
    const world = new CollisionWorld({
      instances: [instance('a'), instance('b'), instance('c', proxy([box()], true))],
    });
    const result = world.queryAll();
    expect(result.status).toBe('unknown');
    expect(result.pairs.filter((pair) => pair.status === 'hit')).toHaveLength(1);
    expect(result.pairs).toHaveLength(3);
  });
  it('budgets include broad phase and preserve every unfinished instance', () => {
    let time = 0;
    const world = new CollisionWorld({ instances: [instance('a'), instance('b'), instance('c')], now: () => time++ });
    expect(world.queryAll(undefined, { budgetMs: 0 })).toMatchObject({
      status: 'unknown',
      unknownPaths: [['a'], ['b'], ['c']],
      reasons: ['budget'],
    });
    expect(world.query(['a'], { budgetMs: 2 }).status).toBe('unknown');
  });
  it('preview excludes moved occurrences and does not mutate committed entries', () => {
    const world = new CollisionWorld({ instances: [instance('a'), instance('b', proxy(), [50, 0, 0])] });
    expect(world.query({ shapes: [box()], excludePaths: [['a']] }).status).toBe('none');
    expect(world.query({ shapes: [box([50, 0, 0])], path: ['a'] }).status).toBe('hit');
    expect(world.query(['a']).status).toBe('none');
    expect(world.queryAll([['a']]).pairs).toEqual([]);
  });
});

it('dynamic tree agrees with brute force through rotations, deletion and reinsertion', () => {
  const tree = new DynamicAabbTree(),
    rows = new Map<string, Aabb>();
  for (let i = 0; i < 500; i++) {
    const x = (i * 17) % 197,
      y = (i * 13) % 101;
    const bounds: Aabb = [x, y, i % 3, x + 8, y + 9, (i % 3) + 2];
    tree.set(String(i), bounds);
    rows.set(String(i), bounds);
  }
  for (let i = 0; i < 500; i += 3) {
    tree.delete(String(i));
    rows.delete(String(i));
  }
  for (let i = 0; i < 100; i++) {
    const bounds: Aabb = [i, i, 0, i + 5, i + 5, 5];
    tree.set(String(i), bounds);
    rows.set(String(i), bounds);
  }
  for (let i = 0; i < 100; i += 7) {
    const query: Aabb = [i, i / 2, 0, i + 20, i / 2 + 15, 4];
    expect([...tree.search(query)].filter((key) => key !== undefined).sort()).toEqual(
      [...rows]
        .filter(([, bounds]) => overlaps(query, bounds))
        .map(([key]) => key)
        .sort(),
    );
  }
});
