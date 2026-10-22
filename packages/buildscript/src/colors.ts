import { BuildFailure, Budget } from './limits.js';
import type { CompactColor, BuildWarning } from './types.js';

// Standard values from the corresponding colors in LDraw LDConfig.ldr.
const named: Record<string, string> = {
  red: '#B40000',
  green: '#00852B',
  blue: '#1E5AA8',
  yellow: '#FAC80A',
  orange: '#D67923',
  white: '#F4F4F4',
  black: '#1B2A34',
  brown: '#5F3109',
  gray: '#969696',
  grey: '#969696',
  pink: '#F6A9BB',
  purple: '#671F81',
  tan: '#D7BA8C',
  sand: '#897D62',
  transparent: '#FCFCFC',
  clear: '#FCFCFC',
};
const transparencyWords = new Set(['trans', 'transparent', 'translucent', 'clear', 'glass']);
function lab(hex: string): number[] {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = rgb as [number, number, number];
  const xyz = [
    (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883,
  ].map((v) => (v > 216 / 24389 ? Math.cbrt(v) : (v * 841) / 108 + 4 / 29));
  return [116 * xyz[1]! - 16, 500 * (xyz[0]! - xyz[1]!), 200 * (xyz[1]! - xyz[2]!)];
}

/** Palette-only adapter for plans; preserves ColorMapper's script resolution behavior. */
export function createPaletteColorResolver(
  available: (CompactColor & { aliases?: readonly string[] })[],
  all: (CompactColor & { aliases?: readonly string[] })[] = available,
): (value: string) => string | null {
  if (!available.length) return () => null;
  const mapper = new ColorMapper(available, all, [], new Budget(undefined));
  const key = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
  const byName = (colors: typeof available, value: string) =>
    colors.find((color) => [color.name, ...(color.aliases ?? [])].some((name) => key(name) === key(value)));
  return (value) => {
    const exact =
      available.find((color) => color.id === value) ??
      available.find((color) => color.id === 'c:' + value) ??
      byName(available, value);
    if (exact) return exact.id;
    const source = all.find((color) => color.id === value || color.id === 'c:' + value) ?? byName(all, value);
    try {
      return mapper.resolve(source?.id ?? value);
    } catch (error) {
      if (error instanceof BuildFailure && error.message.startsWith('Unknown color:')) return null;
      throw error;
    }
  };
}
function hex(value: string) {
  return /^#?[\da-f]{6}$/i.test(value) ? `#${value.replace('#', '')}` : undefined;
}
export class ColorMapper {
  private readonly cache = new Map<string, string>();
  private readonly labs: number[][];
  constructor(
    readonly available: CompactColor[],
    readonly all: CompactColor[],
    readonly warnings: BuildWarning[],
    readonly budget: Budget,
  ) {
    if (!available.length) throw new BuildFailure('PART_NOT_ALLOWED', 'The selected scope has no colors');
    for (const c of [...available, ...all]) {
      if (c.alpha !== undefined && (!Number.isFinite(c.alpha) || c.alpha < 0 || c.alpha > 1))
        throw new BuildFailure('RUNTIME', `Invalid catalog color ${c.id}`);
    }
    this.labs = available.map((c) => {
      const rgb = hex(c.rgb);
      if (!rgb) throw new BuildFailure('RUNTIME', `Invalid catalog color ${c.id}`);
      return lab(rgb);
    });
  }
  resolve(value: unknown): string {
    if (typeof value !== 'string') throw new BuildFailure('RUNTIME', 'Color must be an ID, name, #rrggbb or #rrggbbaa');
    const name = value.toLowerCase(),
      cached = this.cache.get(value);
    if (cached) return cached;
    const exact = this.available.find((c) => c.id === value || c.name.toLowerCase() === name);
    if (exact) {
      this.budget.memory(160 + value.length * 2);
      this.cache.set(value, exact.id);
      return exact.id;
    }
    const literal = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    let rgb: string | undefined,
      transparent = false;
    if (literal) {
      rgb = `#${literal[1]}`;
      transparent = literal[2] !== undefined && literal[2].toLowerCase() !== 'ff';
    } else {
      const source = this.all.find((c) => c.id === value || c.name.toLowerCase() === name);
      if (source) {
        rgb = hex(source.rgb);
        transparent = (source.alpha ?? 1) < 1;
      } else {
        const words = name.split(/[\s_-]+/).filter(Boolean);
        transparent = words.some((word) => transparencyWords.has(word));
        const base = words.filter((word) => !transparencyWords.has(word)).join(' ');
        if (transparent && base) {
          const preferred = this.all.find((c) => c.name.toLowerCase() === `transparent ${base}`);
          if (preferred) {
            if (this.available.some((c) => c.id === preferred.id)) {
              this.budget.memory(160 + value.length * 2);
              this.cache.set(value, preferred.id);
              return preferred.id;
            }
            rgb = hex(preferred.rgb);
          }
        }
        if (!rgb && base) {
          const source = this.all.find((c) => c.name.toLowerCase() === base);
          rgb = source ? hex(source.rgb) : Object.hasOwn(named, base) ? named[base] : undefined;
        } else if (transparent && !base) rgb = named.clear;
      }
    }
    if (!rgb) throw new BuildFailure('RUNTIME', `Unknown color: ${value}`);
    const target = lab(rgb),
      hasMatching = this.available.some((c) => (c.alpha ?? 1) < 1 === transparent);
    let distance = Infinity,
      index = 0;
    this.labs.forEach((candidate, i) => {
      const candidateTransparent = (this.available[i]!.alpha ?? 1) < 1;
      if (hasMatching && candidateTransparent !== transparent) return;
      const d = Math.hypot(...candidate.map((c, j) => c - target[j]!));
      if (d < distance || (d === distance && !candidateTransparent && (this.available[index]!.alpha ?? 1) < 1)) {
        distance = d;
        index = i;
      }
    });
    const result = this.available[index]!;
    if (!hasMatching) {
      this.budget.memory(256 + value.length * 2);
      this.warnings.push({
        code: 'COLOR_TRANSPARENCY',
        message: `${value} requested ${transparent ? 'transparent' : 'opaque'}; mapped to ${result.name} (${result.id})`,
      });
    }
    if (distance > 15) {
      this.budget.memory(256 + value.length * 2);
      this.warnings.push({
        code: 'COLOR_DISTANCE',
        message: `${value} mapped to ${result.name} (${result.id}); Lab distance ${distance.toFixed(1)}`,
      });
    }
    this.budget.memory(160 + value.length * 2);
    this.cache.set(value, result.id);
    return result.id;
  }
}
