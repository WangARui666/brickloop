import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOps, createWorkspace, DocumentSession, serializeDocument, ulid, validateDocument } from '@brickloop/core';
import type { BrkDocument, SessionChange } from '@brickloop/core';
import { crc32, exportIo, hashBytes, importIo, packProject, unpackProject } from '../src';
import { utf8 } from '../src/binary';
import { RecoveryStore, trackSession, transactionFromChange } from '../src/node';
import type { RecoveryOptions, RecoveryTransaction } from '../src/node';
import { cleanup, fixture, packed, temporary } from './helpers';

describe('recovery journal and snapshots', () => {
  let dir: string, doc: BrkDocument;
  const stores: RecoveryStore[] = [];
  const store = (options: RecoveryOptions = {}) => {
    const value = new RecoveryStore(dir, { isProcessAlive: () => false, ...options });
    stores.push(value);
    return value;
  };
  const tx = (revision: number, previous = revision - 1): RecoveryTransaction => ({
    revision,
    prevRevision: previous,
    txId: ulid(),
    label: `事务 ${revision}`,
    source: 'ui',
    at: `2026-10-16T00:00:${String(revision % 60).padStart(2, '0')}.000Z`,
    ops: [{ type: 'meta.update', changes: { notes: String(revision) } }],
  });
  const journal = (revision = 0) => path.join(dir, 'recovery', doc.documentId, `journal-${revision}.jsonl`);
  const applyTx = (transaction: RecoveryTransaction) => {
    doc = { ...applyOps(doc, transaction.ops), revision: transaction.revision };
  };
  beforeEach(async () => {
    dir = await temporary();
    doc = await fixture();
  });
  afterEach(async () => {
    for (const value of stores.splice(0)) await value.dispose();
    await cleanup(dir);
  });
  it('M9-5d: unsaved .io recovery preserves the source title and the snapshot writer version', async () => {
    doc = importIo(exportIo(doc).bytes, {}, '彩色积木.io').doc!;
    const value = store();
    const bytes = packProject(doc, createWorkspace(), {}, { appVersion: '9.8.7' });
    await value.startSession(doc.documentId, bytes);
    const snapshot = unpackProject(await fs.readFile(path.join(path.dirname(journal()), 'snapshot-0.brkl')));
    expect(snapshot.manifest!.appVersion).toBe('9.8.7');
    expect(snapshot.doc!.meta.title).toBe('彩色积木.io');
    await value.appendTransaction(doc.documentId, tx(1));
    await value.flush(doc.documentId);
    const found = await store().scanRecoverable();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ title: '彩色积木.io', projectPath: null, recoverableTransactions: 1 });
    expect(found[0]!.doc!.meta.title).toBe('彩色积木.io');
  });
  it('REC-01: scans dead sessions and replays the last flushed revision; live sessions excluded', async () => {
    const value = store();
    await value.startSession(doc.documentId, packed(doc), 'E:\\models\\original.brkl');
    for (let revision = 1; revision <= 3; revision++) {
      const transaction = tx(revision);
      await value.appendTransaction(doc.documentId, transaction);
      applyTx(transaction);
    }
    await value.flush(doc.documentId);
    const found = await store().scanRecoverable();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      recoverableTransactions: 3,
      lastSeq: 3,
      projectPath: 'E:\\models\\original.brkl',
      lastRecoveredAt: tx(3).at,
    });
    expect(serializeDocument(found[0]!.doc!)).toBe(serializeDocument(doc));
    expect(await store({ isProcessAlive: () => true }).scanRecoverable()).toEqual([]);
  });
  it.each(['head', 'middle', 'tail'])('REC-02: stops before a %s-truncated row', async (where) => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    for (let i = 1; i <= 3; i++) await value.appendTransaction(doc.documentId, tx(i));
    await value.flush(doc.documentId);
    const lines = (await fs.readFile(journal(), 'utf8')).split('\n');
    const row = lines[1]!;
    lines[1] = where === 'head' ? row.slice(1) : where === 'middle' ? row.slice(0, row.length / 2) : row.slice(0, -4);
    await fs.writeFile(journal(), lines.join('\n'));
    const recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(1);
    expect(recovered.recoverableTransactions).toBe(1);
    expect(recovered.issues.some((i) => i.code === 'RECOVERY_JOURNAL_INVALID')).toBe(true);
  });
  it('REC-02: a complete JSON row without a newline remains uncommitted', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await value.appendTransaction(doc.documentId, tx(1));
    await value.flush(doc.documentId);
    const line = await fs.readFile(journal(), 'utf8');
    await fs.writeFile(journal(), line.trimEnd());
    expect((await store().recover(doc.documentId)).doc!.revision).toBe(0);
  });
  it.each(['beforeReplace', 'snapshotPublished', 'journalPublished'] as const)(
    'REC-03: interrupted at %s never drops or duplicates transactions',
    async (stage) => {
      let interrupt = false;
      const value = store({
        saveOptions: {
          checkpoint: (point, file) => {
            if (interrupt && stage === 'beforeReplace' && point === 'beforeReplace' && file.includes('snapshot-1.brkl'))
              throw new Error('simulated crash');
          },
        },
        checkpoint: (point) => {
          if (interrupt && stage !== 'beforeReplace' && point === stage) throw new Error('simulated crash');
        },
      });
      await value.writeSnapshot(doc.documentId, packed(doc), 0);
      const transaction = tx(1);
      await value.appendTransaction(doc.documentId, transaction);
      applyTx(transaction);
      await value.flush(doc.documentId);
      interrupt = true;
      await expect(value.writeSnapshot(doc.documentId, packed(doc), 1)).rejects.toThrow();
      const recovered = await store().recover(doc.documentId);
      expect(serializeDocument(recovered.doc!)).toBe(serializeDocument(doc));
      expect(recovered.lastSeq).toBe(1);
      expect(recovered.recoverableTransactions).toBe(stage === 'beforeReplace' ? 1 : 0);
    },
  );
  it('REC-03: abandoned .tmp snapshot ignored; corrupt latest snapshot falls back', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await value.appendTransaction(doc.documentId, tx(1));
    await value.flush(doc.documentId);
    const folder = path.dirname(journal());
    await fs.writeFile(path.join(folder, 'snapshot-100.brkl.tmp-dead'), packed(doc));
    await fs.writeFile(path.join(folder, 'snapshot-99.brkl'), 'bad');
    const recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(1);
    expect(recovered.issues.some((i) => i.code === 'RECOVERY_INVALID_SNAPSHOT')).toBe(true);
  });
  it('REC-05: image resource and model edit recover together; missing resource rejects the whole transaction', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    const bytes = utf8('reference image'),
      hash = hashBytes(bytes),
      imageId = ulid();
    const instance = Object.values(doc.models)
      .flatMap((m) => Object.values(m.instances))
      .find((i) => i.ref.kind === 'part')!;
    const modelId = Object.values(doc.models).find((m) => m.instances[instance.id])!.id;
    const transaction = tx(1);
    transaction.ops = [
      {
        type: 'asset.add',
        items: [{ kind: 'referenceImage', id: imageId, value: { hash, path: `assets/images/${hash}` } }],
      },
      {
        type: 'instance.update',
        items: [{ modelId, instanceId: instance.id, changes: { transform: [20, ...instance.transform.slice(1)] } }],
      },
    ];
    transaction.assets = { [hash]: bytes };
    await value.appendTransaction(doc.documentId, transaction);
    await value.flush(doc.documentId);
    let recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.referenceImages[imageId]!.hash).toBe(hash);
    expect(recovered.doc!.models[modelId]!.instances[instance.id]!.transform[0]).toBe(20);
    expect(recovered.assets[`assets/images/${hash}`]).toEqual(bytes);
    await fs.unlink(path.join(path.dirname(journal()), 'assets', hash));
    recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(0);
    expect(recovered.doc!.referenceImages).toEqual({});
    expect(recovered.doc!.models[modelId]!.instances[instance.id]!.transform[0]).toBe(0);
    expect(recovered.issues[0]!.code).toBe('RECOVERY_ASSET_MISSING');
  });
  it('rejects wrong or absent assets before publishing the referring row', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await expect(
      value.appendTransaction(doc.documentId, { ...tx(1), assets: { ['0'.repeat(64)]: utf8('wrong') } }),
    ).rejects.toThrow();
    expect(await fs.readFile(journal(), 'utf8')).toBe('');
  });
  it('REC-06: clean close deletes only the selected document and rejects unsafe IDs', async () => {
    const value = store(),
      other = await fixture();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await value.writeSnapshot(other.documentId, packed(other), 0);
    await value.closeClean(doc.documentId);
    expect(await fs.readdir(path.join(dir, 'recovery'))).toEqual([other.documentId]);
    expect(() => value.closeClean('../outside')).toThrow('Invalid documentId');
  });
  // About 2,400 serial filesystem calls, including real fsyncs and renames, with no wall-clock waits.
  // Takes ~1 s idle and has reached ~9 s alongside the full suite and Electron e2e.
  // The timeout only detects hangs.
  it('REC-07: 50 snapshots with concurrent queued shared-model changes remain complete', async () => {
    const snapshots: number[] = [];
    const value = store({
      saveOptions: {
        checkpoint: async (stage, file) => {
          if (stage === 'validated' && /snapshot-\d+\.brkl\.tmp-/.test(file)) {
            const project = unpackProject(await fs.readFile(file));
            expect(project.issues).toEqual([]);
            expect(validateDocument(project.doc!)).toEqual([]);
            snapshots.push(project.doc!.revision);
          }
        },
      },
    });
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    const shared = Object.values(doc.models).find((m) => m.kind === 'submodel')!,
      part = Object.values(shared.instances)[0]!;
    const pending: Promise<unknown>[] = [];
    for (let revision = 1; revision <= 50; revision++) {
      const transaction = {
        ...tx(revision),
        ops: [
          {
            type: 'instance.update' as const,
            items: [
              {
                modelId: shared.id,
                instanceId: part.id,
                changes: { transform: [revision, ...part.transform.slice(1)] },
              },
            ],
          },
        ],
      };
      pending.push(value.appendTransaction(doc.documentId, transaction));
      applyTx(transaction);
      pending.push(value.writeSnapshot(doc.documentId, packed(doc), revision));
    }
    await Promise.all(pending);
    const recovered = await store().recover(doc.documentId);
    expect(snapshots).toEqual(Array.from({ length: 51 }, (_, i) => i));
    expect(recovered.doc!.revision).toBe(50);
    expect(serializeDocument(recovered.doc!)).toBe(serializeDocument(doc));
  }, 30_000);
  it('retains transactions newer than an explicitly captured snapshot sequence', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await value.appendTransaction(doc.documentId, tx(1));
    applyTx(tx(1));
    const snapshot = packed(doc);
    await value.appendTransaction(doc.documentId, tx(2));
    applyTx(tx(2));
    await value.writeSnapshot(doc.documentId, snapshot, 1, 1);
    const recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(2);
    expect(recovered.recoverableTransactions).toBe(1);
  });
  it('replays commit/undo/redo/branch in sequence even when revision goes backwards', async () => {
    const session = new DocumentSession(doc),
      events: SessionChange[] = [];
    session.onChange((change) => events.push(change));
    session.applyExternal([{ type: 'meta.update', changes: { notes: 'one' } }], 'one');
    session.applyExternal([{ type: 'meta.update', changes: { notes: 'two' } }], 'two');
    session.undo();
    session.redo();
    session.undo();
    session.applyExternal([{ type: 'meta.update', changes: { notes: 'branch' } }], 'branch');
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    for (const event of events) await value.appendTransaction(doc.documentId, transactionFromChange(event));
    await value.flush(doc.documentId);
    expect(serializeDocument((await store().recover(doc.documentId)).doc!)).toBe(serializeDocument(session.document));
  });
  it('trackSession performs threshold and idle snapshots and surfaces errors', async () => {
    const session = new DocumentSession(doc),
      errors: unknown[] = [],
      value = store({ flushIntervalMs: 20 });
    const tracking = await trackSession(value, session, {
      project: () => ({ workspace: createWorkspace(), assets: {} }),
      snapshotTransactions: 2,
      idleSnapshotMs: 20,
      onError: (error) => errors.push(error),
    });
    session.applyExternal(tx(1).ops, 'first');
    session.applyExternal(tx(2).ops, 'second');
    await tracking.flush();
    expect(await fs.readdir(path.dirname(journal()))).toContain('snapshot-2.brkl');
    session.applyExternal(tx(3).ops, 'third');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await tracking.flush();
    expect(await fs.readdir(path.dirname(journal()))).toContain('snapshot-3.brkl');
    expect(errors).toEqual([]);
    await tracking.closeClean();
  });
  it('deduplicates retained logs and stops before a conflicting duplicate or broken revision chain', async () => {
    const value = store();
    await value.writeSnapshot(doc.documentId, packed(doc), 0);
    await value.appendTransaction(doc.documentId, tx(1));
    await value.appendTransaction(doc.documentId, tx(2));
    await value.flush(doc.documentId);
    const lines = (await fs.readFile(journal(), 'utf8')).trimEnd().split('\n');
    await fs.writeFile(journal(99), lines[1]! + '\n');
    expect((await store().recover(doc.documentId)).recoverableTransactions).toBe(2);
    const row = JSON.parse(lines[1]!) as Record<string, unknown>;
    delete row.crc32;
    row.label = 'conflict';
    await fs.writeFile(journal(99), JSON.stringify({ ...row, crc32: crc32(utf8(JSON.stringify(row))) }) + '\n');
    expect((await store().recover(doc.documentId)).doc!.revision).toBe(1);
    await fs.unlink(journal(99));
    row.prevRevision = 9;
    await fs.writeFile(
      journal(),
      lines[0] + '\n' + JSON.stringify({ ...row, crc32: crc32(utf8(JSON.stringify(row))) }) + '\n',
    );
    const recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(1);
    expect(recovered.issues[0]!.code).toBe('RECOVERY_REVISION_GAP');
  });
  it('keeps the journal when recapturing its base and chooses a newer undo snapshot by sequence', async () => {
    let interrupt = false;
    const value = store({
      checkpoint: (stage) => {
        if (interrupt && stage === 'snapshotPublished') throw new Error('crash');
      },
    });
    const base = packed(doc);
    await value.writeSnapshot(doc.documentId, base, 0);
    await value.appendTransaction(doc.documentId, tx(1));
    await value.writeSnapshot(doc.documentId, base, 0, 0);
    expect((await store().recover(doc.documentId)).doc!.revision).toBe(1);
    applyTx(tx(1));
    await value.appendTransaction(doc.documentId, tx(2));
    applyTx(tx(2));
    await value.writeSnapshot(doc.documentId, packed(doc), 2);
    const undo = { ...tx(1, 2), label: 'undo' };
    await value.appendTransaction(doc.documentId, undo);
    applyTx(undo);
    interrupt = true;
    await expect(value.writeSnapshot(doc.documentId, packed(doc), 1)).rejects.toThrow('crash');
    const recovered = await store().recover(doc.documentId);
    expect(recovered.doc!.revision).toBe(1);
    expect(recovered.lastSeq).toBe(3);
    expect(recovered.recoverableTransactions).toBe(0);
  });
});
