import { checkDimensions, checkImage, deltaE2000, rgbToLab, type RgbaImage, type RGB } from '@brickloop/mosaic';
export * from './reference-image.js';
export * from './image-encoding.js';

export interface ForegroundOptions {
  background?: RGB;
  threshold?: number;
  alphaThreshold?: number;
  minComponentPixels?: number;
  minComponentRatio?: number;
}
export interface ForegroundMask {
  width: number;
  height: number;
  data: Uint8Array;
  background: RGB;
  /** Actual CIEDE2000 cutoff, or null when segmentation uses alpha alone. */
  threshold: number | null;
  pixels: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}
function dominantColor(image: RgbaImage, indices: Iterable<number>): RGB | null {
  const bins = new Map<number, { n: number; rgb: number[] }>();
  for (const i of indices) {
    if (image.data[i * 4 + 3]! < 128) continue;
    const rgb = [image.data[i * 4]!, image.data[i * 4 + 1]!, image.data[i * 4 + 2]!];
    const key = (rgb[0]! >> 4) * 256 + (rgb[1]! >> 4) * 16 + (rgb[2]! >> 4);
    const bin = bins.get(key) ?? { n: 0, rgb: [0, 0, 0] };
    bin.n++;
    rgb.forEach((v, c) => {
      bin.rgb[c] = bin.rgb[c]! + v;
    });
    bins.set(key, bin);
  }
  const best = [...bins].sort((a, b) => b[1].n - a[1].n || a[0] - b[0])[0]?.[1];
  return best ? (best.rgb.map((v) => v / best.n) as [number, number, number]) : null;
}
export function extractForeground(image: RgbaImage, options: ForegroundOptions = {}): ForegroundMask {
  checkImage(image);
  let threshold: number | null = options.threshold ?? 12;
  const alpha = options.alphaThreshold ?? 16;
  const minPixels = options.minComponentPixels ?? 2,
    ratio = options.minComponentRatio ?? 0.01;
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    !Number.isInteger(alpha) ||
    alpha < 0 ||
    alpha > 255 ||
    !Number.isInteger(minPixels) ||
    minPixels < 1 ||
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    ratio > 1
  )
    throw new RangeError('Invalid foreground options.');
  const { width, height } = image,
    border = new Set<number>();
  for (let x = 0; x < width; x++) {
    border.add(x);
    border.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    border.add(y * width);
    border.add(y * width + width - 1);
  }
  const background = options.background ?? dominantColor(image, border) ?? [255, 255, 255];
  const bg = rgbToLab(background),
    data = new Uint8Array(width * height);
  const transparentBackground = [...border].filter((i) => image.data[i * 4 + 3]! < alpha).length > border.size / 2;
  // Bound the cache independently of image size; flat-color references reuse very few colors.
  const differences = new Map<number, number>();
  function difference(i: number): number {
    const r = image.data[i * 4]!,
      g = image.data[i * 4 + 1]!,
      b = image.data[i * 4 + 2]!;
    const key = (r << 16) | (g << 8) | b;
    const cached = differences.get(key);
    if (cached !== undefined) return cached;
    const value = deltaE2000(rgbToLab([r, g, b]), bg);
    if (differences.size < 1024) differences.set(key, value);
    return value;
  }
  if (transparentBackground && !options.background) threshold = null;
  else if (options.threshold === undefined) {
    const noise: number[] = [];
    // Sample the same opaque border pixels used by dominantColor.
    for (const i of border) if (image.data[i * 4 + 3]! >= 128) noise.push(difference(i));
    noise.sort((a, b) => a - b);
    const middle = Math.floor(noise.length / 2);
    const median = noise.length ? (noise[middle]! + noise[Math.floor((noise.length - 1) / 2)]!) / 2 : 0;
    // Three times the median allows for noise tails without letting a minority of touching subject pixels dominate.
    threshold = Math.max(3, Math.min(12, median * 3));
  }
  for (let i = 0; i < data.length; i++) {
    if (image.data[i * 4 + 3]! < alpha) continue;
    if (threshold === null || difference(i) > threshold) data[i] = 1;
  }
  const seen = new Uint8Array(data.length),
    components: number[][] = [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || seen[i]) continue;
    const queue = [i];
    seen[i] = 1;
    for (let q = 0; q < queue.length; q++) {
      const p = queue[q]!,
        x = p % width;
      for (const next of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) {
        if (next >= 0 && next < data.length && data[next] && !seen[next]) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    components.push(queue);
  }
  const largest = components.reduce((n, c) => Math.max(n, c.length), 0);
  for (const component of components)
    if (component.length < Math.max(minPixels, largest * ratio)) for (const i of component) data[i] = 0;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1,
    pixels = 0;
  for (let i = 0; i < data.length; i++)
    if (data[i]) {
      pixels++;
      x0 = Math.min(x0, i % width);
      x1 = Math.max(x1, i % width);
      y0 = Math.min(y0, Math.floor(i / width));
      y1 = Math.max(y1, Math.floor(i / width));
    }
  return {
    width,
    height,
    data,
    background,
    threshold,
    pixels,
    bounds: pixels ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
  };
}
export function silhouetteIoU(
  a: Pick<ForegroundMask, 'width' | 'height' | 'data'>,
  b: Pick<ForegroundMask, 'width' | 'height' | 'data'>,
): number {
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.data.length !== a.width * a.height ||
    b.data.length !== b.width * b.height
  )
    throw new RangeError('Masks must share the same frame dimensions.');
  let intersection = 0,
    union = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] && b.data[i]) intersection++;
    if (a.data[i] || b.data[i]) union++;
  }
  return union ? intersection / union : 1;
}
export function sideBySide(reference: RgbaImage, rendered: RgbaImage, gap = 8): RgbaImage {
  checkImage(reference);
  checkImage(rendered);
  if (!Number.isInteger(gap) || gap < 0) throw new RangeError('Invalid gap.');
  const width = reference.width + gap + rendered.width,
    height = Math.max(reference.height, rendered.height);
  checkDimensions(width, height);
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [image, offset] of [
    [reference, 0],
    [rendered, reference.width + gap],
  ] as const) {
    for (let y = 0; y < image.height; y++)
      data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), (y * width + offset) * 4);
  }
  return { width, height, data };
}
/** Render the same view and frame size; no automatic crop hides positional errors. */
export function compareImages(
  reference: RgbaImage,
  rendered: RgbaImage,
  options: { reference?: ForegroundOptions; rendered?: ForegroundOptions; gap?: number } = {},
) {
  const a = extractForeground(reference, options.reference),
    b = extractForeground(rendered, options.rendered);
  function* foreground(mask: ForegroundMask) {
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) yield i;
  }
  const ca = dominantColor(reference, foreground(a)),
    cb = dominantColor(rendered, foreground(b));
  return {
    iou: silhouetteIoU(a, b),
    colorDifference: ca && cb ? deltaE2000(rgbToLab(ca), rgbToLab(cb)) : null,
    boundsRatioDifference:
      a.bounds && b.bounds
        ? Math.abs(Math.log(a.bounds.width / a.bounds.height / (b.bounds.width / b.bounds.height)))
        : null,
    referenceMask: a,
    renderedMask: b,
    comparison: sideBySide(reference, rendered, options.gap),
  };
}
