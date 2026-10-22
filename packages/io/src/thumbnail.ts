import { zlibSync } from 'fflate';
import { crc32, utf8 } from './binary';

/** A transparent 512×512 PNG when the caller has not rendered a project preview yet. */
export function emptyThumbnail(): Uint8Array {
  const chunk = (name: string, data: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(data.length + 12),
      view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(utf8(name), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, parseInt(crc32(bytes.subarray(4, bytes.length - 4)), 16));
    return bytes;
  };
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, 512);
  view.setUint32(4, 512);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(new Uint8Array(512 * (1 + 512 * 4)))),
    chunk('IEND', new Uint8Array()),
  ];
  const output = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
