import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretStore } from '../src/main/secret-store';
import { SecretUnreadableError, isSecretReadError } from '@brickloop/ai';

describe('safeStorage adapter', () => {
  it('writes only encrypted bytes, atomically replaces and deletes values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'brickloop-secrets-'));
    const transform = (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa7));
    const store = createSecretStore(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (text) => transform(Buffer.from(text)),
      decryptString: (bytes) => transform(bytes).toString(),
    });
    try {
      expect(await store.get('key')).toBeUndefined();
      await store.set('key', 'test-only-sensitive-key');
      expect(await store.get('key')).toBe('test-only-sensitive-key');
      for (const file of await readdir(directory))
        expect((await readFile(path.join(directory, file))).includes(Buffer.from('test-only-sensitive-key'))).toBe(
          false,
        );
      await store.set('key', 'changed');
      expect(await store.get('key')).toBe('changed');
      expect(await readdir(directory)).toHaveLength(1);
      await store.delete('key');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('never falls back to plaintext when OS encryption is unavailable', async () => {
    const store = createSecretStore(path.join(tmpdir(), 'unused-secret-directory'), {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('not reached');
      },
      decryptString: () => {
        throw new Error('not reached');
      },
    });
    await expect(store.set('key', 'secret')).rejects.toThrow('SECURE_STORAGE_UNAVAILABLE');
    await expect(store.get('missing')).resolves.toBeUndefined();
  });
  it('distinguishes decryption failures without exposing native details or modifying ciphertext', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'brickloop-unreadable-'));
    const key = `sk-test-${randomUUID()}`;
    let unreadable = false;
    const transform = (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa7));
    const store = createSecretStore(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (text) => transform(Buffer.from(text)),
      decryptString: (bytes) => {
        if (unreadable) throw new Error(key);
        return transform(bytes).toString();
      },
    });
    try {
      await store.set('key', key);
      const file = path.join(directory, (await readdir(directory))[0]!);
      const original = await readFile(file);
      unreadable = true;
      await expect(store.get('key')).rejects.toBeInstanceOf(SecretUnreadableError);
      const error = await store.get('key').catch((error: unknown) => error);
      expect(isSecretReadError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'SECRET_UNREADABLE' });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain(key);
      expect(await readFile(file)).toEqual(original);
      await expect(store.get('missing')).resolves.toBeUndefined();
      unreadable = false;
      await expect(store.get('key')).resolves.toBe(key);
      await store.set('key', 'replacement-test-value');
      await expect(store.get('key')).resolves.toBe('replacement-test-value');
      unreadable = true;
      await store.delete('key');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps IO and write failures separate from unreadable ciphertext', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'brickloop-secret-io-'));
    const store = createSecretStore(directory, {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('private input');
      },
      decryptString: () => 'unused',
    });
    try {
      await mkdir(path.join(directory, `${createHash('sha256').update('key').digest('hex')}.bin`));
      await expect(store.get('key')).rejects.toThrow('SECURE_STORAGE_FAILED');
      await expect(store.set('other', 'fake')).rejects.toThrow('SECURE_STORAGE_FAILED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
