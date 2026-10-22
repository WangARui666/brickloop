import { buildSystemPrompt } from '@brickloop/ai';

/** Shared by sending and the next-request estimate. Selection is supplied separately. */
export function conversationPrompt(summary: unknown, modelContext: boolean, scope?: { paths: string[][] }) {
  const data =
    summary && typeof summary === 'object' && !Array.isArray(summary)
      ? ({ ...summary } as Record<string, unknown>)
      : {};
  delete data.selection;
  if (!modelContext) delete data.activeModelPath;
  const modelSummary = JSON.stringify(data);
  return { modelSummary, system: buildSystemPrompt({ modelSummary, ...(scope ? { scope } : {}) }) };
}
