import { downscaleReferenceImage } from '@brickloop/ai';
import type { ImageBlock, ReferenceImagePolicy } from '@brickloop/ai';

/** Use the same browser decoding as reference display, including JPEG orientation and GIF/WebP. */
export async function prepareReferenceImage(image: ImageBlock, policy: ReferenceImagePolicy): Promise<ImageBlock> {
  const bitmap = new Image();
  bitmap.src = `data:${image.mime};base64,${image.base64}`;
  await bitmap.decode();
  return downscaleReferenceImage(image, policy, () => ({
    width: bitmap.naturalWidth,
    height: bitmap.naturalHeight,
    opaque() {
      // Downsampling can hide even an alpha of 254 in a single source pixel.
      // For very large images, keep PNG rather than infer opacity from a smaller canvas.
      if (bitmap.naturalWidth * bitmap.naturalHeight > 16_000_000) return false;
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.naturalWidth;
      canvas.height = bitmap.naturalHeight;
      try {
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! < 255) return false;
        return true;
      } finally {
        canvas.width = canvas.height = 1;
      }
    },
    encodeResized(width, height, mime, quality) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      const base64 = canvas.toDataURL(mime, quality).split(',')[1]!;
      canvas.width = canvas.height = 1;
      return base64;
    },
  }));
}
