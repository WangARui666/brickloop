import { ulid } from './id';
import type { IdGenerator } from './id';
import type { BrkDocument, DocumentMeta, ModelDef, Workspace } from './types';

export function createModel(name: string, kind: ModelDef['kind'] = 'submodel', id: IdGenerator = ulid): ModelDef {
  const modelId = id(),
    stepId = id();
  return {
    id: modelId,
    name,
    kind,
    stepIds: [stepId],
    steps: { [stepId]: { id: stepId, instanceIds: [] } },
    instances: {},
    extensions: {},
  };
}
export function createDocument(
  meta: Partial<DocumentMeta> = {},
  options: { id?: IdGenerator; now?: () => string; catalogPack?: BrkDocument['catalogPack'] } = {},
): BrkDocument {
  const id = options.id ?? ulid;
  const model = createModel(meta.title ?? '', 'main', id);
  return {
    schemaVersion: 1,
    documentId: id(),
    revision: 0,
    rootModelId: model.id,
    models: { [model.id]: model },
    groups: {},
    embeddedParts: {},
    referenceImages: {},
    meta: { title: '', author: '', createdAt: (options.now ?? (() => new Date().toISOString()))(), notes: '', ...meta },
    catalogPack: options.catalogPack ?? { id: '', version: '' },
    extensions: {},
  };
}
export function createWorkspace(): Workspace {
  return {
    activeModelPath: [],
    selection: [],
    hidden: [],
    camera: { mode: 'perspective', position: [200, -200, 200], target: [0, 0, 0], up: [0, -1, 0], fov: 45 },
    grid: { horizontal: 1, vertical: 'plate' },
    snapEnabled: true,
    collisionEnabled: true,
    panelState: {},
  };
}
export function updateWorkspace(workspace: Workspace, changes: Partial<Workspace>): Workspace {
  return { ...workspace, ...changes };
}
