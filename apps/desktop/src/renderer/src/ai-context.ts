import {
  calculateCeiling,
  compressHistory,
  createEditorTools,
  estimateInputTokens,
  imageTokenEstimate,
  InputTokenMeter,
  checkpointMessage,
} from '@brickloop/ai';
import type { ContextCheckpoint, Message, ModelCapabilities } from '@brickloop/ai';
import type { Issue } from '@brickloop/collide';
import { diffDocuments, type BrkDocument } from '@brickloop/core';
import type { AiTaskInfo, SavedTurn } from '../../shared/ai-api';
import { conversationPrompt } from '../../shared/ai-context-prompt';
import { completedTurnHistory } from './ai-history';

export interface ContextMarks {
  version: 1;
  clearedTurnIds: string[];
  discardedTurnIds: string[];
  clearedAt?: string;
  checkpoint?: {
    summary: string;
    createdAt: string;
    coveredTurnIds: string[];
    throughTurnId: string;
    /** Number of messages covered in the last turn, at an atomic boundary. */
    throughMessage: number;
  };
}
export const emptyContextMarks = (): ContextMarks => ({ version: 1, clearedTurnIds: [], discardedTurnIds: [] });
export type ContextExclusion = 'cleared' | 'discarded' | 'failed' | 'stopped' | 'truncated' | 'budget' | 'image_failed';
export function turnContextStatus(
  turn: SavedTurn,
  marks: ContextMarks,
): { included: true; summary?: true } | { included: false; reason: ContextExclusion } {
  if (marks.clearedTurnIds.includes(turn.id)) return { included: false, reason: 'cleared' };
  if (marks.discardedTurnIds.includes(turn.id)) return { included: false, reason: 'discarded' };
  if (failedTurnSummary(turn)) return { included: true, summary: true };
  if (turn.report) {
    if (turn.report.reason === 'user_stopped') return { included: false, reason: 'stopped' };
    return turn.report.transaction === 'committed' &&
      ['completed', 'round_budget', 'time_budget', 'tool_budget'].includes(turn.report.reason)
      ? { included: true }
      : { included: false, reason: 'image_failed' };
  }
  switch (turn.result?.reason) {
    case 'completed':
    case 'tool_budget':
      return { included: true };
    case 'cancelled':
      return { included: false, reason: 'stopped' };
    case 'max_tokens':
      return { included: false, reason: 'truncated' };
    case 'time_budget':
    case 'input_budget':
    case 'daily_cost_limit':
      return { included: false, reason: 'budget' };
    default:
      return { included: false, reason: 'failed' };
  }
}

export function failedTurnSummary(turn: SavedTurn): string | undefined {
  if (turn.result?.reason !== 'error' && turn.report?.reason !== 'error') return undefined;
  const edits = turn.context?.retainedEdits;
  if (!edits || !(edits.added || edits.modified || edits.deleted || edits.submodels.length)) return undefined;
  const error = turn.result?.error ?? turn.report?.failure?.error;
  return (
    '[失败回合摘要（已保留修改）]\n用户请求：' +
    turn.user +
    '\n失败原因：' +
    JSON.stringify({ category: error?.category ?? 'server', code: error?.code ?? 'UNKNOWN' }) +
    '\n已完成修改：' +
    JSON.stringify(edits)
  );
}

export function retainedEditContext(before: BrkDocument, after: BrkDocument): SavedTurn['context'] {
  const diff = diffDocuments(before, after);
  if (!diff.instances.length && !diff.structure.length) return undefined;
  const parts = diff.instances.filter((change) => (change.after ?? change.before)?.ref.kind === 'part');
  const models = new Set([
    ...diff.instances.map((change) => change.modelId),
    ...diff.structure.filter((change) => change.kind.startsWith('model.')).map((change) => change.id),
  ]);
  return {
    retainedEdits: {
      added: parts.filter((change) => change.kinds.includes('added')).length,
      modified: parts.filter((change) => !change.kinds.includes('added') && !change.kinds.includes('removed')).length,
      deleted: parts.filter((change) => change.kinds.includes('removed')).length,
      submodels: [...models].map((id) => `${id} (${(after.models[id] ?? before.models[id])?.name ?? id})`),
    },
  };
}

/** The caller logs once per resource load; missing or invalid marks never affect history. */
export function parseContextMarks(source: string | undefined): { marks: ContextMarks; warning: boolean } {
  try {
    const value = JSON.parse(source ?? '') as Partial<ContextMarks> | null;
    const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string');
    if (
      !value ||
      value.version !== 1 ||
      !ids(value.clearedTurnIds) ||
      !ids(value.discardedTurnIds) ||
      (value.clearedAt !== undefined && typeof value.clearedAt !== 'string')
    )
      throw new Error('INVALID_CONTEXT');
    const checkpoint = value.checkpoint;
    const validCheckpoint =
      checkpoint != null &&
      typeof checkpoint.summary === 'string' &&
      typeof checkpoint.createdAt === 'string' &&
      ids(checkpoint.coveredTurnIds) &&
      typeof checkpoint.throughTurnId === 'string' &&
      Number.isInteger(checkpoint.throughMessage) &&
      checkpoint.throughMessage > 0 &&
      checkpoint.coveredTurnIds.at(-1) === checkpoint.throughTurnId;
    return {
      marks: {
        version: 1,
        clearedTurnIds: [...new Set(value.clearedTurnIds)],
        discardedTurnIds: [...new Set(value.discardedTurnIds)],
        ...(value.clearedAt !== undefined ? { clearedAt: value.clearedAt } : {}),
        ...(validCheckpoint ? { checkpoint } : {}),
      },
      warning: checkpoint !== undefined && !validCheckpoint,
    };
  } catch {
    return { marks: emptyContextMarks(), warning: true };
  }
}
export function serializeContextMarks(marks: ContextMarks): string {
  return JSON.stringify({
    ...marks,
    clearedTurnIds: [...new Set(marks.clearedTurnIds)],
    discardedTurnIds: [...new Set(marks.discardedTurnIds)],
  });
}
export function clearContextMarks(marks: ContextMarks, turnIds: string[]): ContextMarks {
  const { checkpoint, ...previous } = marks;
  void checkpoint;
  return {
    ...previous,
    clearedTurnIds: [...new Set([...marks.clearedTurnIds, ...turnIds])],
    clearedAt: new Date().toISOString(),
  };
}

export function contextTurns(
  turns: readonly SavedTurn[],
  marks: ContextMarks,
  tasks: Record<string, Pick<AiTaskInfo, 'status'>> = {},
) {
  return turns.filter(
    (turn) => !['queued', 'running'].includes(tasks[turn.id]?.status ?? '') && turnContextStatus(turn, marks).included,
  );
}
export function contextHistory(
  turns: readonly SavedTurn[],
  marks: ContextMarks,
  tasks: Record<string, Pick<AiTaskInfo, 'status'>> = {},
): Message[] {
  const included = contextTurns(turns, marks, tasks);
  const checkpoint = validContextCheckpoint(included, marks);
  const end = checkpoint ? included.findIndex((turn) => turn.id === checkpoint.throughTurnId) : -1;
  return [
    ...(checkpoint ? [checkpointMessage(checkpoint)] : []),
    ...included.flatMap((turn, index) => {
      if (index < end) return [];
      const messages = turnMessages(turn);
      return index === end ? messages.slice(checkpoint!.throughMessage) : messages;
    }),
  ];
}
function turnMessages(turn: SavedTurn): Message[] {
  const failed = failedTurnSummary(turn);
  return failed
    ? [{ role: 'user', content: [{ type: 'text', text: failed }] }]
    : turn.report
      ? [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `看图搭建任务（软件记录，仅供参考）：${turn.user}（参考图 ${turn.images.length} 张，未附上）`,
              },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: turn.report.summaryZh }] },
        ]
      : completedTurnHistory(turn);
}
function validContextCheckpoint(turns: readonly SavedTurn[], marks: ContextMarks) {
  const checkpoint = marks.checkpoint;
  if (
    !checkpoint ||
    !checkpoint.coveredTurnIds.length ||
    !checkpoint.coveredTurnIds.every((id, index) => turns[index]?.id === id) ||
    checkpoint.throughMessage > turnMessages(turns[checkpoint.coveredTurnIds.length - 1]!).length
  )
    return undefined;
  return checkpoint;
}
/** Translate the agent's archival prefix position into persisted conversation positions.
 * Use the read snapshot: another concurrently finishing task must not shift this cut. */
export function saveContextCheckpoint(
  turns: readonly SavedTurn[],
  marks: ContextMarks,
  checkpoint: ContextCheckpoint,
): ContextMarks {
  const included = contextTurns(turns, marks);
  const previous = validContextCheckpoint(included, marks);
  let remaining = checkpoint.coveredMessages;
  let start = 0;
  if (previous) {
    remaining--;
    start = previous.coveredTurnIds.length - 1;
    remaining += previous.throughMessage;
  }
  for (let index = start; index < included.length; index++) {
    const turn = included[index]!;
    const length = turnMessages(turn).length;
    if (remaining > length) {
      remaining -= length;
      continue;
    }
    if (remaining <= 0) return marks;
    return {
      ...marks,
      checkpoint: {
        summary: checkpoint.summary,
        createdAt: checkpoint.createdAt,
        coveredTurnIds: included.slice(0, index + 1).map((entry) => entry.id),
        throughTurnId: turn.id,
        throughMessage: remaining,
      },
    };
  }
  return marks;
}
export function contextWindow(caps: Pick<ModelCapabilities, 'contextWindow'>): number | null {
  return caps.contextWindow != null && caps.contextWindow > 0 ? caps.contextWindow : null;
}
/** Same projection as get_model_summary, excluding its separately supplied selection.
 * Normalize in the counting Worker so large issue lists stay off the input thread. */
export function contextModelSummary(
  analysis: { summary: Record<string, unknown>; issues: Issue[] },
  activeModelPath: string[],
) {
  const kinds: Record<string, string> = {
    nonFactoryPart: 'non_factory_part',
    nonFactoryColor: 'non_factory_color',
    unavailableColor: 'unavailable_color',
  };
  return {
    ...analysis.summary,
    issues: analysis.issues.map((issue) => ({
      kind: kinds[issue.kind] ?? issue.kind,
      severity: issue.severity,
      paths: issue.paths,
      data: issue.data,
    })),
    activeModelPath,
  };
}
export function estimateContext(input: {
  summary: unknown;
  modelContext: boolean;
  history: Message[];
  capabilities: ModelCapabilities;
}) {
  const { system, modelSummary } = conversationPrompt(input.summary, input.modelContext);
  const tools = createEditorTools();
  const window = contextWindow(input.capabilities);
  const budget = calculateCeiling(window);
  const imageTokens = imageTokenEstimate(input.capabilities);
  const currentUserMessage: Message = { role: 'user', content: [{ type: 'text', text: '' }] };
  const baseTokens = estimateInputTokens(system, [currentUserMessage], tools, imageTokens);
  const result = compressHistory([...input.history, currentUserMessage], {
    system,
    tools,
    modelSummary,
    currentUserMessage,
    maxTokens: budget,
    reasoningReplay: input.capabilities.reasoningReplay ?? false,
    meter: new InputTokenMeter(undefined, imageTokens),
  });
  return {
    tokens: result.tokens,
    summarized: result.summarized,
    window,
    budget,
    baseTokens,
    historyTokens: Math.max(0, result.tokens - baseTokens),
  };
}
export function formatContextTokens(value: number): string {
  return value < 1000
    ? String(Math.round(value))
    : value < 1_000_000
      ? `${(value / 1000).toFixed(1)}K`
      : `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
