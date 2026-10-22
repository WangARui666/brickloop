import { describe, expect, it } from 'vitest';
import { aggregateBom } from '@brickloop/io';
import { planInstructions } from '../src';
import type { Box, Paper } from '../src';
import { catalog, fixture, frozenDocument } from './fixtures';

describe('instruction planning', () => {
  it('preserves user text literally and counts color variants of one submodel as one PLI item', () => {
    const { doc, root, child, setSteps } = fixture();
    child.name = 'A&B <组件>';
    doc.meta.author = '甲 & 乙';
    setSteps(root, [
      [
        { ref: { kind: 'model', modelId: child.id }, color: 'c:red' },
        { ref: { kind: 'model', modelId: child.id }, color: 'c:blue' },
      ],
    ]);
    const plan = planInstructions(doc, { catalog });
    expect(plan.steps.at(-1)!.pli).toMatchObject([{ kind: 'model', quantity: 2, colorId: 'c:red' }]);
    const texts = plan.pages
      .flatMap((page) => page.elements)
      .flatMap((element) => (element.kind === 'text' ? [element.text] : []));
    expect(texts).toContain('子模型：A&B <组件>');
    expect(texts).toContain('作者：甲 & 乙');
    expect(plan.bom.summary.totalParts).toBe(4);
    expect(
      plan.bom.rows
        .filter((row) => row.partId === 'ld:3020')
        .map((row) => row.colorId)
        .sort(),
    ).toEqual(['c:blue', 'c:red']);
  });
  it('INS-01: builds a shared submodel once before its first parent step', () => {
    const { doc, child } = fixture();
    const plan = planInstructions(frozenDocument(doc), { catalog });
    expect(plan.steps.map((step) => step.number)).toEqual(['1', '2.1', '2.2', '2', '3']);
    expect(plan.steps.filter((step) => step.modelId === child.id)).toHaveLength(2);
    expect(plan.steps[3]!.pli).toMatchObject([{ kind: 'model', id: child.id, quantity: 2 }]);
    expect(plan.steps[4]!.pli).toMatchObject([{ kind: 'model', id: child.id, quantity: 1 }]);
    expect(
      plan.pages
        .flatMap((page) => page.elements)
        .filter((element) => element.kind === 'text')
        .map((element) => element.text),
    ).toContain('子模型：车轮组件');
  });
  it('INS-01: recursively inserts nested builds and retains inherited colors', () => {
    const { doc, nestedChild } = fixture(true);
    const plan = planInstructions(doc, { catalog });
    expect(plan.steps.map((step) => step.number)).toEqual(['1', '2.1.1', '2.1', '2.2', '2', '3']);
    expect(plan.steps[1]!.modelId).toBe(nestedChild.id);
    expect(plan.steps[1]!.pli[0]!.colorId).toBe('c:red');
    expect(plan.bom.summary.totalParts).toBe(7);
    expect(plan.bom).toEqual(aggregateBom(doc, catalog));
  });
  it('orders PLI by category order, then color and part number, merging pairs', () => {
    const { doc, root, setSteps } = fixture();
    setSteps(root, [
      [
        { ref: { kind: 'part', partId: 'ld:3020' }, color: 'c:blue' },
        { ref: { kind: 'part', partId: 'ld:3001' } },
        { ref: { kind: 'part', partId: 'ld:3001' }, color: 'c:blue' },
        { ref: { kind: 'part', partId: 'ld:3001' } },
      ],
    ]);
    expect(
      planInstructions(doc, { catalog }).steps[0]!.pli.map(({ id, colorId, quantity }) => [id, colorId, quantity]),
    ).toEqual([
      ['ld:3001', 'c:blue', 1],
      ['ld:3001', 'c:red', 2],
      ['ld:3020', 'c:blue', 1],
    ]);
  });
  it('can use a submodel as the root without modifying the document', () => {
    const { doc, child } = fixture(true);
    const plan = planInstructions(frozenDocument(doc), {
      rootModelId: child.id,
      catalog,
      defaultColorId: 'c:blue',
      language: 'en',
    });
    expect(plan.title).toBe('车轮组件');
    expect(plan.steps.map((step) => step.number)).toEqual(['1.1', '1', '2']);
    expect(plan.bom.summary.totalParts).toBe(2);
    expect(plan.bom.rows.every((row) => row.colorId === 'c:blue')).toBe(true);
  });
  it('does not lose oversized PLIs or BOMs and respects cover/BOM switches', () => {
    const { doc, root, setSteps } = fixture();
    setSteps(root, [Array.from({ length: 41 }, (_, i) => ({ ref: { kind: 'part' as const, partId: `cu:${i}` } }))]);
    const plan = planInstructions(doc, { paper: 'A5', stepsPerPage: 4, includeCover: false });
    expect(plan.pages.some((page) => page.kind === 'cover')).toBe(false);
    expect(plan.pages.filter((page) => page.kind === 'pli').length).toBeGreaterThan(1);
    const thumbnails = (kinds: string[]) =>
      plan.pages
        .filter((page) => kinds.includes(page.kind))
        .flatMap((page) => page.elements)
        .filter((element) => element.kind === 'image' && element.source.kind === 'part');
    expect(thumbnails(['steps', 'pli'])).toHaveLength(41);
    expect(thumbnails(['bom'])).toHaveLength(41);
    expect(
      planInstructions(doc, { includeCover: false, includeBom: false }).pages.every((page) =>
        ['steps', 'pli'].includes(page.kind),
      ),
    ).toBe(true);
  });
  it('disambiguates sibling definitions first used in the same step', () => {
    const { doc, root, child, nestedChild, setSteps } = fixture(true);
    // Make the definitions independent, then reference both in one parent step.
    setSteps(child, [[{ ref: { kind: 'part', partId: 'ld:3001' } }]]);
    setSteps(root, [
      [{ ref: { kind: 'model', modelId: child.id } }, { ref: { kind: 'model', modelId: nestedChild.id } }],
    ]);
    expect(planInstructions(doc).steps.map((step) => step.number)).toEqual(['1.1.1', '1.2.1', '1']);
  });
  it('rejects cycles, missing models, invalid options and accepts empty steps', () => {
    const { doc, child, root, setSteps } = fixture();
    expect(() => planInstructions(doc, { dpi: 0 })).toThrow(RangeError);
    expect(() => planInstructions(doc, { metadataDate: 'invalid' })).toThrow(RangeError);
    expect(() => planInstructions(doc, { rootModelId: 'missing' })).toThrow(RangeError);
    setSteps(child, [[{ ref: { kind: 'model', modelId: root.id } }]]);
    expect(() => planInstructions(doc)).toThrow('Cyclic');
    setSteps(root, [[]]);
    const plan = planInstructions(doc);
    expect(plan.steps).toHaveLength(1);
    expect(plan.bom.rows).toEqual([]);
  });
});

describe('layout snapshots (pt only)', () => {
  for (const paper of ['A4-portrait', 'A4-landscape', 'A5', 'Letter'] as const satisfies readonly Paper[]) {
    for (const stepsPerPage of [1, 2, 4] as const) {
      it(`${paper}, ${stepsPerPage} steps`, () => {
        const { doc, root, child, setSteps } = fixture(true);
        setSteps(root, [
          [{ ref: { kind: 'model', modelId: child.id } }],
          [{ ref: { kind: 'part', partId: 'ld:3001' } }],
          [{ ref: { kind: 'part', partId: 'ld:3020' } }],
          [{ ref: { kind: 'part', partId: 'ld:3001' }, color: 'c:blue' }],
        ]);
        const plan = planInstructions(doc, { paper, stepsPerPage, catalog });
        expect(plan.pages).toEqual(planInstructions(doc, { paper, stepsPerPage, catalog, dpi: 300 }).pages);
        // Snapshot geometry and typography, not the document's model data or font bytes.
        expect(
          plan.pages.map((page) => ({
            ...page,
            elements: page.elements.map((element) => {
              if (element.kind === 'image')
                return { kind: element.kind, box: element.box, source: element.source.kind };
              return element;
            }),
          })),
        ).toMatchSnapshot();
        for (const page of plan.pages)
          for (const element of page.elements) {
            expect(element.box.x).toBeGreaterThanOrEqual(0);
            expect(element.box.y).toBeGreaterThanOrEqual(0);
            expect(element.box.width).toBeGreaterThan(0);
            expect(element.box.height).toBeGreaterThan(0);
            expect(element.box.x + element.box.width).toBeLessThanOrEqual(page.width);
            expect(element.box.y + element.box.height).toBeLessThanOrEqual(page.height);
          }
      });
    }
  }
});

describe('compact instruction layout', () => {
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  it('puts content-sized PLIs below step numbers, centers quantities below thumbnails and enlarges views', () => {
    const { doc, root, setSteps } = fixture();
    setSteps(
      root,
      Array.from({ length: 4 }, () => [{ ref: { kind: 'part' as const, partId: 'ld:3001' } }]),
    );
    const plan = planInstructions(doc, {
      paper: 'A4-landscape',
      stepsPerPage: 4,
      catalog,
      includeCover: false,
      includeBom: false,
    });
    const page = plan.pages[0]!;
    const panels = page.elements.filter((e) => e.kind === 'panel');
    const numbers = page.elements.filter((e) => e.kind === 'text' && e.role === 'step-number');
    const quantities = page.elements.filter((e) => e.kind === 'text' && e.role === 'quantity');
    const thumbs = page.elements.filter((e) => e.kind === 'image' && e.source.kind === 'part');
    const views = page.elements.filter((e) => e.kind === 'image' && e.source.kind === 'step');
    expect(panels).toHaveLength(4);
    expect(page.elements.filter((e) => e.kind === 'line')).toMatchObject([
      { direction: 'vertical', thickness: 0.5, color: '#D9D9D9' },
      { direction: 'horizontal', thickness: 0.5, color: '#D9D9D9' },
    ]);
    panels.forEach((panel, index) => {
      expect(panel.box.width).toBe(68);
      expect(panel.box.height).toBe(70);
      expect(panel.box.x).toBe(numbers[index]!.box.x);
      expect(panel.box.y).toBe(numbers[index]!.box.y + numbers[index]!.box.height + 4);
      const quantity = quantities[index]!,
        thumb = thumbs[index]!;
      expect(quantity).toMatchObject({ align: 'center', bold: true });
      expect(quantity.box.x + quantity.box.width / 2).toBe(thumb.box.x + thumb.box.width / 2);
      expect(quantity.box.y).toBeGreaterThanOrEqual(thumb.box.y + thumb.box.height);
      expect(overlaps(panel.box, views[index]!.box)).toBe(false);
      expect(views[index]!.box.width * views[index]!.box.height).toBeGreaterThan(55_000);
    });
    expect(page.elements.some((e) => e.kind === 'text' && e.role === 'name')).toBe(false);
  });
  it('wraps PLI cells into content-sized rows and enables names only on request', () => {
    const { doc, root, setSteps } = fixture();
    setSteps(root, [Array.from({ length: 7 }, (_, i) => ({ ref: { kind: 'part' as const, partId: `cu:${i}` } }))]);
    const options = { paper: 'A5' as const, includeCover: false, includeBom: false };
    const plain = planInstructions(doc, options).pages[0]!;
    const named = planInstructions(doc, { ...options, pliShowNames: true }).pages[0]!;
    expect(plain.elements.find((e) => e.kind === 'panel')!.box).toMatchObject({ width: 348, height: 128 });
    expect(named.elements.find((e) => e.kind === 'panel')!.box).toMatchObject({ width: 348, height: 156 });
    expect(plain.elements.filter((e) => e.kind === 'text' && e.role === 'name')).toHaveLength(0);
    expect(named.elements.filter((e) => e.kind === 'text' && e.role === 'name')).toHaveLength(7);
    expect(planInstructions(doc, { ...options, pliShowNames: true }).pages).toEqual(
      planInstructions(doc, { ...options, pliShowNames: true, dpi: 300 }).pages,
    );
  });
  it('fits 100 BOM items on three A4 landscape pages, keeps ordering, and prefers factory numbers', () => {
    const { doc, root, setSteps } = fixture();
    const parts = Array.from({ length: 100 }, (_, i) => ({
      id: `cu:${String(i).padStart(3, '0')}`,
      legoNo: String(i),
      nameZh: `零件${i}`,
      nameEn: `Part ${i}`,
      categoryId: i % 2 ? 'plate' : 'brick',
    }));
    setSteps(root, [
      parts
        .map((part) => ({
          ref: { kind: 'part' as const, partId: part.id },
          color: part.legoNo === '0' ? 'c:blue' : 'c:red',
        }))
        .reverse(),
    ]);
    const plan = planInstructions(doc, {
      paper: 'A4-landscape',
      catalog: {
        ...catalog,
        parts,
        factoryParts: [{ partId: 'cu:000', factoryNo: 'F-000', colors: ['c:blue'], status: 'active' }],
      },
    });
    const pages = plan.pages.filter((page) => page.kind === 'bom');
    expect(pages.map((page) => page.elements.filter((e) => e.kind === 'image').length)).toEqual([40, 40, 20]);
    const firstImages = pages[0]!.elements.filter((e) => e.kind === 'image');
    expect(new Set(firstImages.map((e) => e.box.x)).size).toBe(10);
    expect(new Set(firstImages.map((e) => e.box.y)).size).toBe(4);
    expect(firstImages.every((e) => e.box.width === 64 && e.box.height === 64)).toBe(true);
    const expected = [...parts].sort(
      (a, b) =>
        (a.categoryId === 'brick' ? 0 : 1) - (b.categoryId === 'brick' ? 0 : 1) ||
        (a.id === 'cu:000' ? -1 : b.id === 'cu:000' ? 1 : 0) ||
        (a.legoNo < b.legoNo ? -1 : 1),
    );
    expect(
      pages
        .flatMap((p) => p.elements)
        .flatMap((e) => (e.kind === 'image' && e.source.kind === 'part' ? [e.source.partId] : [])),
    ).toEqual(expected.map((p) => p.id));
    const elements = pages.flatMap((p) => p.elements);
    expect(elements.some((e) => e.kind === 'panel')).toBe(false);
    const labels = elements.flatMap((e) => (e.kind === 'text' ? [e.text] : []));
    expect(labels).toContain('工厂编号：F-000');
    expect(labels).toContain('零件编号：1');
    expect(labels).not.toContain('零件编号：0');
    expect(
      elements
        .filter((e) => e.kind === 'text' && e.role === 'name')
        .every((e) => e.kind === 'text' && e.overflow === 'ellipsis'),
    ).toBe(true);
  });
  it('underlines submodel headers, expands incomplete pages and omits empty PLI panels', () => {
    const { doc, child, root, setSteps } = fixture();
    const plan = planInstructions(doc, { stepsPerPage: 4, paper: 'A4-landscape', catalog });
    const childPage = plan.pages.find(
      (p) => p.kind === 'steps' && plan.steps[p.stepIndices[0]!]!.modelId === child.id,
    )!;
    expect(childPage.elements.some((e) => e.kind === 'line' && e.box.y === 51)).toBe(true);
    const views = childPage.elements.filter((e) => e.kind === 'image' && e.source.kind === 'step');
    expect(views.every((e) => e.box.height > 350)).toBe(true);
    setSteps(root, [[]]);
    const empty = planInstructions(doc, { includeCover: false, includeBom: false }).pages[0]!;
    expect(empty.elements.some((e) => e.kind === 'panel')).toBe(false);
  });
});
