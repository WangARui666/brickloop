// Deterministic, original synthetic reference pictures; no downloaded or licensed artwork.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { evaluationCases } from '../src/evaluation.js';

type Box = [x: number, y: number, z: number, width: number, height: number, depth: number, color: string];
const red = '#be3434',
  blue = '#3875c2',
  green = '#35844b',
  gray = '#8d949c',
  brown = '#956643',
  yellow = '#e8bd3e',
  white = '#ededdf';
const scenes: Box[][] = [
  [
    [2, 0, 2, 10, 7, 8, white],
    [1, 7, 1, 12, 2, 10, red],
    [3, 9, 2, 8, 2, 8, red],
    [5, 11, 3, 4, 2, 6, red],
  ],
  [
    [1, 0, 2, 8, 8, 9, white],
    [0, 8, 1, 10, 2, 11, red],
    [9, 0, 2, 6, 5, 8, gray],
    [9, 5, 1, 6, 1, 10, red],
  ],
  [
    [4, 0, 4, 8, 12, 8, gray],
    [3, 12, 3, 10, 2, 10, gray],
    [3, 14, 3, 2, 2, 2, gray],
    [11, 14, 3, 2, 2, 2, gray],
  ],
  [
    [3, 0, 3, 10, 2, 10, gray],
    [5, 2, 5, 6, 4, 6, white],
    [5, 6, 5, 6, 3, 6, red],
    [5, 9, 5, 6, 3, 6, white],
    [4, 12, 4, 8, 2, 8, yellow],
    [3, 14, 3, 10, 1, 10, red],
  ],
  [
    [1, 2, 3, 14, 3, 8, blue],
    [4, 5, 3, 8, 3, 8, blue],
    [1, 0, 2, 3, 3, 2, gray],
    [11, 0, 2, 3, 3, 2, gray],
    [1, 0, 10, 3, 3, 2, gray],
    [11, 0, 10, 3, 3, 2, gray],
  ],
  [
    [0, 2, 3, 16, 2, 8, gray],
    [0, 4, 3, 5, 5, 8, green],
    [5, 4, 3, 10, 3, 8, green],
    [1, 0, 2, 3, 3, 2, gray],
    [12, 0, 2, 3, 3, 2, gray],
  ],
  [
    [0, 3, 3, 16, 6, 8, yellow],
    [1, 6, 2, 3, 2, 1, blue],
    [5, 6, 2, 3, 2, 1, blue],
    [9, 6, 2, 3, 2, 1, blue],
    [1, 0, 2, 3, 3, 2, gray],
    [12, 0, 2, 3, 3, 2, gray],
  ],
  [
    [2, 0, 3, 12, 2, 8, blue],
    [0, 2, 2, 16, 2, 10, blue],
    [5, 4, 4, 6, 4, 6, white],
    [4, 8, 3, 8, 1, 8, white],
  ],
  [
    [4, 3, 4, 8, 5, 6, '#d98c33'],
    [8, 8, 4, 6, 5, 6, '#d98c33'],
    [8, 13, 4, 2, 2, 2, '#d98c33'],
    [12, 13, 4, 2, 2, 2, '#d98c33'],
    [4, 0, 4, 2, 3, 2, brown],
    [10, 0, 4, 2, 3, 2, brown],
    [2, 5, 4, 2, 6, 2, '#d98c33'],
  ],
  [
    [3, 3, 4, 10, 5, 6, brown],
    [10, 8, 4, 5, 5, 6, brown],
    [10, 7, 3, 1, 5, 1, gray],
    [3, 0, 4, 2, 3, 2, brown],
    [11, 0, 4, 2, 3, 2, brown],
    [1, 6, 4, 2, 4, 2, brown],
  ],
  [
    [5, 4, 4, 7, 6, 7, blue],
    [9, 10, 5, 4, 4, 5, blue],
    [13, 10, 5, 2, 2, 2, yellow],
    [2, 6, 5, 3, 2, 4, blue],
    [7, 0, 5, 1, 4, 1, yellow],
    [10, 0, 5, 1, 4, 1, yellow],
  ],
  [
    [2, 4, 2, 10, 7, 10, gray],
    [10, 7, 3, 5, 6, 8, gray],
    [13, 1, 3, 2, 6, 2, gray],
    [2, 0, 2, 3, 4, 3, gray],
    [9, 0, 2, 3, 4, 3, gray],
  ],
  [
    [3, 0, 3, 2, 6, 2, brown],
    [11, 0, 3, 2, 6, 2, brown],
    [3, 0, 11, 2, 6, 2, brown],
    [11, 0, 11, 2, 6, 2, brown],
    [3, 6, 3, 10, 2, 10, red],
    [3, 8, 11, 10, 7, 2, red],
  ],
  [
    [2, 0, 2, 2, 8, 2, brown],
    [12, 0, 2, 2, 8, 2, brown],
    [2, 0, 12, 2, 8, 2, brown],
    [12, 0, 12, 2, 8, 2, brown],
    [1, 8, 1, 14, 2, 14, brown],
  ],
  [
    [1, 0, 4, 2, 15, 8, brown],
    [13, 0, 4, 2, 15, 8, brown],
    [3, 0, 4, 10, 1, 8, brown],
    [3, 5, 4, 10, 1, 8, brown],
    [3, 10, 4, 10, 1, 8, brown],
    [3, 14, 4, 10, 1, 8, brown],
  ],
  [
    [1, 0, 1, 14, 3, 14, brown],
    [1, 3, 1, 14, 2, 14, blue],
    [1, 5, 11, 14, 2, 4, white],
    [1, 5, 14, 14, 5, 1, brown],
  ],
  [
    [4, 0, 4, 8, 5, 8, brown],
    [7, 5, 7, 2, 5, 2, green],
    [3, 7, 7, 4, 2, 2, green],
    [9, 8, 7, 4, 2, 2, green],
    [5, 10, 5, 6, 4, 6, red],
    [7, 11, 4, 2, 2, 1, yellow],
  ],
  [
    [7, 0, 7, 2, 6, 2, brown],
    [3, 6, 3, 10, 4, 10, green],
    [4, 10, 4, 8, 3, 8, green],
    [6, 13, 6, 4, 3, 4, green],
  ],
  [
    [4, 0, 4, 3, 4, 3, gray],
    [9, 0, 4, 3, 4, 3, gray],
    [4, 4, 3, 8, 7, 6, blue],
    [5, 11, 4, 6, 5, 5, gray],
    [1, 5, 4, 3, 5, 3, gray],
    [12, 5, 4, 3, 5, 3, gray],
  ],
  [
    [4, 0, 4, 3, 5, 3, blue],
    [9, 0, 4, 3, 5, 3, blue],
    [4, 5, 3, 8, 6, 6, red],
    [5, 11, 4, 6, 5, 5, yellow],
    [2, 5, 4, 2, 5, 2, red],
    [12, 5, 4, 2, 5, 2, red],
  ],
];
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function png(boxes: Box[], view: 'front' | 'right'): Buffer {
  const width = 192;
  const pixels = Buffer.alloc(width * (width * 3 + 1), 255);
  for (let y = 0; y < width; y++) pixels[y * (width * 3 + 1)] = 0;
  const sorted = [...boxes].sort((a, b) => (view === 'front' ? b[2] - a[2] : a[0] - b[0]));
  for (const [x, y, z, w, h, d, color] of sorted) {
    const left = 16 + (view === 'front' ? x : z) * 10,
      right = left + (view === 'front' ? w : d) * 10;
    const top = 176 - (y + h) * 10,
      bottom = 176 - y * 10;
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    for (let py = Math.max(0, top); py < Math.min(width, bottom); py++)
      for (let px = Math.max(0, left); px < Math.min(width, right); px++) {
        const border = px === left || px === right - 1 || py === top || py === bottom - 1;
        const offset = py * (width * 3 + 1) + 1 + px * 3;
        for (let c = 0; c < 3; c++) pixels[offset + c] = border ? Math.round(rgb[c]! * 0.65) : rgb[c]!;
      }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const directory = new URL('../test/ai-eval/', import.meta.url);
await mkdir(new URL('references/', directory), { recursive: true });
for (const [index, test] of evaluationCases.filter((test) => test.references.length).entries()) {
  for (const reference of test.references)
    await writeFile(new URL(reference.asset, directory), png(scenes[index]!, reference.view));
}
await writeFile(new URL('cases.json', directory), JSON.stringify(evaluationCases, null, 2) + '\n');
process.stdout.write(`Generated 20 original reference sets in ${fileURLToPath(directory)}\n`);
