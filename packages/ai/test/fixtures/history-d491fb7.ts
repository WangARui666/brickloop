// Frozen d491fb7 reference for differential tests. Keep copied implementations unchanged.
import type { Message, ToolCallBlock, ToolSpec } from '../../src/types.js';
import { estimateInputTokens, prepareHistory } from '../../src/agent/history.js';
const bytes = (text: string) => new TextEncoder().encode(text).length;
const serialized = (value: unknown) =>
  JSON.stringify(value, (key, entry: unknown) => (key === 'base64' ? '[image]' : entry));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Last actual input + estimated additions. Removed content releases its proportional
 * share of measured input, so a pessimistic image estimate cannot erase real usage. */
export class InputTokenMeter {
  private previous?: {
    system: string;
    tools: string;
    messages: Map<string, number[]>;
    estimate: number;
    actual: number;
  };
  constructor(private readonly estimate: typeof estimateInputTokens = estimateInputTokens) {}
  count = (system: string, messages: readonly Message[], tools: readonly ToolSpec[]): number => {
    const current = this.estimate(system, messages, tools),
      previous = this.previous;
    if (
      !previous ||
      previous.system !== system ||
      previous.tools !== serialized(tools.map((t) => [t.name, t.description, t.parameters]))
    )
      return current;
    const remaining = new Map([...previous.messages].map(([key, values]) => [key, [...values]]));
    let added = 0;
    const empty = this.estimate(system, [], tools);
    for (const message of messages) {
      if (remaining.get(serialized(message))?.pop() === undefined)
        added += this.estimate(system, [message], tools) - empty;
    }
    const removed = [...remaining.values()].flat().reduce((sum, value) => sum + value, 0);
    return Math.ceil(Math.max(0, previous.actual * (1 - Math.min(1, removed / previous.estimate))) + added);
  };
  observe(system: string, messages: readonly Message[], tools: readonly ToolSpec[], actual: number): void {
    if (!Number.isFinite(actual) || actual < 0) return;
    const entries = new Map<string, number[]>(),
      empty = this.estimate(system, [], tools);
    for (const message of messages) {
      const key = serialized(message),
        values = entries.get(key) ?? [];
      values.push(this.estimate(system, [message], tools) - empty);
      entries.set(key, values);
    }
    this.previous = {
      system,
      tools: serialized(tools.map((t) => [t.name, t.description, t.parameters])),
      messages: entries,
      estimate: Math.max(1, this.estimate(system, messages, tools)),
      actual,
    };
  }
}

function clip(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && bytes(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.8);
  return text.slice(0, end) + '…';
}

/** Keep a parallel assistant batch and ALL result messages indivisible, including signed
 * provider replay state. Call IDs are scoped to a batch, not the entire conversation. */
function atomicGroups(messages: readonly Message[]): Message[][] {
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

function summaryOf(messages: readonly Message[], tools: readonly ToolSpec[], modelSummary?: string): string {
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
  for (const message of messages)
    for (const block of message.content) {
      if (block.type === 'text' && message.role === 'user') notes.push(clip(block.text, 180));
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
            [...new Set(args.operations.map((op: unknown) => String(record(op).tool)))].join('、') + '; ' + stat.points;
      }
    }
  return (
    '[较早上下文摘要]\n' +
    [...stats]
      .map(([name, s]) => `${name}: ${s.calls} 次，失败 ${s.failed}，改动实例 ${s.changed} 次；${s.points}`)
      .join('\n') +
    (notes.length ? '\n早先要求：' + notes.join('；') : '') +
    (modelSummary ? '\nRetained model summary:\n' + clip(modelSummary, 1200) : '')
  );
}

export interface ContextOptions {
  maxTokens: number;
  system: string;
  tools: readonly ToolSpec[];
  modelSummary?: string;
  currentUserMessage?: Message;
  count?: typeof estimateInputTokens;
}

export function compressHistory(
  messages: readonly Message[],
  options: ContextOptions,
): { messages: Message[]; compressed: boolean; tokens: number } {
  const count = (list: readonly Message[]) =>
    (options.count ?? estimateInputTokens)(options.system, list, options.tools);
  const prepared = prepareHistory(messages, options.currentUserMessage);
  let result = prepared;
  if (count(result) <= options.maxTokens)
    return { messages: result, compressed: serialized(result) !== serialized(messages), tokens: count(result) };
  const currentIndex = options.currentUserMessage
    ? messages.indexOf(options.currentUserMessage)
    : messages.lastIndexOf(
        [...messages].reverse().find((m) => m.role === 'user' && !m.content.some((b) => b.type === 'tool_result'))!,
      );
  const current = prepared[currentIndex];
  const latest = prepared.at(-1);
  const groups = atomicGroups(prepared),
    removed: Message[] = [];
  let summary = '';
  for (const group of groups) {
    // Active user input stays intact. Even the newest tool cycle is reducible if needed.
    if (
      group.includes(current!) ||
      (latest?.role === 'user' && !latest.content.some((b) => b.type === 'tool_result') && group.includes(latest))
    )
      continue;
    removed.push(...group);
    // Summarize original results, so truncating a large batch cannot lose mutation counts.
    summary = summaryOf(
      messages.filter((_, i) => removed.includes(prepared[i]!)),
      options.tools,
      options.modelSummary,
    );
    result = [
      { role: 'user', content: [{ type: 'text', text: summary }] },
      ...prepared.filter((m) => !removed.includes(m)),
    ];
    if (count(result) <= options.maxTokens) break;
  }
  // A tiny budget must not fail solely because a deterministic summary is too large.
  while (summary && count(result) > options.maxTokens) {
    summary = summary.length > 80 ? summary.slice(0, Math.floor(summary.length / 2)) : '';
    result = [
      ...(summary ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: summary + '…' }] }] : []),
      ...prepared.filter((m) => !removed.includes(m)),
    ];
  }
  // A later amendment may fit on its own while the earlier request no longer fits alongside it.
  // Shorten that earlier text only after exhausting tool/history compression; keep its images.
  if (current && latest?.role === 'user' && current !== latest && count(result) > options.maxTokens) {
    let preview = current.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    let shortened = current;
    while (preview && count(result) > options.maxTokens) {
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
    }
  }
  return { messages: result, compressed: true, tokens: count(result) };
}
