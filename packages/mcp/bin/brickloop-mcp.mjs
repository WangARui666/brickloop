#!/usr/bin/env node
import process from 'node:process';
import { developmentEnvironment } from '../../../scripts/devenv.mjs';

// Keep direct MCP launches on the same E:-local temp/cache policy as repo scripts.
Object.assign(process.env, developmentEnvironment());
process.env.TSX_DISABLE_CACHE = '1';
try {
  const { tsImport } = await import('tsx/esm/api');
  const { runStdio } = await tsImport('../src/cli.ts', import.meta.url);
  await runStdio();
} catch {
  process.stderr.write('Brickloop MCP could not start. Check the local endpoint and command options.\n');
  process.exitCode = 1;
}
