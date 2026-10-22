import { expandInstances, orderedInstances, pathStartsWith, resolvePath, ulid } from '@brickloop/core';
import type { BrkDocument, ModelDef } from '@brickloop/core';
import { emptyUsage, estimateInputTokens } from '@brickloop/ai';
import type { ToolInput } from '@brickloop/ai';
import type { BomResult } from '@brickloop/io';
import type { ColorDef } from '@brickloop/catalog';
import { deltaE2000, rgbToLab } from '@brickloop/mosaic/color';
import type { SavedTurn } from '../../shared/ai-api';
import { completedTurnHistory } from './ai-history';

export type Shortcut = 'repair' | 'factory' | 'palette' | 'explain';
export type LocalShortcut = NonNullable<SavedTurn['local']>['shortcut'];

export function precheckShortcut(
  shortcut: Shortcut | null,
  text: string,
  prompts: Record<Shortcut, string>,
  images: readonly unknown[],
  mentions: readonly unknown[],
): Shortcut | null {
  return shortcut && text === prompts[shortcut] && !images.length && !mentions.length && !text.includes('@')
    ? shortcut
    : null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const path = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.length > 0);
// normalized() exposes instance paths for these kinds. Cycle's singular "path"
// instead addresses document validation data, so it cannot prove scope exclusion.
const locatedKinds = new Set([
  'collision',
  'collisionUnknown',
  'floating',
  'connectivity',
  'non_factory_part',
  'non_factory_color',
  'unavailable_color',
  'duplicate',
  'missingGeometry',
  'unreviewedConnectors',
  'offGrid',
]);

/** True only when validate proves this scope clean. Uncertainty falls through to AI. */
export function precheckIsClean(result: unknown, paths: string[][] | null): boolean {
  if (!record(result) || result.ok !== true || !record(result.data) || !Array.isArray(result.data.issues)) return false;
  if (!Array.isArray(result.warnings) || result.warnings.length) return false;
  if (paths !== null && (!paths.length || !paths.every(path))) return false;
  return result.data.issues.every((issue: unknown) => {
    if (!record(issue) || typeof issue.kind !== 'string' || !locatedKinds.has(issue.kind)) return false;
    if (!paths || !Array.isArray(issue.paths) || !issue.paths.length || !issue.paths.every(path)) return false;
    return issue.paths.every((issuePath) => !paths.some((selected) => pathStartsWith(issuePath, selected)));
  });
}

export async function runLocalPrecheck(
  validate: (input: ToolInput<'validate'>) => Promise<unknown>,
  shortcut: 'repair' | 'factory',
  paths: string[][] | null,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => validate(shortcut === 'factory' ? { checks: ['non_factory_part', 'non_factory_color'] } : {}))
        .then((result) => precheckIsClean(result, paths)),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 20_000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ShortcutStatisticsServices {
  bom(doc: BrkDocument): Promise<BomResult>;
  colors(): Promise<{ all: ColorDef[]; factory: ColorDef[] }>;
}
export type ShortcutStatistics = { colorCount: number; attachment?: string };
type StatisticsText = (key: string, values?: Record<string, string | number>) => string;
const statisticsStart = '\n\n<local-statistics>\n';
const statisticsEnd = '\n</local-statistics>';

/** The same text travels through IPC, model input and history; no parallel payload can drift. */
export function splitLocalStatistics(user: string): { prompt: string; attachment?: string } {
  const start = user.lastIndexOf(statisticsStart);
  return start >= 0 && user.endsWith(statisticsEnd)
    ? { prompt: user.slice(0, start), attachment: user.slice(start + statisticsStart.length, -statisticsEnd.length) }
    : { prompt: user };
}

/** Filter occurrences, not shared definitions. Retain original paths alongside valid snapshot IDs. */
async function statisticsScope(
  doc: BrkDocument,
  paths: string[][] | null,
  snapshot: boolean,
  checkpoint: () => Promise<void> | undefined,
) {
  if (paths?.some((path) => !path.length || !resolvePath(doc, path))) throw new Error('INVALID_SCOPE');
  const models: Record<string, ModelDef> = {};
  const submodels: { path: string[]; name: string; partCount: number; colors: Set<string> }[] = [];
  let submodelCount = 0;
  // A fully selected document can use the original BOM without cloning its occurrences.
  const whole =
    paths === null ||
    orderedInstances(doc.models[doc.rootModelId]!).every((instance) =>
      paths.some((prefix) => pathStartsWith([instance.id], prefix)),
    );
  const copy = snapshot && !whole;
  async function visit(modelId: string, path: string[], ancestors: Set<string>): Promise<string> {
    if (ancestors.has(modelId) || !doc.models[modelId]) throw new Error('INVALID_MODEL');
    const model = doc.models[modelId]!;
    const id = copy ? ulid() : modelId;
    const stepId = copy ? ulid() : model.stepIds[0]!;
    const instances: ModelDef['instances'] = {};
    for (const instance of orderedInstances(model)) {
      const pause = checkpoint();
      if (pause) await pause;
      const nextPath = [...path, instance.id];
      const selected = paths === null || paths.some((prefix) => pathStartsWith(nextPath, prefix));
      if (!selected && !paths?.some((prefix) => pathStartsWith(prefix, nextPath))) continue;
      const instanceId = copy ? ulid() : instance.id;
      let ref = instance.ref;
      if (ref.kind === 'model') {
        // A partially selected submodel is summarized from its retained descendants only.
        submodelCount++;
        if (submodels.length < 50)
          submodels.push({ path: nextPath, name: doc.models[ref.modelId]!.name, partCount: 0, colors: new Set() });
        const child = await visit(ref.modelId, nextPath, new Set(ancestors).add(modelId));
        if (copy) ref = { ...ref, modelId: child };
      }
      if (copy) instances[instanceId] = { ...instance, id: instanceId, ref, stepId, groupId: null };
    }
    if (copy)
      models[id] = {
        ...model,
        id,
        instances,
        stepIds: [stepId],
        steps: { [stepId]: { id: stepId, instanceIds: Object.keys(instances) } },
      };
    return id;
  }
  const rootModelId = await visit(doc.rootModelId, [], new Set());
  return { doc: copy ? { ...doc, rootModelId, models, groups: {} } : doc, submodels, submodelCount };
}

/** Count expanded occurrences without geometry analysis; reuse the BOM for localized part names. */
export async function buildShortcutStatistics(
  shortcut: 'palette' | 'explain',
  document: BrkDocument,
  paths: string[][] | null,
  services: ShortcutStatisticsServices,
  t: StatisticsText,
  language: string,
  check: () => void = () => undefined,
): Promise<ShortcutStatistics> {
  let work = 0;
  const checkpoint = () => {
    check();
    if (++work % 500 === 0) return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(check);
    return undefined;
  };
  check();
  const scope = await statisticsScope(document, paths, shortcut === 'explain', checkpoint);
  const byPath = new Map(scope.submodels.map((model) => [JSON.stringify(model.path), model]));
  const counts = new Map<
    string,
    { count: number; distribution: Map<string, { modelPath: string[]; count: number }> }
  >();
  const rows = expandInstances(document);
  let partCount = 0;
  check();
  // One pass over expanded occurrences: ancestor totals and direct-owner color buckets.
  for (const row of rows) {
    const pause = checkpoint();
    if (pause) await pause;
    if (paths && !paths.some((prefix) => pathStartsWith(row.path, prefix))) continue;
    partCount++;
    let color = counts.get(row.colorId);
    if (!color) counts.set(row.colorId, (color = { count: 0, distribution: new Map() }));
    color.count++;
    const modelPath = row.path.slice(0, -1),
      key = JSON.stringify(modelPath);
    const distribution = color.distribution.get(key);
    if (distribution) distribution.count++;
    else color.distribution.set(key, { modelPath, count: 1 });
    for (let depth = 1; depth < row.path.length; depth++) {
      const model = byPath.get(JSON.stringify(row.path.slice(0, depth)));
      if (model) {
        model.partCount++;
        model.colors.add(row.colorId);
      }
    }
  }
  const colorCount = counts.size;
  if (shortcut === 'palette' && colorCount <= 1) return { colorCount };
  const colors: {
    id: string;
    name: string;
    count: number;
    factory: boolean;
    distribution: { modelPath: string[]; count: number }[];
    omittedDistribution: number;
  }[] = [];
  const pairs: { colors: [string, string]; deltaE: number }[] = [];
  const submodels = scope.submodels.map(({ path, name, partCount, colors }) => ({
    path,
    name,
    partCount,
    colorCount: colors.size,
  }));
  const parts: { id: string; name: string; count: number }[] = [];
  let partTypes = 0;
  if (shortcut === 'palette') {
    const catalog = await services.colors();
    check();
    const definitions = new Map(catalog.all.map((color) => [String(color.id), color]));
    const factory = new Set<string>(catalog.factory.map((color) => color.id));
    const labs = new Map<string, ReturnType<typeof rgbToLab>>();
    for (const [id, { count, distribution }] of counts) {
      const pause = checkpoint();
      if (pause) await pause;
      const color = definitions.get(id);
      if (!color || !/^#[\da-f]{6}$/i.test(color.rgb)) throw new Error('COLOR_UNAVAILABLE');
      const rgb = [1, 3, 5].map((offset) => parseInt(color.rgb.slice(offset, offset + 2), 16));
      labs.set(id, rgbToLab([rgb[0]!, rgb[1]!, rgb[2]!]));
      colors.push({
        id,
        name: language === 'en' ? (color.legoName ?? color.nameZh) : color.nameZh,
        count,
        factory: factory.has(id),
        distribution: [...distribution.values()]
          .sort((a, b) => b.count - a.count || JSON.stringify(a.modelPath).localeCompare(JSON.stringify(b.modelPath)))
          .slice(0, 10),
        omittedDistribution: Math.max(0, distribution.size - 10),
      });
    }
    colors.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    for (let i = 0; i < colors.length; i++) {
      check();
      for (let j = i + 1; j < colors.length; j++) {
        const pause = checkpoint();
        if (pause) await pause;
        const a = colors[i]!.id,
          b = colors[j]!.id;
        pairs.push({ colors: [a, b], deltaE: deltaE2000(labs.get(a)!, labs.get(b)!) });
        pairs.sort((a, b) => a.deltaE - b.deltaE || a.colors.join('/').localeCompare(b.colors.join('/')));
        if (pairs.length > 10) pairs.pop();
      }
    }
    for (const pair of pairs) pair.deltaE = Number(pair.deltaE.toFixed(3));
  } else {
    const bom = await services.bom(scope.doc);
    check();
    partTypes = bom.summary.partTypes;
    const grouped = new Map<string, (typeof parts)[number]>();
    for (const row of bom.rows) {
      const pause = checkpoint();
      if (pause) await pause;
      const part = grouped.get(row.partId);
      if (part) part.count += row.quantity;
      else
        grouped.set(row.partId, {
          id: row.partId,
          name: language === 'en' ? row.partNameEn : row.partName,
          count: row.quantity,
        });
    }
    parts.push(...[...grouped.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, 30));
  }
  const totals = {
    colors: colors.length,
    pairs: (colors.length * (colors.length - 1)) / 2,
    submodels: scope.submodelCount,
    parts: partTypes,
  };
  const serialize = () => {
    const omitted =
      shortcut === 'palette'
        ? { colors: totals.colors - colors.length, pairs: totals.pairs - pairs.length }
        : { submodels: totals.submodels - submodels.length, parts: totals.parts - parts.length };
    const data = {
      scope: paths ? t('aiUi.localCheck.selection', { count: paths.length }) : t('aiUi.localCheck.document'),
      ...(shortcut === 'palette'
        ? { colorCount, colors, distributionScope: 'direct-parts', colorDifference: 'CIEDE2000 (sRGB D65)', pairs }
        : { summary: { partCount, colorCount }, submodels, parts }),
      omitted,
      ...(Object.values(omitted).some(Boolean) || colors.some((color) => color.omittedDistribution)
        ? { note: t('aiUi.localStatistics.omitted') }
        : {}),
    };
    const intro =
      t('aiUi.localStatistics.intro') +
      (shortcut === 'palette'
        ? ' ' + t('aiUi.localStatistics.paletteHint') + (paths ? ' ' + t('aiUi.localStatistics.selectionHint') : '')
        : ' ' + t('aiUi.localStatistics.explainHint'));
    return statisticsStart + intro + '\n' + JSON.stringify(data) + statisticsEnd;
  };
  let attachment = serialize();
  // Use the existing conservative UTF-8 token estimator, including the text envelope.
  while (estimateInputTokens('', [{ role: 'user', content: [{ type: 'text', text: attachment }] }], []) > 4000) {
    const pause = checkpoint();
    if (pause) await pause;
    const distribution = colors
      .filter((color) => color.distribution.length > 1)
      .sort((a, b) => JSON.stringify(b.distribution).length - JSON.stringify(a.distribution).length)[0];
    if (distribution) {
      distribution.distribution.pop();
      distribution.omittedDistribution++;
      attachment = serialize();
      continue;
    }
    // Drop whole tail rows, retaining the closest pairs and most-used parts.
    const lists = [colors, pairs, submodels, parts].filter((rows) => rows.length);
    const largest = lists.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!largest) throw new Error('STATISTICS_TOO_LARGE');
    largest.pop();
    attachment = serialize();
  }
  return { colorCount, attachment };
}

/** Fail open after one second and abort cancellable services; chunks stop at the next checkpoint. */
export async function runShortcutStatistics(
  build: (check: () => void, signal: AbortSignal) => Promise<ShortcutStatistics>,
  unchanged: () => boolean,
): Promise<ShortcutStatistics | null> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    controller.signal.throwIfAborted();
    if (performance.now() - started >= 1000 || !unchanged()) throw new Error('STATISTICS_STALE');
  };
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => build(check, controller.signal))
        .then((result) => {
          check();
          return result;
        }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, 1000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export function createLocalTurn(
  documentId: string,
  user: string,
  text: string,
  local: NonNullable<SavedTurn['local']>,
): SavedTurn {
  const turn: SavedTurn = {
    id: ulid(),
    documentId,
    user,
    text,
    images: [],
    events: [],
    local: structuredClone(local),
    ...(local.paths ? { selectionCount: local.paths.length } : {}),
  };
  const history = completedTurnHistory(turn);
  return {
    ...turn,
    history,
    result: {
      reason: 'completed',
      text,
      history,
      usage: emptyUsage(),
      cost: { amount: 0, currency: 'USD', label: '' },
      toolCalls: 0,
      elapsedMs: 0,
      unresolvedIssues: [],
    },
  };
}
