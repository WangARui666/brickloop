import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from '@brickloop/core';
import { unpackProject } from '../src/project';
import { RecoveryStore } from '../src/node/recovery';

const directory = process.argv[2]!;
const bytes = await readFile(path.join(directory, 'initial.brkl'));
const doc = unpackProject(bytes).doc!;
const store = new RecoveryStore(directory);
await store.startSession(doc.documentId, bytes);
await store.appendTransaction(doc.documentId, {
  revision: 1,
  prevRevision: doc.revision,
  txId: ulid(),
  label: 'child process edit',
  source: 'ui',
  at: new Date().toISOString(),
  ops: [{ type: 'meta.update', changes: { notes: 'durable before forced termination' } }],
});
// Leave the process alive long enough for the automatic ~1 second batch flush.
await new Promise((resolve) => setTimeout(resolve, 1300));
const state = await store.appendTransaction(doc.documentId, {
  revision: 2,
  prevRevision: 1,
  txId: ulid(),
  label: 'tail edit',
  source: 'ui',
  at: new Date().toISOString(),
  ops: [{ type: 'meta.update', changes: { author: 'child' } }],
});
await writeFile(path.join(directory, 'child-evidence.json'), JSON.stringify({ pid: process.pid, ...state }));
// No store.dispose or closeClean: terminate while the second flush is still pending.
process.kill(process.pid, 'SIGKILL');
