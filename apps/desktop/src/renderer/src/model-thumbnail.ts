import { expandInstances, toLDraw } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import { renderOffscreen } from '@brickloop/viewport';
import type { PartInstance } from '@brickloop/viewport';
import type { Transform } from '@brickloop/ldraw';
import type { LibraryPart } from '../../shared/library-api';
import { getMesh } from './mesh-client';
import { useLibraryStore } from './library-store';

let queue = Promise.resolve();
export const macroThumbnailMetrics = { rendered: 0, cacheHits: 0 };
const pending = new Map<string, Promise<string>>();

export async function modelParts(doc: BrkDocument, neutral = false): Promise<PartInstance[]> {
  const { allColors: colors, status } = useLibraryStore.getState();
  const grey = colors.find((color) => color.ldrawCode === 71);
  if (!grey) throw new Error('Missing palette');
  return Promise.all(
    expandInstances(doc).map(async (row) => {
      const { mesh } = await getMesh(row.partId as LibraryPart['id'], status?.pack?.id ?? 'demo');
      if (!mesh.batches.length) throw new Error('Missing geometry');
      return {
        partId: row.partId as LibraryPart['id'],
        mesh: neutral
          ? {
              ...mesh,
              batches: mesh.batches.map((batch) => ({ ...batch, color: 'main' as const })),
              edges: mesh.edges.map((edge) => ({ ...edge, color: 'edge' as const })),
            }
          : mesh,
        color: neutral
          ? { ...grey, rgb: '#969696', edgeRgb: '#333333', alpha: 1, finish: 'solid' as const }
          : (colors.find((color) => color.id === row.colorId) ?? grey),
        transform: toLDraw(row.worldMatrix) as Transform,
      };
    }),
  );
}

export function renderModelThumbnail(doc: BrkDocument, neutral = false, active = () => true): Promise<string> {
  const task = queue.then(async () => {
    if (!active()) return '';
    const parts = await modelParts(doc, neutral);
    if (!active()) return '';
    const images = await renderOffscreen(parts, useLibraryStore.getState().allColors, {
      views: ['iso'],
      width: 128,
      height: 128,
      transparent: true,
    });
    return images[0]!.png;
  });
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export function macroThumbnail(id: string, hash: string): Promise<string> {
  const existing = pending.get(hash);
  if (existing) return existing;
  const task = (async () => {
    const cached = await window.brickloop.macroThumbGet(id);
    if (cached.png) {
      macroThumbnailMetrics.cacheHits++;
      return cached.png;
    }
    const { pkg } = await window.brickloop.macroRead(id);
    const png = await renderModelThumbnail(pkg.document);
    macroThumbnailMetrics.rendered++;
    await window.brickloop.macroThumbPut(cached.key, png);
    return png;
  })();
  pending.set(hash, task);
  void task.catch(() => pending.delete(hash));
  return task;
}
