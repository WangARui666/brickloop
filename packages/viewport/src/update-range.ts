import type { BufferAttribute } from 'three/webgpu';

/** Coalesce consecutive/overlapping writes, including writes before the first rendered frame.
 * Three's instance adapter spreads these ranges into a function call, so an unrendered
 * progressive batch must not accumulate one range per slot per notification. */
export function markRange(attribute: BufferAttribute, start: number, count: number) {
  const last = attribute.updateRanges.at(-1);
  if (last && start <= last.start + last.count && start + count >= last.start) {
    const end = Math.max(last.start + last.count, start + count);
    last.start = Math.min(last.start, start);
    last.count = end - last.start;
  } else attribute.addUpdateRange(start, count);
}
