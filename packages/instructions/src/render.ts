import { instructionFontkit } from './fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';
import type { Box, ImageElement, InstructionHost, InstructionPlan, TextElement } from './types';

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Instruction export cancelled', 'AbortError');
}
/** Reject promptly even if a host callback does not cooperate with cancellation. */
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  // The operation may synchronously trigger cancellation before returning a
  // rejected promise. Consume that rejection even when we exit immediately.
  if (signal?.aborted) void operation.catch(() => undefined);
  checkAbort(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Instruction export cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replaceAll('\r', '').replaceAll('\t', ' ').split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}
function drawText(page: PDFPage, element: TextElement, font: PDFFont) {
  if (!element.text) return;
  const { box } = element;
  let size = element.size,
    lines = wrap(element.text, font, size, box.width);
  if (element.overflow === 'ellipsis') {
    let value = element.text.replace(/\s+/gu, ' ');
    if (font.widthOfTextAtSize(value, size) > box.width) {
      const characters = [...value];
      while (characters.length && font.widthOfTextAtSize(characters.join('') + '…', size) > box.width) characters.pop();
      value = characters.join('') + '…';
    }
    lines = [value];
  }
  while (
    (lines.length * size * 1.25 > box.height || lines.some((line) => font.widthOfTextAtSize(line, size) > box.width)) &&
    size > 6
  ) {
    size = Math.max(6, size - 0.5);
    lines = wrap(element.text, font, size, box.width);
  }
  if (lines.length * size * 1.25 > box.height || lines.some((line) => font.widthOfTextAtSize(line, size) > box.width))
    throw new RangeError(`Instruction text exceeds its layout box (${element.role}): ${element.text}`);
  lines.forEach((line, index) => {
    const x = box.x + (element.align === 'center' ? (box.width - font.widthOfTextAtSize(line, size)) / 2 : 0);
    page.drawText(line, {
      x,
      y: page.getHeight() - box.y - size - index * size * 1.25,
      size,
      font,
      color: element.color ? hexColor(element.color) : rgb(0.12, 0.12, 0.12),
    });
  });
}
function hexColor(hex: string) {
  return rgb(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );
}
function drawPanel(page: PDFPage, bounds: Box, radius: number) {
  const { x, width, height } = bounds,
    y = page.getHeight() - bounds.y - height;
  const color = rgb(0.95, 0.95, 0.95);
  page.drawRectangle({ x: x + radius, y, width: width - radius * 2, height, color });
  page.drawRectangle({ x, y: y + radius, width, height: height - radius * 2, color });
  for (const cx of [x + radius, x + width - radius])
    for (const cy of [y + radius, y + height - radius]) page.drawCircle({ x: cx, y: cy, size: radius, color });
}

export async function renderInstructionsPdf(plan: InstructionPlan, host: InstructionHost): Promise<Uint8Array> {
  const { signal } = host;
  checkAbort(signal);
  const progress = (completedPages: number) => {
    checkAbort(signal);
    host.onProgress?.({ completedPages, totalPages: plan.pages.length });
    checkAbort(signal);
  };
  progress(0);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(instructionFontkit);
  pdf.setTitle(plan.title);
  pdf.setAuthor(plan.author);
  pdf.setCreator('Brickloop');
  pdf.setProducer('Brickloop / pdf-lib');
  pdf.setLanguage(plan.options.language);
  pdf.setCreationDate(new Date(plan.options.metadataDate));
  pdf.setModificationDate(new Date(plan.options.metadataDate));
  const regular = await abortable(pdf.embedFont(host.fonts.regular, { subset: true }), signal);
  const bold = await abortable(pdf.embedFont(host.fonts.bold, { subset: true }), signal);
  const imageCache = new Map<string, PDFImage>();
  const pixels = (points: number) => Math.max(1, Math.round((points * plan.options.dpi) / 72));
  async function embedImage(element: ImageElement) {
    checkAbort(signal);
    const source = element.source;
    const widthPx = pixels(element.box.width),
      heightPx = pixels(element.box.height);
    const sizePx = Math.max(widthPx, heightPx);
    const key = JSON.stringify([
      source,
      source.kind === 'part' ? sizePx : widthPx,
      source.kind === 'part' ? sizePx : heightPx,
    ]);
    const cached = imageCache.get(key);
    if (cached) return cached;
    const cancellation = signal ? { signal } : {};
    const png = await abortable(
      Promise.resolve(
        source.kind === 'part'
          ? host.renderPart({ partId: source.partId, colorId: source.colorId, sizePx, ...cancellation })
          : host.renderStep({
              modelId: source.modelId,
              stepIndex: source.stepIndex,
              highlightNew: true,
              inheritedColorId: source.inheritedColorId,
              widthPx,
              heightPx,
              ...cancellation,
            }),
      ),
      signal,
    );
    checkAbort(signal);
    const embedded = await abortable(pdf.embedPng(png), signal);
    imageCache.set(key, embedded);
    return embedded;
  }
  for (const [index, planned] of plan.pages.entries()) {
    checkAbort(signal);
    const page = pdf.addPage([planned.width, planned.height]);
    for (const element of planned.elements) {
      checkAbort(signal);
      if (element.kind === 'panel') drawPanel(page, element.box, element.radius);
      else if (element.kind === 'text') drawText(page, element, element.bold ? bold : regular);
      else if (element.kind === 'line') {
        const { x, y, width, height } = element.box;
        const horizontal = element.direction === 'horizontal';
        page.drawLine({
          start: { x: x + (horizontal ? 0 : width / 2), y: planned.height - y - (horizontal ? height / 2 : 0) },
          end: { x: x + (horizontal ? width : width / 2), y: planned.height - y - (horizontal ? height / 2 : height) },
          thickness: element.thickness,
          color: hexColor(element.color),
        });
      } else {
        const image = await embedImage(element);
        const scale = Math.min(element.box.width / image.width, element.box.height / image.height);
        const width = image.width * scale,
          height = image.height * scale;
        page.drawImage(image, {
          x: element.box.x + (element.box.width - width) / 2,
          y: planned.height - element.box.y - (element.box.height + height) / 2,
          width,
          height,
        });
      }
    }
    progress(index + 1);
  }
  const bytes = await abortable(pdf.save({ useObjectStreams: false }), signal);
  checkAbort(signal);
  return bytes;
}
