/** Used by Electron response headers and the HTML fallback. File Workers inherit it
 * through the blob module entry created by createModuleWorker. */
export function contentSecurityPolicy(development: boolean): string {
  const script = `'self' 'wasm-unsafe-eval'${development ? " 'unsafe-inline'" : ''}`;
  // WASM loaders fetch bundled files; Vite also needs its local WebSocket in dev.
  const connect = development ? "'self' blob: data: ws://127.0.0.1:*" : "'self' blob: data:";
  return `default-src 'self'; script-src ${script}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
}
