import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeExportAtomic } from './export-file';
import type { AnimationExportApi } from '../shared/animation-api';

/** The renderer gets an opaque save ticket; paths only come from the native save dialog. */
export function createAnimationExports(
  choose: (extension: string, title: string, name: string) => Promise<string | null>,
  t: (key: string) => string,
) {
  const jobs = new Map<string, { path: string; abort: AbortController; writing: boolean }>();
  const api: AnimationExportApi = {
    async animationChoose(title, format) {
      const name =
        Array.from(title, (char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '_' : char))
          .join('')
          .slice(0, 150) || t('animationUi.untitled');
      const path = await choose(format, t('animationUi.export'), `${name}-${t('animationUi.fileSuffix')}.${format}`);
      if (!path) return null;
      // The renderer awaits this ticket before encoding any frames. Preserve native fs errors for its export UI.
      const directory = dirname(path);
      // readdir supplies the native ENOTDIR error if the selected parent is a file.
      if (!(await stat(directory)).isDirectory()) await readdir(directory);
      await access(directory, constants.W_OK);
      const id = randomUUID();
      jobs.set(id, { path, abort: new AbortController(), writing: false });
      return { id, path };
    },
    async animationSave(id, bytes) {
      const job = jobs.get(id);
      if (!job || job.writing) throw new Error(t('animationUi.invalidSave'));
      job.writing = true;
      try {
        await writeExportAtomic(job.path, bytes, job.abort.signal);
        return job.path;
      } finally {
        jobs.delete(id);
      }
    },
    async animationCancel(id) {
      const job = jobs.get(id);
      job?.abort.abort();
      if (!job?.writing) jobs.delete(id);
    },
  };
  return {
    api,
    dispose() {
      for (const job of jobs.values()) job.abort.abort();
      jobs.clear();
    },
  };
}
