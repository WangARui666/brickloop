import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { contentSecurityPolicy } from './src/shared/content-security-policy';

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const applicationVersion = (JSON.parse(readFileSync(fromRoot('./package.json'), 'utf8')) as { version: string })
  .version;
execFileSync(
  process.execPath,
  [fromRoot('../../scripts/devenv.mjs'), 'node', fromRoot('../../scripts/generate-licenses.mjs'), '--dev'],
  { stdio: 'inherit' },
);

export default defineConfig({
  main: {
    // Keep the distributed MCP handshake in sync without changing workspace package sources.
    plugins: [
      {
        name: 'brickloop-release-version',
        enforce: 'pre',
        transform(code, id) {
          if (!id.replaceAll('\\', '/').endsWith('/packages/mcp/src/server.ts')) return;
          const source = /\{\s*name:\s*['"]brickloop-mcp['"],\s*version:\s*['"]0\.0\.0['"]\s*\}/;
          if (!source.test(code)) throw new Error('MCP version source changed; review release version mapping');
          return code.replace(source, `{ name: 'brickloop-mcp', version: '${applicationVersion}' }`);
        },
      },
    ],
    define: {
      __BRICKLOOP_BUILD__: JSON.stringify({
        commit: execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(),
        date: new Date().toISOString(),
      }),
    },
    build: {
      externalizeDeps: {
        exclude: [
          '@brickloop/ai',
          '@brickloop/mcp',
          '@brickloop/mosaic',
          '@brickloop/i18n',
          '@brickloop/catalog',
          '@brickloop/ldraw',
          '@brickloop/core',
          '@brickloop/io',
          '@brickloop/connect',
          '@brickloop/collide',
        ],
      },
      rollupOptions: {
        external: ['koffi'],
        input: {
          index: fromRoot('./src/main/index.ts'),
          'mcp-shim': fromRoot('./src/main/mcp-shim.ts'),
          'mesh-worker': fromRoot('./src/main/mesh-worker.ts'),
          'project-worker': fromRoot('./src/main/project-worker.ts'),
          'assembly-worker': fromRoot('./src/main/assembly-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preload must be a single CommonJS bundle (only Electron is external).
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [
      react(),
      {
        name: 'brickloop-csp',
        transformIndexHtml(html, context) {
          return html.replace('__BRICKLOOP_CSP__', contentSecurityPolicy(Boolean(context.server)));
        },
      },
    ],
    optimizeDeps: { include: ['quickjs-emscripten'] },
    resolve: {
      alias: {
        'quickjs-emscripten': fromRoot('../../packages/buildscript/node_modules/quickjs-emscripten/dist/index.mjs'),
      },
    },
    worker: { format: 'es' },
    cacheDir: fromRoot('../../.devdata/vite-desktop'),
    server: { host: '127.0.0.1' },
  },
});
