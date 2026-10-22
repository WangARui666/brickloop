import { expect, it } from 'vitest';
import { thumbnailKey } from '../src/main/thumb-cache';

it('keys neutral 71 thumbnails by geometry, without a current color parameter (A-22)', () => {
  const key = thumbnailKey('ld:3001', 'mesh-hash');
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(thumbnailKey('ld:3001', 'mesh-hash')).toBe(key);
  expect(thumbnailKey('ld:3001', 'child-source-changed')).not.toBe(key);
  expect(thumbnailKey('ld:3002', 'mesh-hash')).not.toBe(key);
});
