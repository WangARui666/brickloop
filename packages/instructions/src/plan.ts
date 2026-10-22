import type { BrkDocument } from '@brickloop/core';
import { aggregateBom } from '@brickloop/io';
import { createI18n } from '@brickloop/i18n';
import { layoutPages } from './layout';
import type {
  InstructionOptions,
  InstructionPlan,
  InstructionStep,
  PartListItem,
  ResolvedInstructionOptions,
} from './types';

// A code-point order, independent of the machine's locale/ICU version.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planInstructions(document: BrkDocument, options: InstructionOptions = {}): InstructionPlan {
  const settings: ResolvedInstructionOptions = {
    paper: options.paper ?? 'A4-portrait',
    stepsPerPage: options.stepsPerPage ?? 1,
    includeCover: options.includeCover ?? true,
    includeBom: options.includeBom ?? true,
    pliShowNames: options.pliShowNames ?? false,
    dpi: options.dpi ?? 150,
    language: options.language ?? 'zh-CN',
    rootModelId: options.rootModelId ?? document.rootModelId,
    defaultColorId: options.defaultColorId ?? 'ld:16',
    metadataDate: options.metadataDate ?? '2000-01-01T00:00:00.000Z',
  };
  if (!['A4-portrait', 'A4-landscape', 'A5', 'Letter'].includes(settings.paper))
    throw new RangeError('Unsupported paper');
  if (![1, 2, 4].includes(settings.stepsPerPage)) throw new RangeError('Unsupported stepsPerPage');
  if (!Number.isFinite(settings.dpi) || settings.dpi <= 0) throw new RangeError('dpi must be positive and finite');
  if (!['zh-CN', 'en'].includes(settings.language)) throw new RangeError('Unsupported language');
  const date = new Date(settings.metadataDate);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid metadataDate');
  settings.metadataDate = date.toISOString();
  const root = document.models[settings.rootModelId];
  if (!root) throw new RangeError('Missing root model');
  const catalog = options.catalog ?? {};
  const parts = new Map(catalog.parts?.map((part) => [part.id, part]));
  const colors = new Map(catalog.colors?.map((color) => [color.id, color]));
  const factories = new Map(catalog.factoryParts?.map((part) => [part.partId, part]));
  const categoryOrder = new Map(catalog.categories?.map((category) => [category.id, category.order]));
  const sortItems = (a: PartListItem, b: PartListItem) =>
    Number(a.kind === 'model') - Number(b.kind === 'model') ||
    (categoryOrder.get(a.categoryId) ?? Number.MAX_SAFE_INTEGER) -
      (categoryOrder.get(b.categoryId) ?? Number.MAX_SAFE_INTEGER) ||
    compare(a.categoryId, b.categoryId) ||
    compare(a.colorId, b.colorId) ||
    compare(a.number, b.number) ||
    compare(a.id, b.id);
  const colorName = (id: string) => {
    const color = colors.get(id);
    return (settings.language === 'en' ? color?.legoName : color?.nameZh) || id;
  };
  const steps: InstructionStep[] = [];
  const built = new Set<string>();
  const ancestors = new Set<string>();
  function visit(modelId: string, prefix: string, inheritedColorId: string): void {
    if (ancestors.has(modelId)) throw new RangeError('Cyclic model reference');
    if (built.has(modelId)) return;
    const model = document.models[modelId];
    if (!model) throw new RangeError('Missing model reference');
    if (!model.stepIds.length) throw new RangeError('Model has no steps');
    ancestors.add(modelId);
    for (const [stepIndex, stepId] of model.stepIds.entries()) {
      const step = model.steps[stepId];
      if (!step) throw new RangeError('Missing step');
      const number = prefix ? `${prefix}.${stepIndex + 1}` : String(stepIndex + 1);
      const instances = step.instanceIds.map((id) => {
        const instance = model.instances[id];
        if (!instance || instance.stepId !== stepId) throw new RangeError('Invalid step membership');
        return instance;
      });
      const children = [
        ...new Set(instances.flatMap((instance) => (instance.ref.kind === 'model' ? [instance.ref.modelId] : []))),
      ];
      // Multiple new definitions in one parent step need an additional ordinal to keep numbers unique.
      const newChildren = children.filter((id) => !built.has(id));
      for (const [index, childId] of newChildren.entries()) {
        const instance = instances.find((item) => item.ref.kind === 'model' && item.ref.modelId === childId)!;
        visit(
          childId,
          newChildren.length === 1 ? number : `${number}.${index + 1}`,
          instance.colorId === 'inherit' ? inheritedColorId : instance.colorId,
        );
      }
      const grouped = new Map<string, PartListItem>();
      for (const instance of instances) {
        const colorId = instance.colorId === 'inherit' ? inheritedColorId : instance.colorId;
        const ref = instance.ref;
        const id = ref.kind === 'part' ? ref.partId : ref.modelId;
        const key = JSON.stringify(ref.kind === 'part' ? [ref.kind, id, colorId] : [ref.kind, id]);
        const existing = grouped.get(key);
        if (existing) {
          existing.quantity++;
          continue;
        }
        if (ref.kind === 'part') {
          const part = parts.get(id),
            factory = factories.get(id);
          grouped.set(key, {
            kind: 'part',
            id,
            colorId,
            quantity: 1,
            name: (settings.language === 'en' ? part?.nameEn : (factory?.factoryName ?? part?.nameZh)) || id,
            colorName: colorName(colorId),
            number: part?.legoNo ?? id,
            factoryNo: factory?.factoryNo ?? '',
            categoryId: factory?.categoryId ?? part?.categoryId ?? '',
            image: { kind: 'part', partId: id, colorId },
          });
        } else {
          const child = document.models[id];
          if (!child) throw new RangeError('Missing model reference');
          grouped.set(key, {
            kind: 'model',
            id,
            colorId,
            quantity: 1,
            name: child.name,
            colorName: colorName(colorId),
            number: id,
            factoryNo: '',
            categoryId: '',
            image: { kind: 'step', modelId: id, stepIndex: child.stepIds.length - 1, inheritedColorId: colorId },
          });
        }
      }
      steps.push({
        modelId,
        modelName: model.name,
        stepIndex,
        number,
        isSubmodel: modelId !== settings.rootModelId,
        inheritedColorId,
        description: step.description ?? '',
        pli: [...grouped.values()].sort(sortItems),
      });
    }
    ancestors.delete(modelId);
    built.add(modelId);
  }
  visit(settings.rootModelId, '', settings.defaultColorId);
  // Re-root a shallow view for the public BOM API; never change the source document.
  const bom = aggregateBom({ ...document, rootModelId: root.id }, catalog, { defaultColorId: settings.defaultColorId });
  const bomItems = bom.rows
    .map((row): PartListItem => ({
      kind: 'part',
      id: row.partId,
      colorId: row.colorId,
      quantity: row.quantity,
      name: settings.language === 'en' ? row.partNameEn : row.partName,
      colorName: colorName(row.colorId),
      number: row.legoNo,
      factoryNo: row.factoryNo,
      categoryId: row.category,
      image: { kind: 'part', partId: row.partId, colorId: row.colorId },
    }))
    .sort(sortItems);
  const i18n = createI18n({ language: settings.language });
  const title = (root.id === document.rootModelId ? document.meta.title : root.name) || i18n.t('instructions.untitled');
  return {
    options: settings,
    title,
    author: document.meta.author,
    steps,
    bom,
    pages: layoutPages(settings, title, document.meta.author, steps, bomItems, i18n),
  };
}
