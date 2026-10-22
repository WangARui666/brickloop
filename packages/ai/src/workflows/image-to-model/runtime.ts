import { z } from 'zod';
import { createI18n } from '@brickloop/i18n';
import { runAgentTurn, type AgentResult } from '../../agent/runtime.js';
import { checkpointMessage } from '../../agent/compaction.js';
import { createEditorTools, toolSchemas, type EditorTool, type ToolName, type ToolResult } from '../../tools/index.js';
import { calculateCeiling } from '../../capacity.js';
import { publicAiError } from '../../errors.js';
import { emptyUsage, type JsonValue, type Message } from '../../types.js';
import { parseStructurePlan, planningReferenceId, type StructurePlan } from './plan.js';
import { imageToModelPrompt, palettePlanningPrompt, structurePlanPrompt, viewPlanningPrompt } from './prompts.js';
import { isStandardReferenceView, resolveReferenceViews } from './views.js';
import { roundContext } from './context.js';
import { summarizeImageModelReport } from './report.js';
import { metricsPlateau, transitionPhase } from './state.js';
import { normalizePlanColors } from './colors.js';
import { normalizePlanBoxes } from './boxes.js';
import type {
  ImageToModelOptions,
  ViewComparison,
  WorkflowEvent,
  WorkflowReport,
  WorkflowState,
  WorkflowStopReason,
} from './types.js';

const imagesSchema = z.array(toolSchemas.add_reference_image.shape.image).min(1);
const summarySchema = z.object({
  partCount: z.number().int().nonnegative(),
  colorCount: z.number().int().nonnegative(),
});
const validationSchema = z.object({ issues: z.array(z.object({ kind: z.string() }).catchall(z.json())) });
const comparisonSchema = z.object({
  iou: z.number().min(0).max(1),
  colorDifference: z.number().nonnegative().nullable().optional(),
  boundsRatioDifference: z.number().nonnegative().nullable().optional(),
  images: imagesSchema,
  emptyModel: z.boolean().optional(),
});
class Halt extends Error {
  constructor(
    readonly reason: WorkflowStopReason,
    readonly code?: string,
    readonly failure?: WorkflowReport['failure'],
  ) {
    super(reason);
  }
}
function record(data: JsonValue): Record<string, JsonValue> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Halt('error', 'host_result');
  return data;
}

/** Consume events to drive execution; result resolves after the one outer transaction is closed. */
export function runImageToModel(options: ImageToModelOptions) {
  const control = new AbortController(),
    deadline = new AbortController();
  const signal = AbortSignal.any([control.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
  const limit = options.budget?.toolCalls ?? 2000,
    duration = options.budget?.durationMs ?? 7_200_000;
  const inputLimit =
    options.budget?.inputTokens ?? calculateCeiling(options.provider.capabilities(options.model).contextWindow);
  if (!(inputLimit >= 0)) throw new RangeError('Invalid input budget.');
  if (!Number.isInteger(limit) || limit < 0 || !Number.isFinite(duration) || duration < 0 || duration > 2_147_483_647)
    throw new RangeError('Invalid workflow budget.');
  if (
    options.improvementEpsilon !== undefined &&
    (!Number.isFinite(options.improvementEpsilon) || options.improvementEpsilon < 0)
  )
    throw new RangeError('Invalid improvement epsilon.');
  const roundLimit = options.budget?.rounds ?? 20;
  if (!Number.isInteger(roundLimit) || roundLimit < 2 || roundLimit > 20) throw new RangeError('Invalid round budget.');
  const scriptId = 'image-' + globalThis.crypto.randomUUID();
  const input = structuredClone(options.input);
  let modelInput = input;
  input.priority ??= 'buildable';
  input.parts ??= { source: 'all' };
  if (!['appearance', 'buildable'].includes(input.priority)) throw new RangeError('Invalid priority.');
  input.viewMode ??= 'auto';
  if (!['auto', 'fixed'].includes(input.viewMode)) throw new RangeError('Invalid view mode.');
  if ((!input.description?.trim() && !input.images?.length) || (input.images?.length ?? 0) > 8)
    throw new RangeError('Supply text or 1-8 images.');
  for (const image of input.images ?? []) {
    toolSchemas.add_reference_image.shape.image.parse(image.image);
    if (image.view === 'unknown') image.view = 'auto';
    if (!isStandardReferenceView(image.view) && !['auto', 'exclude'].includes(image.view))
      throw new RangeError('Invalid reference view.');
    if (input.viewMode === 'fixed' && !isStandardReferenceView(image.view))
      throw new RangeError('Fixed mode requires a standard view for every image.');
  }
  const estimateIds = (input.images ?? []).flatMap((image, index) =>
    image.view === 'auto' ? [planningReferenceId(index)] : [],
  );
  if (
    typeof input.targetSize === 'object' &&
    (!Object.values(input.targetSize).length ||
      Object.values(input.targetSize).some((v) => !Number.isFinite(v) || v <= 0))
  )
    throw new RangeError('Invalid target size.');
  const state: WorkflowState = {
    phase: 'understanding',
    paused: false,
    awaitingConfirmation: false,
    documentLocked: false,
    componentId: null,
    componentIndex: 0,
    round: 0,
    toolCalls: 0,
    elapsedMs: 0,
  };
  let started = 0,
    pausedAt: number | null = null,
    pausedMs = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    ended = false,
    startedRun = false,
    transaction = false,
    confirmation: StructurePlan | null = null;
  let wake: (() => void) | undefined;
  let paletteColorIds: string[] | undefined;
  const interjections: string[] = [];
  let delivered = 0;
  const report: WorkflowReport = {
    rounds: [],
    script: null,
    buildabilitySkipped: input.priority === 'appearance',
    reason: 'user_stopped',
    plan: null,
    components: [],
    partCount: null,
    colorCount: null,
    validation: { checked: false, issues: [] },
    checks: [],
    comparisons: [],
    references: resolveReferenceViews(input),
    latestRender: [],
    unfinished: [],
    interjections,
    toolCalls: 0,
    elapsedMs: 0,
    usage: emptyUsage(),
    transaction: 'none',
    summaryZh: '',
  };
  let resolveResult: (report: WorkflowReport) => void = () => undefined;
  const result = new Promise<WorkflowReport>((resolve) => {
    resolveResult = resolve;
  });
  const elapsed = () => (startedRun ? (pausedAt ?? Date.now()) - started - pausedMs : 0);
  const armDeadline = () => {
    clearTimeout(timer);
    if (startedRun && !ended && !state.paused)
      timer = setTimeout(() => deadline.abort(), Math.max(0, duration - elapsed()));
  };
  const snapshot = (): WorkflowState => ({
    ...state,
    ...(state.modelActivity
      ? { modelActivity: { ...state.modelActivity, counts: { ...state.modelActivity.counts } } }
      : {}),
    elapsedMs: !ended ? elapsed() : state.elapsedMs,
  });
  const publish = () => {
    try {
      options.onState?.(snapshot());
    } catch {
      /* A UI observer must not strand the transaction. */
    }
  };
  const notify = () => {
    wake?.();
    wake = undefined;
    publish();
  };
  const abortCheck = () => {
    if (deadline.signal.aborted || (startedRun && elapsed() >= duration)) throw new Halt('time_budget');
    if (signal.aborted) throw new Halt('user_stopped');
  };
  async function gate() {
    abortCheck();
    while (state.paused || (state.awaitingConfirmation && !confirmation)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        wake = done;
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
      abortCheck();
    }
    abortCheck();
  }
  function budgetCheck() {
    abortCheck();
    if (state.toolCalls >= limit) throw new Halt('tool_budget');
  }
  function* phase(next: WorkflowState['phase']): Generator<WorkflowEvent> {
    state.phase = transitionPhase(state.phase, next);
    publish();
    yield { type: 'state', state: snapshot() };
  }
  const allTools = createEditorTools();
  const tool = (name: string) => {
    const found = allTools.find((t) => t.name === name);
    if (!found) throw new Halt('error', 'host_result');
    return found;
  };
  let lastRun: JsonValue = null,
    examples: JsonValue = null;
  let scriptRan = false;
  let roundNote = '';
  const roundWarnings: string[] = [];
  function observe(name: string, _args: unknown, output: ToolResult) {
    if (!output.ok) return;
    if (tool(name).mutating) {
      report.validation.checked = false;
      report.partCount = null;
      report.colorCount = null;
    }
    if (name === 'run_build_script') {
      scriptRan = true;
      lastRun = output.data;
      const args = toolSchemas.run_build_script.parse(_args);
      // Preserve a successful full source even if stop/budget prevents the automatic source read.
      report.script = args.code !== undefined ? { scriptId, code: args.code } : null;
      const data = record(output.data);
      const models = z
        .array(z.object({ name: z.string(), modelId: z.string(), bounds: z.unknown().nullable() }))
        .safeParse(data.submodels);
      report.components = models.success
        ? (report.plan?.components ?? []).flatMap((c) => {
            const found = models.data.find((m) => (m.name === c.id || m.name === c.name) && m.bounds);
            return found ? [{ componentId: c.id, submodelId: found.modelId, modelPath: [], checked: true }] : [];
          })
        : [];
    }
  }
  async function* execute(name: ToolName, args: unknown): AsyncGenerator<WorkflowEvent, ToolResult & { ok: true }> {
    await gate();
    budgetCheck();
    state.toolCalls++;
    publish();
    abortCheck();
    const call = { type: 'tool_call' as const, id: `check-${state.toolCalls}`, name, arguments: args };
    yield { type: 'agent', event: { type: 'tool_call', call } };
    await gate();
    const output = await tool(name).execute(options.host, args);
    yield { type: 'agent', event: { type: 'tool_result', call, result: output } };
    if (!output.ok && output.code === 'ENGINE_UNAVAILABLE') throw new Halt('engine_unavailable', 'engine_unavailable');
    observe(name, args, output);
    if (!output.ok) throw new Halt('error', 'host_result');
    return output;
  }
  const forbidden = new Set(['add_reference_image', 'make_mosaic', 'export_io', 'job_status', 'job_cancel', 'batch']);
  const agentTools: EditorTool[] = allTools
    .filter((t) => !forbidden.has(t.name))
    .map((t) => ({
      ...t,
      async execute(_host, args) {
        await gate();
        if (t.name === 'run_build_script') {
          const parsed = toolSchemas.run_build_script.parse(args);
          if (
            parsed.scriptId !== scriptId ||
            parsed.mode !== 'replace' ||
            (parsed.target && parsed.target !== 'root') ||
            scriptRan
          )
            return {
              ok: false,
              code: 'WORKFLOW_SCRIPT',
              message: 'Run only the supplied main script, once per round, mode replace, target root.',
            };
          args = {
            ...parsed,
            scope: state.phase === 'buildability' && input.parts?.source === 'factory' ? 'factory' : 'all',
          };
        }
        if (t.name === 'compare_to_reference') {
          const comparison = toolSchemas.compare_to_reference.parse(args);
          const ref = report.references.find((r) => r.referenceId === comparison.referenceId);
          if (ref?.view === null)
            return {
              ok: false,
              code: 'REFERENCE_NOT_COMPARABLE',
              message: 'This reference is for understanding only.',
            };
        }
        const output = await t.execute(options.host, args);
        observe(t.name, args, output);
        // The generic chat agent insists on clearing introduced issues. V2 defers that to buildability.
        return output.ok && state.phase !== 'buildability' ? { ...output, introducedIssues: [] } : output;
      },
    }));
  let roundHistory: Message[] = [];
  const retainedHistory = (answer: AgentResult): Message[] =>
    answer.checkpoint
      ? [checkpointMessage(answer.checkpoint), ...answer.history.slice(answer.checkpoint.coveredMessages)]
      : answer.history;
  async function* modelTurn(
    text: string,
    planning = false,
    history: readonly Message[] = roundHistory,
  ): AsyncGenerator<WorkflowEvent, AgentResult> {
    await gate();
    budgetCheck();
    const amendments = interjections.slice();
    delivered = amendments.length;
    let userMessage: Message = planning
      ? {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                text +
                '\nRequirements: ' +
                JSON.stringify({
                  ...input,
                  images: input.images?.map(({ name, view }, index) => ({
                    referenceId: planningReferenceId(index),
                    name,
                    view,
                  })),
                }) +
                '\nAll user amendments: ' +
                JSON.stringify(amendments),
            },
            ...(modelInput.images ?? []).flatMap((ref, index) => [
              { type: 'text' as const, text: 'Reference ' + planningReferenceId(index) + ': ' + ref.name },
              ref.image,
            ]),
          ],
        }
      : roundContext(modelInput, report, state, lastRun, examples, amendments);
    let attempts = 0,
      truncations = 0,
      usedTools = 0;
    let attemptHistory = history;
    while (true) {
      await gate();
      budgetCheck();
      attempts++;
      const turn = runAgentTurn({
        provider: options.provider,
        model: options.model,
        system: planning
          ? [
              structurePlanPrompt,
              ...(paletteColorIds ? [palettePlanningPrompt(paletteColorIds)] : []),
              viewPlanningPrompt(estimateIds),
            ].join('\n\n')
          : [imageToModelPrompt, 'Main scriptId: ' + scriptId, options.designGuides?.(report.plan!) ?? ''].join('\n\n'),
        history: attemptHistory,
        userMessage,
        tools: planning
          ? []
          : agentTools.filter((t) => !t.mutating || t.name === 'run_build_script' || state.phase === 'buildability'),
        host: { ...options.host, beginTransaction: async () => undefined, commitTransaction: async () => undefined },
        budget: {
          ...(options.budget?.dailyCostLimit !== undefined ? { dailyCostLimit: options.budget.dailyCostLimit } : {}),
          toolCalls: Math.min(12 - usedTools, limit - state.toolCalls),
          // The workflow owns the pausable deadline through signal.
          inputTokens: inputLimit,
        },
        async prepareMessages(messages) {
          await gate();
          budgetCheck();
          return messages;
        },
        signal,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        ...(options.streamStallMs !== undefined ? { streamStallMs: options.streamStallMs } : {}),
        ...(options.ledger ? { ledger: options.ledger } : {}),
        ...(options.prices ? { prices: options.prices } : {}),
      });
      let counted = 0;
      try {
        for await (const event of turn.events) {
          if (event.type === 'request_started')
            state.modelActivity = {
              startedAt: Date.now(),
              receivedAt: null,
              counts: { type: 'activity', reasoningChars: 0, contentChars: 0, toolChars: 0 },
            };
          if (event.type === 'activity' && state.modelActivity)
            state.modelActivity = { ...state.modelActivity, receivedAt: Date.now(), counts: event };
          if (['done', 'retry', 'error', 'finished'].includes(event.type)) delete state.modelActivity;
          if (event.type === 'tool_result') {
            // Cancelled/exhausted calls are represented as results but were never charged by the agent.
            if (event.result.ok || !['CANCELLED', 'TOOL_BUDGET'].includes(event.result.code)) {
              state.toolCalls++;
              counted++;
              publish();
            }
          }
          if (event.type === 'retry' && !roundWarnings.includes('transient_retry'))
            roundWarnings.push('transient_retry');
          yield { type: 'agent', event };
          if (event.type === 'tool_result' && !event.result.ok && event.result.code === 'ENGINE_UNAVAILABLE')
            throw new Halt('engine_unavailable', 'engine_unavailable');
        }
      } finally {
        turn.cancel();
        await turn.events.return(undefined);
        const done = await turn.result;
        state.toolCalls += done.toolCalls - counted;
        report.usage.inputTokens += done.usage.inputTokens;
        report.usage.outputTokens += done.usage.outputTokens;
        report.usage.cacheReadInputTokens += done.usage.cacheReadInputTokens;
        report.usage.cacheWriteInputTokens =
          (report.usage.cacheWriteInputTokens ?? 0) + (done.usage.cacheWriteInputTokens ?? 0);
      }
      const done = await turn.result;
      // A new workflow round already rebuilds authoritative script, validation and
      // comparison context. Carry its checkpoint forward; tool pairs stay verbatim
      // within the active modelTurn (including output-truncation retries).
      if (!planning && done.checkpoint) roundHistory = [checkpointMessage(done.checkpoint)];
      usedTools += done.toolCalls;
      await gate();
      if (state.toolCalls >= limit) throw new Halt('tool_budget');
      if (done.reason === 'tool_budget' && !planning) {
        roundWarnings.push('round_tool_limit');
        return done;
      }
      if (done.reason === 'completed' || (planning && done.reason === 'max_tokens')) return done;
      const failure: NonNullable<WorkflowReport['failure']> = {
        stage: planning ? 'planning' : 'round',
        ...(!planning ? { round: state.round } : {}),
        agentReason: done.reason,
        ...(done.error ? { error: publicAiError(done.error) } : {}),
        attempts: done.reason === 'max_tokens' ? attempts : (done.requestAttempts ?? 1),
      };
      if (done.reason === 'max_tokens' && truncations++ < 2) {
        if (!roundWarnings.includes('output_truncated_retried')) roundWarnings.push('output_truncated_retried');
        attemptHistory = retainedHistory(done);
        userMessage = {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'The previous output was truncated before the tool call completed; that script was not executed. ' +
                'The output ceiling is approximately ' +
                (done.maxOutputTokens ?? 'the provider default number of') +
                ' tokens. Write a shorter script or patch. For many components, first outline ALL components with a few box() calls or helper functions; add details with patches in later rounds.',
            },
            ...userMessage.content.filter((b) => b.type === 'image'),
          ],
        };
        continue;
      }
      throw new Halt(
        done.reason === 'tool_budget' ||
          done.reason === 'time_budget' ||
          done.reason === 'input_budget' ||
          done.reason === 'daily_cost_limit'
          ? done.reason
          : 'error',
        done.reason === 'max_tokens'
          ? 'output_truncated'
          : done.error?.category === 'refusal'
            ? 'model_refused'
            : done.error
              ? 'provider_error'
              : 'model_failed',
        failure,
      );
    }
  }
  async function* inspectRound(): AsyncGenerator<WorkflowEvent, number[]> {
    if (scriptRan) {
      const saved = record((yield* execute('get_build_script', { scriptId })).data);
      if (typeof saved.code !== 'string') throw new Halt('error', 'host_result');
      report.script = { scriptId, code: saved.code };
    }
    const validation = validationSchema.safeParse((yield* execute('validate', {})).data);
    if (!validation.success) throw new Halt('error', 'host_result');
    report.validation = { checked: true, issues: validation.data.issues };
    report.checks.push({ componentId: null, round: state.round, issues: validation.data.issues });
    const references = report.references.filter((r) => r.view !== null);
    const rendered = yield* execute('render_views', {
      views: [...new Set([...references.map((r) => r.view!), 'isometric'])],
      width: 384,
      height: 384,
    });
    const renderImages = imagesSchema.safeParse(record(rendered.data).images);
    if (!renderImages.success) throw new Halt('error', 'host_result');
    report.latestRender = renderImages.data;
    const comparisons: ViewComparison[] = [],
      metrics: number[] = [];
    for (const ref of references) {
      const compared = yield* execute('compare_to_reference', { referenceId: ref.referenceId, view: ref.view });
      const parsed = comparisonSchema.safeParse(compared.data);
      if (!parsed.success) throw new Halt('error', 'host_result');
      const comparison: ViewComparison = {
        referenceId: ref.referenceId,
        view: ref.view!,
        inferredView: ref.source === 'ai',
        confidence: ref.confidence,
        componentId: null,
        round: state.round,
        iou: parsed.data.iou,
        colorDifference: parsed.data.colorDifference ?? null,
        boundsRatioDifference: parsed.data.boundsRatioDifference ?? null,
        images: parsed.data.images,
        ...(parsed.data.emptyModel ? { emptyModel: true } : {}),
      };
      metrics.push(comparison.iou);
      if (comparison.colorDifference !== null) metrics.push(1 / (1 + comparison.colorDifference));
      if (comparison.boundsRatioDifference != null) metrics.push(1 / (1 + comparison.boundsRatioDifference));
      comparisons.push(comparison);
      report.comparisons.push(comparison);
      ref.iou = comparison.iou;
      yield { type: 'comparison', comparison };
    }
    const summaryData = (yield* execute('get_model_summary', {})).data;
    const summary = summarySchema.safeParse(summaryData);
    if (!summary.success) throw new Halt('error', 'host_result');
    report.partCount = summary.data.partCount;
    report.colorCount = summary.data.colorCount;
    const structure = z
      .object({
        models: z.array(
          z.object({
            id: z.string(),
            count: z.number(),
            children: z.array(z.object({ instanceId: z.string(), ref: z.object({ modelId: z.string() }) })),
          }),
        ),
      })
      .safeParse(summaryData);
    if (structure.success && lastRun) {
      const submodels = z
        .array(z.object({ name: z.string(), modelId: z.string() }))
        .safeParse(record(lastRun).submodels);
      const rootId = submodels.success ? submodels.data.find((m) => m.name === 'root')?.modelId : undefined;
      const root = structure.data.models.find((m) => m.id === rootId);
      report.components = report.components.map((component) => {
        const instance = root?.children.find((c) => c.ref.modelId === component.submodelId);
        const populated = structure.data.models.some((m) => m.id === component.submodelId && m.count > 0);
        return {
          ...component,
          modelPath: instance ? [instance.instanceId] : component.modelPath,
          checked: populated && !!instance,
        };
      });
    }
    if (!references.length && lastRun) {
      const bounds = z
        .array(
          z.object({
            name: z.string(),
            bounds: z
              .object({
                min: z.object({ x: z.number(), z: z.number(), level: z.number() }),
                max: z.object({ x: z.number(), z: z.number(), level: z.number() }),
              })
              .nullable(),
          }),
        )
        .safeParse(record(lastRun).submodels);
      if (bounds.success)
        for (const component of report.plan?.components ?? []) {
          const box = bounds.data.find((b) => b.name === component.id || b.name === component.name)?.bounds;
          if (box)
            metrics.push(
              ...[
                [box.max.x - box.min.x, component.size.width],
                [box.max.z - box.min.z, component.size.depth],
                [(box.max.level - box.min.level) / 2.5, component.size.height],
              ].map(([actual, planned]) => 1 / (1 + Math.abs(actual! - planned!) / planned!)),
            );
        }
    }
    const previous = report.rounds.at(-1);
    const round = {
      round: state.round,
      phase: state.phase,
      ...summary.data,
      images: renderImages.data,
      comparisons,
      issues: validation.data.issues,
      warnings: [...roundWarnings],
      summary: `Round ${state.round}: ${state.phase}; ${scriptRan ? 'script replaced' : 'review/structural adjustments'}; ${roundNote}; ${report.partCount} parts (delta ${report.partCount - (previous?.partCount ?? 0)}); IoU ${comparisons.map((c) => `${c.iou.toFixed(3)} (delta ${(c.iou - (previous?.comparisons.find((p) => p.referenceId === c.referenceId)?.iou ?? 0)).toFixed(3)})`).join(',') || 'n/a'}; ${validation.data.issues.length} issues.`,
    };
    report.rounds.push(round);
    yield { type: 'round', round: structuredClone(round), script: report.script };
    return metrics;
  }
  const completeComponents = () =>
    !!report.partCount &&
    report.components.length === report.plan?.components.length &&
    report.components.every((c) => c.checked);
  const blockingIssues = () =>
    report.validation.issues.filter(
      (i) => input.parts?.source === 'factory' || !['non_factory_part', 'non_factory_color'].includes(i.kind),
    );
  async function* run(): AsyncGenerator<WorkflowEvent> {
    startedRun = true;
    started = Date.now();
    if (state.paused) pausedAt = started;
    state.documentLocked = true;
    armDeadline();
    try {
      publish();
      yield { type: 'state', state: snapshot() };
      if (options.prepareReferenceImage) {
        const images = [];
        for (const ref of input.images ?? []) {
          await gate();
          images.push({ ...ref, image: await options.prepareReferenceImage(ref.image) });
        }
        modelInput = { ...input, images };
      }
      if (options.colors)
        paletteColorIds = normalizePlanColors(
          { name: '', components: [], buildOrder: [] },
          options.colors.palette,
          options.colors.catalog,
        ).paletteColorIds;
      let history: Message[] = [],
        plan: StructurePlan | null = null,
        repairs: string[] = [];
      let colorRepairs: ReturnType<typeof normalizePlanColors>['colorRepairs'] = [];
      let boxRepairs: ReturnType<typeof normalizePlanBoxes>['boxRepairs'] = [];
      let truncatedPlan = false;
      let colorRewriteRequested = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer: AgentResult = yield* modelTurn(
          attempt
            ? truncatedPlan
              ? 'Return a compact complete JSON plan.'
              : 'Repair the invalid plan. Return a complete JSON plan.'
            : 'Create the structure plan.',
          true,
          history,
        );
        // Accept editable geometry first; both entry paths normalize before strict confirmation.
        let parsed = parseStructurePlan(answer.text, estimateIds, true);
        truncatedPlan = answer.reason === 'max_tokens';
        if (parsed.ok && !truncatedPlan) {
          const formatRepairs = parsed.repairs;
          const legacyBoxRepairs = parsed.boxRepairs;
          const normalized = options.colors
            ? normalizePlanColors(parsed.plan, options.colors.palette, options.colors.catalog, colorRewriteRequested)
            : { plan: parsed.plan, colorRepairs: [], issues: [] };
          const boxes = normalizePlanBoxes(normalized.plan);
          // Direct start must retry invalid geometry, after arithmetic/color repairs.
          // Confirmation keeps editable geometry so the designer can correct it.
          parsed = normalized.issues.length
            ? { ok: false, issues: normalized.issues }
            : options.directStart
              ? parseStructurePlan(boxes.plan, estimateIds)
              : { ...parsed, plan: boxes.plan };
          if (normalized.issues.length) colorRewriteRequested = true;
          if (parsed.ok) {
            plan = parsed.plan;
            delete plan.viewOverrides;
            repairs = formatRepairs;
            colorRepairs = normalized.colorRepairs;
            boxRepairs = [...legacyBoxRepairs, ...boxes.boxRepairs];
            if ('paletteColorIds' in normalized) paletteColorIds = normalized.paletteColorIds;
            break;
          }
        }
        history = [
          ...retainedHistory(answer),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: truncatedPlan
                  ? 'The plan was truncated. Return a compact complete JSON plan.'
                  : JSON.stringify(parsed.ok ? [] : parsed.issues),
              },
            ],
          },
        ];
      }
      if (!plan)
        throw new Halt('error', truncatedPlan ? 'output_truncated' : 'invalid_plan', {
          stage: 'planning',
          attempts: 3,
          ...(truncatedPlan ? { agentReason: 'max_tokens' } : {}),
        });
      report.plan = plan;
      report.references = resolveReferenceViews(input, plan);
      state.awaitingConfirmation = !options.directStart;
      publish();
      yield {
        type: 'plan',
        plan: structuredClone(plan),
        repairs,
        colorRepairs,
        boxRepairs,
        ...(paletteColorIds ? { paletteColorIds } : {}),
      };
      await gate();
      if (confirmation) report.plan = confirmation;
      report.references = resolveReferenceViews(input, report.plan);
      state.awaitingConfirmation = false;
      yield* phase('preparing');
      await gate();
      budgetCheck();
      await options.host.beginTransaction(createI18n().t('imageModel.transaction'));
      transaction = true;
      state.documentLocked = true;
      publish();
      abortCheck();
      for (const [index, ref] of (input.images ?? []).entries()) {
        const resolved = report.references[index]!;
        const output = yield* execute('add_reference_image', {
          image: ref.image,
          name: ref.name,
          ...(resolved.view ? { view: resolved.view } : {}),
        });
        const data = record(output.data),
          referenceId = data.referenceId ?? data.id;
        if (typeof referenceId !== 'string' || !referenceId) throw new Halt('error', 'host_result');
        resolved.referenceId = referenceId;
      }
      const listed = (yield* execute('list_build_examples', {})).data;
      examples = options.matchingExamples?.(report.plan, listed) ?? listed;
      let previous: number[] | null = null,
        plateaus = 0,
        visualDone = false;
      let next: WorkflowState['phase'] = 'drafting';
      for (let round = 1; round <= roundLimit; round++) {
        state.round = round;
        yield* phase(next);
        scriptRan = false;
        roundWarnings.length = 0;
        const answer = yield* modelTurn('');
        roundNote = answer.text.replace(/\s+/g, ' ').slice(0, 240);
        const metrics = yield* inspectRound();
        const newAmendment = delivered !== interjections.length;
        plateaus =
          !newAmendment &&
          completeComponents() &&
          !report.rounds.at(-1)!.comparisons.some((c) => c.emptyModel) &&
          metricsPlateau(previous, metrics, options.improvementEpsilon)
            ? plateaus + 1
            : 0;
        previous = metrics;
        visualDone = plateaus >= 2;
        if (newAmendment) visualDone = false;
        if (next === 'buildability') {
          if (visualDone && !blockingIssues().length && completeComponents() && !newAmendment) break;
        } else if (next === 'detailing') {
          if (input.priority === 'appearance') {
            if (visualDone && !newAmendment) break;
            continue;
          }
          next = 'buildability';
        } else {
          const reserve = input.priority === 'appearance' ? 1 : 2;
          next = visualDone || round >= roundLimit - reserve ? 'detailing' : 'iterating';
        }
      }
      // Even a two-round budget enters the final check stage; repairs require remaining budget.
      if (input.priority !== 'appearance' && state.phase !== 'buildability') yield* phase('buildability');
      report.reason =
        visualDone &&
        completeComponents() &&
        delivered === interjections.length &&
        (input.priority === 'appearance' || !blockingIssues().length)
          ? 'completed'
          : 'round_budget';
    } catch (error) {
      report.reason =
        error instanceof Halt
          ? error.reason
          : signal.aborted
            ? deadline.signal.aborted
              ? 'time_budget'
              : 'user_stopped'
            : 'error';
      if (error instanceof Halt && error.code) report.unfinished.push({ code: error.code });
      if (report.reason === 'error' || (error instanceof Halt && error.failure))
        report.failure =
          error instanceof Halt && error.failure
            ? error.failure
            : {
                stage:
                  state.phase === 'understanding' ? 'planning' : state.phase === 'preparing' ? 'preparing' : 'round',
                ...(state.round ? { round: state.round } : {}),
              };
    } finally {
      clearTimeout(timer);
      if (pausedAt !== null) {
        pausedMs += Date.now() - pausedAt;
        pausedAt = null;
      }
      state.phase = transitionPhase(state.phase, 'finishing');
      state.paused = false;
      state.awaitingConfirmation = false;
      publish();
      if (transaction) {
        if (report.reason !== 'completed' && (report.partCount === null || report.colorCount === null)) {
          try {
            // Cleanup reads the working copy directly, even after cancellation or budget exhaustion.
            const output = await options.host.get_model_summary({});
            const summary = output.ok ? summarySchema.safeParse(output.data) : null;
            if (summary?.success) {
              report.partCount ??= summary.data.partCount;
              report.colorCount ??= summary.data.colorCount;
            }
          } catch {
            /* Missing counts must not replace the original failure or prevent commit. */
          }
        }
        try {
          await options.host.commitTransaction();
          report.transaction = 'committed';
        } catch {
          report.reason = 'error';
          report.transaction = 'commit_failed';
          report.unfinished.push({ code: 'commit_failed' });
          report.failure ??= {
            stage: state.round ? 'round' : 'preparing',
            ...(state.round ? { round: state.round } : {}),
          };
        }
      }
      for (const id of report.plan?.buildOrder ?? [])
        if (!report.components.some((c) => c.componentId === id && c.checked))
          report.unfinished.push({ code: 'component', componentId: id });
      if (!report.validation.checked) report.unfinished.push({ code: 'validation' });
      if (report.validation.issues.length) report.unfinished.push({ code: 'issues' });
      if (report.reason !== 'completed') report.unfinished.push({ code: 'assembly' });
      if (input.priority !== 'appearance' && blockingIssues().length) report.unfinished.push({ code: 'buildability' });
      if (report.partCount === null || report.colorCount === null) report.unfinished.push({ code: 'counts' });
      state.elapsedMs = elapsed();
      ended = true;
      state.documentLocked = report.transaction === 'commit_failed';
      report.elapsedMs = state.elapsedMs;
      report.toolCalls = state.toolCalls;
      report.summaryZh = summarizeImageModelReport(report);
      state.phase = transitionPhase(state.phase, 'finished');
      delete state.modelActivity;
      notify();
      resolveResult(structuredClone(report));
    }
    yield { type: 'finished', report: structuredClone(report) };
  }
  return {
    events: run(),
    result,
    getState: snapshot,
    pause() {
      if (!ended && !state.paused) {
        if (startedRun) pausedAt = Date.now();
        state.paused = true;
        clearTimeout(timer);
        notify();
      }
    },
    resume() {
      if (ended || !state.paused) return;
      if (pausedAt !== null) pausedMs += Date.now() - pausedAt;
      pausedAt = null;
      state.paused = false;
      armDeadline();
      notify();
    },
    stop() {
      control.abort();
      notify();
    },
    interject(text: string) {
      if (!ended && text.trim()) {
        interjections.push(text.trim());
        notify();
      }
    },
    confirmPlan(inputPlan: unknown = report.plan) {
      const parsed = parseStructurePlan(inputPlan);
      const allowedColors = paletteColorIds;
      if (parsed.ok) {
        if (
          allowedColors &&
          parsed.plan.components.some((component) => component.colors.some((id) => !allowedColors.includes(id)))
        )
          return {
            ok: false as const,
            issues: [{ path: 'components', message: 'Colors must belong to the task palette.' }],
          };
        const overrides = parsed.plan.viewOverrides ?? [];
        const ids = (input.images ?? []).map((_, index) => planningReferenceId(index));
        if (
          new Set(overrides.map((v) => v.referenceId)).size !== overrides.length ||
          overrides.some(
            (v) => !ids.includes(v.referenceId) || (input.viewMode === 'fixed' && !isStandardReferenceView(v.view)),
          )
        )
          return {
            ok: false as const,
            issues: [{ path: 'viewOverrides', message: 'Invalid reference view override.' }],
          };
        // Confidence belongs to the original model estimate; explicit designer choices use overrides.
        parsed.plan.viewEstimates = report.plan?.viewEstimates ?? [];
      }
      if (parsed.ok && state.awaitingConfirmation && !ended) {
        confirmation = parsed.plan;
        notify();
      }
      return parsed;
    },
  };
}
