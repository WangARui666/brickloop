import type {
  AiError,
  ChatEvent,
  ContextCheckpoint,
  Message,
  ModelProvider,
  PublicAiError,
  StopReason,
  TokenUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '../types.js';
import { emptyUsage } from '../types.js';
import { publicAiError } from '../errors.js';
import { isTimeoutFailure, transientDelay, waitForRetry } from './retry.js';
import { watchModelStream, type RequestStarted, type TransportActivity } from './stream.js';
import { calculateCeiling, outputLimit } from '../capacity.js';
import type { EditorHost, EditorTool, ToolResult, ValidationIssue } from '../tools/index.js';
import { resultContent } from '../tools/index.js';
import { defaultPriceTable, estimateCost, type DailyCostLedger, type CostEstimate, type PriceTable } from '../cost.js';
import type { estimateInputTokens } from './history.js';
import { imageTokenEstimate, InputTokenMeter } from './history.js';
import { compactHistory } from './compaction.js';

export interface AgentBudget {
  toolCalls?: number;
  durationMs?: number;
  inputTokens?: number;
  dailyCostLimit?: number;
}
export type AgentStopReason =
  | 'completed'
  | 'cancelled'
  | 'tool_budget'
  | 'time_budget'
  | 'input_budget'
  | 'daily_cost_limit'
  | 'max_tokens'
  | 'error';
export interface AgentResult {
  reason: AgentStopReason;
  text: string;
  history: Message[];
  checkpoint?: ContextCheckpoint;
  usage: TokenUsage;
  cost: CostEstimate;
  toolCalls: number;
  elapsedMs: number;
  unresolvedIssues: ValidationIssue[];
  error?: AiError;
  /** Actual per-request ceiling, when known. */
  maxOutputTokens?: number;
  /** Attempts made for the most recent model request, including retries. */
  requestAttempts?: number;
}
export type AgentEvent =
  | RequestStarted
  | TransportActivity
  | Exclude<ChatEvent, { type: 'usage' }>
  | { type: 'usage'; usage: TokenUsage; totalUsage?: TokenUsage; cost?: CostEstimate }
  | { type: 'retry'; attempt: number; delayMs: number; error: PublicAiError }
  | { type: 'tool_result'; call: ToolCallBlock; result: ToolResult }
  | { type: 'history_compressed'; estimatedTokens: number; summarized: boolean }
  | { type: 'finished'; result: AgentResult };
export interface AgentTurnOptions {
  provider: ModelProvider;
  model: string;
  system: string;
  history: readonly Message[];
  userMessage: Message;
  tools: readonly EditorTool[];
  host: EditorHost;
  budget?: AgentBudget;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  modelSummary?: string;
  prices?: PriceTable;
  ledger?: DailyCostLedger;
  countInputTokens?: typeof estimateInputTokens;
  /** Test harness override; applications must only supply this in test builds. */
  retryDelayMs?: number;
  retryRandom?: () => number;
  streamStallMs?: number;
  /** Workflow gates and amendments run before context projection and budget accounting. */
  prepareMessages?: (messages: readonly Message[]) => Promise<readonly Message[]>;
}
/** Consuming events drives the turn. Breaking iteration cancels and commits; result resolves after cleanup. */
export function runAgentTurn(options: AgentTurnOptions): {
  events: AsyncGenerator<AgentEvent>;
  result: Promise<AgentResult>;
  cancel(): void;
} {
  const controller = new AbortController();
  let resolveResult: (value: AgentResult) => void = () => undefined;
  const result = new Promise<AgentResult>((resolve) => {
    resolveResult = resolve;
  });
  async function* run(): AsyncGenerator<AgentEvent> {
    const started = Date.now();
    const limit = options.budget?.toolCalls ?? Infinity;
    const duration = options.budget?.durationMs ?? Infinity;
    const capabilities = options.provider.capabilities(options.model);
    let inputLimit = options.budget?.inputTokens ?? calculateCeiling(capabilities.contextWindow);
    const shrinkSteps = [0.7, 0.5, 0.35];
    let overflowBase = 0,
      overflowRetries = 0,
      retryCompression = false;
    let transientRetries = 0,
      timeoutRetries = 0,
      requestAttempts = 0;
    const deadline = new AbortController();
    const timer =
      Number.isFinite(duration) && duration <= 2_147_483_647 && duration >= 0
        ? setTimeout(() => deadline.abort(), duration)
        : undefined;
    const signal = AbortSignal.any([controller.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    const prices = options.prices ?? defaultPriceTable;
    const day = options.ledger?.day();
    const state: AgentResult = {
      reason: 'cancelled',
      text: '',
      history: [...options.history, options.userMessage],
      usage: emptyUsage(),
      cost: estimateCost(prices, options.provider.id, options.model, emptyUsage(), options.provider.billing),
      toolCalls: 0,
      elapsedMs: 0,
      unresolvedIssues: [],
    };
    let transaction = false;
    let finished = false;
    let compressionReported = false;
    let summaryReported = false;
    let checkpointPending = false;
    const imageTokens = imageTokenEstimate(options.provider.capabilities(options.model));
    const meter = new InputTokenMeter(options.countInputTokens, imageTokens);
    const abortReason = (): AgentStopReason => (deadline.signal.aborted ? 'time_budget' : 'cancelled');
    try {
      if (![limit, duration, inputLimit].every((v) => v >= 0)) throw new Error('Invalid budget');
      if (options.provider.billing === 'api' && options.budget?.dailyCostLimit !== undefined) {
        if (!options.ledger || state.cost.amount === null) {
          state.reason = 'error';
          state.error = {
            category: 'invalid_request',
            code: 'COST_CONFIGURATION_REQUIRED',
            message: 'Configure model prices and a persistent daily ledger before enabling the daily cost limit.',
          };
          finished = true;
        } else if (!options.ledger.canStart(options.budget.dailyCostLimit)) {
          state.reason = 'daily_cost_limit';
          finished = true;
        }
      }
      while (!finished) {
        if (signal.aborted || Date.now() - started >= duration) {
          state.reason = abortReason();
          if (!signal.aborted) state.reason = 'time_budget';
          break;
        }
        // Completed requests from every concurrent task are already in the shared ledger.
        const dailyLimit = options.budget?.dailyCostLimit;
        if (
          options.provider.billing === 'api' &&
          dailyLimit !== undefined &&
          options.ledger &&
          options.ledger.spent(day) >= dailyLimit
        ) {
          state.reason = 'daily_cost_limit';
          break;
        }
        const summarize = state.toolCalls >= limit;
        const activeTools = options.tools;
        // Keep archival history complete; instructions and compression are request projections.
        const requestHistory = [...state.history];
        if (summarize)
          requestHistory.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'The tool-call budget has been exhausted. Do not call tools. Summarize completed work and unresolved issues in Simplified Chinese, then stop.',
              },
            ],
          });
        if (state.unresolvedIssues.length)
          requestHistory.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Resolve introduced validation issues before finishing. Inspect and repair them, then validate: ${JSON.stringify(state.unresolvedIssues)}`,
              },
            ],
          });
        const prepared = options.prepareMessages ? await options.prepareMessages(requestHistory) : requestHistory;
        const compressed = yield* compactHistory(prepared, {
          provider: options.provider,
          model: options.model,
          signal,
          ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
          ...(options.retryRandom ? { retryRandom: options.retryRandom } : {}),
          ...(options.streamStallMs !== undefined ? { streamStallMs: options.streamStallMs } : {}),
          ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
          onUsage(usage) {
            state.usage.inputTokens += usage.inputTokens;
            state.usage.outputTokens += usage.outputTokens;
            state.usage.cacheReadInputTokens += usage.cacheReadInputTokens;
            state.usage.cacheWriteInputTokens =
              (state.usage.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
            const cost = estimateCost(prices, options.provider.id, options.model, usage, options.provider.billing);
            if (cost.amount !== null && options.ledger) options.ledger.add(cost.amount, day);
          },
          reasoningReplay: capabilities.reasoningReplay ?? false,
          system: options.system,
          tools: activeTools,
          maxTokens: inputLimit,
          currentUserMessage: options.userMessage,
          meter,
          ...(options.modelSummary ? { modelSummary: options.modelSummary } : {}),
        });
        if (compressed.tokens > inputLimit) {
          state.reason = 'input_budget';
          break;
        }
        if (compressed.checkpoint) {
          state.checkpoint = compressed.checkpoint;
          if (
            options.provider.billing === 'api' &&
            dailyLimit !== undefined &&
            options.ledger &&
            options.ledger.spent(day) >= dailyLimit
          ) {
            state.reason = 'daily_cost_limit';
            break;
          }
          // Summary streams can yield while a workflow is paused or amended.
          // Re-enter its gate and apply its returned amendments, with the saved
          // checkpoint, before starting the actual task request.
          if (options.prepareMessages) {
            checkpointPending = true;
            continue;
          }
        }
        if (signal.aborted) {
          state.reason = abortReason();
          break;
        }
        const maxOutputTokens = outputLimit(capabilities, compressed.tokens, options.maxOutputTokens);
        if (maxOutputTokens !== undefined) state.maxOutputTokens = maxOutputTokens;
        const messages = compressed.messages;
        const assistant: Message = { role: 'assistant', content: [] };
        const pending: { call: ToolCallBlock; invalid: boolean }[] = [];
        let stop: StopReason | undefined;
        let fatal = false;
        let iterationText = '';
        const usage = emptyUsage();
        state.requestAttempts = ++requestAttempts;
        try {
          for await (const event of watchModelStream(
            options.provider,
            {
              model: options.model,
              system: options.system,
              messages,
              tools: activeTools,
              ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            },
            signal,
            options.streamStallMs,
          )) {
            // Do not yield between the workflow's gate/amendment snapshot and starting
            // the request. Otherwise a pause at history_compressed could bypass the gate.
            if (
              retryCompression ||
              (checkpointPending && !summaryReported) ||
              (compressed.compressed && (!compressionReported || (compressed.summarized && !summaryReported)))
            ) {
              compressionReported = true;
              summaryReported ||= compressed.summarized || retryCompression || checkpointPending;
              yield {
                type: 'history_compressed',
                estimatedTokens: compressed.tokens,
                summarized: compressed.summarized || retryCompression || checkpointPending,
              };
              retryCompression = false;
            }
            checkpointPending = false;
            if (event.type === 'text_delta') iterationText += event.text;
            if (event.type === 'provider_state') assistant.providerState = event.state;
            if (event.type === 'tool_call') pending.push({ call: event.call, invalid: false });
            if (event.type === 'error') {
              if (event.invalidCall) pending.push({ call: event.invalidCall, invalid: true });
              else {
                state.error = event.error;
                fatal = true;
              }
            }
            if (event.type === 'usage') {
              meter.observe(options.system, messages, activeTools, event.usage.inputTokens);
              state.usage.inputTokens += event.usage.inputTokens - usage.inputTokens;
              state.usage.outputTokens += event.usage.outputTokens - usage.outputTokens;
              state.usage.cacheReadInputTokens += event.usage.cacheReadInputTokens - usage.cacheReadInputTokens;
              state.usage.cacheWriteInputTokens =
                (state.usage.cacheWriteInputTokens ?? 0) +
                (event.usage.cacheWriteInputTokens ?? 0) -
                (usage.cacheWriteInputTokens ?? 0);
              Object.assign(usage, event.usage);
            }
            if (event.type === 'done') stop = event.reason;
            yield event.type === 'usage'
              ? {
                  ...event,
                  totalUsage: { ...state.usage },
                  cost: estimateCost(prices, options.provider.id, options.model, state.usage, options.provider.billing),
                }
              : event;
          }
        } catch (error) {
          // Preserve typed transport diagnostics from adapters that throw AiError.
          if (
            error &&
            typeof error === 'object' &&
            'category' in error &&
            'message' in error &&
            typeof error.message === 'string' &&
            ['network', 'server', 'rate_limit', 'auth', 'quota_exceeded', 'invalid_request', 'refusal'].includes(
              String(error.category),
            )
          ) {
            state.error = error as AiError;
            fatal = true;
            yield { type: 'error', error: state.error };
          } else throw error;
        } finally {
          // Settle even cancelled/failed streams, exactly once per request. Other tasks see
          // this charge before issuing their next call, rather than at the end of the turn.
          const cost = estimateCost(prices, options.provider.id, options.model, usage, options.provider.billing);
          if (cost.amount !== null && options.ledger) options.ledger.add(cost.amount, day);
        }
        if (signal.aborted || stop === 'cancelled') {
          state.reason = signal.aborted ? abortReason() : 'cancelled';
          break;
        }
        if (!fatal && !stop) {
          fatal = true;
          state.error = {
            category: 'network',
            code: 'INCOMPLETE_STREAM',
            message: 'Provider stream ended without completion.',
          };
        }
        if (fatal && state.error?.code === 'CONTEXT_OVERFLOW') {
          // Never replay tools: only the rejected model request is retried, projected
          // from archival history that already contains every executed call/result.
          if (overflowRetries === 0) overflowBase = compressed.tokens;
          const shrink = shrinkSteps[overflowRetries++];
          if (shrink === undefined) {
            state.reason = 'input_budget';
            break;
          }
          inputLimit = Math.min(inputLimit, Math.floor(overflowBase * shrink));
          retryCompression = true;
          continue;
        }
        if (fatal) {
          const delayMs = transientDelay(state.error, transientRetries, {
            timeoutRetries,
            ...(options.retryDelayMs !== undefined ? { overrideMs: options.retryDelayMs } : {}),
            ...(options.retryRandom ? { random: options.retryRandom } : {}),
          });
          if (delayMs !== undefined) {
            if (isTimeoutFailure(state.error!)) timeoutRetries++;
            yield { type: 'retry', attempt: ++transientRetries, delayMs, error: publicAiError(state.error!) };
            await waitForRetry(delayMs, signal);
            continue;
          }
          state.reason = 'error';
          break;
        }
        if (stop) {
          transientRetries = 0;
          timeoutRetries = 0;
          requestAttempts = 0;
          overflowRetries = 0;
          delete state.error;
        }
        if (iterationText) {
          assistant.content.push({ type: 'text', text: iterationText });
          state.text += iterationText;
        }
        if (signal.aborted) {
          state.reason = abortReason();
          break;
        }
        if (stop === 'max_tokens' || stop === 'refusal') {
          state.reason = stop === 'max_tokens' ? 'max_tokens' : 'error';
          if (stop === 'refusal')
            state.error = { category: 'refusal', code: 'MODEL_REFUSED', message: 'The model refused the request.' };
          break;
        }
        if (!pending.length) {
          if (assistant.content.length || assistant.providerState) state.history.push(assistant);
          state.reason = summarize ? 'tool_budget' : 'completed';
          break;
        }
        assistant.content.push(...pending.map((p) => p.call));
        state.history.push(assistant);
        const results: ToolResultBlock[] = pending.map(({ call }) => ({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          isError: true,
          content: [{ type: 'text', text: '{"ok":false,"code":"CANCELLED","message":"Tool was not executed."}' }],
        }));
        state.history.push({ role: 'tool', content: results });
        for (const [index, { call, invalid }] of pending.entries()) {
          const tool = options.tools.find((t) => t.name === call.name);
          let output: ToolResult;
          if (signal.aborted) {
            state.reason = abortReason();
            finished = true;
            output = { ok: false, code: 'CANCELLED', message: 'Tool was not started because the turn was cancelled.' };
          } else if (state.toolCalls >= limit) {
            state.reason = 'tool_budget';
            finished = summarize;
            output = {
              ok: false,
              code: 'TOOL_BUDGET',
              message: 'Tool was not started because the call budget was exhausted.',
            };
          } else {
            state.toolCalls++;
            const parsed = tool?.schema.safeParse(call.arguments);
            if (invalid || !parsed?.success || !tool)
              output = {
                ok: false,
                code: 'INVALID_ARGUMENTS',
                message: 'Invalid JSON or arguments. Correct the tool call and try again.',
              };
            else {
              if (tool.mutating && !transaction) {
                await options.host.beginTransaction(
                  'AI: ' +
                    options.userMessage.content
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text)
                      .join(' ')
                      .slice(0, 80),
                );
                transaction = true;
              }
              // Do not abort a running host command; it owns its atomic mutation boundary.
              output = signal.aborted
                ? { ok: false, code: 'CANCELLED', message: 'Tool was not started because the turn was cancelled.' }
                : await tool.execute(options.host, parsed.data);
              if (output.ok && tool.mutating && output.introducedIssues.length)
                state.unresolvedIssues.push(...output.introducedIssues);
              if (
                output.ok &&
                call.name === 'validate' &&
                output.data &&
                typeof output.data === 'object' &&
                !Array.isArray(output.data)
              ) {
                const issues = output.data.issues;
                if (Array.isArray(issues) && issues.length === 0) state.unresolvedIssues = [];
              }
            }
          }
          results[index] = {
            type: 'tool_result',
            id: call.id,
            name: call.name,
            content: resultContent(output),
            isError: !output.ok,
          };
          yield { type: 'tool_result', call, result: output };
        }
      }
    } catch {
      state.reason = signal.aborted ? abortReason() : 'error';
      if (!signal.aborted)
        state.error = { category: 'server', code: 'TURN_FAILED', message: 'The agent turn could not be completed.' };
    } finally {
      clearTimeout(timer);
      if (transaction) {
        try {
          await options.host.commitTransaction();
        } catch {
          state.reason = 'error';
          state.error = {
            category: 'server',
            code: 'COMMIT_FAILED',
            message: 'The host could not commit the AI transaction.',
          };
        }
      }
      state.cost = estimateCost(prices, options.provider.id, options.model, state.usage, options.provider.billing);
      state.elapsedMs = Date.now() - started;
      resolveResult(state);
    }
    yield { type: 'finished', result: state };
  }
  return { events: run(), result, cancel: () => controller.abort() };
}
