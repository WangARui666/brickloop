import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runImageToModel,
  parseStructurePlan,
  metricsPlateau,
  transitionPhase,
  type StructurePlan,
  type ImageToModelOptions,
} from '../src/workflows/image-to-model/index.js';
import type { ChatEvent, ChatRequest, ImageBlock, ModelProvider, ToolCallBlock } from '../src/types.js';
import { collect, fakeHost, image, ok } from './helpers.js';
import { estimateInputTokens } from '../src/agent/history.js';
import { SUMMARY_PROMPT, SUMMARY_TEMPLATE } from '../src/agent/compaction.js';
import { DailyCostLedger } from '../src/cost.js';

const plan = (): StructurePlan => ({
  name: '汽车',
  components: ['body', 'wheels'].map((id) => ({
    id,
    name: id,
    size: { width: 6, depth: 4, height: 2 },
    colors: ['ld:4'],
    partTypes: ['brick'],
    connections: [],
  })),
  buildOrder: ['body', 'wheels'],
});
const call = (name: string, args: unknown = {}): ToolCallBlock => ({
  type: 'tool_call',
  id: crypto.randomUUID(),
  name,
  arguments: args,
});
const picture = (round: number, kind: string): ImageBlock => ({
  ...image,
  base64: Buffer.from(`${round}-${kind}`).toString('base64'),
});
function fixture() {
  const host = fakeHost(),
    requests: ChatRequest[] = [];
  const controls = {
    round: 0,
    code: '',
    queryLoop: false,
    invalidPlan: false,
    plan: null as StructurePlan | null,
    missingComponent: false,
    improving: false,
    noScript: false,
    patch: false,
  };
  let reference = 0;
  vi.mocked(host.add_reference_image).mockImplementation(async () => ok({ referenceId: `ref-${++reference}` }));
  vi.mocked(host.list_build_examples).mockResolvedValue(ok({ examples: [{ id: 'car' }] }));
  vi.mocked(host.get_build_example).mockImplementation(async () =>
    ok({ code: `example-from-round-${controls.round}` }),
  );
  vi.mocked(host.run_build_script).mockImplementation(async (args) => {
    controls.code = args.code ?? 'patched full source';
    return ok({
      stats: { parts: 1500, colors: 2 },
      warnings: [],
      submodels: (controls.missingComponent ? ['body'] : ['body', 'wheels']).map((name) => ({
        name,
        modelId: name,
        bounds: { min: { x: 0, z: 0, level: 0 }, max: { x: 6, z: 4, level: 5 } },
      })),
    });
  });
  vi.mocked(host.get_build_script).mockImplementation(async () => ok({ code: controls.code }));
  vi.mocked(host.validate).mockResolvedValue(ok({ issues: [] }));
  vi.mocked(host.render_views).mockImplementation(async () => ({
    ok: true,
    data: { images: [picture(controls.round, 'front'), picture(controls.round, 'iso')] },
    introducedIssues: [],
    warnings: [],
  }));
  vi.mocked(host.compare_to_reference).mockImplementation(async () => ({
    ok: true,
    data: {
      images: [image, picture(controls.round, 'comparison')],
      iou: controls.improving ? controls.round / 25 : 0.7,
      colorDifference: 3,
    },
    introducedIssues: [],
    warnings: [],
  }));
  vi.mocked(host.get_model_summary).mockResolvedValue(ok({ partCount: 1500, colorCount: 2 }));
  const provider: ModelProvider = {
    id: 'fake',
    billing: 'api',
    endpoint: 'http://127.0.0.1/fake',
    listModels: async () => [],
    capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
    async *stream(request): AsyncGenerator<ChatEvent> {
      requests.push(structuredClone({ ...request, tools: [] }));
      // Schemas are not cloneable, retain their references solely for token accounting.
      requests.at(-1)!.tools = request.tools;
      let text: string | undefined, toolCall: ToolCallBlock | undefined;
      const source = request.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (!request.tools.length) text = controls.invalidPlan ? '{}' : JSON.stringify(controls.plan ?? plan());
      else {
        controls.round = Number(source.match(/Script workflow round: (\d+)/)?.[1]);
        const results = request.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
        if (source.includes('tool-call budget has been exhausted')) text = '本轮查询已达上限';
        else if (controls.queryLoop) toolCall = call('list_colors');
        else if (!results.some((b) => b.name === 'get_build_example'))
          toolCall = call('get_build_example', { id: 'car' });
        else if (!controls.noScript && !results.some((b) => b.name === 'run_build_script'))
          toolCall = call('run_build_script', {
            scriptId: request.system.match(/Main scriptId: (\S+)/)![1],
            ...(controls.patch && controls.round === 2
              ? { patch: '@@ -1 +1 @@\n-old\n+new' }
              : { code: `// round-${controls.round}\nsubmodel('body',()=>{});` }),
          });
        else text = '已更新全部部件';
      }
      if (toolCall) yield { type: 'tool_call', call: toolCall };
      else yield { type: 'text_delta', text: text! };
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 50, cacheReadInputTokens: 0 } };
      yield { type: 'done', reason: toolCall ? 'tool_calls' : 'stop' };
    },
  };
  const options: ImageToModelOptions = {
    provider,
    host,
    model: 'test',
    directStart: true,
    input: { description: '红色汽车', images: [{ name: 'front', image, view: 'front' }] },
  };
  return { host, requests, controls, provider, options };
}
async function finish(options: ImageToModelOptions) {
  const task = runImageToModel(options);
  const events = await collect(task.events);
  return { report: await task.result, events, task };
}
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network prohibited');
    }),
  ),
);

it.each([false, true])('returns colour validation once and then uses model rewrite/fallback=%s', async (fallback) => {
  const f = fixture();
  const palette = [
    { id: 'c:bright-green', legoName: 'Bright Green', rgb: '#4b9f4a' },
    { id: 'c:transparent-blue', legoName: 'Transparent Blue', rgb: '#0020a0', alpha: 0.5 },
  ];
  const catalog = [
    ...palette,
    { id: 'c:transparent-light-blue', legoName: 'Transparent Light Blue', rgb: '#90d0ff', alpha: 0.5 },
  ];
  f.controls.plan = plan();
  for (const component of f.controls.plan.components) component.colors = ['c:bright-green'];
  f.controls.plan.components[0]!.colors = ['c:nonexistent', 'Bright Green', 'transparent-light-blue'];
  const stream = f.provider.stream;
  let attempts = 0;
  f.provider.stream = (request, signal) => {
    if (!request.tools.length && attempts++ === 1 && !fallback)
      f.controls.plan!.components[0]!.colors = ['c:bright-green', 'c:transparent-blue'];
    return stream(request, signal);
  };
  const { report, events } = await finish({ ...f.options, colors: { palette, catalog } });
  const planning = f.requests.filter((request) => !request.tools.length);
  expect(planning).toHaveLength(2);
  expect(planning[0]!.system).toContain('Allowed palette colour IDs: ["c:bright-green","c:transparent-blue"]');
  const second = JSON.stringify(planning[1]!.messages);
  expect(second).toContain('components.0.colors.0');
  expect(second).toContain('Component body: colour');
  expect(second).toContain('c:nonexistent');
  expect(second).toContain('transparent-light-blue');
  expect(second).toContain('Allowed palette colour IDs');
  expect(second).toContain('c:transparent-blue');
  expect(report.reason).toBe('completed');
  expect(report.plan!.components[0]!.colors).toEqual(['c:bright-green', 'c:transparent-blue']);
  const event = events.find((event) => event.type === 'plan');
  expect(event?.type).toBe('plan');
  if (event?.type === 'plan')
    expect(event.colorRepairs).toEqual(
      fallback
        ? [
            { componentId: 'body', from: 'c:nonexistent', to: null },
            { componentId: 'body', from: 'Bright Green', to: 'c:bright-green' },
            { componentId: 'body', from: 'transparent-light-blue', to: 'c:transparent-blue' },
          ]
        : [],
    );
});

it('prepares each reference once, reuses it during planning retries and building, and stores originals', async () => {
  const f = fixture();
  f.controls.plan = plan();
  for (const component of f.controls.plan.components) component.colors = ['c:nonexistent'];
  const prepareReferenceImage = vi.fn((original: ImageBlock) => ({ ...original, base64: 'c2NhbGVk' }));
  const { report } = await finish({
    ...f.options,
    prepareReferenceImage,
    colors: { palette: [{ id: 'c:red', legoName: 'Red', rgb: '#ff0000' }], catalog: [] },
  });
  expect(report.reason).toBe('completed');
  expect(prepareReferenceImage).toHaveBeenCalledExactlyOnceWith(image);
  for (const request of f.requests.slice(0, 5)) {
    const pictures = request.messages.flatMap((message) => message.content).filter((block) => block.type === 'image');
    expect(pictures.length).toBeGreaterThan(0);
    expect(pictures.every((picture) => picture.base64 === 'c2NhbGVk')).toBe(true);
  }
  expect(f.host.add_reference_image).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ image }));
  expect(f.options.input.images![0]!.image).toEqual(image);
});

it.each([false, true])('normalizes plan events and build prompts with directStart=%s', async (directStart) => {
  const f = fixture();
  f.controls.plan = plan();
  f.controls.plan.components[0]!.colors = ['bright-green', 'Dark Green', 'foo'];
  const palette = [
    { id: 'c:bright-green', legoName: 'Bright Green', rgb: '#4B9F4A' },
    { id: 'c:dark-green', legoName: 'Dark Green', rgb: '#00852B' },
  ];
  const task = runImageToModel({ ...f.options, directStart, colors: { palette, catalog: palette } });
  for await (const event of task.events)
    if (event.type === 'plan') {
      expect(event.plan.components[0]!.colors).toEqual(['c:bright-green', 'c:dark-green']);
      expect(event.colorRepairs.slice(0, 3)).toEqual([
        { componentId: 'body', from: 'bright-green', to: 'c:bright-green' },
        { componentId: 'body', from: 'Dark Green', to: 'c:dark-green' },
        { componentId: 'body', from: 'foo', to: null },
      ]);
      expect(event.paletteColorIds).toEqual(palette.map((c) => c.id));
      if (!directStart) {
        const outside = structuredClone(event.plan);
        outside.components[0]!.colors = ['outside'];
        expect(task.confirmPlan(outside).ok).toBe(false);
        expect(task.confirmPlan(event.plan).ok).toBe(true);
      }
    }
  const report = await task.result;
  expect(report.reason).toBe('completed');
  expect(report.plan!.components[0]!.colors).toEqual(['c:bright-green', 'c:dark-green']);
  const build = f.requests.find((r) => r.tools.length)!;
  expect(JSON.stringify(build.messages)).toContain('c:bright-green');
  expect(JSON.stringify(build.messages)).not.toContain('foo');
});

it.each([false, true])('keeps zero-size plans editable only when directStart=%s is false', async (directStart) => {
  const f = fixture();
  f.controls.plan = plan();
  f.controls.plan.components[0]!.size.width = 0;
  const task = runImageToModel({ ...f.options, directStart });
  let reviewed = false;
  for await (const event of task.events)
    if (event.type === 'plan') {
      reviewed = true;
      expect(task.confirmPlan(event.plan).ok).toBe(false);
      event.plan.components[0]!.size.width = 6;
      event.plan.components[0]!.boundingBox!.max.x = 6;
      expect(task.confirmPlan(event.plan).ok).toBe(true);
    }
  expect(reviewed).toBe(!directStart);
  expect((await task.result).reason).toBe(directStart ? 'error' : 'completed');
  if (directStart) expect(f.host.beginTransaction).not.toHaveBeenCalled();
});

it('retries a zero-size direct-start plan with strict issues and uses the repaired second plan', async () => {
  const f = fixture();
  const invalid = plan(),
    valid = plan();
  invalid.components[0]!.size.width = 0;
  valid.name = 'Repaired plan';
  let planning = 0;
  const original = f.provider.stream.bind(f.provider);
  f.provider.stream = async function* (request, signal) {
    if (!request.tools.length) f.controls.plan = planning++ === 0 ? invalid : valid;
    yield* original(request, signal);
  };
  const { report, events } = await finish(f.options);
  const requests = f.requests.filter((request) => !request.tools.length);
  expect(requests).toHaveLength(2);
  const repairRequest = JSON.stringify(requests[1]!.messages);
  expect(repairRequest).toContain('Repair the invalid plan. Return a complete JSON plan.');
  expect(repairRequest).toContain('components.0.size.width');
  expect(report.reason).toBe('completed');
  expect(report.plan).toMatchObject({
    name: valid.name,
    components: [{ size: valid.components[0]!.size }, { size: valid.components[1]!.size }],
  });
  expect(events.filter((event) => event.type === 'plan')).toHaveLength(1);
  expect(JSON.stringify(f.requests.find((request) => request.tools.length)!.messages)).toContain(valid.name);
  expect(f.host.beginTransaction).toHaveBeenCalledTimes(1);
});

it('normalizes a box-only mismatch before strict direct-start validation without a repair request', async () => {
  const f = fixture();
  f.controls.plan = plan();
  const from = { min: { x: -2, y: 1, z: 3 }, max: { x: 99, y: 99, z: 99 } };
  const to = { min: from.min, max: { x: 4, y: 3, z: 7 } };
  f.controls.plan.components[0]!.boundingBox = from;
  const { report, events } = await finish(f.options);
  expect(f.requests.filter((request) => !request.tools.length)).toHaveLength(1);
  expect(JSON.stringify(f.requests.map((request) => request.messages))).not.toContain('Repair the invalid plan');
  expect(report.reason).toBe('completed');
  expect(report.plan!.components[0]!.boundingBox).toEqual(to);
  const event = events.find((event) => event.type === 'plan');
  expect(event).toMatchObject({ boxRepairs: [{ componentId: 'body', from, to }], colorRepairs: [] });
});

it.each([0, -1, undefined, 'invalid'])(
  'reports three failed direct-start plan attempts for width %s',
  async (width) => {
    const f = fixture();
    f.controls.plan = plan();
    f.controls.plan.components[0]!.size.width = width as number;
    const { report, events } = await finish(f.options);
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests.slice(1)) {
      const text = JSON.stringify(request.messages);
      expect(text).toContain('Repair the invalid plan. Return a complete JSON plan.');
      expect(text).toContain('components.0.size.width');
    }
    expect(report).toMatchObject({ reason: 'error', plan: null, failure: { stage: 'planning', attempts: 3 } });
    expect(report.unfinished).toContainEqual({ code: 'invalid_plan' });
    expect(events.some((event) => event.type === 'plan')).toBe(false);
    expect(f.host.beginTransaction).not.toHaveBeenCalled();
  },
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('v2 plan and state', () => {
  it('normalizes old plans and retains explicit boxes, categories and strategies', () => {
    const old = parseStructurePlan(plan());
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.plan.components[0]).toMatchObject({
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 4 } },
      strategy: 'shapes',
    });
    const component = {
      ...old.plan.components[0]!,
      category: 'plants',
      strategy: 'parts',
      boundingBox: { min: { x: -2, y: 1, z: 0 }, max: { x: 4, y: 3, z: 4 } },
    };
    expect(parseStructurePlan({ ...plan(), components: [component, old.plan.components[1]] })).toMatchObject({
      ok: true,
      plan: { components: [component, old.plan.components[1]] },
    });
    for (const update of [
      { category: 'bad' },
      { strategy: 'invalid' },
      { boundingBox: { min: { x: 'invalid', y: 0, z: 0 }, max: { x: 0, y: 1, z: 1 } } },
    ])
      expect(
        parseStructurePlan({ ...plan(), components: [{ ...component, ...update }, old.plan.components[1]] }).ok,
      ).toBe(false);
  });
  it('repairs fenced JSON, numeric size strings, singleton lists and absent order; rejects bad references', () => {
    const value = {
      ...plan(),
      buildOrder: undefined,
      components: [
        { ...plan().components[0], size: { width: '6', depth: '4', height: '2' }, colors: 'ld:4', partTypes: 'brick' },
      ],
    };
    const parsed = parseStructurePlan('```json\n' + JSON.stringify({ plan: value }) + '\n```');
    expect(parsed).toMatchObject({
      ok: true,
      plan: { buildOrder: ['body'], components: [{ size: { width: 6, depth: 4, height: 2 } }] },
    });
    for (const bad of [
      '{',
      {},
      { ...plan(), buildOrder: ['missing'] },
      { ...plan(), components: [plan().components[0], plan().components[0]] },
      {
        ...plan(),
        components: [{ ...plan().components[0], connections: [{ target: 'missing', description: 'bad' }] }],
      },
    ])
      expect(parseStructurePlan(bad).ok).toBe(false);
  });
  it('repairs missing, duplicate and malformed view estimates, including legacy unknown', () => {
    const estimate = { referenceId: 'reference-1', view: 'front', confidence: 0.9, reason: '正面' };
    expect(parseStructurePlan({ ...plan(), viewEstimates: [estimate] }, ['reference-1'])).toMatchObject({
      ok: true,
      plan: { viewEstimates: [estimate] },
    });
    for (const values of [
      undefined,
      null,
      [],
      [estimate, estimate],
      [{ ...estimate, view: 'unknown' }],
      [{ ...estimate, confidence: 2 }],
      [{ ...estimate, reason: undefined }],
    ])
      expect(parseStructurePlan({ ...plan(), viewEstimates: values }, ['reference-1'])).toMatchObject({
        ok: true,
        plan: { viewEstimates: [{ view: 'none', confidence: 0 }] },
      });
    expect(
      parseStructurePlan({ ...plan(), viewOverrides: [{ referenceId: 'reference-1', view: 'unknown' }] }),
    ).toMatchObject({ ok: true, plan: { viewOverrides: [{ view: 'auto' }] } });
  });
  it('allows the seven stages and separates visual plateau from validation', () => {
    const phases = [
      'understanding',
      'preparing',
      'drafting',
      'iterating',
      'detailing',
      'buildability',
      'finishing',
      'finished',
    ] as const;
    for (let i = 1; i < phases.length; i++) expect(transitionPhase(phases[i - 1]!, phases[i]!)).toBe(phases[i]);
    expect(() => transitionPhase('preparing', 'detailing')).toThrow();
    expect(metricsPlateau([0.7], [0.704])).toBe(true);
    expect(metricsPlateau([0.7], [0.8])).toBe(false);
    expect(metricsPlateau(null, [])).toBe(false);
    expect(metricsPlateau([0.7], [NaN])).toBe(false);
  });
});
describe('script workflow with offline provider', () => {
  it('reads back complete source after a patch and sends it in the next round', async () => {
    const f = fixture();
    f.controls.patch = true;
    const { report } = await finish(f.options);
    expect(report.reason).toBe('completed');
    expect(vi.mocked(f.host.run_build_script).mock.calls[1]?.[0].patch).toBeDefined();
    const third = f.requests.find((r) => JSON.stringify(r.messages).includes('Script workflow round: 3'));
    expect(JSON.stringify(third?.messages)).toContain('patched full source');
    expect(JSON.stringify(third?.messages)).not.toContain('@@ -1');
  });
  it('rejects other script identities and add mode without mutating the host', async () => {
    for (const change of [{ scriptId: 'other' }, { mode: 'add' }]) {
      const f = fixture();
      const provider: ModelProvider = {
        ...f.provider,
        async *stream(request, signal) {
          for await (const e of f.provider.stream(request, signal)) {
            if (e.type === 'tool_call' && e.call.name === 'run_build_script')
              yield { ...e, call: { ...e.call, arguments: { ...(e.call.arguments as object), ...change } } };
            else yield e;
          }
        },
      };
      const { report } = await finish({ ...f.options, provider });
      expect(report.reason).toBe('round_budget');
      expect(f.host.run_build_script).not.toHaveBeenCalled();
      expect(JSON.stringify(f.requests)).toContain('WORKFLOW_SCRIPT');
    }
  });
  it('keeps large validation feedback intact when the model window can hold it', async () => {
    const f = fixture();
    f.provider.capabilities = () => ({
      vision: true,
      tools: true,
      reasoning: false,
      maxContext: 1000000,
      contextWindow: 1000000,
    });
    vi.mocked(f.host.validate).mockResolvedValue(
      ok({
        issues: Array.from({ length: 3000 }, (_, i) => ({
          kind: 'collision',
          instanceId: `collision-${i}`,
          paths: [[`part-${i}`]],
          data: 'detail'.repeat(100),
        })),
      }),
    );
    const { report } = await finish({
      ...f.options,
      input: { ...f.options.input, priority: 'appearance' },
    });
    expect(report.reason).toBe('completed');
    expect(report.validation.issues).toHaveLength(3000);
    expect(f.requests.every((r) => estimateInputTokens(r.system, r.messages, r.tools) <= 850000)).toBe(true);
    expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('collision-2999');
    expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain('contextTruncation');
  });
  it('runs draft → two plateau rounds → detail → buildability in one transaction with reference + isometric renders', async () => {
    const f = fixture();
    const { report, events } = await finish(f.options);
    expect(report.reason).toBe('completed');
    expect(report.rounds.map((r) => r.phase)).toEqual([
      'drafting',
      'iterating',
      'iterating',
      'detailing',
      'buildability',
    ]);
    expect(report.rounds.map((r) => r.partCount)).toEqual([1500, 1500, 1500, 1500, 1500]);
    expect(report.script?.code).toContain('round-5');
    expect(report.components).toHaveLength(2);
    expect(report.validation).toEqual({ checked: true, issues: [] });
    expect(report.unfinished).toEqual([]);
    expect(f.host.beginTransaction).toHaveBeenCalledTimes(1);
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    expect(f.host.render_views).toHaveBeenCalledTimes(5);
    expect(f.host.get_model_summary).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(f.host.render_views)
        .mock.calls.every(([args]) => args.views.includes('front') && args.views.includes('isometric')),
    ).toBe(true);
    expect(events.filter((e) => e.type === 'round')).toHaveLength(5);
    expect(report.summaryZh).toContain('第 5 轮：1500 件');
  });
  it('CTX-01: 20 workflow rounds rebuild requests from current script, latest images and short summaries; no old tool history', async () => {
    const f = fixture();
    f.controls.improving = true;
    const { report } = await finish({ ...f.options, budget: { rounds: 20, inputTokens: 40000 } });
    expect(report.rounds).toHaveLength(20);
    expect(report.reason).toBe('round_budget');
    const starts = f.requests.filter((r) => r.tools.length && r.messages.every((m) => m.role === 'user'));
    expect(starts).toHaveLength(20);
    for (const [i, request] of starts.entries()) {
      const encoded = JSON.stringify(request.messages);
      expect(request.messages).toHaveLength(1);
      expect(encoded).not.toContain('tool_call');
      expect(encoded).not.toContain('tool_result');
      expect(encoded).not.toContain('example-from-round-');
      const images = request.messages.flatMap((m) => m.content).filter((b) => b.type === 'image');
      expect(images).toEqual(
        i === 0 ? [image] : [picture(i, 'front'), picture(i, 'iso'), image, picture(i, 'comparison')],
      );
      if (i) expect(encoded).toContain(`// round-${i}`);
      for (let old = 1; old < i; old++) expect(encoded).not.toContain(picture(old, 'front').base64);
    }
    for (const r of f.requests) expect(estimateInputTokens(r.system, r.messages, r.tools)).toBeLessThanOrEqual(40000);
  });
  it('injects guidance from the designer-confirmed categories before metering, with matched examples before drafting', async () => {
    const f = fixture();
    const guides = vi.fn((p: StructurePlan) => `guide:${p.components[0]?.category}`);
    const task = runImageToModel({
      ...f.options,
      directStart: false,
      designGuides: guides,
      matchingExamples: () => [{ id: 'trees' }],
    });
    for await (const e of task.events)
      if (e.type === 'plan')
        task.confirmPlan({ ...e.plan, components: e.plan.components.map((c) => ({ ...c, category: 'plants' })) });
    expect((await task.result).reason).toBe('completed');
    expect(f.requests.slice(1).every((r) => r.system.includes('guide:plants'))).toBe(true);
    expect(JSON.stringify(f.requests[1]?.messages)).toContain('trees');
    const denied = fixture();
    await finish({ ...denied.options, designGuides: () => 'huge '.repeat(100000), budget: { inputTokens: 20000 } });
    expect(denied.requests).toHaveLength(1);
  });
  it('defers collisions through iterations and details; appearance skips repair while retaining issues', async () => {
    for (const priority of ['appearance', 'buildable'] as const) {
      const f = fixture();
      vi.mocked(f.host.validate).mockImplementation(async () =>
        ok({ issues: f.controls.round >= 5 ? [] : [{ kind: 'collision' }, { kind: 'floating' }] }),
      );
      const { report } = await finish({ ...f.options, input: { ...f.options.input, priority } });
      expect(report.reason).toBe('completed');
      expect(report.rounds.slice(0, 4).every((r) => r.issues.length === 2)).toBe(true);
      expect(report.rounds.at(-1)?.phase).toBe(priority === 'appearance' ? 'detailing' : 'buildability');
      expect(report.buildabilitySkipped).toBe(priority === 'appearance');
      expect(report.validation.issues).toHaveLength(priority === 'appearance' ? 2 : 0);
    }
  });
  it('requests all parts during concept rounds and factory scope only during final factory repair', async () => {
    const f = fixture();
    await finish({ ...f.options, input: { ...f.options.input, parts: { source: 'factory' } } });
    expect(vi.mocked(f.host.run_build_script).mock.calls.map(([args]) => args.scope)).toEqual([
      'all',
      'all',
      'all',
      'all',
      'factory',
    ]);
  });
  it('does not accept plateau with missing components or an empty model; keeps final buildability issues unfinished', async () => {
    for (const mode of ['missing', 'empty', 'issues'] as const) {
      const f = fixture();
      if (mode === 'missing') f.controls.missingComponent = true;
      if (mode === 'empty') vi.mocked(f.host.get_model_summary).mockResolvedValue(ok({ partCount: 0, colorCount: 0 }));
      if (mode === 'issues') vi.mocked(f.host.validate).mockResolvedValue(ok({ issues: [{ kind: 'collision' }] }));
      const { report } = await finish(f.options);
      expect(report.reason).toBe('round_budget');
      expect(report.unfinished.length).toBeGreaterThan(0);
    }
  });
  it('limits a query loop to 12 calls per round and accounts automatic tools against IMG-04 global limit 30', async () => {
    const f = fixture();
    f.controls.queryLoop = true;
    const { report } = await finish({ ...f.options, budget: { toolCalls: 30 } });
    expect(report.reason).toBe('tool_budget');
    expect(report.toolCalls).toBe(30);
    expect(report.rounds[0]?.warnings).toContain('round_tool_limit');
    expect(f.host.list_colors).toHaveBeenCalledTimes(24);
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    expect(report.unfinished).toContainEqual({ code: 'component', componentId: 'body' });
  });
  it('uses amendments only from the next round, including those inserted while paused', async () => {
    const f = fixture();
    const task = runImageToModel(f.options);
    let inserted = false;
    for await (const e of task.events)
      if (
        !inserted &&
        e.type === 'agent' &&
        e.event.type === 'tool_call' &&
        e.event.call.name === 'get_build_example'
      ) {
        inserted = true;
        task.pause();
        task.interject('改用蓝色');
        expect(f.host.get_build_example).not.toHaveBeenCalled();
        task.resume();
      }
    expect((await task.result).reason).toBe('completed');
    const rounds = f.requests.filter((r) => r.tools.length);
    expect(
      rounds
        .filter((r) => JSON.stringify(r.messages).includes('Script workflow round: 1'))
        .every((r) => !JSON.stringify(r.messages).includes('改用蓝色')),
    ).toBe(true);
    expect(
      rounds
        .filter((r) => JSON.stringify(r.messages).includes('Script workflow round: 2'))
        .every((r) => JSON.stringify(r.messages).includes('改用蓝色')),
    ).toBe(true);
  });
  it('charges oversized amendments before the next round request', async () => {
    const f = fixture();
    const task = runImageToModel(f.options);
    for await (const e of task.events)
      if (e.type === 'round' && e.round.round === 1) task.interject('修改要求'.repeat(30000));
    expect((await task.result).reason).toBe('input_budget');
    expect(f.host.run_build_script).toHaveBeenCalledTimes(1);
  });
  it('pause blocks pending work; stop releases the gate and commits once', async () => {
    const f = fixture();
    const task = runImageToModel(f.options);
    for (;;) {
      const next = await task.events.next();
      if (next.value?.type === 'state' && next.value.state.phase === 'drafting') break;
    }
    task.pause();
    let resolved = false;
    const pending = task.events.next().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    task.stop();
    await pending;
    await collect(task.events);
    expect((await task.result).reason).toBe('user_stopped');
    expect(f.requests).toHaveLength(1);
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
  });
  it('halts immediately on an unavailable engine without retrying or inspecting an empty model', async () => {
    const f = fixture();
    vi.mocked(f.host.run_build_script).mockResolvedValue({
      ok: false,
      code: 'ENGINE_UNAVAILABLE',
      message: 'WASM blocked',
    });
    const { report, events } = await finish(f.options);
    expect(report.reason).toBe('engine_unavailable');
    expect(report.rounds).toHaveLength(0);
    expect(f.host.run_build_script).toHaveBeenCalledTimes(1);
    expect(f.host.validate).not.toHaveBeenCalled();
    expect(f.host.render_views).not.toHaveBeenCalled();
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    expect(
      events.some(
        (e) =>
          e.type === 'agent' &&
          e.event.type === 'tool_result' &&
          !e.event.result.ok &&
          e.event.result.code === 'ENGINE_UNAVAILABLE',
      ),
    ).toBe(true);
    expect(report.summaryZh).toContain('搭建引擎无法启动');
  });
  it('freezes elapsed time and the deadline during repeated pauses, even inside a model turn', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let pausedOnce = false;
    const provider: ModelProvider = {
      ...f.provider,
      async *stream(request, signal) {
        if (request.tools.length && !pausedOnce) {
          pausedOnce = true;
          task.pause();
        }
        yield* f.provider.stream(request, signal);
      },
    };
    const task = runImageToModel({ ...f.options, provider, budget: { durationMs: 100 } });
    const consuming = collect(task.events);
    await vi.advanceTimersByTimeAsync(20);
    expect(task.getState().paused).toBe(true);
    const frozen = task.getState().elapsedMs;
    task.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task.getState().elapsedMs).toBe(frozen);
    expect(f.host.run_build_script).not.toHaveBeenCalled();
    task.resume();
    task.resume();
    await consuming;
    expect((await task.result).reason).toBe('completed');
    expect((await task.result).elapsedMs).toBeLessThan(100);
  });
  it('resumes with only the remaining active time and still aborts streaming at its budget', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const provider: ModelProvider = {
      ...f.provider,
      async *stream(_request, signal) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'done', reason: 'cancelled' };
      },
    };
    const task = runImageToModel({ ...f.options, provider, budget: { durationMs: 100 } });
    const consuming = collect(task.events);
    await vi.advanceTimersByTimeAsync(30);
    task.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task.getState().elapsedMs).toBe(30);
    task.resume();
    await vi.advanceTimersByTimeAsync(40);
    task.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task.getState().elapsedMs).toBe(70);
    task.resume();
    await vi.advanceTimersByTimeAsync(31);
    await consuming;
    expect((await task.result).reason).toBe('time_budget');
    expect((await task.result).elapsedMs).toBe(100);
  });
  it('stopping an atomic script waits for it before committing', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    vi.mocked(f.host.run_build_script).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok({ submodels: [] });
    });
    const task = runImageToModel(f.options);
    const consuming = collect(task.events);
    await vi.waitFor(() => expect(release).toBeDefined());
    task.stop();
    expect(f.host.commitTransaction).not.toHaveBeenCalled();
    release?.();
    await consuming;
    expect((await task.result).reason).toBe('user_stopped');
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    expect(f.host.validate).not.toHaveBeenCalled();
  });
  it.each(['error', 'user_stopped', 'time_budget'] as const)(
    'refreshes counts once after a second-round script ends with %s',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      let failed = false,
        requestsAtStop = 0;
      const provider: ModelProvider = {
        ...f.provider,
        async *stream(request, signal) {
          if (failed)
            yield {
              type: 'error',
              error: { category: 'quota_exceeded', status: 402, message: 'Insufficient Balance' },
            };
          else yield* f.provider.stream(request, signal);
        },
      };
      const stream = vi.spyOn(provider, 'stream');
      const task = runImageToModel({ ...f.options, provider, budget: { durationMs: 1000 } });
      for await (const e of task.events) {
        if (
          e.type === 'agent' &&
          e.event.type === 'tool_result' &&
          e.event.call.name === 'run_build_script' &&
          e.event.result.ok &&
          f.controls.round === 2
        ) {
          failed = true;
          requestsAtStop = stream.mock.calls.length;
          vi.mocked(f.host.get_model_summary).mockResolvedValue(ok({ partCount: 1600, colorCount: 3 }));
          if (reason === 'user_stopped') task.stop();
          if (reason === 'time_budget') vi.setSystemTime(Date.now() + 1001);
        }
      }
      const report = await task.result;
      expect(report).toMatchObject({ reason, partCount: 1600, colorCount: 3, transaction: 'committed' });
      expect(report.rounds).toHaveLength(1);
      expect(report.rounds[0]?.partCount).toBe(1500);
      expect(report.unfinished).not.toContainEqual({ code: 'counts' });
      expect(report.summaryZh).toContain('1600');
      expect(f.host.get_model_summary).toHaveBeenCalledTimes(2);
      expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(requestsAtStop + (reason === 'error' ? 1 : 0));
      if (reason === 'error') expect(report.failure?.error).toMatchObject({ category: 'quota_exceeded', status: 402 });
    },
  );
  it.each(['throws', 'error', 'malformed'] as const)(
    'preserves the original failure when final counts %s',
    async (mode) => {
      const f = fixture();
      const summary = vi.mocked(f.host.get_model_summary);
      if (mode === 'throws') summary.mockRejectedValue(new Error('summary failed'));
      else
        summary.mockResolvedValue(
          mode === 'error'
            ? { ok: false, code: 'HOST_ERROR', message: 'summary failed' }
            : ok({ partCount: -1, colorCount: 'unknown' }),
        );
      const error = { category: 'quota_exceeded' as const, status: 402, message: 'Insufficient Balance' };
      const provider: ModelProvider = {
        ...f.provider,
        async *stream(request, signal) {
          if (vi.mocked(f.host.run_build_script).mock.calls.length) yield { type: 'error', error };
          else yield* f.provider.stream(request, signal);
        },
      };
      const { report } = await finish({ ...f.options, provider });
      expect(report).toMatchObject({
        reason: 'error',
        partCount: null,
        colorCount: null,
        transaction: 'committed',
        failure: { stage: 'round', round: 1, attempts: 1, error: { category: 'quota_exceeded', status: 402 } },
      });
      expect(report.unfinished).toContainEqual({ code: 'counts' });
      expect(report.unfinished).toContainEqual({ code: 'provider_error' });
      expect(summary).toHaveBeenCalledTimes(1);
      expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps existing counts when stopped after a fully inspected round', async () => {
    const f = fixture();
    const task = runImageToModel(f.options);
    for await (const e of task.events) if (e.type === 'round') task.stop();
    expect(await task.result).toMatchObject({ reason: 'user_stopped', partCount: 1500, colorCount: 2 });
    expect(f.host.get_model_summary).toHaveBeenCalledTimes(1);
  });
  it('zero budget and cancelled confirmation never open a transaction; bad plans retry without mutation', async () => {
    const f = fixture();
    expect((await finish({ ...f.options, budget: { toolCalls: 0 } })).report.reason).toBe('tool_budget');
    expect(f.requests).toHaveLength(0);
    const task = runImageToModel({ ...f.options, directStart: false });
    for await (const e of task.events) if (e.type === 'plan') task.stop();
    expect((await task.result).reason).toBe('user_stopped');
    expect(f.host.beginTransaction).not.toHaveBeenCalled();
    f.controls.invalidPlan = true;
    expect((await finish(f.options)).report.unfinished).toContainEqual({ code: 'invalid_plan' });
    expect(f.host.beginTransaction).not.toHaveBeenCalled();
    expect(f.host.get_model_summary).not.toHaveBeenCalled();
  });
  it('consumer break and failed commit close the transaction exactly once', async () => {
    const f = fixture();
    const task = runImageToModel(f.options);
    for await (const e of task.events) if (e.type === 'state' && e.state.phase === 'drafting') break;
    expect((await task.result).reason).toBe('user_stopped');
    expect(f.host.commitTransaction).toHaveBeenCalledTimes(1);
    const bad = fixture();
    vi.mocked(bad.host.commitTransaction).mockRejectedValue(new Error('disk'));
    const done = await finish(bad.options);
    expect(done.report.transaction).toBe('commit_failed');
    expect(done.task.getState().documentLocked).toBe(true);
  });
  it('aborts streaming at the duration limit and respects daily cost before work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const provider: ModelProvider = {
      ...f.provider,
      async *stream(_request, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
        yield { type: 'done', reason: 'cancelled' };
      },
    };
    const pending = finish({ ...f.options, provider, budget: { durationMs: 50 } });
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).report.reason).toBe('time_budget');
    vi.useRealTimers();
    const ledger = new DailyCostLedger();
    ledger.add(1);
    const result = await finish({
      ...f.options,
      ledger,
      prices: { currency: 'USD', providers: { fake: { test: { input: 1, output: 1, cacheRead: 0 } } } },
      budget: { dailyCostLimit: 0 },
    });
    expect(result.report.reason).toBe('daily_cost_limit');
    expect(f.host.beginTransaction).not.toHaveBeenCalled();
  });
  it('rejects malformed validation and round budgets', async () => {
    const f = fixture();
    vi.mocked(f.host.validate).mockResolvedValue(ok({}));
    expect((await finish(f.options)).report.reason).toBe('error');
    for (const rounds of [1, 21, 2.5, NaN])
      expect(() => runImageToModel({ ...f.options, budget: { rounds } })).toThrow('round budget');
  });
  it('old unknown views have no inferred fallback; fixed views retain designer priority', async () => {
    const f = fixture();
    const { report } = await finish({ ...f.options, input: { images: [{ name: 'legacy', image, view: 'unknown' }] } });
    expect(report.reason).toBe('completed');
    expect(report.references[0]?.view).toBeNull();
    expect(f.host.compare_to_reference).not.toHaveBeenCalled();
    expect(f.host.render_views).toHaveBeenCalled();
    const fixed = fixture();
    const done = await finish({ ...fixed.options, input: { ...fixed.options.input, viewMode: 'fixed' } });
    expect(done.report.references[0]?.source).toBe('designer');
    expect(fixed.requests[0]?.system).toContain('Do not estimate views');
    for (const view of ['auto', 'unknown', 'exclude'] as const)
      expect(() =>
        runImageToModel({ ...fixed.options, input: { viewMode: 'fixed', images: [{ name: 'image', image, view }] } }),
      ).toThrow('Fixed mode');
  });
  it('confirmation accepts view overrides, rejects missing IDs and duplicate overrides', async () => {
    const f = fixture();
    const task = runImageToModel({ ...f.options, directStart: false });
    for await (const e of task.events)
      if (e.type === 'plan') {
        expect(task.confirmPlan({ ...e.plan, viewOverrides: [{ referenceId: 'bad', view: 'top' }] }).ok).toBe(false);
        expect(
          task.confirmPlan({
            ...e.plan,
            viewOverrides: [1, 2].map(() => ({ referenceId: 'reference-1', view: 'top' })),
          }).ok,
        ).toBe(false);
        expect(task.confirmPlan({ ...e.plan, viewOverrides: [{ referenceId: 'reference-1', view: 'top' }] }).ok).toBe(
          true,
        );
      }
    expect((await task.result).references[0]).toMatchObject({ view: 'top', source: 'designer' });
  });
});

describe('M12-1 recoverable failures', () => {
  beforeEach(() => vi.spyOn(Math, 'random').mockReturnValue(0));
  afterEach(() => vi.restoreAllMocks());
  function failing(f: ReturnType<typeof fixture>, faults: ChatEvent[][], afterTools = false) {
    const attempts: ChatRequest[] = [];
    const provider: ModelProvider = {
      ...f.provider,
      capabilities: () => ({
        ...f.provider.capabilities('test'),
        maxOutputTokens: 256000,
        contextWindow: 1000000,
        maxContext: 1000000,
      }),
      async *stream(request, signal) {
        attempts.push(request);
        const hasResults = request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
        if (request.tools.length && (!afterTools || hasResults) && faults.length) yield* faults.shift()!;
        else yield* f.provider.stream(request, signal);
      },
    };
    return { provider, attempts };
  }
  const truncated: ChatEvent[] = [{ type: 'done', reason: 'max_tokens' }];
  const unavailable: ChatEvent[] = [
    { type: 'error', error: { category: 'server', status: 503, code: 'unavailable', message: 'offline' } },
  ];

  it('IMG-10: retries a truncated first draft in the same round with a compact-script instruction', async () => {
    const f = fixture(),
      retry = failing(f, [truncated]);
    const { report } = await finish({ ...f.options, provider: retry.provider });
    expect(report.reason).toBe('completed');
    expect(report.partCount).toBeGreaterThan(0);
    expect(report.rounds[0]?.warnings).toContain('output_truncated_retried');
    expect(JSON.stringify(retry.attempts[2]?.messages)).toContain('that script was not executed');
    expect(JSON.stringify(retry.attempts[2]?.messages)).toContain('256000 tokens');
    expect(f.host.run_build_script).toHaveBeenCalledTimes(report.rounds.length);
    expect(report.toolCalls).toBe((await finish(fixture().options)).report.toolCalls);
  });
  it('three truncations preserve the phase, round, attempts and specific unfinished reason', async () => {
    const f = fixture(),
      retry = failing(f, [truncated, truncated, truncated]);
    const { report } = await finish({ ...f.options, provider: retry.provider });
    expect(report.reason).toBe('error');
    expect(report.unfinished).toContainEqual({ code: 'output_truncated' });
    expect(report.failure).toEqual({ stage: 'round', round: 1, agentReason: 'max_tokens', attempts: 3 });
    expect(report.summaryZh).toContain('模型输出达到长度上限');
    expect(f.host.run_build_script).not.toHaveBeenCalled();
    expect(retry.attempts).toHaveLength(4);
  });
  it('IMG-11: a 400 is not retried and report diagnostics are public and redacted', async () => {
    const f = fixture(),
      retry = failing(f, [
        [
          {
            type: 'error',
            error: {
              category: 'invalid_request',
              status: 400,
              code: 'invalid_parameter',
              message: 'private',
              providerMessage: 'Bad parameter sk-test-123\nBearer hidden-token https://example.test/a?private=yes',
              details: { secret: 'must not persist' },
            },
          },
        ],
      ]);
    const { report } = await finish({ ...f.options, provider: retry.provider });
    expect(report.failure).toMatchObject({
      stage: 'round',
      round: 1,
      attempts: 1,
      error: {
        category: 'invalid_request',
        code: 'invalid_parameter',
        status: 400,
        providerMessage: expect.stringContaining('Bad parameter'),
      },
    });
    for (const value of ['sk-test-123', 'hidden-token', '?private', 'must not persist'])
      expect(JSON.stringify(report)).not.toContain(value);
    expect(report.summaryZh).toContain('第 1 轮');
    expect(report.summaryZh).toContain('请求被服务商拒绝');
    expect(report.summaryZh).toContain('HTTP 400');
    expect(report.unfinished).toContainEqual({ code: 'provider_error' });
    expect(retry.attempts).toHaveLength(2);
  });
  it.each(['auth', 'quota_exceeded', 'refusal', 'invalid_request'] as const)('never retries %s', async (category) => {
    const f = fixture(),
      retry = failing(f, [[{ type: 'error', error: { category, message: 'denied' } }]]);
    const { report } = await finish({ ...f.options, provider: retry.provider });
    expect(retry.attempts).toHaveLength(2);
    expect(report.unfinished).toContainEqual({ code: category === 'refusal' ? 'model_refused' : 'provider_error' });
  });
  it('compacts an overlong plan repair immediately without transient backoff', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let planning = 0;
    const provider: ModelProvider = {
      ...f.provider,
      capabilities: () => ({ ...f.provider.capabilities('test'), contextWindow: null }),
      async *stream(request, signal) {
        if (request.messages.at(-1)?.content.some((b) => b.type === 'text' && b.text.includes(SUMMARY_PROMPT))) {
          yield { type: 'text_delta', text: SUMMARY_TEMPLATE };
          yield { type: 'done', reason: 'stop' };
          return;
        }
        if (!request.tools.length) {
          planning++;
          if (planning === 1) {
            yield { type: 'text_delta', text: 'Invalid old plan text. '.repeat(15000) };
            yield { type: 'done', reason: 'stop' };
            return;
          }
          if (planning === 2) {
            yield {
              type: 'error',
              error: { category: 'invalid_request', code: 'CONTEXT_OVERFLOW', message: 'Prompt too long' },
            };
            return;
          }
        }
        yield* f.provider.stream(request, signal);
      },
    };
    const { report } = await finish({ ...f.options, provider });
    expect(planning).toBe(3);
    expect(report.reason).toBe('completed');
    expect(report.elapsedMs).toBe(0);
    expect(report.rounds.flatMap((r) => r.warnings)).not.toContain('transient_retry');
  });
  it('retains provider diagnostics when an overlong active input cannot be reduced', async () => {
    const f = fixture();
    const provider: ModelProvider = {
      ...f.provider,
      async *stream() {
        yield {
          type: 'error',
          error: {
            category: 'invalid_request',
            code: 'CONTEXT_OVERFLOW',
            status: 400,
            message: 'Prompt too long',
            providerMessage: 'Prompt 超长',
          },
        };
      },
    };
    const { report } = await finish({ ...f.options, provider });
    expect(report.reason).toBe('input_budget');
    expect(report.failure).toMatchObject({
      stage: 'planning',
      agentReason: 'input_budget',
      error: { code: 'CONTEXT_OVERFLOW', status: 400, providerMessage: 'Prompt 超长' },
    });
  });
  it('recovers a 503 after exactly 2 seconds; repeated errors use the 4-second second backoff', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      retry = failing(f, [unavailable, unavailable]);
    const pending = finish({ ...f.options, provider: retry.provider });
    await vi.advanceTimersByTimeAsync(1999);
    expect(retry.attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry.attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(retry.attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    const { report } = await pending;
    expect(report.reason).toBe('completed');
    expect(report.rounds[0]?.warnings).toContain('transient_retry');
    expect(report.elapsedMs).toBe(6000);
    expect(retry.attempts[1]?.messages).toEqual(retry.attempts[2]?.messages);
    expect(retry.attempts[2]?.messages).toEqual(retry.attempts[3]?.messages);
  });
  it('recovers within a turn that already executed a tool without replaying tools', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      retry = failing(
        f,
        [[{ type: 'error', error: { category: 'network', code: 'INCOMPLETE_STREAM', message: 'interrupted' } }]],
        true,
      );
    const pending = finish({ ...f.options, provider: retry.provider });
    await vi.advanceTimersByTimeAsync(2000);
    const { report, events } = await pending;
    expect(report.reason).toBe('completed');
    expect(report.rounds[0]?.warnings).toContain('transient_retry');
    expect(report.failure).toBeUndefined();
    expect(events.filter((e) => e.type === 'agent' && e.event.type === 'retry')).toHaveLength(1);
    expect(f.host.get_build_example).toHaveBeenCalledTimes(report.rounds.length);
    expect(f.host.run_build_script).toHaveBeenCalledTimes(report.rounds.length);
    expect(retry.attempts[2]?.messages).toEqual(retry.attempts[3]?.messages);
  });
  it('records eleven attempts for the failed request even after earlier requests executed tools', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      retry = failing(f, Array<ChatEvent[]>(11).fill(unavailable), true);
    const pending = finish({ ...f.options, provider: retry.provider });
    await vi.advanceTimersByTimeAsync(84000);
    const { report } = await pending;
    expect(report.reason).toBe('error');
    expect(report.failure).toMatchObject({
      stage: 'round',
      round: 1,
      attempts: 11,
      error: { category: 'server', status: 503 },
    });
    expect(f.host.get_build_example).toHaveBeenCalledTimes(1);
    expect(f.host.run_build_script).not.toHaveBeenCalled();
    expect(retry.attempts).toHaveLength(13);
    expect(report.elapsedMs).toBe(84000);
  });
  it('repairs a truncated plan within its three attempts even if partial text happens to parse', async () => {
    const f = fixture();
    let attempts = 0;
    const provider: ModelProvider = {
      ...f.provider,
      async *stream(request, signal) {
        if (!request.tools.length && attempts++ < 2) {
          yield { type: 'text_delta', text: JSON.stringify(plan()) };
          yield* truncated;
        } else yield* f.provider.stream(request, signal);
      },
    };
    const { report } = await finish({ ...f.options, provider });
    expect(report.reason).toBe('completed');
    expect(attempts).toBe(3);
    expect(JSON.stringify(f.requests[0]?.messages)).toContain('Return a compact complete JSON plan');
  });
  it.each(['resume', 'stop'] as const)(
    'pause then %s at a truncation boundary prevents requests during the pause',
    async (action) => {
      vi.useFakeTimers();
      const f = fixture(),
        retry = failing(f, [truncated]);
      const task = runImageToModel({ ...f.options, provider: retry.provider, budget: { durationMs: 1000 } });
      const consume = (async () => {
        for await (const e of task.events)
          if (e.type === 'agent' && e.event.type === 'finished' && e.event.result.reason === 'max_tokens') task.pause();
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(task.getState().paused).toBe(true);
      await vi.advanceTimersByTimeAsync(10000);
      expect(retry.attempts).toHaveLength(2);
      expect(task.getState().elapsedMs).toBe(0);
      task[action]();
      await consume;
      expect((await task.result).reason).toBe(action === 'resume' ? 'completed' : 'user_stopped');
    },
  );
  it.each(['resume', 'stop'] as const)(
    'pause then %s during backoff gates the next request without extending the delay',
    async (action) => {
      vi.useFakeTimers();
      const f = fixture(),
        retry = failing(f, [unavailable]);
      const task = runImageToModel({ ...f.options, provider: retry.provider, budget: { durationMs: 3000 } });
      const consume = collect(task.events);
      await vi.advanceTimersByTimeAsync(1000);
      task.pause();
      await vi.advanceTimersByTimeAsync(10000);
      expect(retry.attempts).toHaveLength(2);
      expect(task.getState().elapsedMs).toBe(1000);
      task[action]();
      if (action === 'resume') await vi.advanceTimersByTimeAsync(0);
      await consume;
      expect((await task.result).reason).toBe(action === 'resume' ? 'completed' : 'user_stopped');
      expect((await task.result).elapsedMs).toBe(1000);
    },
  );
  it('truncation after a completed tool keeps its result and never replays that tool', async () => {
    const f = fixture(),
      retry = failing(f, [truncated], true);
    const { report } = await finish({ ...f.options, provider: retry.provider });
    expect(report.reason).toBe('completed');
    expect(report.rounds[0]?.warnings).toContain('output_truncated_retried');
    expect(f.host.get_build_example).toHaveBeenCalledTimes(report.rounds.length);
    const followup = retry.attempts[3]!;
    expect(
      followup.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result' && b.name === 'get_build_example'),
    ).toHaveLength(1);
  });
  it('deadline still stops a transient backoff before another request', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      retry = failing(f, [unavailable]);
    const pending = finish({ ...f.options, provider: retry.provider, budget: { durationMs: 1500 } });
    await vi.advanceTimersByTimeAsync(1500);
    const { report } = await pending;
    expect(report.reason).toBe('time_budget');
    expect(retry.attempts).toHaveLength(2);
    expect(report.elapsedMs).toBe(1500);
  });
});

it.each(['active', 'recovered', 'exhausted', 'stopped', 'deadline'] as const)(
  'A-116 image watchdog: %s',
  async (mode) => {
    vi.useFakeTimers();
    const f = fixture(),
      original = f.provider.stream.bind(f.provider);
    let attempts = 0;
    const signals: AbortSignal[] = [];
    f.provider.stream = async function* (request, signal) {
      signals.push(signal);
      if (!request.tools.length) {
        attempts++;
        if (mode === 'active') {
          for (let i = 0; i < 5; i++) {
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            yield { type: 'activity', reasoningChars: i + 1, contentChars: 0, toolChars: 0 };
          }
        } else if (mode !== 'recovered' || attempts === 1) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          yield { type: 'done', reason: 'cancelled' };
          return;
        }
      }
      yield* original(request, signal);
    };
    const task = runImageToModel({
      ...f.options,
      streamStallMs: 50,
      retryDelayMs: 10,
      ...(mode === 'deadline' ? { budget: { durationMs: 30 } } : {}),
    });
    const pending = collect(task.events);
    await vi.advanceTimersByTimeAsync(30);
    if (mode === 'active') expect(task.getState().modelActivity).toMatchObject({ counts: { reasoningChars: 1 } });
    if (mode === 'stopped') task.stop();
    await vi.advanceTimersByTimeAsync(500);
    const events = await pending;
    const report = await task.result;
    expect(report.reason).toBe(
      mode === 'active' || mode === 'recovered'
        ? 'completed'
        : mode === 'stopped'
          ? 'user_stopped'
          : mode === 'deadline'
            ? 'time_budget'
            : 'error',
    );
    const errors = events.flatMap((e) => (e.type === 'agent' && e.event.type === 'error' ? [e.event.error] : []));
    const count = mode === 'recovered' ? 1 : mode === 'exhausted' ? 4 : 0;
    expect(errors).toHaveLength(count);
    expect(events.filter((e) => e.type === 'agent' && e.event.type === 'retry')).toHaveLength(Math.min(3, count));
    if (mode === 'exhausted') {
      expect(report.failure).toMatchObject({ attempts: 4, error: { category: 'network', code: 'STREAM_STALLED' } });
      expect(report.summaryZh).toContain('服务商长时间没有响应');
      expect(report.failure?.error).not.toHaveProperty('providerMessage');
    }
    expect(task.getState().modelActivity).toBeUndefined();
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([false, true])(
  'A-117 normalizes boxes and colors in the plan event before directStart=%s',
  async (directStart) => {
    const f = fixture();
    f.controls.plan = plan();
    f.controls.plan.components[0]!.boundingBox = { min: { x: -2, y: 1, z: 3 }, max: { x: 99, y: 99, z: 99 } };
    f.controls.plan.components[0]!.colors = ['red'];
    const palette = [{ id: 'c:red', legoName: 'Red', rgb: '#ff0000' }];
    const task = runImageToModel({ ...f.options, directStart, colors: { palette, catalog: palette } });
    let reviewed = false;
    for await (const event of task.events)
      if (event.type === 'plan') {
        reviewed = true;
        expect(event.boxRepairs).toEqual([
          {
            componentId: 'body',
            from: f.controls.plan.components[0]!.boundingBox,
            to: { min: { x: -2, y: 1, z: 3 }, max: { x: 4, y: 3, z: 7 } },
          },
        ]);
        expect(event.colorRepairs).toContainEqual({ componentId: 'body', from: 'red', to: 'c:red' });
        expect(parseStructurePlan(event.plan).ok).toBe(true);
        if (!directStart) expect(task.confirmPlan(event.plan).ok).toBe(true);
      }
    expect(reviewed).toBe(true);
    expect((await task.result).reason).toBe('completed');
  },
);
