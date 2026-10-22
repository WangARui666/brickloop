#!/usr/bin/env node
// Runs a command with temp files and Node compile caches redirected into <repo>/.devdata,
// so tooling does not write to the system temp directory (workspace rule: keep caches on E:).
// Usage (from any package script): node <path-to>/scripts/devenv.mjs <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function developmentEnvironment(profile) {
  const devdata = path.join(repoRoot, '.devdata');
  const dirs = {
    TEMP: path.join(devdata, 'tmp'),
    TMP: path.join(devdata, 'tmp'),
    TMPDIR: path.join(devdata, 'tmp'),
    NODE_COMPILE_CACHE: path.join(devdata, 'node-compile-cache'),
    electron_config_cache: path.join(devdata, 'electron-cache'),
    ELECTRON_BUILDER_CACHE: path.join(devdata, 'electron-builder-cache'),
    npm_config_cache: path.join(devdata, 'npm-cache'),
    XDG_CACHE_HOME: path.join(devdata, 'tool-cache'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(devdata, 'playwright'),
  };
  if (profile !== undefined) {
    if (profile !== 'dev' && profile !== 'e2e') throw new Error(`Unknown development profile: ${profile}`);
    dirs.BRICKLOOP_DATA_DIR = path.join(devdata, profile);
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { ...process.env, ...dirs };
}

// Also imported by the pnpm configuration hook, before dependency install scripts run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const profile = args[0] === '--profile' ? (args.splice(0, 1), args.shift()) : undefined;
  const command = args.shift();
  if (!command) {
    console.error('usage: node scripts/devenv.mjs [--profile dev|e2e] <command> [args...]');
    process.exit(2);
  }
  // Package scripts use fixed arguments; the shell resolves Windows .cmd shims.
  const child = spawn([command, ...args].join(' '), {
    stdio: 'inherit',
    env: developmentEnvironment(profile),
    shell: true,
  });
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
