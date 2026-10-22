import type { Message, ModelCapabilities, ToolCallBlock, ToolResultBlock, ToolSpec } from '../types.js';

const bytes = (text: string) => new TextEncoder().encode(text).length;
const serialized = (value: unknown) =>
  JSON.stringify(value, (key, entry: unknown) => (key === 'base64' ? '[image]' : entry));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textTokens = (text: string) => Math.ceil(bytes(text) / 3);
export const IMAGE_TOKEN_ESTIMATE = 1_500;

/** Providers can expose per-model estimates without changing tool/protocol types. */
export function imageTokenEstimate(capabilities: ModelCapabilities & { imageTokens?: number }): number {
  return Number.isFinite(capabilities.imageTokens) && capabilities.imageTokens! >= 0
    ? capabilities.imageTokens!
    : IMAGE_TOKEN_ESTIMATE;
}

/** Conservative fallback; image payload bytes are never treated as text tokens. */
export function estimateInputTokens(
  system: string,
  messages: readonly Message[],
  tools: readonly ToolSpec[],
  imageTokens = IMAGE_TOKEN_ESTIMATE,
): number {
  let images = 0;
  for (const m of messages)
    for (const b of m.content) {
      if (b.type === 'image') images++;
      if (b.type === 'tool_result') images += b.content.filter((c) => c.type === 'image').length;
    }
  return (
    textTokens(
      serialized({
        system,
        messages,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      }),
    ) +
    images * imageTokens
  );
}

type MessageSize = { key: string; bytes: number; images: number };
const maxCachedDeltas = 1024;

/** Object identity is safe only within a projection, where messages stay unchanged. */
class ProjectionCounter {
  private readonly envelope: number;
  private readonly sizes = new WeakMap<Message, MessageSize>();
  private readonly deltas = new Map<string, number>();
  private empty?: number;
  constructor(
    private readonly system: string,
    private readonly tools: readonly ToolSpec[],
    private readonly imageTokens: number,
    readonly toolsKey: string,
    private readonly opaque?: {
      estimate: typeof estimateInputTokens;
      cache: Map<string, number>;
      previous: Map<string, number[]> | undefined;
    },
  ) {
    // Recompute the envelope: the tuple key conflates undefined and null fields.
    this.envelope = opaque
      ? 0
      : bytes(
          serialized({
            system,
            messages: [],
            tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          }),
        );
  }
  size(message: Message): MessageSize {
    let size = this.sizes.get(message);
    if (!size) {
      const key = serialized(message);
      let images = 0;
      for (const block of message.content) {
        if (block.type === 'image') images++;
        if (block.type === 'tool_result') images += block.content.filter((b) => b.type === 'image').length;
      }
      size = { key, bytes: bytes(key), images };
      this.sizes.set(message, size);
    }
    return size;
  }
  total(messages: readonly Message[]): number {
    if (this.opaque) return this.opaque.estimate(this.system, messages, this.tools);
    let totalBytes = this.envelope + Math.max(0, messages.length - 1),
      images = 0;
    for (const message of messages) {
      const size = this.size(message);
      totalBytes += size.bytes;
      images += size.images;
    }
    return Math.ceil(totalBytes / 3) + images * this.imageTokens;
  }
  delta(message: Message): number {
    const size = this.size(message);
    if (!this.opaque)
      return (
        Math.ceil((this.envelope + size.bytes) / 3) - Math.ceil(this.envelope / 3) + size.images * this.imageTokens
      );
    const { estimate, cache, previous } = this.opaque;
    const cached = previous?.get(size.key)?.at(-1) ?? this.deltas.get(size.key) ?? cache.get(size.key);
    if (cached !== undefined) {
      this.deltas.set(size.key, cached);
      return cached;
    }
    this.empty ??= estimate(this.system, [], this.tools);
    const delta = estimate(this.system, [message], this.tools) - this.empty;
    this.deltas.set(size.key, delta);
    if (cache.size >= maxCachedDeltas) cache.delete(cache.keys().next().value!);
    cache.set(size.key, delta);
    return delta;
  }
}

/** Last actual input + estimated additions. Removed content releases its proportional
 * share of measured input, so a pessimistic image estimate cannot erase real usage.
 * Opaque estimators must depend only on the serialized matching key (base64 replaced
 * by '[image]') used for reuse, as the built-in estimator does. */
export class InputTokenMeter {
  private previous?: {
    system: string;
    tools: string;
    messages: Map<string, number[]>;
    estimate: number;
    actual: number;
  };
  private deltas?: { system: string; tools: string; values: Map<string, number> };
  constructor(
    private readonly estimate: typeof estimateInputTokens = estimateInputTokens,
    private readonly imageTokens = IMAGE_TOKEN_ESTIMATE,
  ) {}
  private projection(system: string, tools: readonly ToolSpec[]) {
    const toolsKey = serialized(tools.map((t) => [t.name, t.description, t.parameters]));
    if (this.estimate === estimateInputTokens) return new ProjectionCounter(system, tools, this.imageTokens, toolsKey);
    if (this.deltas?.system !== system || this.deltas.tools !== toolsKey)
      this.deltas = { system, tools: toolsKey, values: new Map() };
    return new ProjectionCounter(system, tools, this.imageTokens, toolsKey, {
      estimate: this.estimate,
      cache: this.deltas.values,
      previous:
        this.previous?.system === system && this.previous.tools === toolsKey ? this.previous.messages : undefined,
    });
  }
  count = (system: string, messages: readonly Message[], tools: readonly ToolSpec[]): number =>
    this.counter(system, tools)(messages);
  /** Reuse only within one projection; callers must not mutate its messages or tools. */
  counter(system: string, tools: readonly ToolSpec[]): (messages: readonly Message[]) => number {
    const counter = this.projection(system, tools),
      previous = this.previous;
    return (messages) => {
      if (!previous || previous.system !== system || previous.tools !== counter.toolsKey)
        return counter.total(messages);
      const remaining = new Map([...previous.messages].map(([key, values]) => [key, [...values]]));
      let added = 0;
      for (const message of messages) {
        const key = counter.size(message).key;
        if (remaining.get(key)?.pop() === undefined) added += counter.delta(message);
      }
      const removed = [...remaining.values()].flat().reduce((sum, value) => sum + value, 0);
      return Math.ceil(Math.max(0, previous.actual * (1 - Math.min(1, removed / previous.estimate))) + added);
    };
  }
  observe(system: string, messages: readonly Message[], tools: readonly ToolSpec[], actual: number): void {
    if (!Number.isFinite(actual) || actual < 0) return;
    const counter = this.projection(system, tools),
      entries = new Map<string, number[]>();
    for (const message of messages) {
      const key = counter.size(message).key,
        values = entries.get(key) ?? [];
      values.push(counter.delta(message));
      entries.set(key, values);
    }
    this.previous = {
      system,
      tools: counter.toolsKey,
      messages: entries,
      estimate: Math.max(1, counter.total(messages)),
      actual,
    };
    if (this.estimate !== estimateInputTokens)
      this.deltas = {
        system,
        tools: counter.toolsKey,
        values: new Map([...entries].slice(-maxCachedDeltas).map(([key, values]) => [key, values.at(-1)!])),
      };
  }
}

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && bytes(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.8);
  return text.slice(0, end) + '…';
}

/** Bound text only; retained images have their own budget. Preserve JSON envelopes and
 * sibling statistics, with first rows and pagination guidance instead of broken JSON. */
export function truncateToolResult(result: ToolResultBlock, args: unknown = {}, maxTokens = 2000): ToolResultBlock {
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (textTokens(text) <= maxTokens) return result;
  const offset = typeof record(args).offset === 'number' ? (record(args).offset as number) : 0;
  const instruction =
    result.name === 'list_instances'
      ? '使用 offset 继续获取；需要完整变换时调用 get_instance。'
      : '用不同的过滤条件缩小范围；需要详情时调用对应查询工具。';
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = text;
  }
  const rowKeys =
    result.name === 'search_parts'
      ? ['id', 'name', 'nameZh', 'nameEn', 'dimensions', 'bboxLdu', 'colors', 'categoryId']
      : result.name === 'list_instances'
        ? ['instanceId', 'path', 'partId', 'colorId', 'position']
        : undefined;
  let rendered = '';
  for (let limit = 20; limit >= 0; limit = limit > 1 ? Math.floor(limit / 2) : limit - 1) {
    const lists: { path: string; total: number; shown: number }[] = [];
    function shorten(entry: unknown, path: string): unknown {
      if (Array.isArray(entry)) {
        // Positions, bounds, matrices and instance paths are values, not paginated rows.
        if (entry.length <= 16 && entry.every((v) => v === null || typeof v !== 'object')) return entry;
        const rows = entry.slice(0, limit).map((row) => {
          const compact =
            rowKeys && /\.(parts|instances)$/.test(path)
              ? Object.fromEntries(Object.entries(record(row)).filter(([key]) => rowKeys.includes(key)))
              : row;
          return shorten(compact, path + '[]');
        });
        if (entry.length > rows.length) lists.push({ path, total: entry.length, shown: rows.length });
        return rows;
      }
      if (typeof entry === 'string') return clip(entry, limit ? 600 : 120);
      if (entry && typeof entry === 'object')
        return Object.fromEntries(Object.entries(entry).map(([key, v]) => [key, shorten(v, path + '.' + key)]));
      return entry;
    }
    const shortened = shorten(value, '$');
    const primary = lists.find((list) => /\.(parts|instances)$/.test(list.path)) ?? lists[0];
    const data = record(record(value).data);
    const pageKey = result.name === 'search_parts' ? 'parts' : result.name === 'list_instances' ? 'instances' : '';
    const page = record(record(shortened).data)[pageKey];
    const total =
      typeof data.total === 'number'
        ? data.total
        : Array.isArray(data[pageKey])
          ? data[pageKey].length
          : primary?.total;
    const shown = Array.isArray(page) ? page.length : primary?.shown;
    if (result.name === 'list_instances' && shown !== undefined) {
      const outputData = record(record(shortened).data);
      outputData.offset = offset;
      outputData.nextOffset = offset + shown;
    }
    const note = {
      truncated: true,
      ...(total !== undefined ? { total, shown } : {}),
      lists,
      ...(result.name === 'list_instances' && shown !== undefined ? { offset, nextOffset: offset + shown } : {}),
      message: (total === undefined ? '工具结果已截断。' : `共 ${total} 条，显示 ${shown} 条。`) + instruction,
    };
    rendered = JSON.stringify(
      typeof shortened === 'object' && shortened !== null && !Array.isArray(shortened)
        ? { ...shortened, contextTruncation: note }
        : { preview: shortened, contextTruncation: note },
    );
    if (textTokens(rendered) <= maxTokens) break;
  }
  if (textTokens(rendered) > maxTokens) {
    let preview = clip(text, Math.max(0, maxTokens * 3 - 600));
    do {
      rendered = JSON.stringify({ preview, contextTruncation: { truncated: true, message: instruction } });
      preview = preview.slice(0, Math.floor(preview.length / 2));
    } while (textTokens(rendered) > maxTokens && preview.length);
  }
  return {
    ...result,
    content: [{ type: 'text', text: rendered }, ...result.content.filter((b) => b.type === 'image')],
  };
}

/** Request-only projection. A group is one image-bearing tool result (possibly several views).
 * Non-image queries do not evict render groups. Raw history is never modified. */
export function prepareHistory(messages: readonly Message[], currentUserMessage?: Message): Message[] {
  const current =
    currentUserMessage ??
    [...messages].reverse().find((m) => m.role === 'user' && !m.content.some((b) => b.type === 'tool_result'));
  const imageResults = messages.flatMap((m) =>
    m.content.filter(
      (b): b is ToolResultBlock => b.type === 'tool_result' && b.content.some((c) => c.type === 'image'),
    ),
  );
  // Render/compare images have a separate visual budget: keep the two latest groups
  // for comparison. This does not limit any tool's textual result.
  const retained = new Set(imageResults.slice(-2));
  const calls = new Map<string, { call: ToolCallBlock; turn: number; occurrence: number }>();
  const counts = new Map<string, number>();
  let turn = 0;
  return messages.map((message) => {
    if (message.role === 'user' && !message.content.some((b) => b.type === 'tool_result')) turn++;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'tool_call') {
          const occurrence = (counts.get(block.name) ?? 0) + 1;
          counts.set(block.name, occurrence);
          calls.set(block.id, { call: block, turn, occurrence });
        }
        if (block.type === 'image' && message !== current)
          return { type: 'text', text: `[已省略：第 ${turn} 轮${message.role === 'user' ? '用户' : '助手'}图片]` };
        if (block.type !== 'tool_result') return block;
        const info = calls.get(block.id),
          args = record(info?.call.arguments);
        let result = block;
        if (!retained.has(block) && block.content.some((c) => c.type === 'image')) {
          const views = Array.isArray(args.views) ? args.views.join('、') : String(args.view ?? '未指定视角');
          result = {
            ...result,
            content: [
              ...result.content.filter((c) => c.type !== 'image'),
              {
                type: 'text',
                text: `[已省略：${block.name} 第 ${info?.occurrence ?? '?'} 次，第 ${info?.turn ?? turn} 轮，${views}]`,
              },
            ],
          };
        }
        return result;
      }),
    };
  });
}

/** Keep a parallel assistant batch and ALL result messages indivisible, including signed
 * provider replay state. Call IDs are scoped to a batch, not the entire conversation. */
export function atomicGroups(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [],
    pending = new Set<string>();
  let group: Message[] = [];
  for (const message of messages) {
    group.push(message);
    for (const b of message.content) {
      if (b.type === 'tool_call') pending.add(b.id);
      if (b.type === 'tool_result') pending.delete(b.id);
    }
    if (!pending.size) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

export function summaryBuilder(tools: readonly ToolSpec[], modelSummary?: string) {
  const stats = new Map<string, { calls: number; failed: number; changed: number; points: string }>();
  const calls = new Map<string, ToolCallBlock>();
  const notes: string[] = [];
  function changedInstances(name: string, args: Record<string, unknown>, result: Record<string, unknown>): number {
    if (result.ok === false || !tools.find((t) => t.name === name)?.mutating) return 0;
    const data = record(result.data);
    if (data.rolledBack) return 0;
    if (name === 'batch' && Array.isArray(args.operations) && Array.isArray(data.results)) {
      const outputs = data.results;
      return args.operations.reduce((sum: number, op: unknown, index: number) => {
        const operation = record(op);
        return sum + changedInstances(String(operation.tool), record(operation.arguments), record(outputs[index]));
      }, 0);
    }
    if (typeof data.changed === 'number') return data.changed;
    for (const key of ['created', 'instanceIds', 'deleted']) if (Array.isArray(data[key])) return data[key].length;
    if (data.instanceId) return 1;
    return Array.isArray(args.instanceIds) ? args.instanceIds.length : 0;
  }
  return {
    add(messages: readonly Message[]): void {
      for (const message of messages)
        for (const block of message.content) {
          if (block.type === 'text' && message.role === 'user')
            notes.push(message.contextCheckpoint ? block.text : clip(block.text, 180));
          if (block.type === 'tool_call') {
            calls.set(block.id, block);
            const stat = stats.get(block.name) ?? { calls: 0, failed: 0, changed: 0, points: '' };
            stat.calls++;
            stats.set(block.name, stat);
          }
          if (block.type === 'tool_result') {
            const stat = stats.get(block.name);
            if (!stat) continue;
            if (block.isError) stat.failed++;
            const text = block.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(' ');
            let result: Record<string, unknown> = {};
            try {
              result = record(JSON.parse(text));
            } catch {
              /* Plain text still contributes a preview. */
            }
            const data = record(result.data);
            const args = record(calls.get(block.id)?.arguments);
            if (!block.isError) stat.changed += changedInstances(block.name, args, result);
            stat.points = clip(JSON.stringify(Object.keys(data).length ? data : result), 240);
            if (stat.points === '{}') stat.points = clip(text, 240);
            if (block.name === 'batch' && Array.isArray(args.operations))
              stat.points =
                [...new Set(args.operations.map((op: unknown) => String(record(op).tool)))].join('、') +
                '; ' +
                stat.points;
          }
        }
    },
    render(): string {
      return (
        '[较早上下文摘要]\n' +
        [...stats]
          .map(([name, s]) => `${name}: ${s.calls} 次，失败 ${s.failed}，改动实例 ${s.changed} 次；${s.points}`)
          .join('\n') +
        (notes.length ? '\n早先要求：' + notes.join('；') : '') +
        (modelSummary ? '\nRetained model summary:\n' + clip(modelSummary, 1200) : '')
      );
    },
  };
}

export interface ContextOptions {
  maxTokens: number;
  system: string;
  tools: readonly ToolSpec[];
  modelSummary?: string;
  currentUserMessage?: Message;
  meter?: InputTokenMeter;
  count?: typeof estimateInputTokens;
  reasoningReplay?: boolean;
  /** Reuse the same per-projection counter during asynchronous compaction. */
  countMessages?: (messages: readonly Message[]) => number;
}

export function compressHistory(
  messages: readonly Message[],
  options: ContextOptions,
): { messages: Message[]; compressed: boolean; summarized: boolean; tokens: number } {
  const original = messages;
  if (options.reasoningReplay && options.tools.length) {
    const current = options.currentUserMessage ? messages.indexOf(options.currentUserMessage) : -1;
    let end = 0;
    for (let i = 0; i < current; i++) {
      if (messages[i]!.role !== 'assistant' || messages[i]!.providerState?.kind === 'openai-compatible-reasoning')
        continue;
      // Include the complete earlier turn, so no orphan tool results reach the provider.
      end = current;
      for (let j = i + 1; j < current; j++) {
        if (messages[j]!.role === 'user' && !messages[j]!.content.some((b) => b.type === 'tool_result')) {
          end = j;
          break;
        }
      }
    }
    if (end) {
      const builder = summaryBuilder(options.tools, options.modelSummary);
      const checkpoint = messages[0]?.contextCheckpoint ? messages[0] : undefined;
      builder.add(messages.slice(checkpoint ? 1 : 0, end));
      messages = [
        ...(checkpoint ? [checkpoint] : []),
        { role: 'user', content: [{ type: 'text', text: builder.render() }] },
        ...messages.slice(end),
      ];
    }
  }
  const count =
    options.countMessages ??
    (options.meter
      ? options.meter.counter(options.system, options.tools)
      : options.count
        ? (list: readonly Message[]) => options.count!(options.system, list, options.tools)
        : new InputTokenMeter().counter(options.system, options.tools));
  const prepared = prepareHistory(messages, options.currentUserMessage);
  let result = prepared;
  let tokens = count(result);
  if (tokens <= options.maxTokens)
    return { messages: result, compressed: serialized(result) !== serialized(original), summarized: false, tokens };
  const currentIndex = options.currentUserMessage
    ? messages.indexOf(options.currentUserMessage)
    : messages.lastIndexOf(
        [...messages].reverse().find((m) => m.role === 'user' && !m.content.some((b) => b.type === 'tool_result'))!,
      );
  const current = prepared[currentIndex];
  const latest = prepared.at(-1);
  const groups = atomicGroups(prepared),
    removed = new Set<Message>(),
    originals = new Map(prepared.map((message, index) => [message, messages[index]!])),
    builder = summaryBuilder(options.tools, options.modelSummary);
  let summary = '';
  for (const group of groups) {
    // Active user input stays intact. Even the newest tool cycle is reducible if needed.
    if (
      group.includes(current!) ||
      (latest?.role === 'user' && !latest.content.some((b) => b.type === 'tool_result') && group.includes(latest))
    )
      continue;
    for (const message of group) removed.add(message);
    // Summarize original results, so truncating a large batch cannot lose mutation counts.
    builder.add(group.map((message) => originals.get(message)!));
    summary = builder.render();
    result = [{ role: 'user', content: [{ type: 'text', text: summary }] }, ...prepared.filter((m) => !removed.has(m))];
    tokens = count(result);
    if (tokens <= options.maxTokens) break;
  }
  // A tiny budget must not fail solely because a deterministic summary is too large.
  while (summary && tokens > options.maxTokens) {
    summary = summary.length > 80 ? summary.slice(0, Math.floor(summary.length / 2)) : '';
    result = [
      ...(summary ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: summary + '…' }] }] : []),
      ...prepared.filter((m) => !removed.has(m)),
    ];
    tokens = count(result);
  }
  // A later amendment may fit on its own while the earlier request no longer fits alongside it.
  // Shorten that earlier text only after exhausting tool/history compression; keep its images.
  if (current && latest?.role === 'user' && current !== latest && tokens > options.maxTokens) {
    let preview = current.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    let shortened = current;
    while (preview && tokens > options.maxTokens) {
      preview = preview.slice(0, Math.floor(preview.length / 2));
      const replacement: Message = {
        role: 'user',
        content: [
          { type: 'text', text: '[早先要求摘要] ' + preview + '…' },
          ...current.content.filter((b) => b.type === 'image'),
        ],
      };
      result = result.map((m) => (m === shortened ? replacement : m));
      shortened = replacement;
      tokens = count(result);
    }
  }
  return { messages: result, compressed: true, summarized: removed.size > 0, tokens };
}
