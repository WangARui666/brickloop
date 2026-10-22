import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  size: number;
  crc: number;
  read(): Buffer;
}
function uint64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP64 value exceeds safe integer range');
  return Number(value);
}

/** Minimal ZIP reader for official stored/deflated archives, including ZIP64 central directories. */
export function readZip(buffer: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Missing ZIP end record');
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0)
    throw new Error('Multi-disk ZIP is unsupported');
  let count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff || buffer.readUInt32LE(end + 12) === 0xffffffff) {
    if (end < 20 || buffer.readUInt32LE(end - 20) !== 0x07064b50) throw new Error('Missing ZIP64 locator');
    const zip64 = uint64(buffer, end - 12);
    if (buffer.readUInt32LE(zip64) !== 0x06064b50) throw new Error('Missing ZIP64 record');
    count = uint64(buffer, zip64 + 32);
    offset = uint64(buffer, zip64 + 48);
  }
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    let compressed = buffer.readUInt32LE(offset + 20);
    let size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const mode = buffer.readUInt32LE(offset + 38) >>> 16;
    let local = buffer.readUInt32LE(offset + 42);
    const rawName = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8')
      .replaceAll('\\', '/');
    const extraEnd = offset + 46 + nameLength + extraLength;
    for (let extra = offset + 46 + nameLength; extra + 4 <= extraEnd;) {
      const tag = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (extra + 4 + length > extraEnd) throw new Error('Invalid ZIP extra field');
      if (tag === 1) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = uint64(buffer, field);
          field += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = uint64(buffer, field);
          field += 8;
        }
        if (local === 0xffffffff) local = uint64(buffer, field);
      }
      extra += 4 + length;
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || (method !== 0 && method !== 8)) throw new Error('Encrypted/unsupported ZIP member');
    if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are unsupported');
    const segments = rawName.replace(/\/$/, '').split('/');
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === '..' ||
          segment === '.' ||
          /[\x00-\x1f:<>"|?*]/.test(segment) ||
          /[. ]$/.test(segment) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      )
    )
      throw new Error(`Unsafe ZIP path: ${rawName}`);
    // complete.zip has one ldraw/ root; accepting arbitrary roots can hide traversal mistakes.
    if (segments[0]?.toLowerCase() !== 'ldraw') throw new Error(`Unexpected ZIP root: ${rawName}`);
    if (rawName.endsWith('/')) continue;
    const name = segments.slice(1).join('/');
    if (!name || names.has(name.toLowerCase())) throw new Error(`Duplicate ZIP member: ${name}`);
    names.add(name.toLowerCase());
    total += size;
    if (size > 64 * 1024 * 1024 || total > 4 * 1024 ** 3)
      throw new Error('ZIP decompressed size exceeds library limits');
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new Error('Truncated ZIP member');
    entries.push({
      name,
      size,
      crc,
      read() {
        const content =
          method === 0
            ? buffer.subarray(start, start + compressed)
            : inflateRawSync(buffer.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) });
        if (content.length !== size || crc32(content) !== crc) throw new Error(`ZIP size/CRC mismatch: ${name}`);
        return content;
      },
    });
  }
  return entries;
}
