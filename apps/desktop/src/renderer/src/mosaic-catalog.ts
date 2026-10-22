import type { Tile, PaletteColor } from '@brickloop/mosaic';
import type { LibraryColor, LibraryPart } from '../../shared/library-api';
import type { AssemblyCatalog } from '../../shared/assembly-api';

/** Plain rectangular tiles only: irregular/decorated shapes must not be treated as filled rectangles. */
export function mosaicTiles(parts: LibraryPart[], catalog: AssemblyCatalog): Tile[] {
  return parts.flatMap((part) => {
    const name = part.nameEn.trim().replace(/\s+/g, ' ');
    const factory = catalog.parts.find((p) => p.id === part.id && p.factory);
    if (!factory || !part.bboxLdu) return [];
    const round = /^(?:Tile|Plate) (?:Round 1 x 1|1 x 1 Round)(?: with (?:Groove|Solid Stud|Hollow Stud))?$/i.test(
      name,
    );
    if (!round && !/^Tile \d+ x \d+(?: with Groove)?$/i.test(name)) return [];
    const width = (part.bboxLdu[3] - part.bboxLdu[0]) / 20,
      height = (part.bboxLdu[5] - part.bboxLdu[2]) / 20;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      (round && (width !== 1 || height !== 1))
    )
      return [];
    return [
      {
        partId: part.id,
        width,
        height,
        colorIds: factory.colors,
        style: round ? ('round' as const) : ('square' as const),
      },
    ];
  });
}
export function mosaicPalette(colors: LibraryColor[], tiles: Tile[], style: 'square' | 'round'): PaletteColor[] {
  return colors
    .filter((c) => tiles.some((t) => t.style === style && t.width === 1 && t.height === 1 && t.colorIds.includes(c.id)))
    .map((c) => ({
      id: c.id,
      rgb: [1, 3, 5].map((n) => parseInt(c.rgb.slice(n, n + 2), 16)) as [number, number, number],
    }));
}
