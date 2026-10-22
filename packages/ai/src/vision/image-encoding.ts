import type { RgbaImage, RGB } from '@brickloop/mosaic';
import type { ImageBlock } from '../types.js';
import { REFERENCE_JPEG_MIN_SAVING, REFERENCE_JPEG_QUALITY } from './reference-image.js';

/** Encode the model-facing copy at its original size, without changing metric pixels.
 * A precomputed PNG must represent these same pixels; a backdrop always requires a fresh encode. */
export function encodeModelImage(
  image: RgbaImage,
  encode: (image: RgbaImage, mime: 'image/png' | 'image/jpeg', quality: number) => string,
  background?: RGB,
  pngBase64?: string,
): ImageBlock {
  let transparent = false;
  for (let index = 3; index < image.data.length; index += 4)
    if (image.data[index]! < 255) {
      transparent = true;
      break;
    }
  let pixels = image;
  if (transparent && background) {
    const data = new Uint8Array(image.data.length);
    for (let index = 0; index < data.length; index += 4) {
      const alpha = image.data[index + 3]!;
      for (let channel = 0; channel < 3; channel++)
        data[index + channel] = Math.round(
          (image.data[index + channel]! * alpha + background[channel]! * (255 - alpha)) / 255,
        );
      data[index + 3] = 255;
    }
    pixels = { width: image.width, height: image.height, data };
    transparent = false;
  }
  const png = (background === undefined ? pngBase64 : undefined) ?? encode(pixels, 'image/png', REFERENCE_JPEG_QUALITY);
  if (!transparent) {
    const jpeg = encode(pixels, 'image/jpeg', REFERENCE_JPEG_QUALITY);
    if (jpeg.length <= png.length * (1 - REFERENCE_JPEG_MIN_SAVING))
      return { type: 'image', mime: 'image/jpeg', base64: jpeg };
  }
  return { type: 'image', mime: 'image/png', base64: png };
}
