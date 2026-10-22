import { createModel, ulid, type ModelDef, type Op } from '@brickloop/core';
import { deltaE2000, rgbToLab, type RGB } from './color.js';
import { checkDimensions, resizeImage, type RgbaImage } from './image.js';

export interface PaletteColor {
  id: string;
  rgb: RGB;
}
/** Host supplies only factory part/color combinations available in the active data pack. */
export interface Tile {
  partId: string;
  width: number;
  height: number;
  colorIds: readonly string[];
  rotatable?: boolean;
  style?: 'square' | 'round';
}
export interface MosaicCell {
  colorId: string;
}
export interface MosaicPiece {
  x: number;
  y: number;
  width: number;
  height: number;
  colorId: string;
  partId: string;
  rotated: boolean;
}
export interface MosaicOptions {
  width: number;
  height: number;
  palette: readonly PaletteColor[];
  tiles: readonly Tile[];
  style?: 'square' | 'round';
  dither?: boolean;
  merge?: boolean;
  background?: RGB;
}
export interface MosaicResult {
  width: number;
  height: number;
  cells: MosaicCell[];
  pieces: MosaicPiece[];
  preview: RgbaImage;
}
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function mergeTiles(
  cells: readonly MosaicCell[],
  width: number,
  height: number,
  tiles: readonly Tile[],
  merge = true,
): MosaicPiece[] {
  checkDimensions(width, height);
  if (cells.length !== width * height) throw new RangeError('Invalid cell count.');
  for (const tile of tiles) checkDimensions(tile.width, tile.height);
  const choices = tiles
    .flatMap((t) => [
      { ...t, rotated: false },
      ...(t.rotatable !== false && t.width !== t.height
        ? [{ ...t, width: t.height, height: t.width, rotated: true }]
        : []),
    ])
    .filter((t) => merge || t.width * t.height === 1)
    .sort(
      (a, b) =>
        b.width * b.height - a.width * a.height ||
        b.width - a.width ||
        b.height - a.height ||
        compareId(a.partId, b.partId) ||
        Number(a.rotated) - Number(b.rotated),
    );
  const used = new Uint8Array(cells.length),
    pieces: MosaicPiece[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (used[y * width + x]) continue;
      const colorId = cells[y * width + x]!.colorId;
      const tile = choices.find((t) => {
        if (x + t.width > width || y + t.height > height || !t.colorIds.includes(colorId)) return false;
        for (let dy = 0; dy < t.height; dy++)
          for (let dx = 0; dx < t.width; dx++) {
            const i = (y + dy) * width + x + dx;
            if (used[i] || cells[i]!.colorId !== colorId) return false;
          }
        return true;
      });
      if (!tile) throw new Error(`No tile available for color ${colorId}.`);
      for (let dy = 0; dy < tile.height; dy++) used.fill(1, (y + dy) * width + x, (y + dy) * width + x + tile.width);
      pieces.push({
        x,
        y,
        width: tile.width,
        height: tile.height,
        partId: tile.partId,
        colorId,
        rotated: tile.rotated,
      });
    }
  return pieces;
}
export function generateMosaic(image: RgbaImage, options: MosaicOptions): MosaicResult {
  const { width, height } = options;
  const preview = resizeImage(image, width, height, options.background);
  const colors = [...options.palette].sort((a, b) => compareId(a.id, b.id));
  const tiles = options.tiles.filter((t) => (t.style ?? 'square') === (options.style ?? 'square'));
  if (
    !colors.length ||
    new Set(colors.map((c) => c.id)).size !== colors.length ||
    colors.some((c) => !c.id || c.rgb.length !== 3 || c.rgb.some((v) => !Number.isFinite(v) || v < 0 || v > 255))
  )
    throw new Error('Invalid palette.');
  // A one-cell fallback is required for each color; merging must never force an out-of-pack substitution.
  if (colors.some((c) => !tiles.some((t) => t.width === 1 && t.height === 1 && t.colorIds.includes(c.id))))
    throw new Error('Every palette color requires a 1x1 tile.');
  const labs = colors.map((c) => rgbToLab(c.rgb)),
    cells: MosaicCell[] = [];
  const values = Float64Array.from(preview.data);
  const diffuse = (x: number, y: number, channel: number, value: number) => {
    if (x >= 0 && x < width && y < height)
      values[(y * width + x) * 4 + channel] = values[(y * width + x) * 4 + channel]! + value;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const rgb: RGB = [0, 1, 2].map((c) => Math.max(0, Math.min(255, values[i + c]!))) as [number, number, number];
      const lab = rgbToLab(rgb);
      let best = 0,
        distance = Infinity;
      labs.forEach((candidate, j) => {
        const d = deltaE2000(lab, candidate);
        if (d < distance) {
          distance = d;
          best = j;
        }
      });
      const color = colors[best]!;
      cells.push({ colorId: color.id });
      preview.data.set([...color.rgb, 255], i);
      if (options.dither)
        for (let c = 0; c < 3; c++) {
          const error = rgb[c]! - color.rgb[c]!;
          diffuse(x + 1, y, c, (error * 7) / 16);
          diffuse(x - 1, y + 1, c, (error * 3) / 16);
          diffuse(x, y + 1, c, (error * 5) / 16);
          diffuse(x + 1, y + 1, c, error / 16);
        }
    }
  const pieces = mergeTiles(cells, width, height, tiles, options.style !== 'round' && (options.merge ?? false));
  return { width, height, cells, pieces, preview };
}
/** Returns a complete submodel and insertion ops; applyExternal commits all of them as one undoable transaction. */
export function mosaicToOps(
  mosaic: MosaicResult,
  options: { parentModelId: string; parentStepId: string; name: string; id?: () => string; transform?: number[] },
): { model: ModelDef; instanceId: string; ops: Op[] } {
  const id = options.id ?? ulid,
    model = createModel(options.name, 'submodel', id),
    stepId = model.stepIds[0]!;
  for (const piece of mosaic.pieces) {
    const instanceId = id();
    model.instances[instanceId] = {
      id: instanceId,
      ref: { kind: 'part', partId: piece.partId },
      colorId: piece.colorId,
      stepId,
      groupId: null,
      // Cell (0,0) has center (0,0). Image rows run along +Z. LDraw tile origin is its top face.
      transform: [
        20 * (piece.x + (piece.width - 1) / 2),
        0,
        20 * (piece.y + (piece.height - 1) / 2),
        ...(piece.rotated ? [0, 0, 1, 0, 1, 0, -1, 0, 0] : [1, 0, 0, 0, 1, 0, 0, 0, 1]),
      ],
    };
    model.steps[stepId]!.instanceIds.push(instanceId);
  }
  const instanceId = id();
  return {
    model,
    instanceId,
    ops: [
      { type: 'model.add', items: [model] },
      {
        type: 'instance.add',
        items: [
          {
            modelId: options.parentModelId,
            instance: {
              id: instanceId,
              ref: { kind: 'model', modelId: model.id },
              colorId: 'inherit',
              transform: options.transform ?? [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
              stepId: options.parentStepId,
              groupId: null,
            },
          },
        ],
      },
    ],
  };
}
