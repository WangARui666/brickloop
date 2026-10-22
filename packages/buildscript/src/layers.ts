import type { BuildInstance, CompactColor, PartSize } from './types.js';

/** Render already flattened model instances. Unknown sizes are explicitly listed, never guessed. */
export function renderLayers(
  instances: readonly BuildInstance[],
  partSizes: Readonly<Record<string, PartSize>>,
  fromLevel: number,
  toLevel: number,
  colors: readonly CompactColor[],
): string {
  if (!Number.isInteger(fromLevel) || !Number.isInteger(toLevel) || toLevel < fromLevel || toLevel - fromLevel >= 128)
    throw new RangeError('Request an inclusive range of at most 128 integer levels');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    used = [...new Set(instances.map((i) => i.colorId))].sort();
  if (used.length > alphabet.length) throw new RangeError('Layer maps support at most 62 colors');
  const glyph = new Map(used.map((id, i) => [id, alphabet[i]!]));
  const unknown = new Set<string>();
  const rows = instances
    .flatMap((i) => {
      const s = partSizes[i.partId];
      if (!s) {
        unknown.add(i.partId);
        return [];
      }
      if (![s.w, s.d, s.h].every((n) => Number.isInteger(n) && n > 0))
        throw new RangeError(`Invalid size: ${i.partId}`);
      const turn = i.pose.rotY % 180 !== 0,
        w = turn ? s.d : s.w,
        d = turn ? s.w : s.d;
      return [
        { x: i.pose.x - w / 2, z: i.pose.z - d / 2, y: i.pose.level - s.h, w, d, h: s.h, c: glyph.get(i.colorId)! },
      ];
    })
    .filter((p) => p.y <= toLevel && p.y + p.h > fromLevel);
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (const p of rows) {
    x0 = Math.min(x0, Math.floor(p.x));
    z0 = Math.min(z0, Math.floor(p.z));
    x1 = Math.max(x1, Math.ceil(p.x + p.w));
    z1 = Math.max(z1, Math.ceil(p.z + p.d));
  }
  if (!rows.length) {
    x0 = z0 = 0;
    x1 = z1 = 1;
  }
  let scale = 1;
  while (Math.ceil((x1 - x0) / scale) > 64 || Math.ceil((z1 - z0) / scale) > 64) scale *= 2;
  const width = Math.ceil((x1 - x0) / scale),
    depth = Math.ceil((z1 - z0) / scale);
  const lines = [
    `Legend: . empty; ${used.map((id) => `${glyph.get(id)} ${id} ${colors.find((c) => c.id === id)?.name ?? 'unknown'}`).join('; ')}`,
  ];
  if (unknown.size) lines.push(`Skipped unknown part sizes: ${[...unknown].join(', ')}`);
  if (scale > 1)
    lines.push(
      `Merged ${scale}×${scale} cells per character (repeated 2×2 reduction); dominant occupied color, ties by legend. Empty space may be hidden.`,
    );
  const labelWidth = String(Math.max(Math.abs(z0), Math.abs(z1))).length + 1;
  lines.push(`x → ${x0} … ${x1 - 1}; z ↓ ${z0} … ${z1 - 1}; column step ${scale}`);
  for (let y = fromLevel; y <= toLevel; y++) {
    lines.push(
      `level ${y}`,
      `${' '.repeat(labelWidth + 2)}${Array.from({ length: width }, (_, i) => String((((x0 + i * scale) % 10) + 10) % 10)).join('')}`,
    );
    const counts = Array.from({ length: width * depth }, () => new Map<string, number>());
    for (const p of rows)
      if (y >= p.y && y < p.y + p.h) {
        // Intersect part rectangles with display bins: work is bounded by the rendered grid.
        for (
          let bz = Math.max(0, Math.floor((p.z - z0) / scale));
          bz < Math.min(depth, Math.ceil((p.z + p.d - z0) / scale));
          bz++
        )
          for (
            let bx = Math.max(0, Math.floor((p.x - x0) / scale));
            bx < Math.min(width, Math.ceil((p.x + p.w - x0) / scale));
            bx++
          ) {
            const area =
              (Math.min(p.x + p.w, x0 + (bx + 1) * scale) - Math.max(p.x, x0 + bx * scale)) *
              (Math.min(p.z + p.d, z0 + (bz + 1) * scale) - Math.max(p.z, z0 + bz * scale));
            const bin = counts[bz * width + bx]!;
            bin.set(p.c, (bin.get(p.c) ?? 0) + area);
          }
      }
    for (let z = 0; z < depth; z++) {
      let line = '';
      for (let x = 0; x < width; x++)
        line +=
          [...counts[z * width + x]!].sort(
            (a, b) => b[1] - a[1] || alphabet.indexOf(a[0]) - alphabet.indexOf(b[0]),
          )[0]?.[0] ?? '.';
      lines.push(`${String(z0 + z * scale).padStart(labelWidth)} |${line}`);
    }
  }
  return lines.join('\n');
}
