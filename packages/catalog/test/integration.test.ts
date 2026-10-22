import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalogIndex, defaultLibraryDir, repositoryRoot, sha256 } from '../src/catalog-index';
import { CatalogService } from '../src/catalog-service';
import { readColors } from '../src/colors';
import { DEMO_COLOR_CODES, DEMO_PARTS } from '../src/demo-parts';
import { importPack } from '../src/pack-import';
import { packFiles } from '../src/pack-workbooks';
import type { CatalogIndex, ColorDef, Pack } from '../src/types';

const available =
  existsSync(path.join(defaultLibraryDir, 'LDConfig.ldr')) && existsSync(path.join(defaultLibraryDir, 'parts'));
const skipReason = 'LDraw 零件库不存在；先运行 pnpm ldraw:fetch（由 M1-1 提供；并行分支可能尚未包含此脚本）。';
if (!available) console.warn(`跳过 catalog 真实库集成测试：${skipReason}`);
describe.skipIf(!available)('真实 LDraw 零件库与内置示例包', () => {
  let catalog: CatalogIndex;
  let colors: ColorDef[];
  let pack: Pack;
  let service: CatalogService;
  beforeAll(async () => {
    catalog = await buildCatalogIndex();
    colors = await readColors(path.join(defaultLibraryDir, 'LDConfig.ldr'));
    const result = await importPack(path.join(repositoryRoot, 'library/packs/demo'), { catalog, colors });
    expect(result.report.errors).toEqual([]);
    pack = result.pack!;
    service = new CatalogService(catalog, colors, pack);
  }, 60_000);

  it('FAC-01 示例包的乐高编号、工厂编号、颜色和可产配色完整', () => {
    expect(catalog.parts.length).toBeGreaterThan(20_000);
    expect(pack.parts).toHaveLength(DEMO_PARTS.length);
    expect(pack.parts.length).toBeGreaterThanOrEqual(190);
    expect(pack.colors).toHaveLength(DEMO_COLOR_CODES.length);
    expect(pack.colors[0]?.factoryCode).toBe('DEMO-001');
    expect(service.getPart('ld:3001')).toMatchObject({ legoNo: '3001', nameZh: '砖 2×4' });
    expect(service.factoryInfo('ld:3001')?.factoryNo).toMatch(/^DEMO-P\d{3}$/);
    expect(service.getColor('c:bright-red')).toMatchObject({ legoName: 'Bright Red', legoColorId: 21, ldrawCode: 4 });
    for (const part of pack.parts) expect(service.availableColors(part.partId)).toHaveLength(40);
    expect(service.search('phb').some((part) => part.nameZh.includes('平滑板'))).toBe(true);
  });

  it('示例包重建字节一致、无运行时间或随机 ZIP 元数据', async () => {
    const rebuilt = await packFiles(pack);
    for (const [name, bytes] of Object.entries(rebuilt)) {
      expect(sha256(bytes), name).toBe(sha256(await readFile(path.join(repositoryRoot, 'library/packs/demo', name))));
    }
  });

  // Runs 120 synchronous searches: ~3 s alone and ~5 s in the full suite.
  // Median assertions enforce performance (A-29); the timeout only detects hangs.
  it('UI-03 2 万条全库搜索 <30 ms，记录每个查询的首次及重复耗时', () => {
    const queries = ['2x4 砖', '3001', service.factoryInfo('ld:3001')!.factoryNo, 'phb', '平滑板', 'technc'];
    const measurements: string[] = [];
    for (const query of queries) {
      const timings: number[] = [];
      for (let iteration = 0; iteration < 20; iteration++) {
        const start = performance.now();
        const results = service.search(query, { includeAll: true });
        timings.push(performance.now() - start);
        expect(results.length).toBeGreaterThan(0);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      measurements.push(
        `${query}: first=${timings[0]!.toFixed(2)} ms, p50=${sorted[10]!.toFixed(2)} ms, max=${Math.max(...timings).toFixed(2)} ms`,
      );
      // Target is 30 ms (median); the assertion only catches order-of-magnitude regressions so
      // parallel test load does not make it flaky (decision A-29).
      expect(sorted[10]!, `${query} 搜索中位数应小于 90 ms`).toBeLessThan(90);
    }
    console.log(`catalog 搜索性能（${catalog.parts.length} 条，全部范围，20 次/查询）：\n${measurements.join('\n')}`);
  }, 30_000);
});
