import { readFile } from 'node:fs/promises';
import { colorNameZh } from './color-names-zh';
import type { ColorDef, ColorId, Finish } from './types';

export { LDRAW_INTERNAL_COLOR_CODES, isLDrawInternalColor } from './ldraw-internal-colors';

export function legoColorIdFromName(name: string): `c:${string}` {
  return `c:${name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')}`;
}

export function finishFromMaterial(text: string, alpha: number): Finish {
  if (/\bCHROME\b/i.test(text)) return 'chrome';
  if (/\bMETAL\b/i.test(text)) return 'metallic';
  if (/\bPEARLESCENT\b/i.test(text)) return 'pearl';
  if (/\bRUBBER\b/i.test(text)) return 'rubber';
  if (/\bGLITTER\b/i.test(text)) return 'glitter';
  if (/\bSPECKLE\b/i.test(text)) return 'speckle';
  if (/\bLUMINANCE\s+[1-9]/i.test(text)) return 'glow';
  return alpha < 1 ? 'transparent' : 'solid';
}

export function parseLDConfig(source: string): ColorDef[] {
  const colors: ColorDef[] = [];
  let lego: { id: number; name: string } | undefined;
  for (const line of source.split(/\r?\n/)) {
    const comment = /^0\s+\/\/\s*LEGOID\s+(\d+)(?:\s*\/\s*\d+)*\s*-\s*(.+?)\s*$/i.exec(line);
    if (comment) {
      lego = { id: Number(comment[1]), name: comment[2]! };
      continue;
    }
    const color = /^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[\da-f]{6})\s+EDGE\s+(#[\da-f]{6}|\d+)(.*)$/i.exec(
      line,
    );
    if (color) {
      const [, name, code, rgb, edge, material = ''] = color;
      const alpha = Number(/\bALPHA\s+(\d+)/i.exec(material)?.[1] ?? 255) / 255;
      if (alpha < 0 || alpha > 1) throw new Error(`LDConfig 颜色 ${code} 的 ALPHA 超出 0–255`);
      colors.push({
        id: lego ? legoColorIdFromName(lego.name) : `ld:${Number(code)}`,
        legoName: lego?.name ?? null,
        legoColorId: lego?.id ?? null,
        nameZh: colorNameZh(lego?.name ?? name!.replaceAll('_', ' ')),
        ldrawCode: Number(code),
        rgb: rgb!.toUpperCase(),
        edgeRgb: edge!.toUpperCase(),
        alpha,
        finish: finishFromMaterial(material, alpha),
      });
      lego = undefined; // A LEGOID applies to one definition, never leaks to the next colour.
    } else if (line.trim() && !/^0\s*$/.test(line)) {
      lego = undefined;
    }
  }
  const byCode = new Map(colors.map((color) => [color.ldrawCode, color]));
  for (const color of colors) {
    if (!color.edgeRgb.startsWith('#')) color.edgeRgb = byCode.get(Number(color.edgeRgb))?.rgb ?? '#333333';
  }
  return colors;
}

export async function readColors(path: string): Promise<ColorDef[]> {
  return parseLDConfig(await readFile(path, 'utf8'));
}

/** Inherited colour is a document sentinel, not a factory colour definition. */
export function colorIdFromLDrawCode(colors: readonly ColorDef[], code: number): ColorId | 'inherit' | undefined {
  return code === 16 ? 'inherit' : colors.find((color) => color.ldrawCode === code)?.id;
}
