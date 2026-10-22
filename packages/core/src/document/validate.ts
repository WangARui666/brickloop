import { isUlid } from './id';
import type { BrkDocument, DocumentIssue } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates untrusted JSON too; never assumes the caller has a well-formed object. */
export function validateDocument(value: unknown): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const add = (code: string, path: string) => {
    issues.push({ code, path, messageKey: `core.validation.${code}`, severity: 'error' });
  };
  const record = (v: unknown, path: string): v is Record<string, unknown> => {
    if (isRecord(v)) return true;
    add('STRUCTURE', path);
    return false;
  };
  const string = (v: unknown, path: string) => {
    if (typeof v !== 'string') add('STRUCTURE', path);
  };
  const identifier = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !isUlid(v)) add('IDENTIFIER', path);
  };
  const ids = (v: unknown, path: string) => {
    if (!Array.isArray(v)) {
      add('STRUCTURE', path);
      return;
    }
    for (const [i, id] of v.entries()) identifier(id, `${path}.${i}`);
  };
  const vector = (v: unknown, size: number, path: string) => {
    if (!Array.isArray(v) || v.length !== size || !v.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)))
      add('STRUCTURE', path);
  };
  if (!record(value, '')) return issues;
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1)
    add('SCHEMA_VERSION', 'schemaVersion');
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) add('REVISION', 'revision');
  identifier(value.documentId, 'documentId');
  identifier(value.rootModelId, 'rootModelId');
  record(value.extensions, 'extensions');
  if (record(value.meta, 'meta'))
    for (const key of ['title', 'author', 'createdAt', 'notes']) string(value.meta[key], `meta.${key}`);
  if (record(value.catalogPack, 'catalogPack'))
    for (const key of ['id', 'version']) string(value.catalogPack[key], `catalogPack.${key}`);
  for (const key of ['embeddedParts', 'referenceImages'])
    if (record(value[key], key)) {
      for (const [id, asset] of Object.entries(value[key])) {
        if (key === 'referenceImages') identifier(id, `${key}.${id}`);
        else if (!/^(ld|cu):.+$/.test(id)) add('PART_ID', `${key}.${id}`);
        if (record(asset, `${key}.${id}`)) string(asset.hash, `${key}.${id}.hash`);
      }
    }
  if (record(value.models, 'models'))
    for (const [key, model] of Object.entries(value.models)) {
      const path = `models.${key}`;
      if (!record(model, path)) continue;
      identifier(model.id, `${path}.id`);
      if (key !== model.id) add('KEY_MISMATCH', path);
      string(model.name, `${path}.name`);
      if (model.kind !== 'main' && model.kind !== 'submodel') add('STRUCTURE', `${path}.kind`);
      record(model.extensions, `${path}.extensions`);
      ids(model.stepIds, `${path}.stepIds`);
      if (record(model.steps, `${path}.steps`))
        for (const [sid, step] of Object.entries(model.steps)) {
          const sp = `${path}.steps.${sid}`;
          if (!record(step, sp)) continue;
          identifier(step.id, `${sp}.id`);
          if (sid !== step.id) add('KEY_MISMATCH', sp);
          ids(step.instanceIds, `${sp}.instanceIds`);
          if (step.description !== undefined) string(step.description, `${sp}.description`);
          if (step.camera !== undefined && record(step.camera, `${sp}.camera`)) {
            for (const k of ['position', 'target', 'up'])
              if (step.camera[k] !== undefined) vector(step.camera[k], 3, `${sp}.camera.${k}`);
            if (
              step.camera.fov !== undefined &&
              (typeof step.camera.fov !== 'number' || !Number.isFinite(step.camera.fov))
            )
              add('STRUCTURE', `${sp}.camera.fov`);
          }
        }
      if (record(model.instances, `${path}.instances`))
        for (const [iid, instance] of Object.entries(model.instances)) {
          const ip = `${path}.instances.${iid}`;
          if (!record(instance, ip)) continue;
          identifier(instance.id, `${ip}.id`);
          if (iid !== instance.id) add('KEY_MISMATCH', ip);
          identifier(instance.stepId, `${ip}.stepId`);
          if (instance.groupId !== null) identifier(instance.groupId, `${ip}.groupId`);
          vector(instance.transform, 12, `${ip}.transform`);
          if (typeof instance.colorId !== 'string' || !/^(inherit|(?:c|cx|ld):.+)$/.test(instance.colorId))
            add('COLOR_ID', `${ip}.colorId`);
          if (record(instance.ref, `${ip}.ref`)) {
            if (instance.ref.kind === 'model') identifier(instance.ref.modelId, `${ip}.ref.modelId`);
            else if (instance.ref.kind === 'part') {
              if (typeof instance.ref.partId !== 'string' || !/^(ld|cu):.+$/.test(instance.ref.partId))
                add('PART_ID', `${ip}.ref.partId`);
            } else add('STRUCTURE', `${ip}.ref.kind`);
          }
        }
    }
  if (record(value.groups, 'groups'))
    for (const [key, group] of Object.entries(value.groups)) {
      const path = `groups.${key}`;
      if (!record(group, path)) continue;
      identifier(group.id, `${path}.id`);
      if (key !== group.id) add('KEY_MISMATCH', path);
      identifier(group.modelId, `${path}.modelId`);
      string(group.name, `${path}.name`);
      if (group.parentGroupId !== null) identifier(group.parentGroupId, `${path}.parentGroupId`);
    }
  // Only access typed fields after the complete structural pass succeeds.
  if (issues.length) return issues;
  const doc = value as unknown as BrkDocument;
  const seenIds = new Set<string>([doc.documentId]);
  const unique = (id: string, path: string) => {
    if (seenIds.has(id)) add('DUPLICATE_ID', path);
    seenIds.add(id);
  };
  if (doc.models[doc.rootModelId]?.kind !== 'main') add('ROOT_MODEL', 'rootModelId');
  for (const model of Object.values(doc.models)) {
    const path = `models.${model.id}`;
    unique(model.id, path);
    if (
      !model.stepIds.length ||
      new Set(model.stepIds).size !== model.stepIds.length ||
      model.stepIds.some((id) => !doc.models[model.id]!.steps[id]) ||
      Object.keys(model.steps).some((id) => !model.stepIds.includes(id))
    )
      add('STEP_ORDER', `${path}.stepIds`);
    const membership = new Map<string, number>();
    for (const step of Object.values(model.steps)) {
      unique(step.id, `${path}.steps.${step.id}`);
      for (const id of step.instanceIds) {
        membership.set(id, (membership.get(id) ?? 0) + 1);
        if (model.instances[id]?.stepId !== step.id) add('STEP_MEMBERSHIP', `${path}.steps.${step.id}`);
      }
    }
    for (const instance of Object.values(model.instances)) {
      const ip = `${path}.instances.${instance.id}`;
      unique(instance.id, ip);
      if (membership.get(instance.id) !== 1 || !model.steps[instance.stepId]) add('STEP_MEMBERSHIP', ip);
      if (instance.ref.kind === 'model' && !doc.models[instance.ref.modelId]) add('MODEL_REFERENCE', ip);
      if (instance.groupId !== null && doc.groups[instance.groupId]?.modelId !== model.id) add('GROUP_MODEL', ip);
    }
  }
  // Iterative three-colour DFS detects cycles without overflowing the JS stack.
  const colors = new Map<string, number>();
  for (const id of Object.keys(doc.models)) {
    const stack: [string, boolean][] = [[id, false]];
    while (stack.length) {
      const [current, exit] = stack.pop()!;
      if (exit) {
        colors.set(current, 2);
        continue;
      }
      if (colors.get(current) === 1) {
        add('CYCLE', `models.${current}`);
        continue;
      }
      if (colors.get(current) === 2) continue;
      colors.set(current, 1);
      stack.push([current, true]);
      for (const instance of Object.values(doc.models[current]?.instances ?? {}))
        if (instance.ref.kind === 'model') stack.push([instance.ref.modelId, false]);
    }
  }
  for (const group of Object.values(doc.groups)) {
    const path = `groups.${group.id}`;
    unique(group.id, path);
    if (
      !doc.models[group.modelId] ||
      (group.parentGroupId !== null && doc.groups[group.parentGroupId]?.modelId !== group.modelId)
    )
      add('GROUP_MODEL', path);
    const visited = new Set<string>();
    let next: string | null = group.id;
    while (next !== null) {
      if (visited.has(next)) {
        add('GROUP_CYCLE', path);
        break;
      }
      visited.add(next);
      next = doc.groups[next]?.parentGroupId ?? null;
    }
  }
  return issues;
}
