import { expect, it } from 'vitest';
import { completedTurnHistory } from '../src/renderer/src/ai-history';
import type { SavedTurn } from '../src/shared/ai-api';
it('takes completed round history without prior rounds, preserving validation messages after the original request', () => {
  const turn: SavedTurn = {
    id: 'task',
    user: 'Move the wing',
    text: 'Done',
    images: [],
    events: [],
    history: [
      { role: 'user', content: [{ type: 'text', text: 'Old round' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Old answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Move the wing' }] },
      { role: 'user', content: [{ type: 'text', text: 'Resolve introduced validation issues' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    ],
  };
  expect(completedTurnHistory(turn)).toEqual(turn.history!.slice(2));
  expect(completedTurnHistory({ ...turn, history: turn.history!.slice(3) })).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'Move the wing' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ]);
});
