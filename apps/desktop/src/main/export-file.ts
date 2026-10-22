import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

/** Complete bytes are staged beside the target, flushed, then atomically renamed. */
export async function writeExportAtomic(file: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
