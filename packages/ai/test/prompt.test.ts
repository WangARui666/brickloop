import { expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/agent/prompt';

it('specifies the physical scale for grid coordinates and dimension conversions', () => {
  const prompt = buildSystemPrompt();
  expect(prompt).toContain('1 LDU = 0.4 mm');
  expect(prompt).toContain('1 stud = 20 LDU = 8 mm');
  expect(prompt).toContain('1 plate = 8 LDU = 3.2 mm');
  expect(prompt).toContain('use this ratio when converting to physical dimensions');
});

it('applies the response language to user-facing explanations before and between tool calls', () => {
  const prompt = buildSystemPrompt();
  for (const text of [
    'Simplified Chinese',
    'all user-facing text',
    'brief explanations before and between tool calls',
    'explicitly asks in another language',
    'use that language instead',
  ])
    expect(prompt).toContain(text);
});
