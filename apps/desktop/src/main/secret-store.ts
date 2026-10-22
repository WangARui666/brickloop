import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretStore } from '@brickloop/ai';
import { SecretUnreadableError } from '@brickloop/ai';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** Only ciphertext reaches disk, including temporary atomic replacement files. */
export function createSecretStore(directory: string, safeStorage: SafeStorageAdapter): SecretStore {
  const filename = (key: string) => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.bin`);
  const available = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  };
  return {
    async get(key) {
      let encrypted: Buffer;
      try {
        encrypted = await readFile(filename(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        // eslint-disable-next-line preserve-caught-error -- Native storage errors must not expose sensitive details.
        throw new Error('SECURE_STORAGE_FAILED');
      }
      available();
      try {
        return safeStorage.decryptString(encrypted);
      } catch {
        throw new SecretUnreadableError();
      }
    },
    async set(key, value) {
      available();
      const file = filename(key),
        temporary = `${file}.tmp`;
      try {
        const encrypted = safeStorage.encryptString(value);
        await mkdir(directory, { recursive: true });
        try {
          await writeFile(temporary, encrypted, { mode: 0o600 });
          await rename(temporary, file);
        } finally {
          await rm(temporary, { force: true });
        }
      } catch {
        throw new Error('SECURE_STORAGE_FAILED');
      }
    },
    async delete(key) {
      try {
        await rm(filename(key), { force: true });
      } catch {
        throw new Error('SECURE_STORAGE_FAILED');
      }
    },
  };
}
