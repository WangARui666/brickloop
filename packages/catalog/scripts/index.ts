import { performance } from 'node:perf_hooks';
import { buildCatalogIndex } from '../src/catalog-index';

const start = performance.now();
const index = await buildCatalogIndex({ force: process.argv.includes('--force') });
console.log(
  `目录 ${index.libraryVersion}：${index.parts.length} 件，${index.categories.length} 个分类，${Object.keys(index.aliases).length} 个别名；${(performance.now() - start).toFixed(1)} ms`,
);
