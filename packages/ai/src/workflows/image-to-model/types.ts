import type { AgentBudget, AgentEvent, AgentStopReason } from '../../agent/runtime.js';
import type { EditorHost, ValidationIssue } from '../../tools/index.js';
import type { ImageBlock, JsonValue, ModelProvider, TokenUsage, PublicAiError } from '../../types.js';
import type { StructurePlan, standardReferenceViews } from './plan.js';
import type { DailyCostLedger, PriceTable } from '../../cost.js';
import type { PlanColor, PlanColorRepair } from './colors.js';
import type { PlanBoxRepair } from './boxes.js';
import type { ModelActivity } from '../../types.js';

export type StandardReferenceView = (typeof standardReferenceViews)[number];
export type ReferenceView = StandardReferenceView | 'auto' | 'exclude' | 'unknown';
export interface ImageModelInput {
  viewMode?: 'fixed' | 'auto';
  description?: string;
  images?: { name: string; image: ImageBlock; view: ReferenceView }[];
  targetSize?: { width?: number; depth?: number; height?: number } | 'small' | 'medium' | 'large';
  palette?: { source: 'factory' | 'project' | 'custom'; colorIds?: string[] };
  parts?: { source: 'factory' | 'categories' | 'all'; categories?: string[] };
  style?: string;
  priority?: 'appearance' | 'buildable';
}
export type WorkflowPhase =
  'understanding' | 'preparing' | 'drafting' | 'iterating' | 'detailing' | 'buildability' | 'finishing' | 'finished';
export interface WorkflowState {
  modelActivity?: { startedAt: number; receivedAt: number | null; counts: ModelActivity };
  phase: WorkflowPhase;
  paused: boolean;
  awaitingConfirmation: boolean;
  documentLocked: boolean;
  componentId: string | null;
  componentIndex: number;
  round: number;
  toolCalls: number;
  elapsedMs: number;
}
export type WorkflowStopReason =
  | 'completed'
  | 'user_stopped'
  | 'round_budget'
  | 'tool_budget'
  | 'time_budget'
  | 'input_budget'
  | 'daily_cost_limit'
  | 'engine_unavailable'
  | 'error';
export interface WorkflowRound {
  round: number;
  phase: WorkflowPhase;
  partCount: number;
  colorCount: number;
  comparisons: ViewComparison[];
  images: ImageBlock[];
  issues: ValidationIssue[];
  warnings: string[];
  summary: string;
}
export interface ViewComparison {
  referenceId: string;
  view: StandardReferenceView;
  inferredView: boolean;
  confidence: number | null;
  componentId: string | null;
  round: number;
  iou: number;
  colorDifference: number | null;
  boundsRatioDifference?: number | null;
  emptyModel?: boolean;
  images: ImageBlock[];
}
export interface ReferenceViewReport {
  referenceId: string;
  name: string;
  view: StandardReferenceView | null;
  source: 'designer' | 'ai' | 'excluded';
  confidence: number | null;
  iou: number | null;
}
export interface WorkflowReport {
  rounds: WorkflowRound[];
  script: { scriptId: string; code: string } | null;
  buildabilitySkipped: boolean;
  reason: WorkflowStopReason;
  plan: StructurePlan | null;
  components: { componentId: string; submodelId: string; modelPath: string[]; checked: boolean }[];
  partCount: number | null;
  colorCount: number | null;
  validation: { checked: boolean; issues: ValidationIssue[] };
  checks: { componentId: string | null; round: number; issues: ValidationIssue[] }[];
  comparisons: ViewComparison[];
  references: ReferenceViewReport[];
  latestRender: ImageBlock[];
  unfinished: { code: string; componentId?: string }[];
  interjections: string[];
  toolCalls: number;
  elapsedMs: number;
  usage: TokenUsage;
  transaction: 'none' | 'committed' | 'commit_failed';
  summaryZh: string;
  failure?: {
    stage: 'planning' | 'preparing' | 'round';
    round?: number;
    agentReason?: AgentStopReason;
    error?: PublicAiError;
    attempts?: number;
  };
}
export type WorkflowEvent =
  | { type: 'state'; state: WorkflowState }
  | {
      type: 'plan';
      plan: StructurePlan;
      repairs: string[];
      colorRepairs: PlanColorRepair[];
      boxRepairs: PlanBoxRepair[];
      paletteColorIds?: string[];
    }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'comparison'; comparison: ViewComparison }
  | { type: 'round'; round: WorkflowRound; script: WorkflowReport['script'] }
  | { type: 'finished'; report: WorkflowReport };
export interface ImageToModelOptions {
  provider: ModelProvider;
  model: string;
  host: EditorHost;
  input: ImageModelInput;
  directStart?: boolean;
  /** Resolved task palette and catalog snapshot from the host, before planning starts. */
  colors?: { palette: PlanColor[]; catalog: PlanColor[] };
  /** Called once per original reference, before planning; project assets retain the original block. */
  prepareReferenceImage?: (image: ImageBlock) => ImageBlock | Promise<ImageBlock>;
  budget?: Pick<AgentBudget, 'toolCalls' | 'durationMs' | 'inputTokens' | 'dailyCostLimit'> & { rounds?: number };
  /** Resolve from the confirmed (possibly edited) plan, before shared token accounting. */
  designGuides?: (plan: StructurePlan) => string;
  matchingExamples?: (plan: StructurePlan, examples: JsonValue) => JsonValue;
  ledger?: DailyCostLedger;
  prices?: PriceTable;
  signal?: AbortSignal;
  improvementEpsilon?: number;
  /** Test harness override, forwarded to the agent. */
  retryDelayMs?: number;
  streamStallMs?: number;
  /** UI lock/progress adapter; called synchronously, including pause/resume and transaction cleanup. */
  onState?: (state: WorkflowState) => void;
}
