import type { RgbaImage } from '@brickloop/mosaic';

const MAX_COMPARISON_EDGE = 768;

/** Area averaging with premultiplied alpha preserves transparent silhouettes and thin edges. */
export function shrinkComparisonImage(image: RgbaImage): RgbaImage {
  const scale = MAX_COMPARISON_EDGE / Math.max(image.width, image.height);
  if (scale >= 1) return image;
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale)),
    data = new Uint8Array(width * height * 4),
    sx = image.width / width,
    sy = image.height / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const left = x * sx,
        right = (x + 1) * sx,
        top = y * sy,
        bottom = (y + 1) * sy;
      let red = 0,
        green = 0,
        blue = 0,
        alpha = 0;
      for (let iy = Math.floor(top); iy < Math.min(image.height, Math.ceil(bottom)); iy++)
        for (let ix = Math.floor(left); ix < Math.min(image.width, Math.ceil(right)); ix++) {
          const offset = (iy * image.width + ix) * 4,
            weight = (Math.min(ix + 1, right) - Math.max(ix, left)) * (Math.min(iy + 1, bottom) - Math.max(iy, top)),
            coverage = image.data[offset + 3]! * weight;
          alpha += coverage;
          red += image.data[offset]! * coverage;
          green += image.data[offset + 1]! * coverage;
          blue += image.data[offset + 2]! * coverage;
        }
      const offset = (y * width + x) * 4;
      if (alpha > 0) {
        data[offset] = Math.round(red / alpha);
        data[offset + 1] = Math.round(green / alpha);
        data[offset + 2] = Math.round(blue / alpha);
        data[offset + 3] = Math.round(alpha / (sx * sy));
      }
    }
  return { width, height, data };
}
