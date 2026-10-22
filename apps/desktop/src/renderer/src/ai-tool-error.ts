const errors: Record<string, string> = {
  ENGINE_UNAVAILABLE: 'aiToolErrors.engineUnavailable',
  SYNTAX: 'aiToolErrors.script',
  RUNTIME: 'aiToolErrors.script',
  TIMEOUT: 'aiToolErrors.script',
  MEMORY: 'aiToolErrors.script',
  LIMIT: 'aiToolErrors.script',
  PART_NOT_ALLOWED: 'aiToolErrors.script',
  OUT_OF_SCOPE: 'aiToolErrors.outOfScope',
  REFERENCE_EMPTY: 'aiToolErrors.referenceEmpty',
  REFERENCE_NOT_COMPARABLE: 'aiToolErrors.referenceNotComparable',
  WORKFLOW_SCRIPT: 'aiToolErrors.workflowScript',
  EMPTY_FOREGROUND: 'aiToolErrors.emptyForeground',
  REFERENCE_NOT_FOUND: 'aiToolErrors.referenceMissing',
  VIEW_MISMATCH: 'aiToolErrors.viewMismatch',
  INVALID_ARGUMENTS: 'aiToolErrors.invalidArguments',
  CANCELLED: 'aiToolErrors.cancelled',
  TOOL_BUDGET: 'aiToolErrors.budget',
  RENDER_ASSET_MISSING: 'aiToolErrors.geometryMissing',
};
export function toolErrorKey(code: string): string {
  return errors[code] ?? 'aiToolErrors.failed';
}
