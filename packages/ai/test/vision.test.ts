import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { compareImages, extractForeground, sideBySide, silhouetteIoU } from '../src/vision/index.js';
import type { ForegroundOptions } from '../src/vision/index.js';
import { decodeImage, deltaE2000, rgbToLab, type RgbaImage, type RGB } from '@brickloop/mosaic';
const canvas = (rgba = [255, 255, 255, 255], width = 10, height = width): RgbaImage => ({
  width,
  height,
  data: Uint8Array.from({ length: width * height * 4 }, (_, i) => rgba[i % 4]!),
});
function rectangle(image: RgbaImage, x: number, y: number, width: number, height: number, color: number[]) {
  for (let dy = y; dy < y + height; dy++)
    for (let dx = x; dx < x + width; dx++) image.data.set(color, (dy * image.width + dx) * 4);
  return image;
}
function square(image: RgbaImage, x: number, color = [220, 0, 0, 255]) {
  return rectangle(image, x, 3, 4, 4, color);
}
it('estimates border background and removes isolated foreground noise', () => {
  const image = square(canvas([245, 245, 245, 255]), 3);
  image.data.set([0, 0, 0, 255], 11 * 4);
  const mask = extractForeground(image);
  expect(mask.background).toEqual([245, 245, 245]);
  expect(mask.pixels).toBe(16);
  expect(mask.bounds).toEqual({ x: 3, y: 3, width: 4, height: 4 });
});
it('handles transparency, same-color objects and multiple meaningful components', () => {
  const image = square(canvas([0, 0, 0, 0]), 3, [255, 255, 255, 255]);
  expect(extractForeground(image).pixels).toBe(16);
  image.data.set([0, 0, 0, 255], 0);
  image.data.set([0, 0, 0, 255], 4);
  expect(extractForeground(image).pixels).toBe(18);
});
it('computes analytic IoU and dominant CIEDE2000 difference without registration', () => {
  const a = square(canvas(), 2),
    b = square(canvas(), 4);
  const compared = compareImages(a, b);
  expect(compared.iou).toBeCloseTo(1 / 3);
  expect(compared.colorDifference).toBe(0);
  expect(compared.boundsRatioDifference).toBe(0);
  expect(compareImages(a, square(canvas(), 2, [0, 0, 255, 255])).colorDifference).toBeGreaterThan(20);
  expect(silhouetteIoU(extractForeground(canvas()), extractForeground(canvas()))).toBe(1);
  expect(compareImages(canvas(), canvas()).colorDifference).toBeNull();
  expect(() => silhouetteIoU(extractForeground(a), { width: 1, height: 1, data: new Uint8Array(1) })).toThrow();
});
it('composes exact RGBA rows without modifying either image', () => {
  const left = { width: 1, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
  const right = { width: 1, height: 1, data: new Uint8Array([10, 20, 30, 40]) };
  const result = sideBySide(left, right, 1);
  expect([result.width, result.height]).toEqual([3, 2]);
  expect([...result.data]).toEqual([
    1, 2, 3, 4, 255, 255, 255, 255, 10, 20, 30, 40, 5, 6, 7, 8, 255, 255, 255, 255, 255, 255, 255, 255,
  ]);
});

const white = [255, 255, 255, 255];
const cream = [237, 237, 223, 255];
const red = [190, 52, 52, 255];
function nonWhitePixels(image: RgbaImage) {
  return Uint8Array.from({ length: image.width * image.height }, (_, i) =>
    image.data[i * 4] === 255 && image.data[i * 4 + 1] === 255 && image.data[i * 4 + 2] === 255 ? 0 : 1,
  );
}

it('IMG-09a: preserves cream walls, a red roof and light gray on white', () => {
  const image = rectangle(canvas(white, 64), 20, 24, 24, 24, cream);
  rectangle(image, 16, 12, 32, 12, red);
  rectangle(image, 50, 40, 8, 8, [238, 238, 238, 255]);
  const mask = extractForeground(image);
  expect(mask.threshold).toBe(3);
  expect(mask.pixels).toBe(1024);
  expect(mask.data).toEqual(nonWhitePixels(image));
});

it('IMG-09b: preserves a dark subject with exact bounds on white', () => {
  const image = rectangle(canvas(white, 64), 12, 16, 32, 28, [40, 40, 40, 255]);
  const mask = extractForeground(image);
  expect(mask.threshold).toBe(3);
  expect(mask.pixels).toBe(896);
  expect(mask.bounds).toEqual({ x: 12, y: 16, width: 32, height: 28 });
  expect(mask.data).toEqual(nonWhitePixels(image));
});

it('IMG-09c: retains white and similar-color subjects on a colored background', () => {
  const background: RGB = [70, 130, 180];
  const similar: RGB = [85, 150, 200];
  const difference = deltaE2000(rgbToLab(background), rgbToLab(similar));
  expect(difference).toBeGreaterThan(5);
  expect(difference).toBeLessThan(10);
  const image = rectangle(canvas([...background, 255], 64), 8, 16, 16, 24, white);
  rectangle(image, 40, 16, 16, 24, [...similar, 255]);
  const mask = extractForeground(image);
  expect(mask.background).toEqual(background);
  expect(mask.threshold).toBe(3);
  expect(mask.pixels).toBe(768);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      expect(mask.data[y * 64 + x]).toBe(y >= 16 && y < 40 && ((x >= 8 && x < 24) || (x >= 40 && x < 56)) ? 1 : 0);
});

it('IMG-09d: rejects deterministic ±5 background noise while preserving every cream pixel', () => {
  const image = canvas(white, 96);
  let seed = 0x12345678;
  for (let i = 0; i < image.data.length; i += 4)
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      image.data[i + channel] = Math.min(255, 255 + (seed % 11) - 5);
    }
  rectangle(image, 24, 24, 48, 48, cream);
  // Disable component filtering so it cannot hide background misclassification.
  const mask = extractForeground(image, { minComponentPixels: 1, minComponentRatio: 0 });
  expect(mask.threshold).toBeGreaterThan(3);
  expect(mask.threshold).toBeLessThanOrEqual(12);
  let subjectPixels = 0;
  for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) subjectPixels += mask.data[y * 96 + x]!;
  expect(subjectPixels).toBe(2304);
  expect(mask.pixels - subjectPixels).toBeLessThanOrEqual((96 * 96 - 2304) * 0.005);
});

it('IMG-09d: stronger border noise is capped at the legacy threshold', () => {
  const image = canvas(white, 64);
  for (let i = 0; i < image.width * image.height; i++)
    image.data.set(i % 2 ? [240, 255, 240, 255] : [255, 240, 255, 255], i * 4);
  rectangle(image, 16, 16, 32, 32, red);
  const mask = extractForeground(image);
  expect(mask.threshold).toBe(12);
  expect(mask.data).toEqual(extractForeground(image, { threshold: 12 }).data);
});

it('IMG-09e: a cream subject covering 30% of the opaque border does not raise the threshold', () => {
  // The bottom 7 rows cover 64 + 6 * 2 = 76 of 252 border pixels, or 30.16%.
  const image = rectangle(canvas(white, 64), 0, 57, 64, 7, cream);
  const mask = extractForeground(image);
  expect(mask.background).toEqual([255, 255, 255]);
  expect(mask.threshold).toBe(3);
  expect(mask.pixels).toBe(448);
  expect(mask.bounds).toEqual({ x: 0, y: 57, width: 64, height: 7 });
  expect(mask.data).toEqual(nonWhitePixels(image));
});

it('IMG-09f: transparency takes priority unless a background is supplied; low alpha is always excluded', () => {
  const image = rectangle(canvas([255, 255, 255, 0], 64), 16, 16, 32, 32, cream);
  const transparent = extractForeground(image, { threshold: 12 });
  expect(transparent.threshold).toBeNull();
  expect(transparent.pixels).toBe(1024);
  const explicit = extractForeground(image, { background: [255, 255, 255] });
  expect(explicit.threshold).toBe(3);
  expect(explicit.data).toEqual(transparent.data);
  expect(extractForeground(image, { background: [255, 255, 255], threshold: 12 }).pixels).toBe(0);
  const opaque = rectangle(canvas(white, 64), 16, 16, 32, 32, cream);
  for (const alpha of [0, 1, 15, 16]) opaque.data[(24 * 64 + 24 + alpha) * 4 + 3] = alpha;
  const mask = extractForeground(opaque);
  expect(mask.threshold).toBe(3);
  expect(mask.pixels).toBe(1021);
  for (const alpha of [0, 1, 15, 16]) expect(mask.data[24 * 64 + 24 + alpha]).toBe(alpha < 16 ? 0 : 1);
  expect(extractForeground(opaque, { background: [255, 255, 255], threshold: 0 }).data).toEqual(mask.data);
  expect(extractForeground(opaque, { alphaThreshold: 17 }).pixels).toBe(1020);
});

it('IMG-09g: explicit threshold 12 reproduces the old cream-wall exclusion', () => {
  const image = rectangle(canvas(white, 64), 20, 24, 24, 24, cream);
  rectangle(image, 16, 12, 32, 12, red);
  const mask = extractForeground(image, { threshold: 12 });
  expect(mask.threshold).toBe(12);
  expect(mask.pixels).toBe(384);
  expect(mask.bounds).toEqual({ x: 16, y: 12, width: 32, height: 12 });
  expect(extractForeground(image, { threshold: 0 }).pixels).toBe(960);
});

it.each<ForegroundOptions>([
  { threshold: -1 },
  { threshold: NaN },
  { threshold: Infinity },
  { alphaThreshold: -1 },
  { alphaThreshold: 256 },
  { alphaThreshold: 1.5 },
  { alphaThreshold: NaN },
  { minComponentPixels: 0 },
  { minComponentPixels: 1.5 },
  { minComponentPixels: Infinity },
  { minComponentRatio: -0.01 },
  { minComponentRatio: 1.01 },
  { minComponentRatio: NaN },
])('IMG-09g: invalid options still throw RangeError (%j)', (options) => {
  expect(() => extractForeground(canvas(white, 64), options)).toThrow(RangeError);
  expect(() => extractForeground(canvas([0, 0, 0, 0], 64), options)).toThrow(RangeError);
});

it('IMG-09: enclosed background-colored holes stay empty and component limits retain their meaning', () => {
  const image = rectangle(canvas(white, 64), 12, 12, 40, 40, cream);
  rectangle(image, 20, 20, 24, 24, white);
  rectangle(image, 2, 2, 2, 2, red);
  rectangle(image, 60, 60, 1, 1, red);
  expect(extractForeground(image).pixels).toBe(1024);
  expect(extractForeground(image).data[32 * 64 + 32]).toBe(0);
  expect(extractForeground(image, { minComponentRatio: 0 }).pixels).toBe(1028);
  expect(extractForeground(image, { minComponentRatio: 0, minComponentPixels: 1 }).pixels).toBe(1029);
  expect(extractForeground(image, { minComponentRatio: 0, minComponentPixels: 5 }).pixels).toBe(1024);
});

const referenceDirectory = new URL('./ai-eval/references/', import.meta.url);
const references = (await readdir(referenceDirectory)).filter((name) => name.endsWith('.png')).sort();
it('IMG-09: covers all 30 original reference images', () => {
  expect(references).toHaveLength(30);
  expect(references).toContain('01-front.png');
});
it.each(references)('IMG-09: %s has the same mask with white or transparent background', async (name) => {
  const original = decodeImage(await readFile(new URL(name, referenceDirectory)));
  const transparent = { ...original, data: original.data.slice() };
  for (let i = 0; i < transparent.data.length; i += 4)
    if (transparent.data[i] === 255 && transparent.data[i + 1] === 255 && transparent.data[i + 2] === 255)
      transparent.data[i + 3] = 0;
  const originalMask = extractForeground(original);
  const transparentMask = extractForeground(transparent);
  expect(originalMask.data).toEqual(transparentMask.data);
  expect(originalMask.threshold).toBe(3);
  expect(transparentMask.threshold).toBeNull();
  if (name === '01-front.png') {
    expect(originalMask.pixels).toBe(11800);
    expect(compareImages(original, transparent).iou).toBe(1);
    expect(extractForeground(original, { threshold: 12 }).pixels).toBe(5136);
  }
});
