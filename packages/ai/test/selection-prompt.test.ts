import { expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/prompt';
it('explains task-start scope, additions, shared definitions and recovery from OUT_OF_SCOPE', () => {
  const prompt = buildSystemPrompt({ scope: { paths: [['roof', 'tile']] } });
  for (const text of [
    'roof',
    'tile',
    'task-start',
    'descendants',
    'reparenting',
    'unrestricted',
    'OUT_OF_SCOPE',
    'continue',
    'make_unique',
  ])
    expect(prompt).toContain(text);
  expect(buildSystemPrompt()).not.toContain('OUT_OF_SCOPE');
});
