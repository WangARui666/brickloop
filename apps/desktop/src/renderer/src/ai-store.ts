import { documentLocked } from './document-store';
import { create } from 'zustand';
import { streamCoalescer } from './stream-coalescer';
import type {
  AgentEvent,
  StructurePlan,
  WorkflowState,
  ViewComparison,
  WorkflowRound,
  WorkflowReport,
  ModelActivity,
  PlanBoxRepair,
} from '@brickloop/ai';
import type { ImageTaskRequest, TurnRequest } from '../../shared/ai-api';
import type { AiSnapshot, Approval, SavedTurn } from '../../shared/ai-api';

export interface ImageWorkflow {
  taskId: string;
  documentId: string;
  request: ImageTaskRequest;
  state: WorkflowState | null;
  plan: StructurePlan | null;
  viewWarnings?: string[];
  comparison: ViewComparison | null;
  rounds?: WorkflowRound[];
  script?: WorkflowReport['script'];
  updatedAt: number;
  boxRepairs?: PlanBoxRepair[];
}
export interface ModelLiveness {
  startedAt: number;
  receivedAt: number | null;
  bytesAt?: number;
  counts: ModelActivity;
  phase: 'thinking' | 'replying' | 'script';
  noticeMs: number;
  retryUntil?: number;
  retryAttempt?: number;
}
interface AiState {
  liveness: Record<string, ModelLiveness>;
  workflows: Record<string, ImageWorkflow>;
  snapshot: AiSnapshot | null;
  settingsOpen: boolean;
  approval: Approval | null;
  turns: SavedTurn[];
  running: boolean;
  error: string | null;
  imageInputOpen: boolean;
  mosaicOpen: boolean;
  selectedProvider: string;
  selectedModel: string;
  effort: TurnRequest['effort'];
  focusComposer: number;
  workflow: ImageWorkflow | null;
}
export const useAiStore = create<AiState>(() => ({
  liveness: {},
  snapshot: null,
  settingsOpen: false,
  approval: null,
  turns: [],
  running: false,
  error: null,
  imageInputOpen: false,
  mosaicOpen: false,
  selectedProvider: '',
  selectedModel: '',
  effort: 'balanced',
  focusComposer: 0,
  workflows: {},
  workflow: null,
}));
export function aiChoice(
  state: Pick<AiState, 'snapshot' | 'selectedProvider' | 'selectedModel' | 'effort'> = useAiStore.getState(),
) {
  const settings = state.snapshot?.settings,
    providers = settings?.providers ?? [],
    purpose = settings?.defaults.chat ?? '',
    purposeId = purpose.split('/')[0];
  const provider =
    providers.find((p) => p.id === state.selectedProvider) ??
    providers.find((p) => p.id === purposeId) ??
    providers.find((p) => p.id === settings?.defaultProviderId) ??
    providers[0];
  const model =
    state.selectedModel ||
    (!state.selectedProvider && purpose.startsWith(`${provider?.id}/`) ? purpose.slice(purposeId!.length + 1) : '') ||
    provider?.model ||
    provider?.models[0] ||
    '';
  return { provider, model, effort: state.effort };
}
// Only the newest snapshot is published each second; no activity is appended to SavedTurn.
const pendingActivity = new Map<string, ModelLiveness>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
function publishActivity(id: string, value: ModelLiveness) {
  useAiStore.setState((s) => ({ liveness: { ...s.liveness, [id]: value } }));
}
export function clearModelLiveness(id: string) {
  flushAiStream(id);
  clearTimeout(activityTimers.get(id));
  activityTimers.delete(id);
  pendingActivity.delete(id);
  useAiStore.setState((s) => {
    const liveness = { ...s.liveness };
    delete liveness[id];
    return { liveness };
  });
}
function receiveLiveness(id: string, event: AgentEvent, noticeMs = 60_000) {
  const now = Date.now();
  if (event.type === 'request_started' || event.type === 'retry') {
    clearModelLiveness(id);
    publishActivity(id, {
      startedAt: now,
      receivedAt: null,
      phase: 'thinking',
      noticeMs,
      counts: { type: 'activity', reasoningChars: 0, contentChars: 0, toolChars: 0 },
      ...(event.type === 'retry' ? { retryUntil: now + event.delayMs, retryAttempt: event.attempt } : {}),
    });
  } else if (event.type === 'activity' || event.type === 'transport_activity') {
    const previous = pendingActivity.get(id) ?? useAiStore.getState().liveness[id];
    if (!previous) return;
    const counts = event.type === 'activity' ? event : previous.counts;
    const contentChanged =
      counts.toolChars > previous.counts.toolChars ||
      counts.contentChars > previous.counts.contentChars ||
      counts.reasoningChars > previous.counts.reasoningChars;
    const phase =
      counts.toolChars > previous.counts.toolChars
        ? 'script'
        : counts.contentChars > previous.counts.contentChars
          ? 'replying'
          : counts.reasoningChars > previous.counts.reasoningChars
            ? 'thinking'
            : previous.phase;
    const latest: ModelLiveness = {
      ...previous,
      receivedAt: contentChanged ? now : previous.receivedAt,
      ...(event.type === 'transport_activity' ? { bytesAt: event.receivedAt } : {}),
      counts,
      phase,
    };
    pendingActivity.set(id, latest);
    const displayed = useAiStore.getState().liveness[id];
    // First data and recovery from silence are visible immediately.
    if (
      (contentChanged && previous.receivedAt === null) ||
      (event.type === 'transport_activity' && previous.bytesAt === undefined) ||
      (displayed && now - (displayed.bytesAt ?? displayed.receivedAt ?? displayed.startedAt) >= noticeMs)
    )
      publishActivity(id, latest);
    if (!activityTimers.has(id))
      activityTimers.set(
        id,
        setTimeout(() => {
          activityTimers.delete(id);
          const value = pendingActivity.get(id);
          pendingActivity.delete(id);
          if (value) publishActivity(id, value);
        }, 1000),
      );
  } else if (['done', 'error', 'finished'].includes(event.type)) clearModelLiveness(id);
}
const incremental = ({ event }: { event: AgentEvent }) =>
  ['text_delta', 'reasoning_summary', 'activity', 'transport_activity'].includes(event.type);
const conversationStream = streamCoalescer<{ event: AgentEvent; noticeMs: number | undefined }>((id, entries) => {
  const first = entries[0]!;
  if (!incremental(first.value)) {
    applyAiEvent(id, first.value.event, first.value.noticeMs);
    return;
  }
  useAiStore.setState((state) => {
    const text: string[] = [];
    let liveness = state.liveness[id];
    for (const {
      value: { event },
      receivedAt,
    } of entries) {
      if (event.type === 'text_delta') text.push(event.text);
      if (!liveness) continue;
      if (event.type === 'transport_activity') {
        // Preserve A-122's raw-byte timestamp, not the time this batch is rendered.
        liveness = { ...liveness, bytesAt: event.receivedAt };
      } else if (event.type === 'activity') {
        const previous = liveness.counts;
        const phase =
          event.toolChars > previous.toolChars
            ? 'script'
            : event.contentChars > previous.contentChars
              ? 'replying'
              : event.reasoningChars > previous.reasoningChars
                ? 'thinking'
                : undefined;
        liveness = {
          ...liveness,
          counts: event,
          ...(phase ? { phase, receivedAt } : {}),
        };
      }
    }
    const delta = text.join('');
    if (!delta && liveness === state.liveness[id]) return state;
    return {
      ...(delta
        ? { turns: state.turns.map((turn) => (turn.id === id ? { ...turn, text: turn.text + delta } : turn)) }
        : {}),
      ...(liveness && liveness !== state.liveness[id] ? { liveness: { ...state.liveness, [id]: liveness } } : {}),
    };
  });
}, incremental);

export function flushAiStream(id?: string) {
  conversationStream.flush(id);
}

export function receiveAiEvent(id: string, event: AgentEvent, noticeMs?: number, workflow = false) {
  if (workflow) applyAiEvent(id, event, noticeMs, true);
  else conversationStream.push(id, { event, noticeMs });
}

function applyAiEvent(id: string, event: AgentEvent, noticeMs?: number, workflow = false) {
  receiveLiveness(id, event, noticeMs);
  if (workflow && !['tool_call', 'tool_result', 'usage', 'retry'].includes(event.type)) return;
  if (event.type === 'activity' || event.type === 'transport_activity' || event.type === 'request_started') return;
  useAiStore.setState((state) => ({
    turns: state.turns.map((turn) => {
      if (turn.id !== id) return turn;
      if (event.type === 'text_delta') return { ...turn, text: turn.text + event.text };
      if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'retry')
        return { ...turn, events: [...turn.events, event] };
      if (event.type === 'finished') return { ...turn, text: event.result.text, result: event.result };
      if (event.type === 'history_compressed' && event.summarized)
        return { ...turn, compressed: { estimatedTokens: event.estimatedTokens } };
      if (event.type === 'usage')
        return { ...turn, usage: event.totalUsage ?? event.usage, ...(event.cost ? { cost: event.cost } : {}) };
      return turn;
    }),
  }));
}
export async function startImageTask(request: ImageTaskRequest) {
  if (documentLocked()) return null;
  useAiStore.setState({ error: null });
  try {
    const id = await window.brickloop.aiStartImage(request);
    useAiStore.setState({ imageInputOpen: false });
    return id;
  } catch {
    useAiStore.setState({ error: 'aiUi.failed' });
    return null;
  }
}
