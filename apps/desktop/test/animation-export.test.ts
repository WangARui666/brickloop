import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnimationExports } from '../src/main/animation-export';
import { validAnimationArguments, ANIMATION_CHANNELS } from '../src/shared/animation-api';
import { writeExportAtomic } from '../src/main/export-file';
describe('animation export IPC and atomic writes', () => {
  let directory: string;
  beforeEach(async () => {
    const base = path.resolve('.devdata/animation-unit');
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(path.join(base, 'export-'));
  });
  afterEach(async () => {
    if (directory.startsWith(path.resolve('.devdata/animation-unit') + path.sep))
      await rm(directory, { recursive: true, force: true });
  });
  it('preflights a missing parent before issuing a ticket and preserves the native ENOENT error', async () => {
    const parent = path.join(directory, 'missing'),
      service = createAnimationExports(
        async () => path.join(parent, 'movie.mp4'),
        (key) => key,
      );
    await expect(service.api.animationChoose('Cottage', 'mp4')).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'stat',
      path: parent,
    });
    expect(await readdir(directory)).toEqual([]);
    service.dispose();
  });
  it('rejects a parent that is a file with the native ENOTDIR error without changing it', async () => {
    const parent = path.join(directory, 'not-a-directory');
    await writeFile(parent, 'original');
    const service = createAnimationExports(
      async () => path.join(parent, 'movie.mp4'),
      (key) => key,
    );
    await expect(service.api.animationChoose('Cottage', 'mp4')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await readFile(parent, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['not-a-directory']);
    service.dispose();
  });
  it('preflights a writable directory without creating the target or a temporary file', async () => {
    const file = path.join(directory, 'movie.mp4'),
      service = createAnimationExports(
        async () => file,
        (key) => key,
      );
    const job = await service.api.animationChoose('Cottage', 'mp4');
    expect(job).toEqual({ id: expect.any(String), path: file });
    expect(await readdir(directory)).toEqual([]);
    service.dispose();
  });
  it('still rejects and cleans up when the parent disappears after preflight', async () => {
    const parent = path.join(directory, 'destination');
    await mkdir(parent);
    const service = createAnimationExports(
        async () => path.join(parent, 'movie.mp4'),
        (key) => key,
      ),
      job = await service.api.animationChoose('Cottage', 'mp4');
    await rm(parent, { recursive: true });
    await expect(service.api.animationSave(job!.id, new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(directory)).toEqual([]);
    await expect(service.api.animationSave(job!.id, new Uint8Array([1]))).rejects.toThrow('invalidSave');
    service.dispose();
  });
  it('only accepts a native-dialog ticket, commits complete bytes, and consumes the ticket', async () => {
    const file = path.join(directory, 'movie.mp4'),
      service = createAnimationExports(
        async () => file,
        (key) => key,
      );
    const job = await service.api.animationChoose('Cottage', 'mp4');
    expect(job).not.toBeNull();
    await expect(service.api.animationSave(job!.id, new Uint8Array([1, 2, 3]))).resolves.toBe(file);
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
    expect(await readdir(directory)).toEqual(['movie.mp4']);
    await expect(service.api.animationSave(job!.id, new Uint8Array([4]))).rejects.toThrow('invalidSave');
    service.dispose();
  });
  it('ANI-06 cancel never overwrites an existing complete video', async () => {
    const file = path.join(directory, 'movie.mp4');
    await writeFile(file, 'original');
    const service = createAnimationExports(
        async () => file,
        (key) => key,
      ),
      job = await service.api.animationChoose('Cottage', 'mp4');
    await service.api.animationCancel(job!.id);
    await expect(service.api.animationSave(job!.id, new Uint8Array([2]))).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(writeExportAtomic(file, new Uint8Array([2]), abort.signal)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['movie.mp4']);
  });
  it('ANI-06 write failure cleans the temporary sibling; dialog cancellation creates no ticket', async () => {
    const file = path.join(directory, 'existing-directory');
    await mkdir(file);
    const service = createAnimationExports(
        async () => file,
        (key) => key,
      ),
      job = await service.api.animationChoose('Cottage', 'mp4');
    await expect(service.api.animationSave(job!.id, new Uint8Array([1, 2]))).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['existing-directory']);
    expect(
      await createAnimationExports(
        async () => null,
        (key) => key,
      ).api.animationChoose('a', 'webm'),
    ).toBeNull();
  });
  it('rejects renderer-supplied paths, arbitrary payloads and unknown formats', () => {
    expect(validAnimationArguments(ANIMATION_CHANNELS.animationSave, ['E:\\movie.mp4', new Uint8Array([1])])).toBe(
      false,
    );
    expect(validAnimationArguments(ANIMATION_CHANNELS.animationChoose, ['title', 'avi'])).toBe(false);
    expect(validAnimationArguments(ANIMATION_CHANNELS.animationChoose, ['title', ['mp4']])).toBe(false);
    expect(
      validAnimationArguments(ANIMATION_CHANNELS.animationSave, ['00000000-0000-0000-0000-000000000000', []]),
    ).toBe(false);
    expect(validAnimationArguments(ANIMATION_CHANNELS.animationChoose, ['title', 'mp4'])).toBe(true);
  });
});
