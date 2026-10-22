import { createPaletteColorResolver } from '../../../../buildscript/src/colors.js';
import { isLDrawInternalColor } from '../../../../catalog/src/ldraw-internal-colors.js';
import type { StructurePlan } from './plan.js';

export interface PlanColor {
  id: string;
  legoName?: string | null;
  nameZh?: string;
  aliases?: string[];
  rgb: string;
  alpha?: number;
  ldrawCode?: number | null;
}
export interface PlanColorRepair {
  componentId: string;
  from: string;
  to: string | null;
  reason?: 'description' | 'palette-first' | 'duplicate';
}

/** The wider catalog supplies color intent, never output IDs outside the task palette. */
export function normalizePlanColors(
  plan: StructurePlan,
  palette: PlanColor[],
  catalog: PlanColor[] = palette,
  allowFallback = false,
) {
  const compact = (colors: PlanColor[]) =>
    colors
      .filter((color) => !isLDrawInternalColor({ ldrawCode: color.ldrawCode ?? null }))
      .map((color) => ({
        id: color.id,
        name: color.legoName ?? color.nameZh ?? color.id,
        aliases: [color.nameZh ?? '', color.id.replace(/^c:/, ''), ...(color.aliases ?? [])].filter(Boolean),
        rgb: color.rgb,
        alpha: color.alpha ?? 1,
        factory: true,
      }));
  const available = compact(palette),
    all = compact(catalog);
  const resolve = createPaletteColorResolver(available, all);
  const key = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
  function exact(value: string) {
    const byId = available.find((color) => color.id === value) ?? available.find((color) => color.id === 'c:' + value);
    if (byId) return byId.id;
    const matches = available.filter((color) =>
      [color.name, ...color.aliases].some((name) => key(name) === key(value)),
    );
    return matches.length === 1 ? matches[0]!.id : null;
  }
  const colorRepairs: PlanColorRepair[] = [];
  const issues: { path: string; message: string }[] = [];
  function descriptionColor(component: StructurePlan['components'][number]) {
    // Component descriptions are carried by names, part types and connection notes.
    for (const text of [component.name, ...component.partTypes, ...component.connections.map((c) => c.description)]) {
      const words = text.split(/[\s_,;，。；、:：()（）-]+/u).filter(Boolean);
      const maxWords = Math.max(4, ...all.map((c) => c.name.split(/[\s_-]+/).length));
      for (let i = 0; i < words.length; i++)
        for (let n = Math.min(maxWords, words.length - i); n > 0; n--) {
          const from = words.slice(i, i + n).join(' '),
            to = resolve(from);
          if (to) return { from, to };
        }
      for (const color of all)
        for (const alias of color.aliases)
          if (/[\u3400-\u9fff]/u.test(alias) && text.includes(alias)) {
            const to = resolve(alias);
            if (to) return { from: alias, to };
          }
    }
    return null;
  }
  const components = plan.components.map((component, componentIndex) => {
    const colors: string[] = [];
    for (const [colorIndex, from] of component.colors.entries()) {
      const to = exact(from) ?? (allowFallback ? resolve(from) : null);
      if (!to && !allowFallback) {
        colors.push(from);
        issues.push({
          path: `components.${componentIndex}.colors.${colorIndex}`,
          message: `Component ${component.id}: colour ${JSON.stringify(from)} is not an unambiguous task palette colour. Allowed palette colour IDs: ${JSON.stringify(available.map((color) => color.id))}.`,
        });
        continue;
      }
      if (to && colors.includes(to)) {
        colorRepairs.push({ componentId: component.id, from, to: null, reason: 'duplicate' });
        continue;
      }
      if (to) colors.push(to);
      if (to !== from) colorRepairs.push({ componentId: component.id, from, to });
    }
    if (!colors.length && allowFallback) {
      const described = descriptionColor(component);
      const to = described?.to ?? available[0]?.id;
      if (to) {
        colors.push(to);
        colorRepairs.push({
          componentId: component.id,
          from: described?.from ?? '',
          to,
          reason: described ? 'description' : 'palette-first',
        });
      }
    }
    return { ...component, colors };
  });
  return { plan: { ...plan, components }, colorRepairs, paletteColorIds: available.map((c) => c.id), issues };
}
