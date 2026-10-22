import { standardPackingParts, runBuildScript } from '../src/index.js';
import type { BuildCatalog, BuildOptions, BuildResult } from '../src/index.js';
export const catalog: BuildCatalog = {
  parts: standardPackingParts.map((p) => ({ ...p, factory: true })),
  colors: [
    { id: '4', name: 'Red', rgb: '#C91A09', factory: true },
    { id: '1', name: 'Blue', rgb: '#0055BF', factory: true },
    { id: '2', name: 'Green', rgb: '#237841', factory: true },
    { id: '0', name: 'Black', rgb: '#05131D', factory: true },
    { id: '15', name: 'White', rgb: '#FFFFFF', factory: true },
    { id: '14', name: 'Yellow', rgb: '#F2CD37', factory: true },
    { id: '70', name: 'Brown', rgb: '#582A12', factory: true },
    { id: '71', name: 'Gray', rgb: '#A0A5A9', factory: true },
    { id: '19', name: 'Tan', rgb: '#E4CD9E', factory: true },
  ],
};
export const options: BuildOptions = { catalog, scope: 'factory', seed: 42 };
export async function build(code: string, overrides: Partial<BuildOptions> = {}): Promise<BuildResult> {
  const result = await runBuildScript(code, { ...options, ...overrides });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
export function cells(result: BuildResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const i of result.instances) {
    const size = catalog.parts.find((p) => p.id === i.partId)!.size!,
      turn = i.pose.rotY % 180 !== 0,
      w = turn ? size.d : size.w,
      d = turn ? size.w : size.d;
    for (let y = i.pose.level - size.h; y < i.pose.level; y++)
      for (let z = i.pose.z - d / 2; z < i.pose.z + d / 2; z++)
        for (let x = i.pose.x - w / 2; x < i.pose.x + w / 2; x++) {
          const k = `${x},${y},${z}`;
          if (map.has(k)) throw new Error(`Overlap at ${k}`);
          map.set(k, i.colorId);
        }
  }
  return map;
}
