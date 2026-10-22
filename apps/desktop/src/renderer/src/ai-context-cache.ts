import type { BrkDocument } from '@brickloop/core';
import type { Issue } from '@brickloop/collide';

export type ContextAnalysis = { summary: Record<string, unknown>; issues: Issue[] };
export class ContextAnalysisCache {
  private entries = new Map<
    string,
    { document: BrkDocument; analysis: ContextAnalysis; at: number; durationMs: number }
  >();
  private attempts = new Map<string, { at: number; count: number; totalMs: number; durationMs: number }>();
  private listeners = new Set<() => void>();
  get(id: string) {
    return this.entries.get(id);
  }
  stats(id: string) {
    return this.attempts.get(id);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  remember(document: BrkDocument, analysis: ContextAnalysis, durationMs: number, at = performance.now()) {
    this.entries.set(document.documentId, { document, analysis, at, durationMs });
    for (const listener of this.listeners) listener();
  }
  start(id: string, at = performance.now()) {
    const old = this.attempts.get(id);
    this.attempts.set(id, {
      at,
      count: (old?.count ?? 0) + 1,
      totalMs: old?.totalMs ?? 0,
      durationMs: old?.durationMs ?? 0,
    });
  }
  finish(id: string, durationMs: number) {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    attempt.totalMs += durationMs;
    attempt.durationMs = durationMs;
    for (const listener of this.listeners) listener();
  }
  delay(document: BrkDocument, now = performance.now()) {
    const entry = this.entries.get(document.documentId);
    if (entry?.document === document) return Infinity;
    const attempt = this.attempts.get(document.documentId);
    return Math.max(
      0,
      entry ? entry.at + Math.max(30000, entry.durationMs * 10) - now : 0,
      attempt ? attempt.at + Math.max(30000, attempt.durationMs * 10) - now : 0,
    );
  }
  retain(ids: string[]) {
    for (const id of this.entries.keys()) if (!ids.includes(id)) this.entries.delete(id);
    for (const id of this.attempts.keys()) if (!ids.includes(id)) this.attempts.delete(id);
  }
}
export const contextAnalysisCache = new ContextAnalysisCache();
