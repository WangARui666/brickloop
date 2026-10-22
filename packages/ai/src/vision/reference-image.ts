import type { ImageBlock, ModelCapabilities } from '../types.js';

// Anthropic's native resolution tiers; select the larger tier only from model capabilities.
// https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost
export const ANTHROPIC_REFERENCE_LONG_EDGE = 1568;
export const ANTHROPIC_HIGH_RESOLUTION_LONG_EDGE = 2576;
// Verified 2026-10-20: these are the tile-based high/auto detail rules (e.g. GPT-4o/4.1),
// not the patch budgets of newer model families. A-126 uses this provider-level policy.
// https://developers.openai.com/api/docs/guides/images-vision#tile-based-image-tokenization
export const OPENAI_REFERENCE_LONG_EDGE = 2048;
export const OPENAI_REFERENCE_SHORT_EDGE = 768;
// A-126 default for compatible services (including DeepSeek) without a documented limit.
export const COMPATIBLE_REFERENCE_LONG_EDGE = 1568;
export const REFERENCE_JPEG_QUALITY = 0.9;
export const REENCODE_MIN_BASE64 = 262144;
export const REFERENCE_JPEG_MIN_SAVING = 0.25;

export interface ReferenceImagePolicy {
  longEdge: number;
  shortEdge?: number | undefined;
}
export function referenceImagePolicy(
  providerType: string,
  capabilities: Pick<ModelCapabilities, 'highResolutionImages'> = {},
): ReferenceImagePolicy {
  if (providerType === 'anthropic')
    return {
      longEdge: capabilities.highResolutionImages ? ANTHROPIC_HIGH_RESOLUTION_LONG_EDGE : ANTHROPIC_REFERENCE_LONG_EDGE,
    };
  if (providerType === 'openai' || providerType === 'chatgpt')
    return { longEdge: OPENAI_REFERENCE_LONG_EDGE, shortEdge: OPENAI_REFERENCE_SHORT_EDGE };
  return { longEdge: COMPATIBLE_REFERENCE_LONG_EDGE };
}
export function referenceImageSize(width: number, height: number, policy: ReferenceImagePolicy) {
  if (![width, height].every((value) => Number.isInteger(value) && value > 0))
    throw new RangeError('Invalid reference image dimensions.');
  const scale = Math.min(
    1,
    policy.longEdge / Math.max(width, height),
    policy.shortEdge === undefined ? 1 : policy.shortEdge / Math.min(width, height),
  );
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Decode and resample once through the host codec; the original block is never mutated. */
export function downscaleReferenceImage(
  image: ImageBlock,
  policy: ReferenceImagePolicy,
  decode: (image: ImageBlock) => {
    width: number;
    height: number;
    opaque?(): boolean;
    encodeResized(width: number, height: number, mime: ImageBlock['mime'], quality: number): string;
  },
): ImageBlock {
  const decoded = decode(image);
  const size = referenceImageSize(decoded.width, decoded.height, policy);
  const resized = size.width !== decoded.width || size.height !== decoded.height;
  if (!resized && (image.mime === 'image/jpeg' || image.base64.length <= REENCODE_MIN_BASE64)) return image;
  if (image.mime !== 'image/jpeg' && decoded.opaque?.() === true) {
    const baseline = resized
      ? decoded.encodeResized(size.width, size.height, 'image/png', REFERENCE_JPEG_QUALITY)
      : image.base64;
    const jpeg = decoded.encodeResized(size.width, size.height, 'image/jpeg', REFERENCE_JPEG_QUALITY);
    if (jpeg.length <= baseline.length * (1 - REFERENCE_JPEG_MIN_SAVING))
      return { type: 'image', mime: 'image/jpeg', base64: jpeg };
    return resized ? { type: 'image', mime: 'image/png', base64: baseline } : image;
  }
  if (!resized) return image;
  const mime = image.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return {
    type: 'image',
    mime,
    base64: decoded.encodeResized(size.width, size.height, mime, REFERENCE_JPEG_QUALITY),
  };
}
