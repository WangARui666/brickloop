import { describe, expect, it } from 'vitest';
import { createDocument, createModel, DocumentSession, expandInstances } from '@brickloop/core';
import { mutationNames, toolSchemas } from '@brickloop/ai';
import type { ToolName } from '@brickloop/ai';
import { SelectionScope, mutationTargets } from '../src/renderer/src/ai-scope';
import { mentionCandidates, resolveMentions, reconcileMentionTokens } from '../src/renderer/src/ai-mentions';
import { turnSchema } from '../src/shared/ai-api';

function fixture() {
  const session = new DocumentSession(createDocument());
  for (let i = 0; i < 3; i++) session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
  const ids = expandInstances(session.document).map((r) => r.path.at(-1)!);
  session.dispatch({ type: 'group.create', paths: ids.slice(0, 2).map((id) => [id]), name: '组' });
  return { session, ids, doc: session.document };
}
describe('selection task boundaries', () => {
  it('checks immutable original paths, descendants, new identities and capped errors', () => {
    const { session, ids } = fixture();
    const scope = new SelectionScope(session.document, [[ids[0]!]]);
    expect(scope.check([[ids[0]!], ['new']])).toBeUndefined();
    expect(scope.check([['new-parent', ids[1]!]])).toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(scope.check([['moved-parent', ids[0]!]])).toBeUndefined();
    const paths = Array.from({ length: 60 }, (_, i) => [`path-${i}`]);
    const rejected = new SelectionScope(session.document, paths).check([[ids[0]!]])!;
    expect(rejected.details).toMatchObject({ allowedTotal: 60 });
    expect((rejected.details as { allowed: string[] }).allowed).toHaveLength(50);
  });
  it('covers every mutationNames entry with its actual targets', () => {
    const { doc, ids } = fixture(),
      groupId = Object.keys(doc.groups)[0]!;
    const pose = { kind: 'grid', x: 0, z: 0, level: 0 };
    const cases: Record<string, { args: unknown; targets: string[] }> = {
      run_build_script: { args: { scriptId: 'new', code: 'box(0,0,0,1,1,3,"Red")' }, targets: [] },
      move: { args: { instanceIds: [ids[1]], delta: { x: 0, z: 0, level: 1 } }, targets: [ids[1]!] },
      rotate: { args: { instanceIds: [ids[1]], axis: 'y', degrees: 90 }, targets: [ids[1]!] },
      set_transform: { args: { instanceIds: [ids[1]], pose }, targets: [ids[1]!] },
      set_color: { args: { instanceIds: [ids[1]], colorId: 'c:blue' }, targets: [ids[1]!] },
      delete: { args: { instanceIds: [ids[1]] }, targets: [ids[1]!] },
      create_group: { args: { instanceIds: [ids[1]], name: 'g' }, targets: [ids[1]!] },
      create_submodel: { args: { instanceIds: [ids[1]], name: 's' }, targets: [ids[1]!] },
      make_unique: { args: { instanceId: ids[1] }, targets: [ids[1]!] },
      replace_color: { args: { fromColorId: 'c:red', toColorId: 'c:blue' }, targets: ids },
      ungroup: { args: { groupIds: [groupId] }, targets: ids.slice(0, 2) },
      place_part: { args: { partId: 'ld:3001', colorId: 'c:red', pose }, targets: [] },
      instantiate_submodel: { args: { submodelId: 'sub', pose }, targets: [] },
      add_reference_image: {
        args: { image: { type: 'image', mime: 'image/png', base64: 'AQID' }, name: 'r' },
        targets: [],
      },
      make_mosaic: { args: { referenceId: 'ref', width: 1, height: 1, name: 'm' }, targets: [] },
      batch: { args: { operations: [{ tool: 'delete', arguments: { instanceIds: [ids[1]] } }] }, targets: [] },
    };
    expect(Object.keys(cases).sort()).toEqual([...mutationNames].sort());
    for (const [name, c] of Object.entries(cases)) {
      const tool = name as ToolName,
        parsed = toolSchemas[tool].parse(c.args);
      expect(
        mutationTargets(tool, parsed, doc, [], (ids) => ids.map((id) => [id])),
        name,
      ).toEqual(c.targets.map((id) => [id]));
    }
  });
  it('validates optional scope and mention fields without accepting arbitrary data', () => {
    const turn = {
      providerId: 'p',
      model: 'm',
      effort: 'balanced',
      text: 'test',
      images: [],
      selection: true,
      modelContext: true,
    };
    expect(
      turnSchema.safeParse({
        ...turn,
        scope: { paths: [['id']] },
        mentions: [{ type: 'submodel', id: 's', name: '车身', count: 2 }],
      }).success,
    ).toBe(true);
    expect(turnSchema.safeParse({ ...turn, scope: { paths: [[]] } }).success).toBe(false);
  });
});
describe('plain text references', () => {
  it('retains distinct chosen identities with the same display name through plain text edits', () => {
    const first = { type: 'submodel' as const, id: 'first', name: '车身', count: 1 },
      second = { ...first, id: 'second' };
    const text = '@车身 @车身',
      bindings = [
        { start: 0, end: 3, mention: first },
        { start: 4, end: 7, mention: second },
      ];
    const changed = `修改 ${text}`,
      shifted = reconcileMentionTokens(text, changed, bindings);
    expect(resolveMentions(changed, [first, second], [first, second], shifted).mentions).toEqual([first, second]);
    expect(resolveMentions(changed, [first, second], [second], shifted)).toMatchObject({
      text: '修改  @车身',
      removed: ['车身'],
      mentions: [second],
    });
    expect(reconcileMentionTokens(text, '@车门 @车身', bindings)).toEqual([bindings[1]]);
  });
  it('deduplicates markers, omits removed text and drops deleted objects', () => {
    const car = { type: 'submodel' as const, id: 'car', name: '车身', count: 3 },
      wheel = { ...car, id: 'wheel', name: '车轮' };
    expect(resolveMentions('@车身 @车身 改色', [car], [car]).mentions).toEqual([car]);
    expect(resolveMentions('改色', [car], [car]).mentions).toEqual([]);
    expect(resolveMentions('@车轮 改色 @车身', [car, wheel], [car])).toEqual({
      text: ' 改色 @车身',
      mentions: [car],
      removed: ['车轮'],
    });
    expect(resolveMentions('@车身体积', [car], [car]).mentions).toEqual([]);
  });
  it('takes @selection at send time and supplies all five candidate categories', () => {
    const { doc, ids } = fixture();
    const sub = createModel('车身', 'submodel');
    doc.models[sub.id] = sub;
    doc.referenceImages.ref = { hash: 'fixture', name: '设计图' };
    const labels = { selection: '选中', step: (n: number) => `步骤 ${n}`, color: (id: string) => id };
    const before = mentionCandidates(doc, [], [[ids[0]!]], labels),
      after = mentionCandidates(doc, [], [[ids[1]!]], labels);
    expect(resolveMentions('@选中', before, after).mentions[0]?.paths).toEqual([[ids[1]!]]);
    expect(after.map((m) => m.type)).toEqual(['selection', 'submodel', 'step', 'color', 'reference']);
  });
});
