import * as fs from 'node:fs/promises';
import path from 'node:path';
import { applyOps, isRecord, isUlid, validateDocument } from '@brickloop/core';
import type { BrkDocument, DocumentSession, Op, SessionChange, Transaction, Workspace } from '@brickloop/core';
import { crc32, hashBytes, text, utf8 } from '../binary';
import type { ProjectAssets } from '../binary';
import { issue } from '../issues';
import type { IoIssue } from '../issues';
import { packProject, unpackProject } from '../project';
import type { UnpackedProject } from '../project';
import { saveBytesAtomic, saveProjectAtomic, syncFile } from './atomic';
import type { SaveOptions, SaveResult } from './atomic';

export interface RecoveryTransaction {
  seq?: number;
  revision: number;
  prevRevision: number;
  txId: string;
  label: string;
  source: Transaction['source'];
  at: string;
  ops: Op[];
  /** Keys are SHA-256 strings; resources are durably written before the journal row. */
  assets?: ProjectAssets;
}
interface JournalRecord extends Omit<RecoveryTransaction, 'seq' | 'assets'> {
  seq: number;
  assetHashes: string[];
  crc32: string;
}
export interface RecoverySession {
  documentId: string;
  pid: number;
  startedAt: string;
  projectPath: string | null;
  clean: boolean;
}
export interface RecoveryResult {
  doc: BrkDocument | null;
  workspace: Workspace | null;
  assets: ProjectAssets;
  recoverableTransactions: number;
  lastRecoveredAt: string | null;
  issues: IoIssue[];
  lastSeq: number;
  unsaved: true;
}
export interface RecoverableDocument extends RecoveryResult {
  documentId: string;
  title: string;
  projectPath: string | null;
}
export interface RecoveryOptions {
  flushIntervalMs?: number;
  isProcessAlive?: (pid: number, startedAt: string) => boolean | Promise<boolean>;
  pid?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
  saveOptions?: SaveOptions;
  /** Simulate a crash after publishing the snapshot but before journal compaction. */
  checkpoint?: (stage: 'snapshotPublished' | 'journalPublished', documentId: string) => void | Promise<void>;
}
interface ActiveDocument {
  session: RecoverySession;
  seq: number;
  revision: number;
  baseSeq: number;
  baseRevision: number;
  records: JournalRecord[];
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  fault?: unknown;
  lastDurableAt: string | null;
}
function checked(result: SaveResult): void {
  if (!result.ok) throw Object.assign(new Error(result.error.messageKey), { issue: result.error });
  if (result.durability === 'uncertain') throw new Error('SAVE_DURABILITY');
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function journalLine(record: Omit<JournalRecord, 'crc32'>): JournalRecord {
  return { ...record, crc32: crc32(utf8(JSON.stringify(record))) };
}
function decodeLine(line: string): JournalRecord {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error('Not an object');
  const { crc32: checksum, ...body } = value;
  if (
    checksum !== crc32(utf8(JSON.stringify(body))) ||
    !Number.isSafeInteger(body.seq) ||
    Number(body.seq) < 1 ||
    !Number.isSafeInteger(body.revision) ||
    Number(body.revision) < 0 ||
    !Number.isSafeInteger(body.prevRevision) ||
    Number(body.prevRevision) < 0 ||
    typeof body.txId !== 'string' ||
    typeof body.at !== 'string' ||
    !Number.isFinite(Date.parse(body.at)) ||
    typeof body.label !== 'string' ||
    !['ui', 'ai', 'mcp', 'import'].includes(String(body.source)) ||
    !Array.isArray(body.ops) ||
    !Array.isArray(body.assetHashes) ||
    !body.assetHashes.every((h: unknown) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))
  )
    throw new Error('Invalid transaction or CRC32');
  return value as unknown as JournalRecord;
}
export function transactionFromChange(
  change: SessionChange,
  at = new Date().toISOString(),
  assets?: ProjectAssets,
): RecoveryTransaction {
  return {
    revision: change.revisionAfter,
    prevRevision: change.revisionBefore,
    txId: change.transaction.id,
    label: change.transaction.label,
    source: change.transaction.source,
    at,
    ops: change.ops,
    ...(assets ? { assets } : {}),
  };
}

export class RecoveryStore {
  readonly recoveryDir: string;
  private readonly active = new Map<string, ActiveDocument>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly interval: number;
  constructor(
    rootDir: string,
    private readonly options: RecoveryOptions = {},
  ) {
    this.recoveryDir = path.resolve(rootDir, 'recovery');
    this.interval = options.flushIntervalMs ?? 1000;
    if (!Number.isFinite(this.interval) || this.interval < 1 || this.interval > 1000)
      throw new Error('flushIntervalMs must be 1..1000');
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private dir(docId: string): string {
    if (!isUlid(docId)) throw new Error('Invalid documentId');
    return path.join(this.recoveryDir, docId);
  }
  private async ensureRealDirectory(docId: string, create = false): Promise<string> {
    const dir = this.dir(docId);
    if (create) await fs.mkdir(dir, { recursive: true });
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Recovery directory must not be a link');
    const root = await fs.realpath(this.recoveryDir),
      real = await fs.realpath(dir);
    if (path.dirname(real).toLowerCase() !== root.toLowerCase()) throw new Error('Recovery directory escapes root');
    return dir;
  }
  private enqueue<T>(docId: string, action: () => Promise<T>): Promise<T> {
    this.dir(docId);
    const previous = this.queues.get(docId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.queues.set(docId, next);
    void next
      .finally(() => {
        if (this.queues.get(docId) === next) this.queues.delete(docId);
      })
      .catch(() => undefined);
    return next;
  }
  private state(docId: string): ActiveDocument {
    const state = this.active.get(docId);
    if (!state) throw new Error('Call writeSnapshot/startSession before appending');
    if (state.fault) throw state.fault;
    return state;
  }
  private journalPath(docId: string, state: ActiveDocument): string {
    return path.join(this.dir(docId), `journal-${state.baseRevision}.jsonl`);
  }
  private async writeSession(docId: string, session: RecoverySession): Promise<void> {
    checked(
      await saveBytesAtomic(
        path.join(this.dir(docId), 'session.json'),
        utf8(JSON.stringify(session)),
        (bytes) => isRecord(JSON.parse(text(bytes))),
        this.options.saveOptions,
      ),
    );
  }
  async startSession(docId: string, bytes: Uint8Array, projectPath: string | null = null): Promise<void> {
    const project = unpackProject(bytes);
    if (!project.doc || project.doc.documentId !== docId) throw new Error('Invalid initial snapshot');
    await this.writeSnapshot(docId, bytes, project.doc.revision);
    await this.enqueue(docId, async () => {
      const state = this.state(docId);
      state.session.projectPath = projectPath;
      await this.writeSession(docId, state.session);
    });
  }
  appendTransaction(
    docId: string,
    transaction: RecoveryTransaction,
  ): Promise<{ seq: number; lastDurableAt: string | null }> {
    // Own a JSON copy before entering the queue; caller edits cannot change an accepted transaction.
    const tx = {
      ...(JSON.parse(JSON.stringify({ ...transaction, assets: undefined })) as RecoveryTransaction),
      assets: Object.fromEntries(Object.entries(transaction.assets ?? {}).map(([key, bytes]) => [key, bytes.slice()])),
    };
    return this.enqueue(docId, async () => {
      const state = this.state(docId);
      if (tx.prevRevision !== state.revision || (tx.seq !== undefined && tx.seq !== state.seq + 1))
        throw new Error('RECOVERY_REVISION_GAP');
      const dir = await this.ensureRealDirectory(docId);
      const hashes = new Set<string>();
      for (const op of tx.ops) if (op.type === 'asset.add') for (const entry of op.items) hashes.add(entry.value.hash);
      for (const hash of Object.keys(tx.assets)) hashes.add(hash);
      for (const hash of hashes) {
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid resource hash');
        const payload = tx.assets[hash];
        if (payload) {
          if (hashBytes(payload) !== hash) throw new Error('Resource hash mismatch');
          checked(
            await saveBytesAtomic(
              path.join(dir, 'assets', hash),
              payload,
              (bytes) => hashBytes(bytes) === hash,
              this.options.saveOptions,
            ),
          );
        } else {
          const saved = await fs.readFile(path.join(dir, 'assets', hash));
          if (hashBytes(saved) !== hash) throw new Error('RECOVERY_ASSET_MISSING');
        }
      }
      const record = journalLine({
        seq: state.seq + 1,
        revision: tx.revision,
        prevRevision: tx.prevRevision,
        txId: tx.txId,
        label: tx.label,
        source: tx.source,
        at: tx.at,
        ops: tx.ops,
        assetHashes: [...hashes],
      });
      decodeLine(JSON.stringify(record));
      try {
        await fs.appendFile(this.journalPath(docId, state), JSON.stringify(record) + '\n');
      } catch (error) {
        state.fault = error;
        throw error;
      }
      state.seq = record.seq;
      state.revision = record.revision;
      state.records.push(record);
      state.dirty = true;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          delete state.timer;
          void this.flush(docId).catch((error: unknown) => {
            state.fault = error;
            this.options.onError?.(error);
          });
        }, this.interval);
        state.timer.unref();
      }
      return { seq: record.seq, lastDurableAt: state.lastDurableAt };
    });
  }
  private async flushState(docId: string, state: ActiveDocument): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      delete state.timer;
    }
    if (state.dirty) {
      await syncFile(this.journalPath(docId, state));
      state.dirty = false;
      state.lastDurableAt = this.now();
    }
  }
  flush(docId: string): Promise<void> {
    return this.enqueue(docId, () => this.flushState(docId, this.state(docId)));
  }
  checkpoint(docId: string): Promise<{ seq: number; revision: number }> {
    return this.enqueue(docId, async () => {
      const state = this.state(docId);
      return { seq: state.seq, revision: state.revision };
    });
  }
  writeSnapshot(docId: string, bytes: Uint8Array, revision: number, snapshotSeq?: number): Promise<void> {
    const owned = bytes.slice();
    return this.enqueue(docId, async () => {
      const project = unpackProject(owned);
      if (
        !project.doc ||
        project.doc.documentId !== docId ||
        project.doc.revision !== revision ||
        project.issues.some((i) => i.severity === 'error') ||
        project.readOnly
      )
        throw new Error('Invalid snapshot identity/revision/content');
      const dir = await this.ensureRealDirectory(docId, true);
      let state = this.active.get(docId);
      if (!state) {
        // Never overwrite an abandoned session implicitly. Recover/close it first.
        try {
          await fs.access(path.join(dir, 'session.json'));
          throw new Error('Existing recovery session; recover and close it before starting');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
        state = {
          session: {
            documentId: docId,
            pid: this.options.pid ?? process.pid,
            startedAt: this.now(),
            projectPath: null,
            clean: false,
          },
          seq: 0,
          revision,
          baseSeq: 0,
          baseRevision: revision,
          records: [],
          dirty: false,
          lastDurableAt: null,
        };
        await this.writeSession(docId, state.session);
        this.active.set(docId, state);
      }
      if (state.fault) throw state.fault;
      const seq =
        snapshotSeq ??
        (revision === state.revision
          ? state.seq
          : ([...state.records].reverse().find((r) => r.revision === revision)?.seq ??
            (revision === state.baseRevision ? state.baseSeq : undefined)));
      if (
        seq === undefined ||
        seq < state.baseSeq ||
        seq > state.seq ||
        (seq === state.seq
          ? state.revision
          : seq === state.baseSeq
            ? state.baseRevision
            : state.records.find((r) => r.seq === seq)?.revision) !== revision
      )
        throw new Error('Snapshot is stale or requires an explicit sequence');
      await this.flushState(docId, state);
      const preservation = {
        ...project.preservation,
        manifest: { ...project.preservation.manifest, recovery: { seq } },
      };
      const snapshot = packProject(project.doc, project.workspace, project.assets, { preservation });
      // Make assets already present in the snapshot available to future asset.add (including redo).
      for (const value of Object.values(project.assets)) {
        const hash = hashBytes(value);
        checked(
          await saveBytesAtomic(
            path.join(dir, 'assets', hash),
            value,
            (data) => hashBytes(data) === hash,
            this.options.saveOptions,
          ),
        );
      }
      const snapshotName = `snapshot-${revision}.brkl`;
      checked(await saveProjectAtomic(path.join(dir, snapshotName), snapshot, this.options.saveOptions));
      await this.options.checkpoint?.('snapshotPublished', docId);
      const remaining = state.records.filter((r) => r.seq > seq);
      const journalName = `journal-${revision}.jsonl`;
      const journal = utf8(remaining.map((r) => JSON.stringify(r) + '\n').join(''));
      checked(
        await saveBytesAtomic(
          path.join(dir, journalName),
          journal,
          (data) => hashBytes(data) === hashBytes(journal),
          this.options.saveOptions,
        ),
      );
      state.baseSeq = seq;
      state.baseRevision = revision;
      state.records = remaining;
      await this.options.checkpoint?.('journalPublished', docId);
      for (const name of await fs.readdir(dir))
        if (
          (/^snapshot-\d+\.brkl$/.test(name) && name !== snapshotName) ||
          (/^journal-\d+\.jsonl$/.test(name) && name !== journalName)
        )
          await fs.unlink(path.join(dir, name));
      state.lastDurableAt = this.now();
    });
  }
  async recover(docId: string): Promise<RecoveryResult> {
    return this.enqueue(docId, () => this.recoverNow(docId));
  }
  private async recoverNow(docId: string): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      doc: null,
      workspace: null,
      assets: {},
      recoverableTransactions: 0,
      lastRecoveredAt: null,
      issues: [],
      lastSeq: 0,
      unsaved: true,
    };
    const dir = await this.ensureRealDirectory(docId);
    const names = await fs.readdir(dir);
    const snapshots: { project: UnpackedProject; seq: number; savedAt: string }[] = [];
    for (const name of names.filter((n) => /^snapshot-\d+\.brkl$/.test(n))) {
      try {
        const project = unpackProject(await fs.readFile(path.join(dir, name)));
        if (
          !project.doc ||
          project.readOnly ||
          project.doc.documentId !== docId ||
          project.doc.revision !== Number(/^snapshot-(\d+)/.exec(name)![1]) ||
          project.issues.some((i) => i.severity === 'error')
        )
          throw new Error('Invalid snapshot');
        const recovery = project.manifest?.recovery;
        const seq = isRecord(recovery) && Number.isSafeInteger(recovery.seq) ? Number(recovery.seq) : 0;
        snapshots.push({ project, seq, savedAt: String(project.manifest?.savedAt ?? '') });
      } catch (error) {
        result.issues.push(issue('RECOVERY_INVALID_SNAPSHOT', name, String(error), 'warning'));
      }
    }
    snapshots.sort((a, b) => b.seq - a.seq || b.savedAt.localeCompare(a.savedAt));
    const snapshot = snapshots[0];
    if (!snapshot) {
      result.issues.push(issue('RECOVERY_NO_SNAPSHOT'));
      return result;
    }
    result.doc = snapshot.project.doc!;
    result.workspace = snapshot.project.workspace;
    result.assets = { ...snapshot.project.assets };
    result.lastSeq = snapshot.seq;
    result.lastRecoveredAt = snapshot.savedAt;
    const records = new Map<number, JournalRecord>();
    let stopSeq = Infinity;
    for (const name of names.filter((n) => /^journal-\d+\.jsonl$/.test(n))) {
      const content = text(await fs.readFile(path.join(dir, name))),
        lines = content.split('\n');
      let previous = 0;
      for (let i = 0; i < lines.length; i++) {
        if (i === lines.length - 1 && lines[i] === '') break;
        let failureSeq = previous ? previous + 1 : snapshot.seq + 1;
        try {
          if (i === lines.length - 1) throw new Error('Uncommitted/truncated line (no newline)');
          const record = decodeLine(lines[i]!);
          if (previous && record.seq !== previous + 1) throw new Error('Journal sequence gap');
          failureSeq = record.seq;
          if (record.seq <= snapshot.seq) {
            previous = record.seq;
            continue;
          }
          const existing = records.get(record.seq);
          if (existing && JSON.stringify(existing) !== JSON.stringify(record))
            throw new Error('Conflicting duplicate sequence');
          records.set(record.seq, record);
          previous = record.seq;
        } catch (error) {
          stopSeq = Math.min(stopSeq, Math.max(snapshot.seq + 1, failureSeq));
          result.issues.push(issue('RECOVERY_JOURNAL_INVALID', name, `line ${i + 1}: ${String(error)}`));
          break;
        }
      }
    }
    for (const record of [...records.values()].sort((a, b) => a.seq - b.seq)) {
      if (record.seq >= stopSeq) break;
      if (record.seq !== result.lastSeq + 1 || record.prevRevision !== result.doc!.revision) {
        result.issues.push(issue('RECOVERY_REVISION_GAP', undefined, `seq ${record.seq}`));
        break;
      }
      try {
        const restored: ProjectAssets = {},
          payloads: ProjectAssets = {};
        for (const hash of record.assetHashes) {
          const bytes = await fs.readFile(path.join(dir, 'assets', hash));
          if (hashBytes(bytes) !== hash) throw new Error('Resource hash mismatch');
          payloads[hash] = new Uint8Array(bytes);
        }
        // Resources and ops publish together only after the entire transaction validates.
        for (const op of record.ops)
          if (op.type === 'asset.add')
            for (const entry of op.items) {
              if (!payloads[entry.value.hash]) throw new Error('Asset is absent from transaction');
              const assetPath =
                typeof entry.value.path === 'string'
                  ? entry.value.path
                  : `assets/${entry.kind === 'referenceImage' ? 'images' : 'parts'}/${entry.value.hash}`;
              restored[assetPath] = payloads[entry.value.hash]!;
            }
        const candidate: BrkDocument = { ...applyOps(result.doc!, record.ops), revision: record.revision };
        if (validateDocument(candidate).some((i) => i.severity === 'error'))
          throw new Error('Invalid transaction result');
        result.doc = candidate;
        Object.assign(result.assets, restored);
        result.lastSeq = record.seq;
        result.recoverableTransactions++;
        result.lastRecoveredAt = record.at;
      } catch (error) {
        result.issues.push(
          issue(
            record.assetHashes.length ? 'RECOVERY_ASSET_MISSING' : 'RECOVERY_JOURNAL_INVALID',
            undefined,
            `seq ${record.seq}: ${String(error)}`,
          ),
        );
        break;
      }
    }
    return result;
  }
  async scanRecoverable(): Promise<RecoverableDocument[]> {
    let directories: string[];
    try {
      directories = await fs.readdir(this.recoveryDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const found: RecoverableDocument[] = [];
    for (const id of directories.filter(isUlid)) {
      let session: RecoverySession;
      try {
        await this.ensureRealDirectory(id);
        const value: unknown = JSON.parse(await fs.readFile(path.join(this.dir(id), 'session.json'), 'utf8'));
        if (
          !isRecord(value) ||
          value.documentId !== id ||
          !Number.isInteger(value.pid) ||
          Number(value.pid) <= 0 ||
          typeof value.startedAt !== 'string' ||
          typeof value.clean !== 'boolean'
        )
          throw new Error('Invalid session');
        session = value as unknown as RecoverySession;
      } catch (error) {
        found.push({
          doc: null,
          workspace: null,
          assets: {},
          recoverableTransactions: 0,
          lastRecoveredAt: null,
          lastSeq: 0,
          unsaved: true,
          documentId: id,
          title: id,
          projectPath: null,
          issues: [issue('RECOVERY_INVALID_SESSION', 'session.json', String(error))],
        });
        continue;
      }
      if (
        session.clean ||
        (await (this.options.isProcessAlive?.(session.pid, session.startedAt) ?? processAlive(session.pid)))
      )
        continue;
      const recovered = await this.recover(id);
      found.push({
        ...recovered,
        documentId: id,
        title: recovered.doc?.meta.title ?? id,
        projectPath: session.projectPath,
      });
    }
    return found;
  }
  closeClean(docId: string): Promise<void> {
    return this.enqueue(docId, async () => {
      const dir = await this.ensureRealDirectory(docId);
      const state = this.active.get(docId);
      if (state?.timer) clearTimeout(state.timer);
      if (state) await this.writeSession(docId, { ...state.session, clean: true });
      // dir is verified as an immediate, non-link child of recoveryDir above.
      await fs.rm(dir, { recursive: true });
      this.active.delete(docId);
    });
  }
  /** Release timers after a simulated/process shutdown; leaves recovery data intact. */
  async dispose(): Promise<void> {
    for (const id of this.active.keys()) {
      const state = this.active.get(id)!;
      if (state.timer) clearTimeout(state.timer);
      await this.queues.get(id)?.catch(() => undefined);
      if (!state.fault) await this.flushState(id, state);
    }
    this.active.clear();
  }
}

export interface TrackSessionOptions {
  project: () => { workspace: Workspace; assets: ProjectAssets };
  projectPath?: string;
  snapshotIntervalMs?: number;
  snapshotTransactions?: number;
  idleSnapshotMs?: number;
  onError: (error: unknown) => void;
}
/** Connect commit/undo/redo events; snapshot triggers are 5 min / 200 events / 30 s idle. */
export async function trackSession(
  store: RecoveryStore,
  session: DocumentSession,
  options: TrackSessionOptions,
): Promise<{ flush: () => Promise<void>; closeClean: () => Promise<void>; dispose: () => Promise<void> }> {
  const id = session.document.documentId;
  const initial = options.project();
  await store.startSession(id, packProject(session.document, initial.workspace, initial.assets), options.projectPath);
  let pending = Promise.resolve(),
    count = 0,
    lastSnapshot = Date.now(),
    stopped = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  const snapshot = () => {
    if (!count || stopped) return;
    const doc = session.document,
      project = options.project(),
      bytes = packProject(doc, project.workspace, project.assets);
    count = 0;
    pending = pending
      .then(() => store.writeSnapshot(id, bytes, doc.revision))
      .then(() => {
        lastSnapshot = Date.now();
      })
      .catch((error: unknown) => {
        failure = error;
        options.onError(error);
      });
  };
  const unsubscribe = session.onChange((change) => {
    const assets: ProjectAssets = {},
      available = options.project().assets;
    for (const op of change.ops)
      if (op.type === 'asset.add')
        for (const entry of op.items) {
          const payload = Object.values(available).find((bytes) => hashBytes(bytes) === entry.value.hash);
          if (payload) assets[entry.value.hash] = payload;
        }
    const transaction = transactionFromChange(change, undefined, assets);
    pending = pending
      .then(async () => {
        if (failure) throw failure;
        await store.appendTransaction(id, transaction);
      })
      .catch((error: unknown) => {
        failure = error;
        options.onError(error);
      });
    count++;
    if (idle) clearTimeout(idle);
    idle = setTimeout(snapshot, options.idleSnapshotMs ?? 30000);
    idle.unref();
    if (count >= (options.snapshotTransactions ?? 200)) snapshot();
  });
  const periodic = setInterval(
    () => {
      if (Date.now() - lastSnapshot >= (options.snapshotIntervalMs ?? 300000)) snapshot();
    },
    Math.min(options.snapshotIntervalMs ?? 300000, 1000),
  );
  periodic.unref();
  const flush = async () => {
    await pending;
    if (failure) throw failure;
    await store.flush(id);
  };
  const stop = () => {
    stopped = true;
    unsubscribe();
    clearInterval(periodic);
    if (idle) clearTimeout(idle);
  };
  return {
    flush,
    closeClean: async () => {
      stop();
      await pending;
      await store.closeClean(id);
    },
    dispose: async () => {
      stop();
      await flush();
    },
  };
}
