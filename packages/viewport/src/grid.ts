import { LDU_PER_STUD } from '@brickloop/core';

export interface GridOptions {
  visible: boolean;
  sizeStuds: number;
  stepLdu: number;
}
export const defaultGrid: GridOptions = { visible: true, sizeStuds: 64, stepLdu: LDU_PER_STUD };
export type GridLineKind = 'subdivision' | 'stud' | 'major' | 'x' | 'z';
export interface GridLine {
  coordinate: number;
  parallel: 'x' | 'z';
  kind: GridLineKind;
}

export function gridLines(options: GridOptions): GridLine[] {
  if (
    !Number.isInteger(options.sizeStuds) ||
    options.sizeStuds <= 0 ||
    options.sizeStuds > 1024 ||
    ![20, 10, 5].includes(options.stepLdu)
  ) {
    throw new RangeError('Grid size must be 1..1024 studs and step must be 20, 10 or 5 LDU');
  }
  const half = (options.sizeStuds * LDU_PER_STUD) / 2;
  const lines: GridLine[] = [];
  for (
    let coordinate = Math.ceil(-half / options.stepLdu) * options.stepLdu;
    coordinate <= half;
    coordinate += options.stepLdu
  ) {
    for (const parallel of ['x', 'z'] as const) {
      const kind =
        coordinate === 0
          ? parallel
          : coordinate % (8 * LDU_PER_STUD) === 0
            ? 'major'
            : coordinate % LDU_PER_STUD === 0
              ? 'stud'
              : 'subdivision';
      lines.push({ coordinate, parallel, kind });
    }
  }
  return lines;
}
