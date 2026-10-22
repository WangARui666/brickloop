import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { buildPartMesh, LibraryResolver, createMemorySource } from '@brickloop/ldraw';
import type { PartMesh } from '@brickloop/ldraw';
import { ownMesh, meshBuffers } from '../src/shared/mesh-transfer';

it('transfers all geometry buffers intact and detaches their original storage', async () => {
  const resolver = new LibraryResolver({
    library: createMemorySource('fixture', {
      'parts/test.dat': '0 Triangle\n3 16 0 0 0 10 0 0 0 10 0\n2 24 0 0 0 10 0 0\n5 24 0 0 0 10 0 0 0 10 0 0 -10 0',
    }),
  });
  const source = await buildPartMesh('test.dat', resolver);
  const mesh = ownMesh(source);
  const buffers = meshBuffers(mesh);
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise<PartMesh>((resolve) => port2.once('message', resolve));
    port1.postMessage(mesh, buffers);
    expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
    expect(source.batches[0]!.positions.byteLength).toBeGreaterThan(0);
    expect(await received).toEqual(source);
  } finally {
    port1.close();
    port2.close();
  }
});
