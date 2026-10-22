import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.devdata/vite',
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'workspace',
          include: ['packages/*/{src,test}/**/*.{test,spec}.{ts,tsx}', 'apps/*/{src,test}/**/*.{test,spec}.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'packages/buildscript/**'],
        },
      },
      {
        test: {
          name: 'buildscript',
          include: ['packages/buildscript/{src,test}/**/*.{test,spec}.{ts,tsx}'],
          // The new package has a two-second wall-clock acceptance test. Run its
          // WASM/voxel workload after the other packages, without competing workers.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
