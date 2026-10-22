import { decode as decodePng, hasPngSignature } from 'fast-png';
import jpeg from 'jpeg-js';
import type { RGB } from './color.js';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
export const MAX_PIXELS = 16_777_216;
export function checkDimensions(width: number, height: number): void {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0) || width * height > MAX_PIXELS)
    throw new RangeError('Invalid image dimensions (maximum 16777216 pixels).');
}
export function checkImage(image: RgbaImage): void {
  checkDimensions(image.width, image.height);
  if (image.data.length !== image.width * image.height * 4) throw new RangeError('Invalid RGBA buffer length.');
}
/** No DOM, filesystem or network. PNG samples are normalized to 8-bit RGBA. */
export function decodeImage(bytes: Uint8Array): RgbaImage {
  if (bytes.length >= 24 && hasPngSignature(bytes)) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    checkDimensions(header.getUint32(16), header.getUint32(20));
    const png = decodePng(bytes, { checkCrc: true });
    const { width, height, channels, depth } = png;
    const data = new Uint8Array(width * height * 4);
    const max = 2 ** depth - 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sample = (c: number) =>
          depth < 8
            ? (png.data[
                y * Math.ceil((width * channels * depth) / 8) + Math.floor(((x * channels + c) * depth) / 8)
              ]! >>
                (8 - depth - (((x * channels + c) * depth) % 8))) &
              max
            : png.data[(y * width + x) * channels + c]!;
        let rgba: number[];
        if (png.palette) {
          const entry = png.palette[sample(0)];
          if (!entry) throw new Error('Invalid PNG palette index.');
          rgba = [entry[0]!, entry[1]!, entry[2]!, entry[3] ?? 255];
        } else {
          const gray = channels <= 2;
          const raw = gray ? [sample(0)] : [sample(0), sample(1), sample(2)];
          const transparent = png.transparency !== undefined && raw.every((v, i) => v === png.transparency![i]);
          const r = Math.round((raw[0]! * 255) / max);
          rgba = [
            r,
            gray ? r : Math.round((raw[1]! * 255) / max),
            gray ? r : Math.round((raw[2]! * 255) / max),
            transparent ? 0 : channels === 2 || channels === 4 ? Math.round((sample(channels - 1) * 255) / max) : 255,
          ];
        }
        data.set(rgba, (y * width + x) * 4);
      }
    return { width, height, data };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const result = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 256,
    });
    checkImage(result);
    return { width: result.width, height: result.height, data: result.data };
  }
  throw new Error('Only PNG and JPEG images are supported.');
}
/** Exact area coverage in sRGB; alpha is composited on the chosen background before averaging. */
export function resizeImage(
  image: RgbaImage,
  width: number,
  height: number,
  background: RGB = [255, 255, 255],
): RgbaImage {
  checkImage(image);
  checkDimensions(width, height);
  const data = new Uint8Array(width * height * 4);
  const sx = image.width / width,
    sy = image.height / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      for (let iy = Math.floor(y * sy); iy < Math.ceil((y + 1) * sy); iy++)
        for (let ix = Math.floor(x * sx); ix < Math.ceil((x + 1) * sx); ix++) {
          if (ix >= image.width || iy >= image.height) continue;
          const weight =
            (Math.min(ix + 1, (x + 1) * sx) - Math.max(ix, x * sx)) *
            (Math.min(iy + 1, (y + 1) * sy) - Math.max(iy, y * sy));
          const offset = (iy * image.width + ix) * 4,
            alpha = image.data[offset + 3]! / 255;
          for (let c = 0; c < 3; c++)
            sum[c] = sum[c]! + (image.data[offset + c]! * alpha + background[c]! * (1 - alpha)) * weight;
        }
      data.set([...sum.map((v) => Math.round(v / (sx * sy))), 255], (y * width + x) * 4);
    }
  return { width, height, data };
}
