/** Box coordinates are in studs; trim trailing zeros and avoid displaying negative zero. */
export function formatBoxCorner(corner: { x: number; y: number; z: number }): string {
  return [corner.x, corner.y, corner.z].map((value) => String(Number(value.toFixed(2)))).join(', ');
}
