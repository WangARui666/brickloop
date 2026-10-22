import { createDocument, createModel } from '@brickloop/core';
import type { BrkDocument, Instance, ModelDef } from '@brickloop/core';
import { crc32 } from '@brickloop/io';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import type { InstructionCatalog, InstructionHost } from '../src';

export const catalog: InstructionCatalog = {
  categories: [
    { id: 'brick', order: 0 },
    { id: 'plate', order: 1 },
  ],
  parts: [
    { id: 'ld:3001', legoNo: '3001', nameZh: '基础砖 2×4', nameEn: 'Brick 2 x 4', categoryId: 'brick' },
    { id: 'ld:3020', legoNo: '3020', nameZh: '薄板 2×4', nameEn: 'Plate 2 x 4', categoryId: 'plate' },
  ],
  colors: [
    {
      id: 'c:red',
      rgb: '#c05549',
      alpha: 1,
      ldrawCode: 4,
      legoColorId: 21,
      legoName: 'Bright Red',
      nameZh: '亮红色',
      edgeRgb: '#333333',
    },
    {
      id: 'c:blue',
      rgb: '#607ea0',
      alpha: 1,
      ldrawCode: 1,
      legoColorId: 23,
      legoName: 'Blue',
      nameZh: '蓝色',
      edgeRgb: '#333333',
    },
  ],
  factoryParts: [{ partId: 'ld:3001', factoryNo: 'SL-0001', status: 'active', colors: ['c:red', 'c:blue'] }],
};
export function fixture(nested = false) {
  let serial = 0;
  const id = () => (++serial).toString().padStart(26, '0');
  const doc = createDocument(
    { title: '积木小车 · 搭建示例', author: 'Brickloop' },
    { id, now: () => '2026-01-01T00:00:00.000Z' },
  );
  const root = doc.models[doc.rootModelId]!;
  const child = createModel('车轮组件', 'submodel', id);
  const nestedChild = createModel('连接底座', 'submodel', id);
  function setSteps(
    model: ModelDef,
    definitions: { ref: Instance['ref']; color?: string; x?: number; y?: number; z?: number }[][],
  ) {
    model.stepIds = [];
    model.steps = {};
    model.instances = {};
    for (const entries of definitions) {
      const stepId = id();
      model.stepIds.push(stepId);
      const step = { id: stepId, instanceIds: [] as string[] };
      model.steps[stepId] = step;
      for (const entry of entries) {
        const instanceId = id();
        step.instanceIds.push(instanceId);
        model.instances[instanceId] = {
          id: instanceId,
          ref: entry.ref,
          colorId: entry.color ?? 'c:red',
          transform: [entry.x ?? 0, entry.y ?? 0, entry.z ?? 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
          stepId,
          groupId: null,
        };
      }
    }
  }
  setSteps(nestedChild, [[{ ref: { kind: 'part', partId: 'ld:3020' }, color: 'inherit' }]]);
  setSteps(child, [
    [
      {
        ref: nested ? { kind: 'model', modelId: nestedChild.id } : { kind: 'part', partId: 'ld:3020' },
        color: 'inherit',
      },
    ],
    [{ ref: { kind: 'part', partId: 'ld:3001' }, color: 'c:blue', y: -24 }],
  ]);
  setSteps(root, [
    [{ ref: { kind: 'part', partId: 'ld:3001' } }],
    [
      { ref: { kind: 'model', modelId: child.id }, x: -90 },
      { ref: { kind: 'model', modelId: child.id }, x: 90 },
    ],
    [{ ref: { kind: 'model', modelId: child.id }, z: 90 }],
  ]);
  doc.models[child.id] = child;
  if (nested) doc.models[nestedChild.id] = nestedChild;
  return { doc, root, child, nestedChild, setSteps };
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  function chunk(type: string, data: Uint8Array) {
    const name = Buffer.from(type),
      content = Buffer.concat([name, data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    content.copy(result, 4);
    result.writeUInt32BE(Number.parseInt(crc32(content), 16), data.length + 8);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', new Uint8Array()),
  ]);
}
export function solidPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.set([220, 225, 230, 255], offset);
  return encodePng(width, height, bytes);
}
export async function loadFonts(): Promise<InstructionHost['fonts']> {
  const base = new URL('../../../library/fonts/', import.meta.url);
  return {
    regular: await readFile(new URL('NotoSansSC-Regular.otf', base)),
    bold: await readFile(new URL('NotoSansSC-Bold.otf', base)),
  };
}
export async function fakeHost(): Promise<InstructionHost> {
  return {
    fonts: await loadFonts(),
    renderStep: ({ widthPx, heightPx }) => solidPng(widthPx, heightPx),
    renderPart: ({ sizePx }) => solidPng(sizePx, sizePx),
  };
}
export function frozenDocument(doc: BrkDocument) {
  function freeze(value: unknown): void {
    if (typeof value !== 'object' || !value) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  freeze(doc);
  return doc;
}
