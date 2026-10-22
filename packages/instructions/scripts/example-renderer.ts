// Small CPU-only example host. Authored cuboids illustrate integration; these
// images are not LDraw geometry and are not used by the desktop application.
import type { BrkDocument } from '@brickloop/core';
import type { InstructionHost } from '../src';
import { catalog, encodePng } from '../test/fixtures';

type Point = [number, number];
interface Brick {
  x: number;
  y: number;
  z: number;
  partId: string;
  colorId: string;
  fresh: boolean;
}
export function exampleRenderer(doc: BrkDocument): Pick<InstructionHost, 'renderStep' | 'renderPart'> {
  function render(bricks: Brick[], width: number, height: number) {
    const rgba = new Uint8Array(width * height * 4).fill(255);
    const project = (x: number, y: number, z: number): Point => [x - z, (x + z) * 0.45 + y];
    const faces: { points: Point[]; color: number[] }[] = [];
    bricks.sort((a, b) => a.x + a.z - a.y - (b.x + b.z - b.y));
    for (const brick of bricks) {
      const tall = brick.partId === 'ld:3020' ? 8 : 24;
      const corners = [
        [-40, 0, -20],
        [40, 0, -20],
        [40, 0, 20],
        [-40, 0, 20],
        [-40, -tall, -20],
        [40, -tall, -20],
        [40, -tall, 20],
        [-40, -tall, 20],
      ];
      const vertices = corners.map(([x, y, z]) => project(brick.x + x!, brick.y + y!, brick.z + z!));
      const hex = catalog.colors?.find((color) => color.id === brick.colorId)?.rgb ?? '#999999';
      const base = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
      // Previously placed bricks are muted; the current step retains its color.
      const tint = base.map((value) => (brick.fresh ? value : value * 0.5 + 120));
      for (const [indices, shade] of [
        [[1, 2, 6, 5], 0.72],
        [[2, 3, 7, 6], 0.88],
        [[4, 5, 6, 7], 1.12],
      ] as const)
        faces.push({
          points: indices.map((index) => vertices[index]!),
          color: tint.map((value) => Math.min(255, Math.round(value * shade))),
        });
      for (const x of [-30, -10, 10, 30])
        for (const z of [-10, 10]) {
          const points = Array.from({ length: 16 }, (_, i) => {
            const angle = (i * Math.PI) / 8;
            return project(brick.x + x + Math.cos(angle) * 6, brick.y - tall - 2, brick.z + z + Math.sin(angle) * 6);
          });
          faces.push({ points, color: tint.map((value) => Math.min(255, Math.round(value * 1.23))) });
        }
    }
    const points = faces.flatMap((face) => face.points);
    if (!points.length) return encodePng(width, height, rgba);
    const minX = Math.min(...points.map((p) => p[0])),
      maxX = Math.max(...points.map((p) => p[0]));
    const minY = Math.min(...points.map((p) => p[1])),
      maxY = Math.max(...points.map((p) => p[1]));
    const scale = Math.min((width * 0.96) / (maxX - minX), (height * 0.96) / (maxY - minY));
    for (const face of faces) {
      const polygon = face.points.map(([x, y]): Point => [
        (x - (minX + maxX) / 2) * scale + width / 2,
        (y - (minY + maxY) / 2) * scale + height / 2,
      ]);
      const startY = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p[1]))));
      const endY = Math.min(height - 1, Math.ceil(Math.max(...polygon.map((p) => p[1]))));
      for (let y = startY; y <= endY; y++) {
        const crossings: number[] = [];
        polygon.forEach((a, i) => {
          const b = polygon[(i + 1) % polygon.length]!;
          if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
            crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        });
        crossings.sort((a, b) => a - b);
        for (let i = 0; i < crossings.length; i += 2)
          for (let x = Math.max(0, Math.ceil(crossings[i]!)); x < Math.min(width, crossings[i + 1]!); x++)
            rgba.set([...face.color, 255], (y * width + x) * 4);
      }
    }
    return encodePng(width, height, rgba);
  }
  return {
    renderPart: ({ partId, colorId, sizePx }) =>
      render([{ x: 0, y: 0, z: 0, partId, colorId, fresh: true }], sizePx, sizePx),
    renderStep: ({ modelId, stepIndex, inheritedColorId, widthPx, heightPx }) => {
      const bricks: Brick[] = [];
      function visit(id: string, through: number, color: string, origin: [number, number, number], fresh?: boolean) {
        const model = doc.models[id]!;
        for (const [index, stepId] of model.stepIds.entries()) {
          if (index > through) break;
          for (const instanceId of model.steps[stepId]!.instanceIds) {
            const instance = model.instances[instanceId]!;
            const resolved = instance.colorId === 'inherit' ? color : instance.colorId;
            const position = origin.map((value, axis) => value + instance.transform[axis]!) as [number, number, number];
            const added = fresh ?? index === through;
            if (instance.ref.kind === 'model') visit(instance.ref.modelId, Infinity, resolved, position, added);
            else
              bricks.push({
                x: position[0],
                y: position[1],
                z: position[2],
                partId: instance.ref.partId,
                colorId: resolved,
                fresh: added,
              });
          }
        }
      }
      visit(modelId, stepIndex, inheritedColorId, [0, 0, 0]);
      return render(bricks, widthPx, heightPx);
    },
  };
}
