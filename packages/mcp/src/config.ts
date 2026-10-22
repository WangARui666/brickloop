import { userInfo, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const BRIDGE_VERSION = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_CONNECTIONS = 32;
export const MAX_PENDING_CALLS = 64;

/** The only endpoint configuration point; never accepts TCP or remote UNC pipes. */
export function resolvePipeName(override = process.env.BRICKLOOP_MCP_PIPE): string {
  if (process.platform === 'win32') {
    const name = override ?? `\\\\.\\pipe\\brickloop-mcp-${userInfo().username.replace(/[\\/:*?"<>|]/g, '_')}`;
    if (!/^\\\\\.\\pipe\\brickloop-mcp-[^\\/]+$/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) {
      throw new Error('Expected a local \\\\.\\pipe\\brickloop-mcp-<name> endpoint.');
    }
    return name;
  }
  const name = override ?? join(tmpdir(), `brickloop-mcp-${userInfo().uid}`, 'host.sock');
  if (!isAbsolute(name) || Buffer.byteLength(name) > 100 || name.includes('\0')) {
    throw new Error('Expected an absolute Unix socket path of at most 100 bytes.');
  }
  return name;
}
