import { crc32, deflateSync } from 'node:zlib';
import { zlibSync } from 'fflate';

/** Lossless PNG encoding of Electron's opaque BGRA bitmap, with adaptive row filters. */
export function guidePng(bitmap: Buffer, width: number, height: number) {
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  const unfiltered = Buffer.alloc(filtered.length),
    sub = Buffer.alloc(filtered.length);
  let previous = Buffer.alloc(stride);
  const predictors = (left: number, above: number, corner: number) => {
    const p = left + above - corner;
    const a = Math.abs(p - left),
      b = Math.abs(p - above),
      c = Math.abs(p - corner);
    return [0, left, above, Math.floor((left + above) / 2), a <= b && a <= c ? left : b <= c ? above : corner];
  };
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      if (bitmap[source + 3] !== 255) throw new Error('Guide capture must be opaque');
      row[x * 3] = bitmap[source + 2]!;
      row[x * 3 + 1] = bitmap[source + 1]!;
      row[x * 3 + 2] = bitmap[source]!;
    }
    const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
    const scores = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const values = predictors(i >= 3 ? row[i - 3]! : 0, previous[i]!, i >= 3 ? previous[i - 3]! : 0);
      for (let f = 0; f < 5; f++) {
        const delta = (row[i]! - values[f]!) & 255;
        candidates[f]![i] = delta;
        scores[f]! += Math.min(delta, 256 - delta);
      }
    }
    const best = scores.indexOf(Math.min(...scores));
    filtered[y * (stride + 1)] = best;
    candidates[best]!.copy(filtered, y * (stride + 1) + 1);
    row.copy(unfiltered, y * (stride + 1) + 1);
    sub[y * (stride + 1)] = 1;
    candidates[1]!.copy(sub, y * (stride + 1) + 1);
    previous = row;
  }
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4, 'ascii');
    data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const best = [filtered, unfiltered, sub]
    .map((data) => ({ data, bytes: deflateSync(data, { level: 9 }) }))
    .sort((a, b) => a.bytes.length - b.bytes.length)[0]!;
  const alternative = Buffer.from(zlibSync(best.data, { level: 9 }));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', alternative.length < best.bytes.length ? alternative : best.bytes),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
