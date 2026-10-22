import { expect, it } from 'vitest';
import { translation } from '@brickloop/core';
import brickJson from '../../../library/connectors/3001.json';
import { ConnectionGraph, parseConnectorFile, solveSnap } from '../src';
import { instance } from './fixtures';

it('records 1,000-instance solveSnap and 10-instance incremental update', () => {
  const brick = parseConnectorFile(brickJson).file!.connectors;
  const scene = Array.from({ length: 1000 }, (_, i) =>
    instance(`part-${String(i).padStart(4, '0')}`, brick, [(i % 40) * 100, 0, Math.floor(i / 40) * 60]),
  );
  const graph = new ConnectionGraph({ instances: () => scene });
  const selection = [instance('drag', brick, [2, -23, 0])];
  const measure = (): number => {
    const start = performance.now();
    const result = solveSnap({ selection, index: graph.index });
    const elapsed = performance.now() - start;
    expect(result.chosen).not.toBeNull();
    return elapsed;
  };
  const cold = measure();
  for (let i = 0; i < 5; i++) measure();
  const times = Array.from({ length: 30 }, measure).sort((a, b) => a - b);
  const untouched = graph.index.entriesOf(scene[900]!.path);
  for (let i = 0; i < 10; i++) scene[i] = { ...scene[i]!, worldMatrix: translation([i * 100, 2, 0]) };
  const start = performance.now();
  const update = graph.update(scene.slice(0, 10).map((i) => i.path));
  const elapsed = performance.now() - start;
  expect(update.updatedInstances).toBe(10);
  expect(graph.index.entriesOf(scene[900]!.path)).toBe(untouched);
  console.log(
    `CONNECT PERF n=1000, connectors/part=${brick.reduce((n, c) => n + (c.grid ? c.grid.rows * c.grid.cols : 1), 0)}; solve cold=${cold.toFixed(3)} ms, warm median=${times[15]!.toFixed(3)} ms, p95=${times[28]!.toFixed(3)} ms, target<=8 ms; update 10=${elapsed.toFixed(3)} ms`,
  );
}, 120000);
