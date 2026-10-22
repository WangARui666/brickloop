import { transformDirection, transformPoint } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
import type { Cell, Connector, ConnectorInstance, ConnectorRef, WorldConnector } from './types';
import { add, cross, norm, scale, unit } from './vector';
import { isMale } from './rules';

export const pathKey = (path: readonly string[]): string => JSON.stringify(path);
export const connectorKey = (ref: ConnectorRef): string =>
  JSON.stringify([ref.path, ref.connectorId, ref.cell ?? null]);
export function cloneConnector(c: Connector): Connector {
  return JSON.parse(JSON.stringify(c)) as Connector;
}
/** Grid rows run +Z for both top and bottom frames shown in spec §2. */
export function gridRow(c: Connector): Vec3 {
  return c.type.startsWith('antistud') ? cross(c.frame.ref, c.frame.axis) : cross(c.frame.axis, c.frame.ref);
}
export function connectorCells(c: Connector): { cell?: Cell; origin: Vec3 }[] {
  if (!c.grid) return [{ origin: c.frame.origin }];
  const result: { cell: Cell; origin: Vec3 }[] = [],
    row = gridRow(c);
  for (let r = 0; r < c.grid.rows; r++)
    for (let col = 0; col < c.grid.cols; col++) {
      if (c.grid.mask && !c.grid.mask[r]?.[col]) continue;
      result.push({
        cell: [r, col],
        origin: add(c.frame.origin, add(scale(c.frame.ref, col * c.grid.pitch), scale(row, r * c.grid.pitch))),
      });
    }
  return result;
}
/** Frame/linear transformation; semantic fields are deep-copied. Grid cell positions
 * are transformed individually by instantiateConnectors, including reflections. */
export function transformConnector(c: Connector, m: Matrix4): Connector {
  const result = cloneConnector(c);
  const axis = transformDirection(m, c.frame.axis),
    ref = transformDirection(m, c.frame.ref);
  result.frame = { origin: transformPoint(m, c.frame.origin), axis: unit(axis), ref: unit(ref) };
  const stableScale = (v: Vec3): number => (Math.abs(norm(v) - 1) < 1e-12 ? 1 : norm(v));
  const axial = stableScale(axis),
    radial = stableScale(ref);
  if (c.length !== undefined) result.length = c.length * axial;
  if (c.stops) result.stops = c.stops.map((s) => s * axial);
  if (c.diameter !== undefined) result.diameter = c.diameter * radial;
  if (c.studDepth !== undefined) result.studDepth = c.studDepth * axial;
  if (c.grid) {
    result.grid!.pitch *= radial;
    const transformedRow = unit(transformDirection(m, gridRow(c)));
    // A mirrored frame reverses its cross product. Reindex rows so its shape stays exact.
    if (transformedRow.some((v, i) => Math.abs(v - gridRow(result)[i]!) > 1e-5)) {
      result.frame.origin = add(result.frame.origin, scale(transformedRow, (c.grid.rows - 1) * result.grid!.pitch));
      if (result.grid!.mask) result.grid!.mask.reverse();
      if (result.cells)
        for (const cells of Object.values(result.cells)) for (const cell of cells) cell[0] = c.grid.rows - 1 - cell[0];
    }
  }
  return result;
}
export function instantiateConnectors(instance: ConnectorInstance): WorldConnector[] {
  return instance.connectors.flatMap((c) =>
    connectorCells(c).map(({ cell, origin }) => {
      const transformed = transformConnector(c, instance.worldMatrix);
      transformed.frame.origin = transformPoint(instance.worldMatrix, origin);
      const ref: ConnectorRef = { path: [...instance.path], connectorId: c.id, ...(cell ? { cell } : {}) };
      return { key: connectorKey(ref), ref, connector: transformed };
    }),
  );
}
export function segmentEnd(c: Connector): Vec3 {
  // Male length follows axis; a receiving hole extends into its part (-axis).
  return add(c.frame.origin, scale(c.frame.axis, (isMale(c) ? 1 : -1) * (c.length ?? 0)));
}
