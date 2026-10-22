import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, resolvePipeName } from './config.js';

export async function runStdio(args = process.argv.slice(2)): Promise<void> {
  let pipeName = resolvePipeName();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pipe' && args[i + 1]) pipeName = resolvePipeName(args[++i]);
    else if (arg === '--timeout-ms' && args[i + 1]) timeoutMs = Number(args[++i]);
    else if (arg === '--help') {
      process.stderr.write('brickloop-mcp [--pipe <local endpoint>] [--timeout-ms <1..600000>]\n');
      return;
    } else throw new Error('Unknown or incomplete brickloop-mcp option.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Invalid timeout.');
  const server = createMcpServer({ pipeName, timeoutMs });
  const transport = new StdioServerTransport();
  const close = () => {
    void server.close().catch(() => {});
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
  await server.connect(transport);
}
