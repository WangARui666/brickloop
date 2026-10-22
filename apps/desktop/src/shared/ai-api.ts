import { z } from 'zod';
import type {
  AgentEvent,
  ImageBlock,
  Message,
  AgentResult,
  TokenUsage,
  PublicAiError,
  ModelCapabilities,
} from '@brickloop/ai';
import type { ChatGptAccount } from '@brickloop/ai/node';
import { structurePlanSchema, toolSchemas } from '@brickloop/ai/schemas';
import type { WorkflowEvent, WorkflowReport, CostEstimate, StructurePlan } from '@brickloop/ai';
import type { ConnectionResult } from './ai-setup';

export const referenceImagePreparationSchema = z.object({
  image: toolSchemas.add_reference_image.shape.image,
  policy: z.object({ longEdge: z.number().int().positive(), shortEdge: z.number().int().positive().optional() }),
});

export const imageTaskSchema = z.strictObject({
  providerId: z.string(),
  model: z.string().min(1).max(200),
  input: z
    .strictObject({
      viewMode: z.enum(['fixed', 'auto']).default('auto'),
      priority: z.enum(['appearance', 'buildable']).default('buildable'),
      description: z.string().max(32000).optional(),
      images: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(200),
            image: toolSchemas.add_reference_image.shape.image,
            view: z
              .enum(['front', 'back', 'left', 'right', 'top', 'isometric', 'auto', 'exclude', 'unknown'])
              .transform((view) => (view === 'unknown' ? ('auto' as const) : view)),
          }),
        )
        .max(8),
      targetSize: z.union([
        z.enum(['small', 'medium', 'large']),
        z
          .strictObject({
            width: z.number().positive().optional(),
            depth: z.number().positive().optional(),
            height: z.number().positive().optional(),
          })
          .refine((v) => Object.keys(v).length > 0),
      ]),
      palette: z.strictObject({
        source: z.enum(['factory', 'project', 'custom']),
        colorIds: z.array(z.string()).optional(),
      }),
      parts: z.strictObject({
        source: z.enum(['factory', 'categories', 'all']),
        categories: z.array(z.string()).optional(),
      }),
      style: z.string().max(4000),
    })
    .refine((v) => !!v.description?.trim() || v.images.length > 0)
    .refine(
      (v) => v.viewMode !== 'fixed' || v.images.every((image) => image.view !== 'auto' && image.view !== 'exclude'),
      { message: 'Fixed mode requires standard views.' },
    ),
  budget: z.strictObject({
    rounds: z.number().int().min(2).max(20).default(20),
    toolCalls: z.number().int().min(1).max(10000).default(2000),
    durationMs: z.number().min(1000).max(7200000).default(7200000),
  }),
  directStart: z.boolean(),
});
export type ImageTaskInput = z.input<typeof imageTaskSchema>;
/** Renderer task state keeps the concrete limits chosen in the dialog. */
export type ImageTaskRequest = ImageTaskInput & { budget: { toolCalls: number; durationMs: number } };

const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  });
export const providerSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  type: z.enum(['chatgpt', 'openai', 'anthropic', 'gemini', 'compatible']),
  mode: z.enum(['account', 'apiKey']).optional(),
  presetId: z.string().max(80).optional(),
  connectionStatus: z.enum(['available', 'untested', 'failed', 'reauth', 'reenter']).optional(),
  endpoint,
  model: z.string().max(200),
  proxy: z.enum(['system', 'custom']).default('system'),
  proxyUrl: z
    .string()
    .max(2048)
    .default('')
    .refine((v) => !v || /^(https?|socks5?):\/\/[^\s@]+$/.test(v)),
  models: z.array(z.string().max(200)).max(500).default([]),
  modelsError: z.enum(['aiUi.noModels', 'aiUi.modelsFailed']).optional(),
  accountId: z.string().optional(),
  prices: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
    })
    .optional(),
});
export type AiProvider = z.output<typeof providerSchema>;
export const aiSettingsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(5).default(3),
  providers: z.array(providerSchema).max(30).default([]),
  defaultProviderId: z.string().default(''),
  defaults: z
    .strictObject({ chat: z.string(), vision: z.string(), quick: z.string() })
    .default({ chat: '', vision: '', quick: '' }),
  chatgptEnabled: z.boolean().default(true),
  chatgptWelcomeSeen: z.boolean().default(false),
  history: z.boolean().default(true),
  localOnly: z.boolean().default(false),
  debug: z.boolean().default(false),
  dailyLimit: z.number().nonnegative().nullable().default(null),
  limitsVersion: z.literal(1).default(1),
  toolLimit: z.number().int().min(1).max(1000).nullable().default(null),
  durationMinutes: z.number().min(0.1).max(120).nullable().default(null),
  mcpEnabled: z.boolean().default(false),
  httpEnabled: z.boolean().default(false),
  httpPort: z.number().int().min(1024).max(65535).default(32145),
});
export type AiSettings = z.output<typeof aiSettingsSchema>;
export const defaultAiSettings = (): AiSettings => aiSettingsSchema.parse({});
export interface AiSnapshot {
  /** Catalog capabilities fetched in this session, keyed by provider then model. */
  modelCapabilities?: Record<string, Record<string, ModelCapabilities>>;
  tasks: AiTaskInfo[];
  settings: AiSettings;
  masks: Record<string, string>;
  /** Transient read failures; never persisted in settings. */
  unreadableKeys: string[];
  accounts: ChatGptAccount[];
  activeAccountId?: string;
  spent: number;
  connections: number;
  httpUrl: string | null;
  shim: string;
  running: boolean;
}
export function providerConnectionStatus(
  provider: AiProvider,
  snapshot: Pick<AiSnapshot, 'accounts' | 'activeAccountId' | 'unreadableKeys'>,
): NonNullable<AiProvider['connectionStatus']> {
  if (provider.type === 'chatgpt') {
    const account = snapshot.accounts.find((a) => a.id === (provider.accountId ?? snapshot.activeAccountId));
    if (!account?.signedIn) return 'reauth';
  } else if (snapshot.unreadableKeys.includes(provider.id)) return 'reenter';
  return provider.connectionStatus ?? 'untested';
}
const instancePaths = z.array(z.array(z.string().min(1)).min(1));
export const mentionSchema = z.strictObject({
  type: z.enum(['selection', 'submodel', 'step', 'color', 'reference']),
  id: z.string().min(1),
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
  paths: instancePaths.optional(),
});
export type Mention = z.output<typeof mentionSchema>;
export const turnSchema = z
  .strictObject({
    providerId: z.string(),
    model: z.string().min(1).max(200),
    effort: z.enum(['fast', 'balanced', 'deep']),
    text: z.string().max(32000),
    images: z
      .array(
        z.strictObject({
          type: z.literal('image'),
          base64: z
            .string()
            .max(16_000_000)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
        }),
      )
      .max(8),
    selection: z.boolean(),
    modelContext: z.boolean(),
    kind: z.literal('selection').optional(),
    selectionPaths: instancePaths.optional(),
    scope: z.strictObject({ paths: instancePaths }).optional(),
    mentions: z.array(mentionSchema).optional(),
  })
  .refine((v) => v.text.trim().length > 0 || v.images.length > 0);
export type TurnRequest = z.output<typeof turnSchema>;
export type Approval = { id: string; kind: 'mcp' | 'images'; name: string; detail: string };
export type AiNotice =
  | { type: 'task'; task: AiTaskInfo }
  | { type: 'workflow'; turnId: string; event: WorkflowEvent; cost?: CostEstimate; stallNoticeMs?: number }
  | { type: 'event'; turnId: string; event: AgentEvent; stallNoticeMs?: number }
  | { type: 'state'; snapshot: AiSnapshot }
  | { type: 'approval'; approval: Approval | null }
  | { type: 'failure'; key: string; taskId?: string; error?: PublicAiError; reason?: string };
export type AiTaskStatus = 'queued' | 'running' | 'pending_merge' | 'merged' | 'discarded' | 'stopped' | 'failed';
export interface AiTaskInfo {
  taskId: string;
  documentId: string;
  kind: 'chat' | 'image' | 'selection';
  status: AiTaskStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}
export type HostRequest = { id: string; method: string; input: unknown; owner: 'ai' | 'mcp'; taskId?: string };
export type HostReply = { id: string; value?: unknown; error?: string };
export interface SavedTurn {
  /** Completed local validation; paths are the original scope for a model recheck. */
  local?: {
    shortcut: 'repair' | 'factory' | 'palette';
    paths: string[][] | null;
    selection: boolean;
    modelContext: boolean;
  };
  /** A-124: only actual retained edits qualify an error turn for text-only replay. */
  context?: {
    retainedEdits: { added: number; modified: number; deleted: number; submodels: string[] };
  };
  compressed?: { estimatedTokens: number };
  selectionCount?: number;
  usage?: TokenUsage;
  documentId?: string;
  id: string;
  user: string;
  images: ImageBlock[];
  text: string;
  events: AgentEvent[];
  result?: AgentResult;
  transactionId?: string;
  history?: Message[];
  report?: WorkflowReport;
  cost?: CostEstimate;
}
export interface AiApi {
  aiSnapshot(): Promise<AiSnapshot>;
  aiSaveSettings(settings: AiSettings): Promise<AiSnapshot>;
  aiSaveProvider(provider: AiProvider, key?: string): Promise<AiSnapshot>;
  aiDeleteProvider(id: string): Promise<AiSnapshot>;
  aiTestProvider(id: string): Promise<ConnectionResult>;
  aiTestProviderDraft(provider: AiProvider, key?: string): Promise<ConnectionResult>;
  aiOpenPresetLink(presetId: string, kind: 'key' | 'docs'): Promise<void>;
  aiRefreshModels(id: string): Promise<AiSnapshot>;
  aiSignIn(): Promise<AiSnapshot>;
  aiSignInDraft(): Promise<{ snapshot: AiSnapshot; provider: AiProvider; result: ConnectionResult }>;
  aiManageUsage(): Promise<void>;
  aiAccount(action: 'select' | 'signout', id: string): Promise<AiSnapshot>;
  aiStart(request: TurnRequest): Promise<string>;
  aiStartImage(request: ImageTaskInput): Promise<string>;
  aiImageControl(action: 'pause' | 'resume' | 'interject', text?: string, taskId?: string): Promise<void>;
  aiConfirmPlan(plan: StructurePlan, taskId?: string): Promise<boolean>;
  aiStop(taskId?: string): Promise<void>;
  aiTaskAction(taskId: string, action: 'merge' | 'discard'): Promise<void>;
  aiApprove(id: string, allow: boolean): Promise<void>;
  aiDisconnect(): Promise<void>;
  aiGenerateToken(): Promise<string>;
  onAiNotice(callback: (notice: AiNotice) => void): () => void;
  onEditorRequest(callback: (request: HostRequest) => void): () => void;
  editorReply(reply: HostReply): Promise<void>;
}
export const AI_CHANNELS = {
  aiSnapshot: 'ai.snapshot',
  aiSaveSettings: 'ai.settings',
  aiSaveProvider: 'ai.provider',
  aiDeleteProvider: 'ai.deleteProvider',
  aiTestProvider: 'ai.test',
  aiTestProviderDraft: 'ai.testDraft',
  aiOpenPresetLink: 'ai.presetLink',
  aiRefreshModels: 'ai.models',
  aiSignIn: 'ai.signin',
  aiSignInDraft: 'ai.signinDraft',
  aiManageUsage: 'ai.manageUsage',
  aiAccount: 'ai.account',
  aiStart: 'ai.start',
  aiStartImage: 'ai.image.start',
  aiImageControl: 'ai.image.control',
  aiConfirmPlan: 'ai.image.plan',
  aiStop: 'ai.stop',
  aiTaskAction: 'ai.task.action',
  aiApprove: 'ai.approve',
  aiDisconnect: 'ai.disconnect',
  aiGenerateToken: 'ai.token',
  editorReply: 'ai.editorReply',
} as const;
const signatures: Record<string, z.ZodType> = {
  'ai.snapshot': z.tuple([]),
  'ai.settings': z.tuple([aiSettingsSchema]),
  'ai.provider': z.tuple([providerSchema, z.string().max(8192).optional()]),
  'ai.deleteProvider': z.tuple([z.string().uuid()]),
  'ai.test': z.tuple([z.string().uuid()]),
  'ai.testDraft': z.tuple([providerSchema, z.string().max(8192).optional()]),
  'ai.presetLink': z.tuple([z.string().max(80), z.enum(['key', 'docs'])]),
  'ai.models': z.tuple([z.string().uuid()]),
  'ai.signin': z.tuple([]),
  'ai.signinDraft': z.tuple([]),
  'ai.manageUsage': z.tuple([]),
  'ai.account': z.tuple([z.enum(['select', 'signout']), z.string()]),
  'ai.start': z.tuple([turnSchema]),
  'ai.image.start': z.tuple([imageTaskSchema]),
  'ai.image.control': z.tuple([
    z.enum(['pause', 'resume', 'interject']),
    z.string().max(32000).optional(),
    z.string().uuid().optional(),
  ]),
  'ai.image.plan': z.tuple([structurePlanSchema, z.string().uuid().optional()]),
  'ai.stop': z.tuple([z.string().uuid().optional()]),
  'ai.task.action': z.tuple([z.string().uuid(), z.enum(['merge', 'discard'])]),
  'ai.approve': z.tuple([z.string().uuid(), z.boolean()]),
  'ai.disconnect': z.tuple([]),
  'ai.token': z.tuple([]),
  'ai.editorReply': z.tuple([
    z.strictObject({ id: z.string().uuid(), value: z.unknown().optional(), error: z.string().optional() }),
  ]),
};
export const validAiArguments = (channel: string, args: readonly unknown[]) =>
  signatures[channel]?.safeParse(args).success === true;
