import { executeCommand, isContextCurrent } from '../commands';
import type { Command, CommandOutput, CommandServices } from '../commands';
import { createWorkspace, resolveContext, resolvePath, ulid, validateDocument } from '../document';
import type { BrkDocument, EditContext, IdGenerator, Workspace } from '../document';
import { attempt, fail } from '../errors';
import type { Result } from '../errors';
import { applyOps, applyWithInverse } from '../ops';
import type { Op } from '../ops';
import { previewBases, transformPreview, previewViews, materializePreview } from './transform-preview';
import { preparedPreviews } from './prepared-preview';

export interface Transaction {
  id: string;
  label: string;
  source: 'ui' | 'ai' | 'mcp' | 'import';
  ops: Op[];
  revisionBefore: number;
  revisionAfter: number;
}
export interface SessionChange {
  type: 'tx' | 'undo' | 'redo';
  transaction: Transaction;
  /** Applied direction: forward on commit/redo, inverse on undo, for journal replay. */
  ops: Op[];
  revisionBefore: number;
  revisionAfter: number;
}
interface Entry {
  transaction: Transaction;
  inverse: Op[];
}
interface Pending {
  base: BrkDocument;
  label: string;
  source: Transaction['source'];
  ops: Op[];
  context: EditContext;
}
export interface SessionOptions extends CommandServices {
  historyLimit?: number;
  mergeKeyboard?: boolean;
  mergeIntervalMs?: number;
  clock?: () => number;
  workspace?: Workspace;
  savedRevision?: number;
  onListenerError?: (error: unknown) => void;
}
export interface DispatchOutput extends CommandOutput {
  transaction?: Transaction;
}

export class DocumentSession {
  private current: BrkDocument;
  private state: Workspace;
  private contextExtras: Omit<EditContext, 'activeModelPath' | 'selection' | 'hidden'> = {};
  private undoEntries: Entry[] = [];
  private redoEntries: Entry[] = [];
  private pending: Pending | undefined;
  private revisionCounter: number;
  private saved: number;
  private readonly listeners = new Set<(event: SessionChange) => void>();
  private readonly clock: () => number;
  private readonly id: IdGenerator;
  private merge: { key: string; at: number } | undefined;
  private readonly limit: number;
  constructor(
    doc: BrkDocument,
    private readonly options: SessionOptions = {},
  ) {
    const issues = validateDocument(doc);
    if (issues.length) fail('INVALID_DOCUMENT', issues);
    this.current = doc;
    this.revisionCounter = doc.revision;
    this.saved = options.savedRevision ?? doc.revision;
    this.state = options.workspace ?? createWorkspace();
    this.clock = options.clock ?? Date.now;
    this.id = options.id ?? ulid;
    this.limit = options.historyLimit ?? 1000;
    if (
      !Number.isInteger(this.limit) ||
      this.limit < 1 ||
      (options.mergeIntervalMs !== undefined &&
        (!Number.isFinite(options.mergeIntervalMs) || options.mergeIntervalMs < 0))
    )
      fail('INVALID_ARGUMENT');
  }
  get document(): BrkDocument {
    return materializePreview(this.current);
  }
  get workspace(): Workspace {
    return this.state;
  }
  get context(): EditContext {
    return {
      ...this.contextExtras,
      activeModelPath: this.state.activeModelPath,
      selection: this.state.selection,
      hidden: this.state.hidden,
    };
  }
  get transactionBase(): BrkDocument {
    return this.pending?.base ?? this.current;
  }
  get isPreviewing(): boolean {
    return this.pending !== undefined;
  }
  get savedRevision(): number {
    return this.saved;
  }
  get isDirty(): boolean {
    return this.current.revision !== this.saved || !!this.pending?.ops.length;
  }
  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }
  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }
  get history(): readonly Transaction[] {
    return this.undoEntries.map((entry) => entry.transaction);
  }
  get redoHistory(): readonly Transaction[] {
    return this.redoEntries.map((entry) => entry.transaction);
  }
  onChange(listener: (event: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: SessionChange): void {
    // A failed journal/UI subscriber cannot roll back an already committed state.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
  }
  endMerge(): void {
    this.merge = undefined;
  }
  updateWorkspace(changes: Partial<Workspace>): void {
    if (
      (changes.selection && !samePaths(changes.selection, this.state.selection)) ||
      (changes.activeModelPath && !samePaths([changes.activeModelPath], [this.state.activeModelPath]))
    ) {
      this.cancel();
      this.endMerge();
    }
    this.state = { ...this.state, ...changes };
  }
  setContext(context: EditContext): void {
    if (context.activeGroupId !== this.contextExtras.activeGroupId || context.stepId !== this.contextExtras.stepId) {
      this.cancel();
      this.endMerge();
    }
    this.updateWorkspace({
      activeModelPath: context.activeModelPath,
      selection: context.selection,
      ...(context.hidden === undefined ? {} : { hidden: context.hidden }),
    });
    this.contextExtras = {
      ...(context.activeGroupId === undefined ? {} : { activeGroupId: context.activeGroupId }),
      ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
      ...(context.primaryPath === undefined ? {} : { primaryPath: context.primaryPath }),
    };
  }
  begin(label: string, source: Transaction['source'] = 'ui'): Result<void> {
    return attempt(() => {
      if (this.pending) fail('TRANSACTION_ACTIVE');
      if (this.current.schemaVersion > 1) fail('READ_ONLY_NEWER');
      if (!resolveContext(this.current, this.context)) fail('INVALID_CONTEXT');
      this.endMerge();
      this.validate(this.current);
      this.pending = { base: this.current, label, source, ops: [], context: this.context };
      if (source === 'ui') previewBases.add(this.current);
    });
  }
  /** Replaces the candidate with ops relative to transactionBase. Use dispatch
   * inside an AI/MCP/import transaction to accumulate successive commands. */
  preview(ops: Op[]): Result<void> {
    const result = attempt(() => {
      const pending = this.pending ?? fail('NO_TRANSACTION');
      const prepared = preparedPreviews.get(ops);
      const candidate = prepared?.base === pending.base ? prepared.next : undefined;
      const fast = candidate ? undefined : transformPreview(pending.base, ops);
      const next = candidate ?? fast ?? applyOps(pending.base, ops);
      if (!candidate && !fast) this.validate(next);
      if (!isContextCurrent(pending.base, next, pending.context)) fail('INVALID_CONTEXT');
      pending.ops = ops;
      this.current = next;
      if (fast) previewViews.set(this, next);
      else previewViews.delete(this);
    });
    preparedPreviews.delete(ops);
    if (!result.ok && result.error.code !== 'NO_TRANSACTION') this.cancel();
    return result;
  }
  cancel(): void {
    if (!this.pending) return;
    this.current = this.pending.base;
    previewBases.delete(this.pending.base);
    previewViews.delete(this);
    this.pending = undefined;
  }
  commit(): Result<Transaction | undefined> {
    const result = attempt(() => {
      const pending = this.pending ?? fail('NO_TRANSACTION');
      if (!isContextCurrent(pending.base, this.current, pending.context)) fail('INVALID_CONTEXT');
      this.validate(this.current);
      this.current = pending.base;
      previewBases.delete(pending.base);
      previewViews.delete(this);
      this.pending = undefined;
      return this.record(pending.base, pending.ops, pending.label, pending.source);
    });
    if (!result.ok) this.cancel();
    return result;
  }
  dispatch(command: Command, context: EditContext = this.context): Result<DispatchOutput> {
    // An unrelated command interrupts a UI gesture. In particular, deleting the
    // active occurrence first discards its preview before touching shared content.
    if (this.pending?.source === 'ui') this.cancel();
    const result = executeCommand(this.current, context, command, this.options);
    if (!result.ok) {
      this.endMerge();
      return result;
    }
    const output = result.value;
    if (this.pending) {
      const pending = this.pending;
      const accumulated = [...pending.ops, ...output.ops];
      const staged = this.preview(accumulated);
      if (staged.ok && output.selection) this.state = { ...this.state, selection: output.selection };
      return staged.ok ? { ok: true, value: output } : staged;
    }
    return attempt(() => {
      const key = this.mergeKey(command, context),
        now = this.clock();
      const combine =
        key !== undefined &&
        this.merge?.key === key &&
        now >= this.merge.at &&
        now - this.merge.at <= (this.options.mergeIntervalMs ?? 1000);
      if (!combine) this.endMerge();
      const transaction = this.record(
        this.current,
        output.ops,
        command.label ?? command.type,
        command.source ?? 'ui',
        combine,
      );
      this.merge = key && transaction ? { key, at: now } : undefined;
      if (output.selection) this.state = { ...this.state, selection: output.selection };
      this.reconcileContext();
      return { ...output, ...(transaction ? { transaction } : {}) };
    });
  }
  /** For import/recovery/external adapters that already produce primitives. */
  applyExternal(ops: Op[], label: string, source: Transaction['source'] = 'mcp'): Result<Transaction | undefined> {
    this.cancel();
    this.endMerge();
    return attempt(() => {
      const tx = this.record(this.current, ops, label, source);
      this.reconcileContext();
      return tx;
    });
  }
  private validate(doc: BrkDocument): void {
    const issues = validateDocument(doc);
    if (issues.length) fail('INVALID_DOCUMENT', issues);
  }
  private record(
    before: BrkDocument,
    ops: Op[],
    label: string,
    source: Transaction['source'],
    combine = false,
  ): Transaction | undefined {
    if (before.schemaVersion > 1) fail('READ_ONLY_NEWER');
    if (!ops.length) {
      this.current = before;
      return undefined;
    }
    const applied = applyWithInverse(before, ops);
    this.validate(applied.doc);
    const transaction: Transaction = {
      id: this.id(),
      label,
      source,
      ops,
      revisionBefore: before.revision,
      revisionAfter: ++this.revisionCounter,
    };
    this.current = { ...applied.doc, revision: transaction.revisionAfter };
    const previous = combine ? this.undoEntries.pop() : undefined;
    this.undoEntries.push(
      previous
        ? {
            transaction: {
              ...previous.transaction,
              ops: [...previous.transaction.ops, ...ops],
              revisionAfter: transaction.revisionAfter,
            },
            inverse: [...applied.inverse, ...previous.inverse],
          }
        : { transaction, inverse: applied.inverse },
    );
    if (this.undoEntries.length > this.limit) this.undoEntries.shift();
    this.redoEntries = [];
    this.emit({
      type: 'tx',
      transaction,
      ops,
      revisionBefore: transaction.revisionBefore,
      revisionAfter: transaction.revisionAfter,
    });
    return transaction;
  }
  undo(): Result<Transaction | undefined> {
    this.cancel();
    this.endMerge();
    return attempt(() => {
      const entry = this.undoEntries.at(-1);
      if (!entry) return undefined;
      const revisionBefore = this.current.revision;
      const next = applyOps(this.current, entry.inverse);
      this.validate(next);
      this.current = { ...next, revision: entry.transaction.revisionBefore };
      this.undoEntries.pop();
      this.redoEntries.push(entry);
      this.reconcileContext();
      this.emit({
        type: 'undo',
        transaction: entry.transaction,
        ops: entry.inverse,
        revisionBefore,
        revisionAfter: this.current.revision,
      });
      return entry.transaction;
    });
  }
  redo(): Result<Transaction | undefined> {
    this.cancel();
    this.endMerge();
    return attempt(() => {
      const entry = this.redoEntries.at(-1);
      if (!entry) return undefined;
      const revisionBefore = this.current.revision;
      const next = applyOps(this.current, entry.transaction.ops);
      this.validate(next);
      this.current = { ...next, revision: entry.transaction.revisionAfter };
      this.redoEntries.pop();
      this.undoEntries.push(entry);
      this.reconcileContext();
      this.emit({
        type: 'redo',
        transaction: entry.transaction,
        ops: entry.transaction.ops,
        revisionBefore,
        revisionAfter: this.current.revision,
      });
      return entry.transaction;
    });
  }
  markSaved(): Result<void> {
    return attempt(() => {
      if (this.pending) fail('TRANSACTION_ACTIVE');
      this.saved = this.current.revision;
      this.endMerge();
    });
  }
  private mergeKey(command: Command, context: EditContext): string | undefined {
    if (
      this.options.mergeKeyboard === false ||
      !command.type.startsWith('transform.') ||
      command.input !== 'keyboard' ||
      (command.source !== undefined && command.source !== 'ui')
    )
      return undefined;
    const paths = 'paths' in command ? (command.paths ?? context.selection) : context.selection;
    // Order determines the implicit primary part, so a primary change ends merging.
    return JSON.stringify([
      command.type,
      context.activeModelPath,
      context.activeGroupId,
      paths,
      context.primaryPath,
      'space' in command ? command.space : undefined,
      command.mergeKey,
    ]);
  }
  private reconcileContext(): void {
    let activeModelPath = this.state.activeModelPath;
    while (activeModelPath.length && !resolveContext(this.current, { activeModelPath }))
      activeModelPath = activeModelPath.slice(0, -1);
    const selection = this.state.selection.filter((path) => resolvePath(this.current, path));
    this.state = { ...this.state, activeModelPath, selection };
    if (this.contextExtras.activeGroupId && !this.current.groups[this.contextExtras.activeGroupId])
      delete this.contextExtras.activeGroupId;
    const model = resolveContext(this.current, this.context)?.model;
    if (this.contextExtras.stepId && !model?.steps[this.contextExtras.stepId]) delete this.contextExtras.stepId;
  }
}
function samePaths(a: readonly string[][], b: readonly string[][]): boolean {
  return (
    a.length === b.length &&
    a.every((path, i) => path.length === b[i]!.length && path.every((id, j) => b[i]![j] === id))
  );
}
