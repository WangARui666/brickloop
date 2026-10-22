import { sha256 } from '@noble/hashes/sha2.js';
import { inflateSync, strFromU8, strToU8, zipSync } from 'fflate';
import { issue } from './issues';
import type { IoIssue } from './issues';

export type ProjectAssets = Record<string, Uint8Array>;
export const utf8 = strToU8;
export const text = (bytes: Uint8Array): string => strFromU8(bytes).replace(/^\uFEFF/, '');
export const hashBytes = (bytes: Uint8Array): string =>
  Array.from(sha256(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
export function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
export function safeMember(name: string): boolean {
  return (
    !!name && !/[\\:\0]/.test(name) && !name.startsWith('/') && !name.split('/').some((s) => s === '..' || s === '.')
  );
}
export function writeZip(members: ProjectAssets): Uint8Array {
  for (const name of Object.keys(members)) if (!safeMember(name)) throw new Error(`Unsafe member: ${name}`);
  return zipSync(members, { level: 6, mtime: new Date(2000, 0, 1) });
}

/** Central-directory traversal allows one corrupt payload to be reported without losing other members.
 * Only ZIP32 stored/deflated members are supported; never extract archive paths to disk. */
export function readZip(bytes: Uint8Array): { members: ProjectAssets; issues: IoIssue[] } {
  const members: ProjectAssets = Object.create(null) as ProjectAssets;
  const issues: IoIssue[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  try {
    let end = bytes.length - 22;
    for (; end >= Math.max(0, bytes.length - 65557); end--) {
      if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    }
    if (
      end < 0 ||
      u32(end) !== 0x06054b50 ||
      u16(end + 4) !== 0 ||
      u16(end + 6) !== 0 ||
      u16(end + 8) !== u16(end + 10)
    )
      throw new Error('Missing/split ZIP directory');
    const count = u16(end + 10),
      size = u32(end + 12),
      offset = u32(end + 16);
    if (count === 65535 || offset + size !== end) throw new Error('Invalid or ZIP64 directory');
    let pos = offset;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (u32(pos) !== 0x02014b50) throw new Error('Invalid directory entry');
      const flags = u16(pos + 8),
        method = u16(pos + 10),
        crc = u32(pos + 16)
          .toString(16)
          .padStart(8, '0');
      const compressed = u32(pos + 20),
        length = u32(pos + 24),
        nameLength = u16(pos + 28),
        extraLength = u16(pos + 30),
        commentLength = u16(pos + 32),
        local = u32(pos + 42);
      const name = text(bytes.subarray(pos + 46, pos + 46 + nameLength));
      pos += 46 + nameLength + extraLength + commentLength;
      if (pos > end) throw new Error('Truncated directory');
      try {
        if (!safeMember(name) || Object.hasOwn(members, name)) throw new Error('Unsafe/duplicate member');
        if (local + 30 > offset || u32(local) !== 0x04034b50) throw new Error('Missing local header');
        if ((flags | u16(local + 6)) & 1) {
          issues.push(issue('IO_ENCRYPTED_UNSUPPORTED', name));
          continue;
        }
        const localNameLength = u16(local + 26);
        if (text(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || u16(local + 8) !== method)
          throw new Error('Header mismatch');
        const start = local + 30 + localNameLength + u16(local + 28);
        total += length;
        if (length > 256 * 1024 * 1024 || total > 512 * 1024 * 1024 || start + compressed > offset)
          throw new Error('Member limit or truncated payload');
        const payload = bytes.subarray(start, start + compressed);
        const decoded =
          method === 0
            ? payload.slice()
            : method === 8
              ? inflateSync(payload, { out: new Uint8Array(length) })
              : undefined;
        if (!decoded || decoded.length !== length) throw new Error('Unsupported compression or size mismatch');
        members[name] = decoded;
        if (crc32(decoded) !== crc) issues.push(issue('ZIP_MEMBER_INVALID', name, 'CRC32 mismatch'));
      } catch (error) {
        issues.push(issue('ZIP_MEMBER_INVALID', name, String(error)));
      }
    }
    if (pos !== end) throw new Error('Directory size mismatch');
  } catch (error) {
    issues.push(issue('ZIP_INVALID', undefined, String(error)));
  }
  return { members, issues };
}
