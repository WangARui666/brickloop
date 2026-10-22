import path from 'node:path';

export function associatedFiles(argv: readonly string[], cwd: string): string[] {
  return [
    ...new Set(
      argv
        .filter((arg) => !arg.startsWith('-') && !arg.includes('\0') && /\.(brkl|brklpack)$/i.test(arg))
        .map((arg) => path.resolve(cwd, arg)),
    ),
  ];
}
export function createOpenFileQueue(send: (files: string[]) => void) {
  let ready = false;
  let pending: string[] = [];
  return {
    enqueue(files: string[]) {
      if (ready) send(files);
      else pending.push(...files);
    },
    ready() {
      ready = true;
      const files = [...new Set(pending)];
      pending = [];
      return files;
    },
    reset() {
      ready = false;
    },
  };
}
