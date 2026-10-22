import type { ValidationIssue } from '../../tools/index.js';
import type { WorkflowPhase } from './types.js';
const transitions: Record<WorkflowPhase, readonly WorkflowPhase[]> = {
  understanding: ['preparing', 'finishing'],
  preparing: ['drafting', 'finishing'],
  drafting: ['iterating', 'detailing', 'buildability', 'finishing'],
  iterating: ['iterating', 'detailing', 'buildability', 'finishing'],
  detailing: ['detailing', 'buildability', 'finishing'],
  buildability: ['buildability', 'finishing'],
  finishing: ['finished'],
  finished: [],
};
export function transitionPhase(from: WorkflowPhase, to: WorkflowPhase): WorkflowPhase {
  if (!transitions[from].includes(to)) throw new Error('Invalid workflow phase transition: ' + from + ' -> ' + to);
  return to;
}
/** A plateau may finish a scope only after a fresh validation with zero issues. */
export function selfCheckComplete(
  issues: readonly ValidationIssue[],
  previous: readonly number[] | null,
  current: readonly number[],
  epsilon = 0.005,
): boolean {
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('Invalid improvement epsilon.');
  if (issues.length) return false;
  if (current.length === 0) return true;
  if (!previous || previous.length !== current.length) return false;
  return current.every(
    (value, i) =>
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1 &&
      Number.isFinite(previous[i]) &&
      value - previous[i]! <= epsilon,
  );
}

/** Visual convergence is independent of buildability; the runtime requires two plateaus. */
export function metricsPlateau(
  previous: readonly number[] | null,
  current: readonly number[],
  epsilon = 0.005,
): boolean {
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new RangeError('Invalid improvement epsilon.');
  return (
    previous !== null &&
    previous.length === current.length &&
    current.every((v, i) => Number.isFinite(v) && Number.isFinite(previous[i]) && v - previous[i]! <= epsilon)
  );
}
