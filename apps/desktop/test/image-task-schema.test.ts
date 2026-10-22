import { describe, expect, it } from 'vitest';
import { imageTaskSchema } from '../src/shared/ai-api';

const request = {
  providerId: 'scripted',
  model: 'offline',
  directStart: false,
  budget: { toolCalls: 400, durationMs: 60000 },
  input: {
    images: [{ name: 'legacy.png', image: { type: 'image', mime: 'image/png', base64: 'AAAA' }, view: 'unknown' }],
    targetSize: 'medium',
    palette: { source: 'factory' },
    parts: { source: 'factory' },
    style: '',
  },
};
describe('image task view modes at the IPC boundary', () => {
  it('defaults to auto and normalizes legacy unknown', () => {
    const parsed = imageTaskSchema.parse(request);
    expect(parsed.input.viewMode).toBe('auto');
    expect(parsed.input.images[0]?.view).toBe('auto');
    expect(parsed.input.priority).toBe('buildable');
    expect(parsed.budget.rounds).toBe(20);
  });
  it('accepts 2–20 rounds and both priorities without changing legacy part restrictions', () => {
    for (const rounds of [2, 8, 20])
      for (const priority of ['appearance', 'buildable']) {
        const parsed = imageTaskSchema.parse({
          ...request,
          budget: { ...request.budget, rounds },
          input: { ...request.input, priority },
        });
        expect(parsed.budget.rounds).toBe(rounds);
        expect(parsed.input.parts.source).toBe('factory');
      }
    for (const rounds of [1, 21, 3.5])
      expect(imageTaskSchema.safeParse({ ...request, budget: { ...request.budget, rounds } }).success).toBe(false);
  });
  it.each(['auto', 'exclude', 'unknown'])('rejects %s in fixed mode', (view) => {
    expect(
      imageTaskSchema.safeParse({
        ...request,
        input: { ...request.input, viewMode: 'fixed', images: [{ ...request.input.images[0], view }] },
      }).success,
    ).toBe(false);
  });
  it.each(['front', 'back', 'left', 'right', 'top', 'isometric'])('accepts designer %s in either mode', (view) => {
    for (const viewMode of ['auto', 'fixed'])
      expect(
        imageTaskSchema.safeParse({
          ...request,
          input: {
            ...request.input,
            viewMode,
            images: [{ ...request.input.images[0], view }],
          },
        }).success,
      ).toBe(true);
  });
});
it('defaults all image workflow safety limits together', () => {
  expect(imageTaskSchema.parse({ ...request, budget: {} }).budget).toEqual({
    rounds: 20,
    toolCalls: 2000,
    durationMs: 7200000,
  });
});
