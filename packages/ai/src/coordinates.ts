import { gridPositionSchema, lduPositionSchema } from './tools/schemas.js';
export type GridPosition = { x: number; z: number; level: number };
export type LduPosition = { x_ldu: number; y_ldu: number; z_ldu: number };
export function gridToLdu(position: GridPosition): LduPosition {
  const p = gridPositionSchema.parse(position);
  return { x_ldu: p.x * 20, y_ldu: p.level === 0 ? 0 : -p.level * 8, z_ldu: p.z * 20 };
}
/** LDraw matrices may produce arbitrary positions; reverse conversion never snaps to the grid. */
export function lduToGrid(position: LduPosition): GridPosition {
  const p = lduPositionSchema.parse(position);
  return { x: p.x_ldu / 20, level: p.y_ldu === 0 ? 0 : -p.y_ldu / 8, z: p.z_ldu / 20 };
}
