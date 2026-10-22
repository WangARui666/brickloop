import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromLDraw, multiply, rotationAxisAngle, translation } from '@brickloop/core';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { buildCollider, CollisionWorld } from '../src/index.js';
import { createOverrideLoader } from '../src/node.js';
import type { Collider } from '../src/index.js';
import { instance } from './fixtures.js';

const libraryDir = path.resolve('library/ldraw');
describe.skipIf(!existsSync(path.join(libraryDir, 'parts/3001.dat')))(
  'official LDraw acceptance, automatic proxies only',
  () => {
    const proxies = new Map<string, Collider>();
    beforeAll(async () => {
      const resolver = createLibraryResolver({ libraryDir });
      for (const file of ['3001', '85861', '30374', '3673', '32316', '3705']) {
        const mesh = await buildPartMesh(`${file}.dat`, resolver);
        const collider = await buildCollider(`${file}.dat`, resolver, mesh);
        proxies.set(file, collider);
        console.log(
          `AUTO ${file}: shapes=${collider.shapes.length} cylinders=${collider.shapes.filter((s) => s.kind === 'cylinder').length} approximate=${collider.approximate} ${collider.diagnostics.join(',')}`,
        );
      }
    }, 60_000);
    it('COL-01 / COL-02: normal 3001 stack clears, half-stud offset penetrates', () => {
      const collider = proxies.get('3001')!;
      expect(collider.approximate).toBe(false);
      const world = new CollisionWorld({
        instances: [instance('upper', collider), instance('lower', collider, [0, 24, 0])],
      });
      expect(world.query(['upper']).status).toBe('none');
      world.set(instance('lower', collider, [10, 24, 0]));
      expect(world.query(['upper']).status).toBe('hit');
    });
    it('COL-03: 1x1 open round plate fits on a bar and offset into its wall collides', () => {
      expect(proxies.get('85861')!.approximate).toBe(false);
      const world = new CollisionWorld({
        instances: [instance('plate', proxies.get('85861')), instance('bar', proxies.get('30374'), [0, -40, 0])],
      });
      expect(world.query(['plate']).status).toBe('none');
      world.set(instance('bar', proxies.get('30374'), [5, -40, 0]));
      expect(world.query(['plate']).status).toBe('hit');
    });
    it('a pin fits through a Technic beam hole, with both instances rotated and mirrored', () => {
      const common = multiply(translation([35, 48, -27]), rotationAxisAngle([1, 2, 3], 29));
      // The centre collar sits at the beam surface, not in the middle of the hole.
      const pinMatrix = multiply(common, fromLDraw([0, -10, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1]));
      const world = new CollisionWorld({
        instances: [
          { path: ['beam'], collider: proxies.get('32316')!, transform: common },
          { path: ['pin'], collider: proxies.get('3673')!, transform: pinMatrix },
        ],
      });
      expect(world.query(['beam']).status).toBe('none');
    });
    it('recognizes cylindrical stud/bar/axle cores while preserving hollow structures', () => {
      for (const part of ['3001', '30374', '3705'])
        expect(proxies.get(part)!.shapes.some((s) => s.kind === 'cylinder')).toBe(true);
    });
    it('all three authored overrides load with priority and retain stacking and through-hole behavior', async () => {
      const resolver = createLibraryResolver({ libraryDir });
      const loadOverride = createOverrideLoader(path.resolve('library/colliders'));
      for (const [part, height] of [
        ['3001', 24],
        ['3020', 8],
      ] as const) {
        const mesh = await buildPartMesh(`${part}.dat`, resolver);
        const manual = await buildCollider(`${part}.dat`, resolver, mesh, { loadOverride });
        expect(manual.source).toBe('manual');
        const world = new CollisionWorld({ instances: [instance('a', manual), instance('b', manual, [0, height, 0])] });
        expect(world.query(['a']).status).toBe('none');
        world.set(instance('b', manual, [10, height, 0]));
        expect(world.query(['a']).status).toBe('hit');
      }
      const manual = await buildCollider('85861.dat', resolver, await buildPartMesh('85861.dat', resolver), {
        loadOverride,
      });
      expect(manual.source).toBe('manual');
      const world = new CollisionWorld({
        instances: [instance('plate', manual), instance('bar', proxies.get('30374'), [0, -40, 0])],
      });
      expect(world.query(['plate']).status).toBe('none');
      world.set(instance('bar', proxies.get('30374'), [5, -40, 0]));
      expect(world.query(['plate']).status).toBe('hit');
    });
  },
);
