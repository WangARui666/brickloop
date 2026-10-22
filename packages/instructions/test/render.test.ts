import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { createHash } from 'node:crypto';
import manifest from '../../../library/fonts/fonts.json';
import { planInstructions, renderInstructionsPdf } from '../src';
import type { InstructionHost, PartRenderRequest, StepRenderRequest } from '../src';
import { catalog, fakeHost, fixture, loadFonts } from './fixtures';

async function inspect(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
  const document = await task.promise;
  try {
    const pages = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      // Force the CFF outlines to be parsed, not just the ToUnicode text layer.
      await page.getOperatorList();
      pages.push({
        view: page.view,
        texts: content.items.flatMap((item) =>
          'str' in item ? [{ text: item.str, transform: item.transform, width: item.width, height: item.height }] : [],
        ),
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
async function imageDimensions(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().flatMap((page) => {
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    return (
      xobjects?.values().flatMap((reference) => {
        const image = pdf.context.lookup(reference);
        if (!(image instanceof PDFRawStream)) return [];
        if (image.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) return [];
        return [
          [
            image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
            image.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
          ],
        ];
      }) ?? []
    );
  });
}
describe('PDF rendering', () => {
  let host: InstructionHost;
  beforeAll(async () => {
    host = await fakeHost();
  });
  it('uses the pinned official fonts, verified offline', async () => {
    const fonts = await loadFonts();
    expect([fonts.regular, fonts.bold].map((font) => createHash('sha256').update(font).digest('hex'))).toEqual(
      manifest.fonts.map((font) => font.sha256),
    );
  });
  it('ellipsizes long BOM names on one line without touching the full plan data', async () => {
    const longName = '这是用于紧凑零件清单的非常长的中文零件名称';
    const { doc } = fixture();
    const plan = planInstructions(doc, {
      paper: 'A4-landscape',
      catalog: { ...catalog, parts: catalog.parts!.map((part) => ({ ...part, nameZh: longName })) },
    });
    expect(plan.bom.rows.every((row) => row.partName === longName)).toBe(true);
    const pages = await inspect(await renderInstructionsPdf(plan, host));
    const bomTexts = pages.at(-1)!.texts;
    const shortened = bomTexts.filter((text) => text.text.endsWith('…'));
    expect(shortened).toHaveLength(3);
    expect(new Set(shortened.map((text) => text.transform[5])).size).toBe(1);
    expect(shortened.every((text) => text.width <= 71)).toBe(true);
    expect(bomTexts.some((text) => text.text === longName)).toBe(false);
  }, 30_000);
  it('embeds valid CFF subsets when Latin/CJK glyphs alternate between private dictionaries', async () => {
    const { doc, root } = fixture();
    doc.meta.title = 'Aa 基础砖 Bb 中文说明 123 ×2';
    root.steps[root.stepIds[0]!]!.description = '中A文B零件C数量D，页码 123。';
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    try {
      await inspect(await renderInstructionsPdf(planInstructions(doc, { catalog }), host));
      expect(
        [...log.mock.calls, ...warn.mock.calls]
          .flat()
          .filter((value) => typeof value === 'string' && /Warning:|CFF|subrIndex|Private DICT/u.test(value)),
      ).toEqual([]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }, 30_000);
  it('rejects safely if a host aborts synchronously while returning a rejected promise', async () => {
    const controller = new AbortController();
    await expect(
      renderInstructionsPdf(planInstructions(fixture().doc), {
        ...host,
        signal: controller.signal,
        renderStep: () => {
          controller.abort();
          return Promise.reject(new Error('host cancelled'));
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('INS-02: Chinese, step numbers, submodel quantities, names and page numbers are searchable text', async () => {
    const { doc } = fixture(true);
    const plan = planInstructions(doc, { catalog, metadataDate: '2026-01-01T00:00:00Z' });
    const bytes = await renderInstructionsPdf(plan, host);
    const pages = await inspect(bytes);
    const text = pages
      .flatMap((page) => page.texts)
      .map((item) => item.text)
      .join('');
    for (const value of [
      '步骤 2.1.1',
      '步骤 2.1',
      '步骤 2.2',
      '×2',
      '基础砖 2×4',
      '薄板 2×4',
      '子模型：车轮组件',
      '亮红色',
      'SL-0001',
      `第 1 页 / 共 ${plan.pages.length} 页`,
    ])
      expect(text).toContain(value);
    expect(pages).toHaveLength(plan.pages.length);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // Full source fonts total over 16 MB; embedded subsets for this fixture stay far below that.
    expect(bytes.length).toBeLessThan(500_000);
    expect(Buffer.from(bytes).toString('latin1')).toContain('/ToUnicode');
  }, 30_000);
  it('INS-03: doubling dpi changes only raster dimensions, preserving every text transform and page box', async () => {
    const { doc } = fixture();
    const render = async (dpi: number) => {
      const steps: StepRenderRequest[] = [],
        parts: PartRenderRequest[] = [];
      const bytes = await renderInstructionsPdf(
        planInstructions(doc, { catalog, paper: 'A4-landscape', stepsPerPage: 4, dpi }),
        {
          ...host,
          renderStep: (request) => {
            steps.push(request);
            return host.renderStep(request);
          },
          renderPart: (request) => {
            parts.push(request);
            return host.renderPart(request);
          },
        },
      );
      return { bytes, steps, parts };
    };
    const low = await render(150),
      high = await render(300);
    expect(await inspect(low.bytes)).toEqual(await inspect(high.bytes));
    expect(high.steps).toHaveLength(low.steps.length);
    low.steps.forEach((request, index) => {
      const larger = high.steps[index]!;
      expect(larger.highlightNew).toBe(true);
      expect([larger.modelId, larger.stepIndex, larger.inheritedColorId]).toEqual([
        request.modelId,
        request.stepIndex,
        request.inheritedColorId,
      ]);
      expect(Math.abs(larger.widthPx - request.widthPx * 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(larger.heightPx - request.heightPx * 2)).toBeLessThanOrEqual(1);
    });
    low.parts.forEach((request, index) =>
      expect(Math.abs(high.parts[index]!.sizePx - request.sizePx * 2)).toBeLessThanOrEqual(1),
    );
    const lowImages = await imageDimensions(low.bytes),
      highImages = await imageDimensions(high.bytes);
    expect(highImages).toHaveLength(lowImages.length);
    lowImages.forEach((size, index) =>
      size.forEach((value, axis) => expect(Math.abs(highImages[index]![axis]! - 2 * value)).toBeLessThanOrEqual(1)),
    );
  }, 30_000);
  it('returns identical bytes and complete page progress for identical input', async () => {
    const plan = planInstructions(fixture().doc, { catalog });
    const onProgress = vi.fn();
    const first = await renderInstructionsPdf(plan, { ...host, onProgress });
    const second = await renderInstructionsPdf(plan, host);
    expect(createHash('sha256').update(first).digest('hex')).toBe(createHash('sha256').update(second).digest('hex'));
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(
      Array.from({ length: plan.pages.length + 1 }, (_, completedPages) => ({
        completedPages,
        totalPages: plan.pages.length,
      })),
    );
  }, 30_000);
  it('localizes generated text and catalog names to English', async () => {
    const plan = planInstructions(fixture().doc, { catalog, language: 'en' });
    const text = (await inspect(await renderInstructionsPdf(plan, host)))
      .flatMap((page) => page.texts)
      .map((item) => item.text)
      .join('');
    for (const value of [
      'Building instructions',
      'Step 2.1',
      'Submodel:',
      'Brick 2 x 4',
      'Bright Red',
      'Factory: SL-0001',
      'Page 1 /',
    ])
      expect(text).toContain(value);
    expect(text).not.toContain('第 1 页');
  }, 30_000);
  it('aborts before rendering, and midway without returning partial output', async () => {
    const plan = planInstructions(fixture().doc);
    const controller = new AbortController();
    controller.abort();
    const renderStep = vi.fn(host.renderStep);
    await expect(renderInstructionsPdf(plan, { ...host, renderStep, signal: controller.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    expect(renderStep).not.toHaveBeenCalled();
    const midway = new AbortController();
    const onProgress = vi.fn(({ completedPages }: { completedPages: number }) => {
      if (completedPages === 1) midway.abort();
    });
    let output: Uint8Array | undefined;
    await expect(
      renderInstructionsPdf(plan, { ...host, signal: midway.signal, onProgress }).then((bytes) => {
        output = bytes;
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(output).toBeUndefined();
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
  it('cancels a pending non-cooperative renderer promptly and passes its signal', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const rendering = renderInstructionsPdf(planInstructions(fixture().doc), {
      ...host,
      signal: controller.signal,
      renderStep: (request) => {
        expect(request.signal).toBe(controller.signal);
        started();
        return new Promise<Uint8Array>(() => undefined);
      },
    });
    await ready;
    controller.abort();
    await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('propagates host failures and does not report unrendered pages', async () => {
    const onProgress = vi.fn();
    await expect(
      renderInstructionsPdf(planInstructions(fixture().doc), {
        ...host,
        onProgress,
        renderStep: () => {
          throw new Error('renderer failed');
        },
      }),
    ).rejects.toThrow('renderer failed');
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ completedPages: 0, totalPages: 7 });
  });
});
