#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { fetch } = globalThis;

const directory = new URL('../library/fonts/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fonts.json', directory), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(directory, { recursive: true });
for (const font of manifest.fonts) {
  const target = new URL(font.file, directory);
  let existing;
  try {
    existing = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && digest(existing) === font.sha256) {
    console.log(`[fonts] Verified ${font.file}`);
    continue;
  }
  const response = await fetch(font.url);
  if (!response.ok) throw new Error(`Font download failed: ${font.file} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== font.sha256) throw new Error(`SHA-256 mismatch: ${font.file}`);
  const temporary = `${fileURLToPath(target)}.download`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`[fonts] Downloaded and verified ${font.file}`);
}
