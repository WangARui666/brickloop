import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PartId } from '@brickloop/catalog';

export function thumbnailKey(partId: PartId, meshHash: string, color?: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify(color ? ['thumb-5-color', partId, meshHash, color] : ['thumb-4-neutral-71', partId, meshHash]),
    )
    .digest('hex');
}
export function createThumbCache(directory: string) {
  const issued = new Set<string>();
  const valid = (data: Buffer) =>
    data.length >= 36 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(16) === 128 &&
    data.readUInt32BE(20) === 128 &&
    data.subarray(-8, -4).toString('ascii') === 'IEND';
  return {
    async get(key: string): Promise<string | null> {
      issued.add(key);
      try {
        const file = path.join(directory, `${key}.png`);
        const data = await readFile(file);
        if (!valid(data)) {
          await rm(file, { force: true });
          return null;
        }
        return `data:image/png;base64,${data.toString('base64')}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async put(key: string, png: string): Promise<void> {
      if (!issued.has(key)) throw new Error('Unknown thumbnail');
      const data = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
      if (!valid(data)) throw new Error('Invalid thumbnail');
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { flag: 'wx' });
        await rename(temporary, path.join(directory, `${key}.png`));
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
