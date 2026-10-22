import { expandInstances, pathStartsWith, resolveContext } from '@brickloop/core';
import type { BrkDocument, InstancePath } from '@brickloop/core';
import type { Mention } from '../../shared/ai-api';

export function mentionCandidates(
  doc: BrkDocument,
  modelPath: InstancePath,
  selection: InstancePath[],
  labels: { selection: string; step: (n: number) => string; color: (id: string) => string },
): Mention[] {
  const rows = expandInstances(doc),
    model = resolveContext(doc, { activeModelPath: modelPath })?.model;
  const colors = new Map<string, number>();
  for (const row of rows) colors.set(row.colorId, (colors.get(row.colorId) ?? 0) + 1);
  return [
    {
      type: 'selection',
      id: 'selection',
      name: labels.selection,
      count: selection.length,
      paths: structuredClone(selection),
    },
    ...Object.values(doc.models)
      .filter((m) => m.id !== doc.rootModelId)
      .map((m): Mention => ({
        type: 'submodel',
        id: m.id,
        name: m.name,
        count: expandInstances(doc, m.id).length,
      })),
    ...(model?.stepIds.map((id, index): Mention => ({
      type: 'step',
      id,
      name: labels.step(index + 1),
      count: model.steps[id]!.instanceIds.length,
    })) ?? []),
    ...[...colors].map(([id, count]): Mention => ({ type: 'color', id, name: labels.color(id), count })),
    ...Object.entries(doc.referenceImages).map(([id, ref]): Mention => ({
      type: 'reference',
      id,
      name: String(ref.name ?? id),
      count: 0,
    })),
  ];
}

export interface MentionToken {
  start: number;
  end: number;
  mention: Mention;
}
export function mentionTokens(text: string, known: Mention[], bindings: MentionToken[] = []): MentionToken[] {
  const names = [...known].sort((a, b) => b.name.length - a.name.length);
  const result: MentionToken[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    const bound = bindings.find((b) => b.start === i && text.slice(b.start, b.end) === `@${b.mention.name}`);
    const mention =
      bound?.mention ??
      names.find(
        (m) =>
          text.startsWith(m.name, i + 1) &&
          (!text[i + 1 + m.name.length] || /[\s，。！？、,.;:!?@]/u.test(text[i + 1 + m.name.length]!)),
      );
    if (mention) {
      result.push({ start: i, end: i + 1 + mention.name.length, mention });
      i += mention.name.length;
    }
  }
  return result;
}
export function reconcileMentionTokens(before: string, after: string, tokens: MentionToken[]): MentionToken[] {
  if (before === after) return tokens;
  let start = 0,
    suffix = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const oldEnd = before.length - suffix,
    delta = after.length - before.length;
  return tokens.flatMap((token) =>
    token.end <= start
      ? [token]
      : token.start >= oldEnd
        ? [{ ...token, start: token.start + delta, end: token.end + delta }]
        : [],
  );
}
export function resolveMentions(text: string, known: Mention[], current: Mention[], bindings: MentionToken[] = []) {
  const mentions = new Map<string, Mention>(),
    removed: string[] = [],
    tokens = mentionTokens(text, known, bindings);
  for (const token of [...tokens].reverse()) {
    const latest = current.find((m) => m.type === token.mention.type && m.id === token.mention.id);
    if (!latest) {
      removed.push(token.mention.name);
      text = text.slice(0, token.start) + text.slice(token.end);
    } else mentions.set(`${latest.type}:${latest.id}`, latest);
  }
  return { text, mentions: [...mentions.values()].reverse(), removed };
}

export function selectedRows(doc: BrkDocument, paths: InstancePath[]) {
  return expandInstances(doc).filter((row) => paths.some((path) => pathStartsWith(row.path, path)));
}
