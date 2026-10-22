import { createThumbnailRenderer } from '@brickloop/viewport';
import type { LibraryColor, LibraryPart } from '../../shared/library-api';
import { getMesh } from './mesh-client';

let renderer: ReturnType<typeof createThumbnailRenderer> | undefined;
let queue = Promise.resolve();
const images = new Map<string, string>();
let lastScroll = -Infinity;
export function markLibraryScroll(): void {
  lastScroll = performance.now();
}
async function waitForScrollIdle(active: () => boolean): Promise<boolean> {
  while (active() && performance.now() - lastScroll < 160)
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  return active();
}
export function thumbnail(
  part: LibraryPart,
  pack: string,
  colors: LibraryColor[],
  active: () => boolean,
  requestedColor?: LibraryColor,
): Promise<string | null> {
  const definition = colors.find((entry) => entry.ldrawCode === 71);
  if (!definition) return Promise.resolve(null);
  const color: LibraryColor = requestedColor ?? {
    ...definition,
    rgb: '#969696',
    edgeRgb: '#333333',
    alpha: 1,
    finish: 'solid',
  };
  const identity = JSON.stringify([requestedColor ?? 'neutral-71', pack, part.id, part.geometry.hash]);
  const image = images.get(identity);
  if (image) return Promise.resolve(image);
  const task = queue.then(async () => {
    if (!(await waitForScrollIdle(active))) return null;
    const existing = images.get(identity);
    if (existing) return existing;
    const cached = await window.brickloop.thumbGet(part.id, color.id, !!requestedColor);
    let png = cached.png;
    if (!png) {
      if (!(await waitForScrollIdle(active))) return null;
      const mesh = await getMesh(part.id, pack);
      if (!mesh.mesh.batches.length) return null;
      renderer ??= createThumbnailRenderer();
      const ready = await renderer;
      if (!(await waitForScrollIdle(active))) return null;
      png = ready.render(
        {
          partId: part.id,
          mesh: requestedColor
            ? mesh.mesh
            : {
                ...mesh.mesh,
                batches: mesh.mesh.batches.map((batch) => ({ ...batch, color: 'main' })),
                edges: mesh.mesh.edges.map((edge) => ({ ...edge, color: 'edge' })),
              },
          color,
        },
        colors,
      );
      await window.brickloop.thumbPut(cached.key, png);
    }
    images.set(identity, png);
    if (images.size > 512) images.delete(images.keys().next().value!);
    // Yield between thumbnails so scrolling and pointer input can paint.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return png;
  });
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
