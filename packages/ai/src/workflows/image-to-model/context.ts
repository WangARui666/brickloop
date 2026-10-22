import type { ImageBlock, JsonValue, Message } from '../../types.js';
import type { ImageModelInput, WorkflowReport, WorkflowState } from './types.js';

/** A projection of workflow state, never AgentResult.history. One current image set only. */
export function roundContext(
  input: ImageModelInput,
  report: WorkflowReport,
  state: WorkflowState,
  lastRun: JsonValue,
  examples: JsonValue,
  amendments: readonly string[],
): Message {
  const latest = report.rounds.at(-1);
  const data = lastRun && typeof lastRun === 'object' && !Array.isArray(lastRun) ? lastRun : {};
  const models = Array.isArray(data.submodels) ? data.submodels : [];
  const missing = (report.plan?.components ?? []).filter(
    (component) =>
      !models.some(
        (m) =>
          m &&
          typeof m === 'object' &&
          !Array.isArray(m) &&
          (m.name === component.id || m.name === component.name) &&
          m.bounds,
      ),
  );
  const images: ImageBlock[] = latest
    ? [...latest.images, ...latest.comparisons.flatMap((c) => c.images)]
    : (input.images ?? []).map((r) => r.image);
  const unique = images.filter(
    (image, i) => images.findIndex((v) => v.base64 === image.base64 && v.mime === image.mime) === i,
  );
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'Script workflow round: ' +
          state.round +
          '\nPhase: ' +
          state.phase +
          '\nRequirements: ' +
          JSON.stringify({ ...input, images: undefined }) +
          '\nPlan: ' +
          JSON.stringify(report.plan) +
          '\nComponents not yet built (尚未建出的部件): ' +
          JSON.stringify(missing.map(({ id, name }) => ({ id, name }))) +
          '\nMain script: ' +
          JSON.stringify(report.script) +
          '\nLast run statistics, warnings and submodel bounds: ' +
          JSON.stringify(lastRun) +
          '\nLatest validation: ' +
          JSON.stringify(report.validation) +
          '\nLatest comparison metrics: ' +
          JSON.stringify(
            latest?.comparisons.map(({ images: _images, ...c }) => {
              void _images;
              return c;
            }) ?? [],
          ) +
          '\nReference images for compare_to_reference: ' +
          JSON.stringify(report.references) +
          '\nMatching examples (get_build_example reads full source): ' +
          JSON.stringify(examples) +
          '\nPrevious rounds (one line each):\n' +
          report.rounds.map((r) => r.summary).join('\n') +
          '\nDesigner amendments (apply this round, later preferences win):\n' +
          amendments.join('\n'),
      },
      {
        type: 'text',
        text: 'Latest image set only: current rendered views followed by reference/render comparison pairs (initial references in drafting).',
      },
      ...unique,
    ],
  };
}
