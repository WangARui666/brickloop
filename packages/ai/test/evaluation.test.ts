import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { evaluateSuite, evaluationCases } from '../src/evaluation.js';
import type { AgentResult } from '../src/agent/runtime.js';

it('provides 20 textual cases and 20 single/multi-view original reference groups', async () => {
  expect(evaluationCases.filter((test) => !test.references.length)).toHaveLength(20);
  expect(evaluationCases.filter((test) => test.references.length)).toHaveLength(20);
  expect(evaluationCases.filter((test) => test.references.length === 2)).toHaveLength(10);
  for (const test of evaluationCases)
    for (const reference of test.references) {
      const image = await readFile(new URL(`./ai-eval/${reference.asset}`, import.meta.url));
      expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  const saved: string[] = [];
  const result: AgentResult = {
    reason: 'completed',
    text: '',
    history: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    cost: { amount: 0.1, currency: 'USD', label: '' },
    toolCalls: 1,
    elapsedMs: 50,
    unresolvedIssues: [],
  };
  const records = await evaluateSuite({
    provider: 'fake',
    model: 'fake',
    promptVersion: 'v1',
    cases: evaluationCases.slice(0, 2),
    execute: async (test) => ({
      result,
      metrics: {
        collisions: test.id === 'text-01' ? 0 : 1,
        connectedComponents: 1,
        nonFactoryParts: 0,
        nonFactoryColors: 0,
        partCount: 20,
      },
    }),
    save: async (record) => {
      saved.push(record.caseId);
    },
  });
  expect(records.map((r) => r.valid)).toEqual([true, false]);
  expect(saved).toEqual(['text-01', 'text-02']);
});
