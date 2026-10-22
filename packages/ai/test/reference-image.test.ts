import { expect, it, vi } from 'vitest';
import {
  downscaleReferenceImage,
  referenceImagePolicy,
  referenceImageSize,
  REENCODE_MIN_BASE64,
  REFERENCE_JPEG_MIN_SAVING,
} from '../src/vision/reference-image.js';
import type { ImageBlock } from '../src/types.js';

it.each([
  ['anthropic', {}, 1568, 1176],
  ['anthropic', { highResolutionImages: true }, 2576, 1932],
  ['openai', {}, 1024, 768],
  ['chatgpt', {}, 1024, 768],
  ['compatible', {}, 1568, 1176],
  ['deepseek', {}, 1568, 1176],
] as const)('sizes a 4000×3000 reference for %s (%j)', (provider, capability, width, height) => {
  const policy = referenceImagePolicy(provider, capability);
  expect(referenceImageSize(4000, 3000, policy)).toEqual({ width, height });
  expect(referenceImageSize(3000, 4000, policy)).toEqual({ width: height, height: width });
  expect(width / height).toBe(4 / 3);
  expect(referenceImageSize(400, 300, policy)).toEqual({ width: 400, height: 300 });
});
it('keeps OpenAI panoramas inside 2048 without enlarging their short side', () => {
  expect(referenceImageSize(4000, 1000, referenceImagePolicy('openai'))).toEqual({ width: 2048, height: 512 });
  expect(referenceImageSize(2048, 512, referenceImagePolicy('openai'))).toEqual({ width: 2048, height: 512 });
  expect(referenceImageSize(3001, 4000, referenceImagePolicy('openai'))).toEqual({ width: 768, height: 1023 });
});
it.each(['image/png', 'image/jpeg'] as const)(
  'resamples %s once, preserves the original and uses quality 0.9',
  (mime) => {
    const image: ImageBlock = { type: 'image', mime, base64: 'original' };
    const encodeResized = vi.fn(() => 'scaled');
    const decode = vi.fn(() => ({ width: 4000, height: 3000, encodeResized }));
    expect(downscaleReferenceImage(image, referenceImagePolicy('openai'), decode)).toEqual({
      ...image,
      base64: 'scaled',
    });
    expect(image.base64).toBe('original');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(encodeResized).toHaveBeenCalledExactlyOnceWith(1024, 768, mime, 0.9);
  },
);
it('returns a small reference byte-for-byte without re-encoding', () => {
  const image: ImageBlock = { type: 'image', mime: 'image/jpeg', base64: 'original' };
  const encodeResized = vi.fn();
  expect(
    downscaleReferenceImage(image, referenceImagePolicy('anthropic'), () => ({
      width: 800,
      height: 600,
      encodeResized,
    })),
  ).toBe(image);
  expect(encodeResized).not.toHaveBeenCalled();
});

const encodedPng = 'iVBOR'.padEnd(400, 'A');
const encodedJpeg = (length: number) => '/9j/'.padEnd(length, 'A');
const policy = referenceImagePolicy('compatible');

it.each(['image/png', 'image/webp', 'image/gif'] as const)(
  're-encodes opaque %s once per format, with matching MIME and bytes',
  (mime) => {
    const image: ImageBlock = { type: 'image', mime, base64: 'original' };
    const opaque = vi.fn(() => true);
    const encodeResized = vi.fn((_width, _height, format) => (format === 'image/jpeg' ? encodedJpeg(100) : encodedPng));
    const decode = vi.fn(() => ({ width: 4000, height: 3000, opaque, encodeResized }));
    expect(downscaleReferenceImage(image, policy, decode)).toEqual({
      type: 'image',
      mime: 'image/jpeg',
      base64: encodedJpeg(100),
    });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(opaque).toHaveBeenCalledTimes(1);
    expect(encodeResized.mock.calls).toEqual([
      [1568, 1176, 'image/png', 0.9],
      [1568, 1176, 'image/jpeg', 0.9],
    ]);
    expect(image).toEqual({ type: 'image', mime, base64: 'original' });
  },
);

it.each([299, 300, 301, 500])('requires at least 25%% saving for a %i-character JPEG', (length) => {
  expect(REFERENCE_JPEG_MIN_SAVING).toBe(0.25);
  const image: ImageBlock = { type: 'image', mime: 'image/png', base64: 'original' };
  const result = downscaleReferenceImage(image, policy, () => ({
    width: 4000,
    height: 3000,
    opaque: () => true,
    encodeResized: (_width, _height, mime) => (mime === 'image/jpeg' ? encodedJpeg(length) : encodedPng),
  }));
  expect(result).toEqual({
    type: 'image',
    mime: length <= 300 ? 'image/jpeg' : 'image/png',
    base64: length <= 300 ? encodedJpeg(length) : encodedPng,
  });
});

it.each(['image/png', 'image/webp', 'image/gif'] as const)(
  'only replaces unscaled opaque %s above the base64 threshold and with sufficient saving',
  (mime) => {
    expect(REENCODE_MIN_BASE64).toBe(262144);
    for (const length of [100, REENCODE_MIN_BASE64, REENCODE_MIN_BASE64 + 1]) {
      const maxJpegLength = Math.floor(length * 0.75);
      for (const jpegLength of [maxJpegLength, maxJpegLength + 1]) {
        const image: ImageBlock = { type: 'image', mime, base64: 'A'.repeat(length) };
        const opaque = vi.fn(() => true);
        const encodeResized = vi.fn((_width, _height, format) =>
          format === 'image/jpeg' ? encodedJpeg(jpegLength) : encodedPng,
        );
        const result = downscaleReferenceImage(image, policy, () => ({
          width: 800,
          height: 600,
          opaque,
          encodeResized,
        }));
        if (length > REENCODE_MIN_BASE64 && jpegLength === maxJpegLength)
          expect(result).toEqual({ type: 'image', mime: 'image/jpeg', base64: encodedJpeg(jpegLength) });
        else expect(result).toBe(image);
        if (length <= REENCODE_MIN_BASE64) {
          expect(opaque).not.toHaveBeenCalled();
          expect(encodeResized).not.toHaveBeenCalled();
        } else expect(encodeResized).toHaveBeenCalledExactlyOnceWith(800, 600, 'image/jpeg', 0.9);
      }
    }
  },
);

it.each([420000, 360000, 300004, 300000, 280000])(
  'compares an unscaled optimized PNG with the original, without encoding PNG (%i-character JPEG)',
  (jpegLength) => {
    const original = 'iVBOR'.padEnd(400000, 'A');
    const canvasPng = 'iVBOR'.padEnd(1200000, 'A');
    const jpeg = encodedJpeg(jpegLength);
    const image: ImageBlock = { type: 'image', mime: 'image/png', base64: original };
    const encodeResized = vi.fn((_width, _height, mime) => (mime === 'image/png' ? canvasPng : jpeg));
    expect(original.length).toBeGreaterThan(REENCODE_MIN_BASE64);
    const result = downscaleReferenceImage(image, policy, () => ({
      width: 800,
      height: 600,
      opaque: () => true,
      encodeResized,
    }));
    if (jpegLength <= 300000) expect(result).toEqual({ type: 'image', mime: 'image/jpeg', base64: jpeg });
    else expect(result).toBe(image);
    expect(image).toEqual({ type: 'image', mime: 'image/png', base64: original });
    expect(encodeResized).toHaveBeenCalledExactlyOnceWith(800, 600, 'image/jpeg', 0.9);
  },
);

it.each(['image/png', 'image/webp', 'image/gif'] as const)(
  'keeps transparent or unknown-opacity %s on the existing path',
  (mime) => {
    for (const opaque of [undefined, () => false])
      for (const width of [800, 4000]) {
        const image: ImageBlock = { type: 'image', mime, base64: 'A'.repeat(REENCODE_MIN_BASE64 + 1) };
        const encodeResized = vi.fn(() => encodedPng);
        const result = downscaleReferenceImage(image, policy, () => ({
          width,
          height: 600,
          ...(opaque ? { opaque } : {}),
          encodeResized,
        }));
        if (width === 800) {
          expect(result).toBe(image);
          expect(encodeResized).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ type: 'image', mime: 'image/png', base64: encodedPng });
          expect(encodeResized).toHaveBeenCalledExactlyOnceWith(1568, 235, 'image/png', 0.9);
        }
      }
  },
);

it('never checks JPEG alpha or re-encodes an unscaled JPEG, regardless of size', () => {
  for (const width of [800, 4000]) {
    const image: ImageBlock = { type: 'image', mime: 'image/jpeg', base64: encodedJpeg(REENCODE_MIN_BASE64 + 1) };
    const opaque = vi.fn(() => true);
    const encodeResized = vi.fn(() => encodedJpeg(100));
    const result = downscaleReferenceImage(image, policy, () => ({ width, height: 600, opaque, encodeResized }));
    expect(opaque).not.toHaveBeenCalled();
    if (width === 800) {
      expect(result).toBe(image);
      expect(encodeResized).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ type: 'image', mime: 'image/jpeg', base64: encodedJpeg(100) });
      expect(encodeResized).toHaveBeenCalledExactlyOnceWith(1568, 235, 'image/jpeg', 0.9);
    }
  }
});
