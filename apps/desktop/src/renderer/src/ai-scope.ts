import { expandInstances, groupAncestors, orderedInstances, pathStartsWith } from '@brickloop/core';
import type { BrkDocument, InstancePath } from '@brickloop/core';
import type { ToolInput, ToolName, ToolResult } from '@brickloop/ai';
import { scriptTargets } from '../../shared/buildscript-document';

/** Immutable task-start identities. Reparenting never grants an existing instance access. */
export class SelectionScope {
  private readonly original = new Map<string, InstancePath[]>();
  readonly paths: InstancePath[];
  constructor(base: BrkDocument, paths: InstancePath[]) {
    this.paths = structuredClone(paths);
    for (const model of Object.values(base.models))
      for (const id of Object.keys(model.instances)) this.original.set(id, []);
    const walk = (modelId: string, parent: InstancePath) => {
      for (const item of orderedInstances(base.models[modelId]!)) {
        const path = [...parent, item.id];
        this.original.get(item.id)!.push(path);
        if (item.ref.kind === 'model') walk(item.ref.modelId, path);
      }
    };
    walk(base.rootModelId, []);
  }
  check(targets: InstancePath[]): Extract<ToolResult, { ok: false }> | undefined {
    const rejected = new Set<string>();
    for (const target of targets) {
      const original = this.original.get(target.at(-1)!);
      if (!original) continue; // Only identities absent from the start document are new.
      if (!original.length) rejected.add(target.join('/'));
      for (const path of original)
        if (!this.paths.some((allowed) => pathStartsWith(path, allowed))) rejected.add(path.join('/'));
    }
    if (rejected.size)
      return {
        ok: false,
        code: 'OUT_OF_SCOPE',
        message:
          'Targets are outside the task-start selection. Use allowed instances or make the selected submodel unique before editing shared contents.',
        details: {
          rejected: [...rejected],
          allowed: this.paths.slice(0, 50).map((p) => p.join('/')),
          allowedTotal: this.paths.length,
        },
      };
    return undefined;
  }
}

/** Mirrors the host's command targets; batch children are checked immediately before each execution. */
export function mutationTargets<K extends ToolName>(
  name: K,
  value: ToolInput<K>,
  doc: BrkDocument,
  modelPath: InstancePath,
  resolve: (ids: string[]) => InstancePath[],
): InstancePath[] {
  const call = { name, value } as { [P in ToolName]: { name: P; value: ToolInput<P> } }[ToolName];
  switch (call.name) {
    case 'run_build_script':
      // SelectionScope resolves every original occurrence by identity, including shared definitions.
      // A singleton path also covers uninstantiated definitions without an ambiguous path lookup.
      return call.value.mode === 'replace' ? scriptTargets(doc, call.value.scriptId).map((v) => [v.instanceId]) : [];
    case 'move':
    case 'rotate':
    case 'set_transform':
    case 'set_color':
    case 'delete':
    case 'create_group':
    case 'create_submodel':
      return resolve(call.value.instanceIds);
    case 'make_unique':
      return resolve([call.value.instanceId]);
    case 'replace_color':
      return expandInstances(doc)
        .filter(
          (row) =>
            pathStartsWith(row.path, call.value.modelPath ?? modelPath) && row.colorId === call.value.fromColorId,
        )
        .map((row) => row.path);
    case 'ungroup': {
      const groups = new Set(call.value.groupIds);
      // Include nested groups: dissolving their ancestor changes their membership hierarchy too.
      return resolve([
        ...new Set(
          Object.values(doc.models).flatMap((model) =>
            Object.values(model.instances)
              .filter((item) => groupAncestors(doc, item.groupId).some((group) => groups.has(group.id)))
              .map((item) => item.id),
          ),
        ),
      ]);
    }
    case 'place_part':
    case 'instantiate_submodel':
    case 'add_reference_image':
    case 'make_mosaic':
    case 'batch':
      return [];
    default:
      return [];
  }
}
