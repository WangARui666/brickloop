import { AiCheckEngine } from './ai-check-engine';
import type { AssemblySnapshot } from './assembly-engine';
import type { CheckOptions } from '@brickloop/collide';
import { expandInstances, pathStartsWith, transformPoint } from '@brickloop/core';
const checks = new AiCheckEngine();
self.onmessage = (
  event: MessageEvent<{ id: number; snapshot: AssemblySnapshot; options: CheckOptions; summary: boolean }>,
) => {
  try {
    const engine = checks.sync(event.data.snapshot);
    const issues = engine.checkIssues(event.data.options);
    const summary: Record<string, unknown> = {};
    if (event.data.summary) {
      const doc = event.data.snapshot.doc,
        scope = event.data.options.activeModelPath ?? [];
      const rows = expandInstances(doc).filter((row) => pathStartsWith(row.path, scope));
      const colors: Record<string, number> = {},
        min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const row of rows) {
        colors[row.colorId] = (colors[row.colorId] ?? 0) + 1;
        const b = engine.parts.get(row.partId)!.collider.bounds;
        for (const x of [b[0], b[3]])
          for (const y of [b[1], b[4]])
            for (const z of [b[2], b[5]]) {
              const world = transformPoint(row.worldMatrix, [x, y, z]),
                p = [world[0] / 20, world[2] / 20, -world[1] / 8];
              for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis]!, p[axis]!);
                max[axis] = Math.max(max[axis]!, p[axis]!);
              }
            }
      }
      Object.assign(summary, {
        documentId: doc.documentId,
        partCount: rows.length,
        colors,
        colorCount: Object.keys(colors).length,
        connectedComponents: engine.graph
          .components()
          .filter((component) => component.some((path) => pathStartsWith(path, scope))).length,
        bounds: rows.length
          ? { min: { x: min[0], z: min[1], level: min[2] }, max: { x: max[0], z: max[1], level: max[2] } }
          : null,
        models: Object.values(doc.models).map((m) => ({
          id: m.id,
          name: m.name,
          count: Object.keys(m.instances).length,
          children: Object.values(m.instances)
            .filter((v) => v.ref.kind === 'model')
            .map((v) => ({ instanceId: v.id, ref: v.ref })),
        })),
      });
    }
    self.postMessage({ id: event.data.id, result: { issues, summary } });
  } catch {
    self.postMessage({ id: event.data.id, error: 'CHECK_FAILED' });
  }
};
