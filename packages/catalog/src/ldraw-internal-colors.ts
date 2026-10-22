import type { ColorDef } from './types';

/** LDConfig.ldr's "LDraw Internal Common Material Colours": internal part materials, not brick colors. */
export const LDRAW_INTERNAL_COLOR_CODES: ReadonlySet<number> = new Set([16, 24, 493, 494, 495, 10047]);

export function isLDrawInternalColor(color: Pick<ColorDef, 'ldrawCode'>): boolean {
  return color.ldrawCode !== null && LDRAW_INTERNAL_COLOR_CODES.has(color.ldrawCode);
}
