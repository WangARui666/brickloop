import type { Message } from '@brickloop/ai';
import type { SavedTurn } from '../../shared/ai-api';

/** Retain this round only. Concurrent rounds must not overwrite or replay one another's history. */
export function completedTurnHistory(turn: SavedTurn): Message[] {
  const history = turn.history ?? turn.result?.history ?? [];
  const offset = [...history]
    .reverse()
    .findIndex(
      (message) =>
        message.role === 'user' && message.content.some((block) => block.type === 'text' && block.text === turn.user),
    );
  if (offset >= 0) return history.slice(history.length - 1 - offset);
  // Compression may have removed the original request. Keep its visible exchange without
  // accidentally treating a validation reminder as the user's entire round.
  return [
    { role: 'user', content: [{ type: 'text', text: turn.user }, ...turn.images] },
    ...(turn.text ? [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: turn.text }] }] : []),
  ];
}
