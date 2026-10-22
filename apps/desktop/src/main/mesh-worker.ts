import { parentPort, workerData } from 'node:worker_threads';
import { createLibraryResolver, createMeshCache } from '@brickloop/ldraw/node';
import { ownMesh, meshBuffers } from '../shared/mesh-transfer';

interface Job {
  id: number;
  file: string;
  customDir?: string;
}
const config = workerData as { library: string; cache: string };
const cache = createMeshCache(config.cache);
const resolvers = new Map<string, ReturnType<typeof createLibraryResolver>>();
parentPort!.on('message', (job: Job) => {
  void (async () => {
    const started = performance.now();
    const scope = job.customDir ?? '';
    let resolver = resolvers.get(scope);
    if (!resolver) {
      resolver = createLibraryResolver({ libraryDir: config.library, customDirs: scope ? [scope] : [] });
      resolvers.set(scope, resolver);
    }
    const result = await cache.build(job.file, resolver);
    const mesh = ownMesh(result.mesh);
    parentPort!.postMessage(
      { id: job.id, result: { ...result, mesh, durationMs: performance.now() - started } },
      meshBuffers(mesh),
    );
  })().catch((error: unknown) =>
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
