/** Chromium does not enforce response CSP on file:// Worker scripts. A blob entry
 * inherits the page CSP; its static module import completes before messages arrive. */
export function createModuleWorker(source: string): Worker {
  const url = new URL(source, location.href);
  const options: WorkerOptions = { type: 'module', name: url.pathname.split('/').at(-1) ?? 'brickloop-worker' };
  if (url.protocol !== 'file:') return new Worker(url, options);
  const blob = URL.createObjectURL(
    new Blob([`import ${JSON.stringify(url.href)};\nURL.revokeObjectURL(import.meta.url);`], {
      type: 'text/javascript',
    }),
  );
  try {
    const worker = new Worker(blob, options);
    worker.addEventListener('error', () => URL.revokeObjectURL(blob), { once: true });
    return worker;
  } catch (error) {
    URL.revokeObjectURL(blob);
    throw error;
  }
}
