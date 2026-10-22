import { runBuildScript, listExamples, getExample } from '../src/index.js';
import { options } from '../test/fixtures.js';

// Run from repository root: node scripts/devenv.mjs pnpm exec tsx --no-cache packages/buildscript/scripts/benchmark.ts
// Pure engine time includes QuickJS execution, rasterization, packing, repair, graph, hash and disposal.
for (const [label, code, expected, bound] of [
  ['2000', `box(0,0,0,160,100,6,'red')`, 2000, 2000],
  ['20000', `box(0,0,0,400,400,6,'red')`, 20000, 10000],
] as const) {
  const times: number[] = [];
  let hash = '';
  for (let trial = 0; trial < 3; trial++) {
    const start = performance.now(),
      r = await runBuildScript(code, options),
      ms = performance.now() - start;
    if (!r.ok) throw Error(JSON.stringify(r));
    if (r.stats.parts !== expected || ms > bound)
      throw Error(`Performance acceptance failed: ${label}, ${ms}ms, ${r.stats.parts} parts`);
    if (hash && hash !== r.hash) throw Error('Nondeterministic output');
    hash = r.hash;
    times.push(ms);
  }
  console.log(
    JSON.stringify({
      benchmark: label,
      parts: expected,
      ms: times.map((n) => Number(n.toFixed(2))),
      medianMs: [...times].sort((a, b) => a - b)[1],
      hash,
    }),
  );
}
for (const e of listExamples()) {
  const r = await runBuildScript(getExample(e.id)!.code, options);
  if (!r.ok) throw Error(JSON.stringify(r));
  if (r.stats.quality.floatingComponents) throw Error(`Example ${e.id} has floating components`);
  console.log(
    JSON.stringify({
      example: e.id,
      parts: r.stats.parts,
      byKind: r.stats.byKind,
      ms: Number(r.stats.ms.toFixed(2)),
      quality: r.stats.quality,
    }),
  );
}
