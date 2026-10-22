import type { createI18n } from '@brickloop/i18n';
import type {
  Box,
  InstructionPage,
  InstructionStep,
  PartListItem,
  ResolvedInstructionOptions,
  TextElement,
} from './types';

const paperSizes = {
  'A4-portrait': [595.28, 841.89],
  'A4-landscape': [841.89, 595.28],
  A5: [419.53, 595.28],
  Letter: [612, 792],
} as const;
const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });

export function layoutPages(
  options: ResolvedInstructionOptions,
  title: string,
  author: string,
  steps: InstructionStep[],
  bom: PartListItem[],
  i18n: ReturnType<typeof createI18n>,
): InstructionPage[] {
  const [width, height] = paperSizes[options.paper];
  const margin = 30,
    gap = 20,
    contentTop = 62,
    contentBottom = height - 42;
  const pages: InstructionPage[] = [];
  // PDF text is not HTML; preserve literal catalog/user names in interpolations.
  const t = (key: string, values: Record<string, string | number> = {}) =>
    i18n.t(key, { ...values, interpolation: { escapeValue: false } });
  const contentWidth = width - margin * 2;
  const text = (
    page: InstructionPage,
    value: string,
    bounds: Box,
    size = 10,
    role: TextElement['role'] = 'label',
    bold = false,
    align: TextElement['align'] = 'left',
    style: Pick<TextElement, 'overflow' | 'color'> = {},
  ) => {
    page.elements.push({ kind: 'text', role, text: value, box: bounds, size, bold, align, ...style });
  };
  const line = (page: InstructionPage, bounds: Box, direction: 'horizontal' | 'vertical' = 'horizontal') => {
    page.elements.push({ kind: 'line', box: bounds, direction, thickness: 0.5, color: '#D9D9D9' });
  };
  const newPage = (kind: InstructionPage['kind'], heading: string, submodel = false): InstructionPage => {
    const page: InstructionPage = { kind, width, height, stepIndices: [], elements: [] };
    text(page, heading, box(margin, 22, contentWidth, 28), 12, 'header', true);
    if (submodel) line(page, box(margin, 51, contentWidth, 0.5));
    pages.push(page);
    return page;
  };
  const quantity = (count: number) => t('instructions.quantity', { count });

  function listPages(kind: 'bom' | 'pli', heading: string, entries: PartListItem[], stepIndex?: number) {
    // A4 landscape targets 10 columns (~78 pt after margins); other papers
    // use a nominal 96 pt cell. All retain a 64 pt thumbnail.
    const cols = Math.max(1, Math.round(contentWidth / (options.paper === 'A4-landscape' ? 78 : 96)));
    const cellWidth = contentWidth / cols;
    const cellHeight = kind === 'bom' ? 116 : options.pliShowNames ? 98 : 84;
    const rowPitch = cellHeight + 4;
    const rows = Math.max(1, Math.floor((contentBottom - contentTop + 4) / rowPitch));
    const capacity = cols * rows;
    for (let offset = 0; offset < Math.max(entries.length, 1); offset += capacity) {
      const page = newPage(kind, heading, stepIndex !== undefined && steps[stepIndex]!.isSubmodel);
      if (stepIndex !== undefined) page.stepIndices.push(stepIndex);
      const shown = entries.slice(offset, offset + capacity);
      if (!shown.length) text(page, t('instructions.empty'), box(margin, 74, contentWidth, 30), 12);
      shown.forEach((item, index) => {
        const x = margin + (index % cols) * cellWidth,
          y = contentTop + Math.floor(index / cols) * rowPitch;
        const textBox = (top: number, h: number) => box(x + 4, y + top, cellWidth - 8, h);
        page.elements.push({ kind: 'image', box: box(x + (cellWidth - 64) / 2, y, 64, 64), source: item.image });
        text(page, quantity(item.quantity), textBox(66, 15), 12, 'quantity', true, 'center');
        if (kind === 'bom' || options.pliShowNames)
          text(page, item.name, textBox(82, 11), 8, 'name', false, 'center', { overflow: 'ellipsis' });
        if (kind === 'bom') {
          text(page, item.colorName, textBox(94, 10), 7.5, 'label', false, 'center', { overflow: 'ellipsis' });
          const number = item.factoryNo
            ? t('instructions.factoryNumber', { number: item.factoryNo })
            : t('instructions.partNumber', { number: item.number });
          text(page, number, textBox(105, 10), 7, 'label', false, 'center', { overflow: 'ellipsis', color: '#777777' });
        }
      });
      for (let row = 1; row < Math.ceil(shown.length / cols); row++)
        line(page, box(margin, contentTop + row * rowPitch - 2, contentWidth, 0.5));
    }
  }
  if (options.includeCover) {
    const page = newPage('cover', t('instructions.title'));
    text(page, title, box(margin, 80, contentWidth, 76), 28, 'name', true, 'center');
    const lastRoot = [...steps].reverse().find((step) => !step.isSubmodel);
    if (lastRoot)
      page.elements.push({
        kind: 'image',
        box: box(margin, 180, contentWidth, height - 310),
        source: {
          kind: 'step',
          modelId: lastRoot.modelId,
          stepIndex: lastRoot.stepIndex,
          inheritedColorId: lastRoot.inheritedColorId,
        },
      });
    if (author)
      text(
        page,
        t('instructions.author', { name: author }),
        box(margin, height - 100, contentWidth, 30),
        11,
        'label',
        false,
        'center',
      );
  }
  // Group contiguous steps of one definition so a page header never describes another model.
  for (let offset = 0; offset < steps.length;) {
    const first = steps[offset]!;
    const batch: number[] = [];
    while (batch.length < options.stepsPerPage && steps[offset]?.modelId === first.modelId) batch.push(offset++);
    const page = newPage(
      'steps',
      first.isSubmodel ? t('instructions.submodel', { name: first.modelName }) : title,
      first.isSubmodel,
    );
    page.stepIndices = batch;
    // An incomplete page expands to one or two slots instead of leaving empty quadrants.
    const slots = batch.length > 2 ? 4 : batch.length;
    const cols = slots === 4 || (slots === 2 && width > height) ? 2 : 1;
    const rows = Math.ceil(slots / cols);
    const cellWidth = (contentWidth - gap * (cols - 1)) / cols;
    const cellHeight = (contentBottom - contentTop - gap * (rows - 1)) / rows;
    if (cols > 1)
      line(page, box(margin + cellWidth + gap / 2, contentTop, 0.5, contentBottom - contentTop), 'vertical');
    if (rows > 1) line(page, box(margin, contentTop + cellHeight + gap / 2, contentWidth, 0.5));
    const overflow: { stepIndex: number; items: PartListItem[] }[] = [];
    batch.forEach((stepIndex, slot) => {
      const step = steps[stepIndex]!;
      const x = margin + (slot % cols) * (cellWidth + gap),
        y = contentTop + Math.floor(slot / cols) * (cellHeight + gap);
      text(page, t('instructions.step', { number: step.number }), box(x, y, cellWidth, 30), 23, 'step-number', true);
      const body = box(x, y + 34, cellWidth, cellHeight - 34);
      const padding = 6,
        itemWidth = 56,
        itemHeight = options.pliShowNames ? 72 : 58;
      const pliCols = Math.max(1, Math.floor((cellWidth - padding * 2) / itemWidth));
      const descriptionHeight = step.description ? 28 : 0;
      // Reserve at least half the body for the cumulative view. Extra items
      // continue on separate PLI pages, retaining every quantity.
      const maxRows = Math.max(1, Math.floor(((body.height - descriptionHeight) * 0.45 - padding * 2) / itemHeight));
      const capacity = pliCols * maxRows;
      const shown = step.pli.slice(0, capacity);
      let imageBox = body;
      if (shown.length) {
        const pliWidth = Math.min(shown.length, pliCols) * itemWidth + padding * 2;
        const pliHeight = Math.ceil(shown.length / pliCols) * itemHeight + padding * 2;
        page.elements.push({ kind: 'panel', box: box(x, body.y, pliWidth, pliHeight), radius: 5 });
        shown.forEach((item, index) => {
          const itemX = x + padding + (index % pliCols) * itemWidth;
          const itemY = body.y + padding + Math.floor(index / pliCols) * itemHeight;
          page.elements.push({ kind: 'image', box: box(itemX + 8, itemY, 40, 40), source: item.image });
          text(page, quantity(item.quantity), box(itemX, itemY + 42, itemWidth, 15), 12, 'quantity', true, 'center');
          if (options.pliShowNames)
            text(page, item.name, box(itemX + 2, itemY + 59, itemWidth - 4, 12), 8, 'name', false, 'center', {
              overflow: 'ellipsis',
            });
        });
        const below = box(x, body.y + pliHeight + 8, cellWidth, body.height - pliHeight - 8);
        const beside = box(x + pliWidth + 10, body.y, cellWidth - pliWidth - 10, body.height);
        // The larger unobstructed rectangle can be beside a short PLI or
        // below a wide PLI. Both choices depend on pt geometry, never dpi.
        imageBox = beside.width >= 96 && beside.width * beside.height > below.width * below.height ? beside : below;
      }
      if (step.description) {
        text(page, step.description, box(imageBox.x, imageBox.y, imageBox.width, descriptionHeight), 10);
        imageBox = box(
          imageBox.x,
          imageBox.y + descriptionHeight + 4,
          imageBox.width,
          imageBox.height - descriptionHeight - 4,
        );
      }
      page.elements.push({
        kind: 'image',
        box: imageBox,
        source: {
          kind: 'step',
          modelId: step.modelId,
          stepIndex: step.stepIndex,
          inheritedColorId: step.inheritedColorId,
        },
      });
      if (step.pli.length > capacity) overflow.push({ stepIndex, items: step.pli.slice(capacity) });
    });
    for (const entry of overflow)
      listPages(
        'pli',
        t('instructions.pliContinuation', { number: steps[entry.stepIndex]!.number }),
        entry.items,
        entry.stepIndex,
      );
  }
  if (options.includeBom) listPages('bom', t('instructions.bom'), bom);
  pages.forEach((page, index) =>
    text(
      page,
      t('instructions.page', { current: index + 1, total: pages.length }),
      box(margin, height - 29, contentWidth, 16),
      9,
      'footer',
      false,
      'center',
    ),
  );
  return pages;
}
