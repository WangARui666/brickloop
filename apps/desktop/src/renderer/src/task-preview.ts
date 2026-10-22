import { diffDocuments, expandInstances, toLDraw } from '@brickloop/core';
import type { TaskPreview } from '@brickloop/viewport';
import type { PartId } from '@brickloop/catalog';
import { editorViewport, meshes, useDocumentStore } from './document-store';
import { getMesh } from './mesh-client';
import { useLibraryStore } from './library-store';
import { reviewOccurrences } from './review-overlay';
import { taskCopies, useTaskStore } from './ai-task-runtime';
let timer: ReturnType<typeof setTimeout> | undefined;
let last = 0,
  ticket = 0,
  key = '';
export function scheduleTaskPreview() {
  ticket++;
  timer ??= setTimeout(
    () => {
      timer = undefined;
      last = performance.now();
      void refreshPreview(ticket).catch(() => undefined);
    },
    Math.max(0, 500 - (performance.now() - last)),
  );
}
async function refreshPreview(generation: number) {
  const state = useTaskStore.getState(),
    id = state.previewId,
    copy = id ? taskCopies.get(id) : undefined;
  const editor = useDocumentStore.getState(),
    viewport = editorViewport();
  if (!viewport) return;
  if (!copy || copy.base.documentId !== editor.activeId || editor.reviewBefore) {
    if (key) viewport.setTaskPreview(null);
    key = '';
    return;
  }
  const doc = copy.working.session.document,
    diff = diffDocuments(copy.base, doc);
  const after = reviewOccurrences(doc),
    before = reviewOccurrences(copy.base);
  const added = new Set<string>(),
    removed = new Set<string>();
  for (const change of diff.instances) {
    if (change.after) for (const row of after.get(change.key) ?? []) added.add(row.path.join('/'));
    else for (const row of before.get(change.key) ?? []) removed.add(row.path.join('/'));
  }
  const rows = (document: typeof doc, paths: Set<string>) =>
    expandInstances(document)
      .filter((r) => r.path.some((_, i) => paths.has(r.path.slice(0, i + 1).join('/'))))
      .map((r) => ({ partId: r.partId, transform: toLDraw(r.worldMatrix) }));
  const preview: TaskPreview = { parts: rows(doc, added), removed: rows(copy.base, removed) };
  const content = `${id}/${JSON.stringify(preview)}`;
  if (content === key) return;
  for (const partId of new Set([...preview.parts, ...preview.removed].map((v) => v.partId))) {
    const mesh =
      meshes.get(partId) ??
      (await getMesh(partId as PartId, useLibraryStore.getState().status?.pack?.id ?? 'demo')).mesh;
    if (generation !== ticket) return;
    viewport.registerPart(partId, mesh);
  }
  if (generation !== ticket) return;
  key = content;
  viewport.setTaskPreview(preview);
}
