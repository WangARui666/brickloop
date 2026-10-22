// Release entry bundled by electron-vite. The launcher supplies Electron's Node mode.
import { runStdio } from '../../../../packages/mcp/src/cli';
void runStdio().catch(() => {
  process.stderr.write('Brickloop MCP could not start.\n');
  process.exitCode = 1;
});
