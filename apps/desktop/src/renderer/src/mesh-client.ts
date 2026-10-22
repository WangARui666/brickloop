import type { PartId } from '@brickloop/catalog';
import type { MeshResult } from '../../shared/library-api';
import type { PartMesh } from '@brickloop/ldraw';

export const sourceMeshes = new Map<string, PartMesh>();
export const meshMetrics = {
  requests: 0,
  failures: 0,
  timeouts: 0,
  cacheHits: 0,
  workerMs: 0,
  queueMs: 0,
  workerDeliveryMs: 0,
  ipcAndSchedulingMs: 0,
};
let pinned = new Set<string>();
export function retainMeshes(ids: Iterable<string>) {
  pinned = new Set(ids);
  const unused = [...sourceMeshes.keys()].filter((id) => !pinned.has(id));
  for (const id of unused.slice(0, Math.max(0, unused.length - 128))) sourceMeshes.delete(id);
}

const pending = new Map<string, { resolve(result: MeshResult): void; reject(error: Error): void }>();
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== 'object') return;
  const data = event.data as { type?: string; request?: string };
  if (data.type !== 'brickloop:mesh-port' || !data.request) return;
  const task = pending.get(data.request);
  const port = event.ports[0];
  if (!task || !port) return;
  port.onmessage = (message: MessageEvent<{ result?: MeshResult; error?: string }>) => {
    pending.delete(data.request!);
    port.close();
    if (message.data.result) task.resolve(message.data.result);
    else task.reject(new Error(message.data.error ?? 'mesh'));
  };
  port.start();
});
export function requestMesh(id: PartId): Promise<MeshResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = crypto.randomUUID();
    // The main-process pool owns execution timeouts. Queue residence is unbounded.
    pending.set(request, {
      resolve: (result) => {
        meshMetrics.requests++;
        if (result.cacheHit) meshMetrics.cacheHits++;
        meshMetrics.workerMs += result.durationMs;
        meshMetrics.queueMs += result.timing?.queueMs ?? 0;
        meshMetrics.workerDeliveryMs += result.timing?.deliveryMs ?? 0;
        meshMetrics.ipcAndSchedulingMs += Math.max(
          0,
          performance.now() -
            started -
            result.durationMs -
            (result.timing?.queueMs ?? 0) -
            (result.timing?.deliveryMs ?? 0),
        );
        resolve(result);
      },
      reject: (error) => {
        meshMetrics.failures++;
        if (/timeout/i.test(error.message)) meshMetrics.timeouts++;
        reject(error);
      },
    });
    window.brickloopMeshRequest(request, id);
  });
}
const meshes = new Map<string, Promise<MeshResult>>();
let cacheGeneration = 0;
export function clearMeshCache() {
  cacheGeneration++;
  meshes.clear();
  sourceMeshes.clear();
}
export function getMesh(id: PartId, pack: string): Promise<MeshResult> {
  const key = `${pack}/${id}`;
  const cached = meshes.get(key);
  if (cached) {
    meshes.delete(key);
    meshes.set(key, cached);
    return cached;
  }
  const generation = cacheGeneration;
  const result = requestMesh(id).then((result) => {
    if (
      result.mesh.diagnostics.missing.length &&
      !result.mesh.batches.some((batch) => batch.indices.length) &&
      !result.mesh.edges.some((edge) => edge.positions.length)
    )
      throw new Error('Missing part shape');
    if (generation === cacheGeneration) {
      sourceMeshes.set(id, result.mesh);
      retainMeshes(pinned);
    }
    return result;
  });
  meshes.set(key, result);
  if (meshes.size > 128) meshes.delete(meshes.keys().next().value!);
  void result.catch(() => {
    if (meshes.get(key) === result) meshes.delete(key);
  });
  return result;
}
