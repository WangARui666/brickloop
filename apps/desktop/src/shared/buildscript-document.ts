import {
  createModel,
  expandInstances,
  multiply,
  rotationAxisAngle,
  toLDraw,
  transformPoint,
  translation,
  ulid,
} from '@brickloop/core';
import type { BrkDocument, Instance, ModelDef, Op } from '@brickloop/core';
import type { ProjectAssets } from '@brickloop/io';
import type { ToolInput } from '@brickloop/ai';
import type { BuildPose } from '../../../../packages/buildscript/src/types';
import { documentPartId, rawPartId } from './buildscript-catalog';
import type { BuildCatalog, BuildResult, BuildStats } from './buildscript-catalog';

export const SCRIPT_EXTENSION = 'brickloop.buildScripts';
export interface SavedBuildScript {
  scriptId: string;
  name: string;
  code: string;
  target: string;
  targetId: string;
  scope: 'factory' | 'all';
  seed: number;
  hash: string;
  updatedAt: string;
  stats: BuildStats;
}
export interface ScriptOutput {
  instanceIds: string[];
  hash: string;
  snapshots: Record<string, string>;
  models: Record<string, string>;
  modelIds?: string[];
  detachedModelIds?: string[];
  script: SavedBuildScript;
}
export class BuildScriptFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function scriptOutputs(doc: BrkDocument): ScriptOutput[] {
  return Object.values(doc.models).flatMap((model) => {
    const entries = model.extensions[SCRIPT_EXTENSION];
    if (!entries || typeof entries !== 'object') return [];
    return Object.values(entries).filter(
      (v): v is ScriptOutput =>
        !!v &&
        typeof v === 'object' &&
        typeof v.script?.scriptId === 'string' &&
        v.script.targetId === model.id &&
        typeof v.script?.code === 'string' &&
        Array.isArray(v.instanceIds),
    );
  });
}
export function findScript(doc: BrkDocument, id: string) {
  return scriptOutputs(doc).find((v) => v.script.scriptId === id);
}
export function scriptForModel(doc: BrkDocument, modelId: string) {
  return scriptOutputs(doc).filter(
    (v) =>
      v.instanceIds.length &&
      (v.script.targetId === modelId || (v.modelIds ?? Object.values(v.models)).includes(modelId)),
  );
}
export function scriptTargets(doc: BrkDocument, id: string) {
  const ids = new Set(findScript(doc, id)?.instanceIds ?? []);
  return Object.values(doc.models).flatMap((model) =>
    Object.keys(model.instances)
      .filter((id) => ids.has(id))
      .map((instanceId) => ({ modelId: model.id, instanceId })),
  );
}
const snapshot = (modelId: string, instance: Instance) => JSON.stringify([modelId, instance]);
export function editedScriptOutput(doc: BrkDocument, id: string) {
  const output = findScript(doc, id);
  if (!output) return false;
  const current = new Map(
    scriptTargets(doc, id).map(({ modelId, instanceId }) => [
      instanceId,
      snapshot(modelId, doc.models[modelId]!.instances[instanceId]!),
    ]),
  );
  return output.instanceIds.some((id) => current.get(id) !== output.snapshots[id]);
}

/** Strict single-file unified diff: no fuzzy matching or silent partial patches. */
export function patchBuildScript(code: string, patch: string): string {
  const normalized = code.replaceAll('\r\n', '\n'),
    sourceNewline = normalized.endsWith('\n');
  const lines = normalized ? normalized.split('\n') : [];
  if (sourceNewline) lines.pop();
  const diff = patch.replaceAll('\r\n', '\n').split('\n');
  const result: string[] = [];
  let cursor = 0,
    hunks = 0,
    i = 0,
    outputNewline = sourceNewline;
  const invalid = () => {
    throw new BuildScriptFailure('INVALID_PATCH', 'Unified diff does not match the saved script.', {
      line: i + 1,
      column: 1,
    });
  };
  while (i < diff.length && !diff[i]!.startsWith('@@')) {
    if (!/^(--- |\+\+\+ |diff |index |$)/.test(diff[i]!)) invalid();
    i++;
  }
  while (i < diff.length) {
    if (i === diff.length - 1 && diff[i] === '') break;
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(diff[i++]!);
    if (!h) invalid();
    const oldCount = Number(h![2] ?? 1),
      newCount = Number(h![4] ?? 1);
    const start = Number(h![1]) - (oldCount ? 1 : 0);
    if (start < cursor || start > lines.length) invalid();
    result.push(...lines.slice(cursor, start));
    cursor = start;
    if (Number(h![3]) - (newCount ? 1 : 0) !== result.length) invalid();
    let removed = 0,
      added = 0,
      previousOp = '',
      hunkNewline = true;
    while (i < diff.length && !diff[i]!.startsWith('@@')) {
      const row = diff[i++]!;
      if (row === '\\ No newline at end of file') {
        if (previousOp === '+' || previousOp === ' ') hunkNewline = false;
        else if (previousOp !== '-') invalid();
        continue;
      }
      if (!row && i === diff.length) break;
      const op = row[0],
        body = row.slice(1);
      if (op === ' ' || op === '-') {
        if (lines[cursor++] !== body) invalid();
        removed++;
      }
      if (op === ' ' || op === '+') {
        result.push(body);
        added++;
        hunkNewline = true;
      } else if (op !== '-') invalid();
      previousOp = op!;
    }
    if (removed !== oldCount || added !== newCount) invalid();
    if (cursor === lines.length) outputNewline = hunkNewline;
    hunks++;
  }
  if (!hunks) invalid();
  const output = [...result, ...lines.slice(cursor)];
  return output.join('\n') + (output.length && outputNewline ? '\n' : '');
}
export function prepareBuildScript(
  doc: BrkDocument,
  input: ToolInput<'run_build_script'>,
  imageScope?: 'factory' | 'all',
) {
  const previous = findScript(doc, input.scriptId);
  const code =
    input.code ??
    (input.patch !== undefined
      ? patchBuildScript(
          previous?.script.code ??
            (() => {
              throw new BuildScriptFailure('SCRIPT_NOT_FOUND', 'Read or create the script before patching.');
            })(),
          input.patch,
        )
      : previous?.script.code);
  if (code === undefined) throw new BuildScriptFailure('SCRIPT_NOT_FOUND', 'A new script requires code.');
  let target: ModelDef | undefined;
  if (input.target === undefined && previous) target = doc.models[previous.script.targetId];
  else if (!input.target || input.target === 'root' || input.target === '根模型') target = doc.models[doc.rootModelId];
  else {
    const matches = Object.values(doc.models).filter((m) => m.name === input.target);
    if (matches.length > 1) throw new BuildScriptFailure('AMBIGUOUS_MODEL', 'Target name identifies multiple models.');
    target = matches[0];
  }
  if (!target) throw new BuildScriptFailure('MODEL_NOT_FOUND', 'Target model does not exist.');
  if (previous && previous.script.targetId !== target.id)
    throw new BuildScriptFailure('SCRIPT_TARGET_MISMATCH', 'Use a new scriptId for a different target model.');
  return {
    code,
    target,
    previous,
    scope: input.scope ?? previous?.script.scope ?? imageScope ?? 'factory',
    seed: input.seed ?? previous?.script.seed ?? 0,
    name: input.name ?? previous?.script.name ?? input.scriptId,
  };
}
export function buildPoseMatrix(p: BuildPose): number[] {
  return p.matrixLdu
    ? [...p.matrixLdu]
    : toLDraw(multiply(translation([p.x * 20, -p.level * 8, p.z * 20]), rotationAxisAngle([0, -1, 0], p.rotY)));
}
/** Whole-model patches avoid O(n²) step insertion and retain ordinary undo/merge semantics. */
export function buildScriptOps(
  doc: BrkDocument,
  input: ToolInput<'run_build_script'>,
  prepared: ReturnType<typeof prepareBuildScript>,
  result: BuildResult,
) {
  const changed = new Map<string, ModelDef>();
  const edit = (model: ModelDef) => {
    let next = changed.get(model.id);
    if (!next) {
      next = {
        ...model,
        instances: { ...model.instances },
        steps: Object.fromEntries(
          Object.entries(model.steps).map(([id, s]) => [id, { ...s, instanceIds: [...s.instanceIds] }]),
        ),
        extensions: { ...model.extensions },
      };
      changed.set(model.id, next);
    }
    return next;
  };
  const removed = input.mode === 'replace' ? scriptTargets(doc, input.scriptId) : [];
  const removedIds = new Set(removed.map((v) => v.instanceId));
  for (const row of removed) delete edit(doc.models[row.modelId]!).instances[row.instanceId];
  for (const model of changed.values())
    for (const step of Object.values(model.steps))
      step.instanceIds = step.instanceIds.filter((id) => !removedIds.has(id));
  const target = edit(prepared.target),
    modelIds = Object.create(null) as Record<string, string>;
  const definitions = new Map<string | null, ModelDef>([[null, target]]);
  // Released definitions are ordinary geometry. Adding a second generation to their
  // shared definition would also change the old visible output (and multiply it).
  const excluded = new Set([
    ...(prepared.previous?.detachedModelIds ?? []),
    ...(input.mode === 'add' ? (prepared.previous?.modelIds ?? Object.values(prepared.previous?.models ?? {})) : []),
  ]);
  for (const sub of result.submodels) {
    if (sub.name === null) continue;
    const previousModel = input.mode === 'replace' ? doc.models[prepared.previous?.models[sub.name] ?? ''] : undefined;
    const matches =
      previousModel && !excluded.has(previousModel.id)
        ? [previousModel]
        : Object.values(doc.models).filter((m) => m.name === sub.name && m.id !== target.id && !excluded.has(m.id));
    if (matches.length > 1) throw new BuildScriptFailure('AMBIGUOUS_MODEL', `Multiple submodels named ${sub.name}.`);
    const model = edit(matches[0] ?? createModel(sub.name));
    definitions.set(sub.name, model);
    modelIds[sub.name] = model.id;
  }
  const created: string[] = [],
    snapshots: Record<string, string> = input.mode === 'add' ? { ...prepared.previous?.snapshots } : {};
  const add = (model: ModelDef, ref: Instance['ref'], colorId: string, pose: BuildPose) => {
    const instance: Instance = {
      id: ulid(),
      ref,
      colorId,
      transform: buildPoseMatrix(pose),
      stepId: model.stepIds[0]!,
      groupId: null,
    };
    model.instances[instance.id] = instance;
    model.steps[instance.stepId]!.instanceIds.push(instance.id);
    created.push(instance.id);
    snapshots[instance.id] = snapshot(model.id, instance);
  };
  for (const part of result.instances)
    add(
      definitions.get(part.submodel)!,
      { kind: 'part', partId: documentPartId(part.partId) },
      part.colorId,
      part.pose,
    );
  for (const sub of result.submodels)
    for (const placement of sub.instances)
      add(
        definitions.get(sub.name)!,
        { kind: 'model', modelId: definitions.get(placement.name)!.id },
        'inherit',
        placement.pose,
      );
  const script: SavedBuildScript = {
    scriptId: input.scriptId,
    name: prepared.name,
    code: prepared.code,
    target: target.id === doc.rootModelId ? 'root' : target.name,
    targetId: target.id,
    scope: prepared.scope,
    seed: prepared.seed,
    hash: result.hash,
    stats: result.stats,
    updatedAt: new Date().toISOString(),
  };
  const output: ScriptOutput = {
    script,
    hash: result.hash,
    instanceIds: [...(input.mode === 'add' ? (prepared.previous?.instanceIds ?? []) : []), ...created],
    snapshots,
    models: modelIds,
    modelIds: [
      ...new Set([
        ...(input.mode === 'add'
          ? (prepared.previous?.modelIds ?? Object.values(prepared.previous?.models ?? {}))
          : []),
        ...Object.values(modelIds),
      ]),
    ],
    detachedModelIds: prepared.previous?.detachedModelIds ?? [],
  };
  target.extensions[SCRIPT_EXTENSION] = {
    ...(target.extensions[SCRIPT_EXTENSION] as object),
    [input.scriptId]: output,
  };
  const ops: Op[] = [
    { type: 'model.add', items: [...changed.values()].filter((m) => !doc.models[m.id]) },
    {
      type: 'model.update',
      items: [...changed.values()].filter((m) => doc.models[m.id]).map((m) => ({ modelId: m.id, changes: m })),
    },
  ];
  return { ops, created, removed: removed.map((r) => r.instanceId), models: modelIds, output };
}

export function detachBuildScript(doc: BrkDocument, scriptId: string): Op[] {
  const output = findScript(doc, scriptId);
  if (!output) return [];
  const target = doc.models[output.script.targetId]!;
  return [
    {
      type: 'model.update',
      items: [
        {
          modelId: target.id,
          changes: {
            extensions: {
              ...target.extensions,
              [SCRIPT_EXTENSION]: {
                ...(target.extensions[SCRIPT_EXTENSION] as object),
                [scriptId]: {
                  ...output,
                  instanceIds: [],
                  snapshots: {},
                  models: {},
                  modelIds: [],
                  detachedModelIds: [
                    ...new Set([
                      ...(output.detachedModelIds ?? []),
                      ...(output.modelIds ?? Object.values(output.models)),
                    ]),
                  ],
                },
              },
            },
          },
        },
      ],
    },
  ];
}

/** Project members are a projection of undoable metadata, so undo and three-way merge cannot leave stale script files. */
export function buildScriptAssets(doc: BrkDocument, assets: ProjectAssets): ProjectAssets {
  const outputs = scriptOutputs(doc),
    result = { ...assets };
  for (const key of Object.keys(result)) if (/^ai\/scripts\//.test(key)) delete result[key];
  const encoder = new TextEncoder();
  if (outputs.length) {
    result['ai/scripts/index.json'] = encoder.encode(
      JSON.stringify(
        outputs.map(({ script: { code: _code, ...metadata } }) => {
          void _code;
          return metadata;
        }),
      ),
    );
    for (const { script } of outputs) result[`ai/scripts/${script.scriptId}.js`] = encoder.encode(script.code);
  }
  return result;
}

export function buildModelBounds(doc: BrkDocument, modelIds: Record<string, string>, catalog: BuildCatalog) {
  const sizes = new Map(catalog.parts.map((p) => [p.id, p.size]));
  return Object.entries(modelIds).map(([name, modelId]) => {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    let unknown = 0;
    for (const row of expandInstances({ ...doc, rootModelId: modelId })) {
      const id = rawPartId(row.partId),
        s = sizes.get(id);
      const b = catalog.boundsLdu?.[id] ?? (s ? [-s.w * 10, 0, -s.d * 10, s.w * 10, s.h * 8, s.d * 10] : undefined);
      if (!b) {
        unknown++;
        continue;
      }
      for (const x of [b[0]!, b[3]!])
        for (const y of [b[1]!, b[4]!])
          for (const z of [b[2]!, b[5]!]) {
            const p = transformPoint(row.worldMatrix, [x, y, z]),
              grid = [p[0] / 20, -p[1] / 8, p[2] / 20];
            for (let k = 0; k < 3; k++) {
              min[k] = Math.min(min[k]!, grid[k]!);
              max[k] = Math.max(max[k]!, grid[k]!);
            }
          }
    }
    return {
      name,
      modelId,
      bounds: Number.isFinite(min[0])
        ? { min: { x: min[0], level: min[1], z: min[2] }, max: { x: max[0], level: max[1], z: max[2] } }
        : null,
      unknownSizes: unknown,
    };
  });
}
