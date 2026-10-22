import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { developmentEnvironment } from '../../../scripts/devenv.mjs';
import { RecoveryStore } from '../src/node';
import { cleanup, fixture, packed, repo, temporary } from './helpers';

// Time is dominated by subprocess startup and tsx module loading.
// Takes ~2 s idle and ~4 s at full-suite startup (previously ~19 s under load).
// The timeout only detects hangs.
it('REC-01: a killed real subprocess is discovered and recovers its complete logged transactions', async () => {
  const dir = await temporary();
  try {
    const doc = await fixture();
    await writeFile(path.join(dir, 'initial.brkl'), packed(doc));
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'packages/io/test/crash-child.ts', dir], {
        cwd: repo,
        env: developmentEnvironment(),
        windowsHide: true,
        stdio: 'pipe',
      });
      let errors = '';
      child.stderr.on('data', (data: Buffer) => {
        errors += data.toString();
      });
      child.on('error', reject);
      child.on('exit', (status) => {
        if (errors && status === 0) reject(new Error(errors));
        else resolve(status);
      });
    });
    expect(code).not.toBe(0);
    const evidence = JSON.parse(await readFile(path.join(dir, 'child-evidence.json'), 'utf8')) as {
      seq: number;
      lastDurableAt: string | null;
    };
    expect(evidence.lastDurableAt).not.toBeNull();
    expect(evidence.seq).toBe(2);
    const store = new RecoveryStore(dir),
      found = await store.scanRecoverable();
    expect(found).toHaveLength(1);
    expect(found[0]!.recoverableTransactions).toBe(2);
    expect(found[0]!.doc!.revision).toBe(2);
    expect(found[0]!.doc!.meta).toMatchObject({ notes: 'durable before forced termination', author: 'child' });
    await store.closeClean(doc.documentId);
  } finally {
    await cleanup(dir);
  }
}, 30_000);
