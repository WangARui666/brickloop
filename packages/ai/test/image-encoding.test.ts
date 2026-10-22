import { expect, it, vi } from 'vitest';
import type { RgbaImage } from '@brickloop/mosaic';
import { encodeModelImage } from '../src/vision/image-encoding.js';
import { REFERENCE_JPEG_MIN_SAVING, REFERENCE_JPEG_QUALITY } from '../src/vision/reference-image.js';

const opaque: RgbaImage = { width: 3, height: 1, data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]) };
const png = 'P'.repeat(400);
const threshold = png.length * (1 - REFERENCE_JPEG_MIN_SAVING);

it.each([threshold - 1, threshold, threshold + 1, 500])(
  'selects JPEG only at the shared saving threshold (%i bytes), with one encode per format',
  (size) => {
    const jpeg = 'J'.repeat(size);
    const encode = vi.fn((_image: RgbaImage, mime: string) => (mime === 'image/png' ? png : jpeg));
    expect(encodeModelImage(opaque, encode)).toEqual({
      type: 'image',
      mime: size <= threshold ? 'image/jpeg' : 'image/png',
      base64: size <= threshold ? jpeg : png,
    });
    expect(encode.mock.calls).toEqual([
      [opaque, 'image/png', REFERENCE_JPEG_QUALITY],
      [opaque, 'image/jpeg', REFERENCE_JPEG_QUALITY],
    ]);
  },
);

it.each([0, 128, 254])('preserves any transparency without a backdrop (alpha %i)', (alpha) => {
  const image = { ...opaque, data: opaque.data.slice() };
  image.data[7] = alpha;
  const before = image.data.slice();
  const encode = vi.fn<Parameters<typeof encodeModelImage>[1]>(() => png);
  expect(encodeModelImage(image, encode)).toEqual({ type: 'image', mime: 'image/png', base64: png });
  expect(encode).toHaveBeenCalledExactlyOnceWith(image, 'image/png', REFERENCE_JPEG_QUALITY);
  expect(image.data).toEqual(before);
});

it.each([100, 350])('composites alpha 0/128/255 exactly without mutating or resizing (%i-byte JPEG)', (size) => {
  const image = { width: 3, height: 1, data: new Uint8Array([200, 100, 0, 0, 200, 100, 0, 128, 200, 100, 0, 255]) };
  const before = image.data.slice();
  const encode = vi.fn((_image: RgbaImage, mime: string) => (mime === 'image/png' ? png : 'J'.repeat(size)));
  expect(encodeModelImage(image, encode, [10, 20, 30]).mime).toBe(size <= threshold ? 'image/jpeg' : 'image/png');
  const composited = {
    width: 3,
    height: 1,
    data: new Uint8Array([10, 20, 30, 255, 105, 60, 15, 255, 200, 100, 0, 255]),
  };
  expect(encode.mock.calls.map(([pixels]) => pixels)).toEqual([composited, composited]);
  expect(image.data).toEqual(before);
});

it('does not change opaque pixels when given a backdrop', () => {
  const encode = vi.fn<Parameters<typeof encodeModelImage>[1]>(() => png);
  encodeModelImage(opaque, encode, [10, 20, 30]);
  expect(encode.mock.calls[0]![0]).toBe(opaque);
});

it.each([threshold - 1, threshold, threshold + 1, 500])(
  'reuses the supplied PNG for the same saving decision without re-encoding it (%i-byte JPEG)',
  (size) => {
    const jpeg = 'J'.repeat(size);
    // Using a newly encoded PNG here would incorrectly accept the larger JPEGs.
    const encode = vi.fn((_image: RgbaImage, mime: string) => (mime === 'image/png' ? 'P'.repeat(1000) : jpeg));
    expect(encodeModelImage(opaque, encode, undefined, png)).toEqual({
      type: 'image',
      mime: size <= threshold ? 'image/jpeg' : 'image/png',
      base64: size <= threshold ? jpeg : png,
    });
    expect(encode).toHaveBeenCalledExactlyOnceWith(opaque, 'image/jpeg', REFERENCE_JPEG_QUALITY);
  },
);

it.each([0, 128, 254])('returns the supplied transparent PNG without any encoding (alpha %i)', (alpha) => {
  const image = { ...opaque, data: opaque.data.slice() };
  image.data[7] = alpha;
  const encode = vi.fn<Parameters<typeof encodeModelImage>[1]>();
  expect(encodeModelImage(image, encode, undefined, png)).toEqual({ type: 'image', mime: 'image/png', base64: png });
  expect(encode).not.toHaveBeenCalled();
});

it.each([0, 128, 255])('ignores a supplied PNG whenever a backdrop is requested (alpha %i)', (alpha) => {
  const image = { ...opaque, data: opaque.data.slice() };
  image.data[7] = alpha;
  const encode = vi.fn((_image: RgbaImage, mime: string) => (mime === 'image/png' ? png : 'J'.repeat(350)));
  expect(encodeModelImage(image, encode, [10, 20, 30], 'P'.repeat(1000))).toEqual({
    type: 'image',
    mime: 'image/png',
    base64: png,
  });
  expect(encode.mock.calls.map(([, mime]) => mime)).toEqual(['image/png', 'image/jpeg']);
});
