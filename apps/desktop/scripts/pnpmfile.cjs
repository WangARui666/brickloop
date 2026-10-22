const process = require('node:process');
const path = require('node:path');
const { pnpm } = require('../../../package.json');

module.exports = {
  hooks: {
    async updateConfig(config) {
      // Runs before Electron's first postinstall, including a plain `pnpm install`.
      const { developmentEnvironment } = await import('../../../scripts/devenv.mjs');
      const environment = developmentEnvironment();
      Object.assign(process.env, environment);
      const devdata = path.dirname(environment.NODE_COMPILE_CACHE);
      return {
        ...config,
        // A worktree has its own dependency store as well as temp/build caches.
        // This also lets `pnpm licenses list` find newly installed muxer metadata.
        storeDir: path.join(devdata, 'pnpm-store'),
        cacheDir: path.join(devdata, 'pnpm-cache'),
        stateDir: path.join(devdata, 'pnpm-state'),
        // M0-1 also declares esbuild in pnpm-workspace.yaml; preserve that list.
        onlyBuiltDependencies: [...new Set([...(config.onlyBuiltDependencies ?? []), ...pnpm.onlyBuiltDependencies])],
      };
    },
  },
};
