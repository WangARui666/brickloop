import { parentPort, workerData } from 'node:worker_threads';
import { packProject } from '@brickloop/io';
import type { ProjectPayload } from '../shared/project-api';
import { buildScriptAssets } from '../shared/buildscript-document';

const { appVersion } = workerData as { appVersion: string };

parentPort!.on('message', ({ id, project }: { id: number; project: ProjectPayload }) => {
  try {
    const bytes = packProject(project.doc, project.workspace, buildScriptAssets(project.doc, project.assets), {
      appVersion,
      ...(project.preservation
        ? {
            preservation: {
              ...project.preservation,
              members: Object.fromEntries(
                Object.entries(project.preservation.members).filter(([key]) => !key.startsWith('ai/scripts/')),
              ),
            },
          }
        : {}),
      ...(project.thumbnail ? { thumbnail: project.thumbnail } : {}),
    });
    const owned = new Uint8Array(bytes);
    parentPort!.postMessage({ id, bytes: owned }, [owned.buffer]);
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
