import { expect, it } from 'vitest';
import { createDocument } from '@brickloop/core';
import { ContextAnalysisCache } from '../src/renderer/src/ai-context-cache';

it('reuses analysis across revisions and spaces refreshes by the larger of 30 seconds and ten analysis durations', () => {
  const cache = new ContextAnalysisCache();
  const doc = createDocument();
  const next = { ...doc };
  const analysis = { summary: { partCount: 10000 }, issues: [] };
  cache.start(doc.documentId, 0);
  cache.finish(doc.documentId, 15000);
  cache.remember(doc, analysis, 15000, 15000);
  expect(cache.delay(doc, 20000)).toBe(Infinity);
  expect(cache.get(next.documentId)?.analysis).toBe(analysis);
  expect(cache.delay(next, 20000)).toBe(145000);
  expect(cache.delay(next, 165000)).toBe(0);
  cache.remember(next, analysis, 10, 165000);
  expect(cache.delay({ ...next }, 166000)).toBe(29000);
  expect(cache.stats(doc.documentId)).toMatchObject({ count: 1, totalMs: 15000 });
});

it('throttles cancelled attempts and forgets closed documents', () => {
  const cache = new ContextAnalysisCache();
  const doc = createDocument();
  cache.start(doc.documentId, 0);
  cache.finish(doc.documentId, 1000);
  expect(cache.delay(doc, 2000)).toBe(28000);
  cache.retain([]);
  expect(cache.delay(doc, 2000)).toBe(0);
  expect(cache.stats(doc.documentId)).toBeUndefined();
});
