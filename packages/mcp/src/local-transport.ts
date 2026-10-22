import { createServer, createConnection } from 'node:net';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import { resolvePipeName } from './config.js';
import { BridgeError } from './protocol.js';

export interface LocalListener {
  close(): Promise<void>;
}

export async function listenLocal(pipeName: string, accept: (stream: Duplex) => void): Promise<LocalListener> {
  resolvePipeName(pipeName);
  if (process.platform === 'win32') {
    const { listenWindowsPipe } = await import('./windows-pipe.js');
    return listenWindowsPipe(pipeName, accept);
  }
  const directory = dirname(pipeName);
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('The Unix socket directory must belong to the current user with mode 0700.');
  }
  const sockets = new Set<Duplex>();
  const server = createServer((stream) => {
    sockets.add(stream);
    stream.once('close', () => sockets.delete(stream));
    accept(stream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // The private parent directory protects the socket during creation/chmod.
  try {
    await chmod(pipeName, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function connectLocal(pipeName: string, signal: AbortSignal): Promise<Duplex> {
  resolvePipeName(pipeName);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BridgeError('CANCELLED', 'Operation cancelled.'));
      return;
    }
    const socket = createConnection(pipeName);
    const abort = () => socket.destroy(new BridgeError('CANCELLED', 'Operation cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(
        signal.aborted
          ? new BridgeError('CANCELLED', 'Operation cancelled.')
          : new BridgeError('NOT_RUNNING', 'Brickloop is not running'),
      );
    });
    socket.once('connect', () => {
      signal.removeEventListener('abort', abort);
      resolve(socket);
    });
  });
}
