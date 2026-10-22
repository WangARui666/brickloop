import type { BrkDocument, ClipboardData, SessionChange, Workspace } from '@brickloop/core';
import type {
  BomResult,
  IoIssue,
  IoReport,
  ModelInfo,
  ProjectAssets,
  ProjectPreservation,
  ScopeOptions,
} from '@brickloop/io';
import type { RecoverableDocument, SaveResult } from '@brickloop/io/node';

export interface ProjectPayload {
  doc: BrkDocument;
  workspace: Workspace;
  assets: ProjectAssets;
  preservation?: ProjectPreservation;
  thumbnail?: Uint8Array;
}
export interface OpenedProject extends ProjectPayload {
  path: string | null;
  sourcePath: string | null;
  imported: boolean;
  readOnly: boolean;
  issues: IoIssue[];
  report?: IoReport;
}
export type ExportFormat = 'io' | 'ldr' | 'mpd' | 'obj' | 'dae' | 'glb' | 'csv' | 'xlsx' | 'png';
export interface ExportRequest {
  project: ProjectPayload;
  format: ExportFormat;
  unit: 'mm' | 'cm' | 'ldu';
  grouping: 'instance' | 'color';
  includeHidden: boolean;
  includeEdges: boolean;
  scope: NonNullable<ScopeOptions['scope']>;
  thumbnails: Record<string, string>;
  png?: Uint8Array;
}
export interface ExportResult {
  path: string;
  byteLength: number;
  triangleCount?: number;
  thumbnailCount?: number;
  report?: IoReport;
  bom?: BomResult;
  issues: IoIssue[];
}
export interface ClipboardPayload {
  data: ClipboardData;
  assets: ProjectAssets;
}
export interface ProjectApi {
  projectOpen(file?: string): Promise<OpenedProject[]>;
  projectSave(
    project: ProjectPayload,
    file: string | null,
    saveAs: boolean,
  ): Promise<{ path: string; result: SaveResult } | null>;
  projectRecent(): Promise<string[]>;
  projectExport(request: ExportRequest): Promise<ExportResult | null>;
  projectBom(project: ProjectPayload, options: ScopeOptions): Promise<BomResult>;
  projectInfo(project: ProjectPayload): Promise<ModelInfo>;
  projectReport(text: string): Promise<string | null>;
  clipboardRead(): Promise<ClipboardPayload | null>;
  clipboardWrite(value: ClipboardPayload): Promise<void>;
  copyText(text: string): Promise<void>;
  recoveryScan(): Promise<RecoverableDocument[]>;
  recoveryStart(project: ProjectPayload, file: string | null): Promise<string>;
  recoveryChange(id: string, change: SessionChange, workspace: Workspace, assets: ProjectAssets): Promise<string>;
  recoveryClose(id: string): Promise<void>;
  windowClose(): Promise<void>;
}
export const PROJECT_CHANNELS = {
  projectOpen: 'project.open',
  projectSave: 'project.save',
  projectRecent: 'project.recent',
  projectExport: 'project.export',
  projectBom: 'project.bom',
  projectInfo: 'project.info',
  projectReport: 'project.report',
  clipboardRead: 'clipboard.read',
  clipboardWrite: 'clipboard.write',
  copyText: 'clipboard.text',
  recoveryScan: 'recovery.scan',
  recoveryStart: 'recovery.start',
  recoveryChange: 'recovery.change',
  recoveryClose: 'recovery.close',
  windowClose: 'window.close',
} as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 32768 && !v.includes('\0');
const project = (v: unknown) => record(v) && record(v.doc) && record(v.workspace) && record(v.assets);
export function validProjectArguments(channel: string, args: readonly unknown[]): boolean {
  const [a, b, c, d] = args;
  switch (channel) {
    case PROJECT_CHANNELS.projectRecent:
    case PROJECT_CHANNELS.clipboardRead:
    case PROJECT_CHANNELS.recoveryScan:
    case PROJECT_CHANNELS.windowClose:
      return args.length === 0;
    case PROJECT_CHANNELS.projectOpen:
      return args.length <= 1 && (a === undefined || text(a));
    case PROJECT_CHANNELS.projectSave:
      return args.length === 3 && project(a) && (b === null || text(b)) && typeof c === 'boolean';
    case PROJECT_CHANNELS.projectInfo:
      return args.length === 1 && project(a);
    case PROJECT_CHANNELS.projectBom:
      return args.length === 2 && project(a) && record(b);
    case PROJECT_CHANNELS.projectExport:
      return (
        args.length === 1 &&
        record(a) &&
        project(a.project) &&
        ['io', 'ldr', 'mpd', 'obj', 'dae', 'glb', 'csv', 'xlsx', 'png'].includes(String(a.format)) &&
        ['mm', 'cm', 'ldu'].includes(String(a.unit)) &&
        ['instance', 'color'].includes(String(a.grouping)) &&
        typeof a.includeHidden === 'boolean' &&
        typeof a.includeEdges === 'boolean' &&
        record(a.scope) &&
        record(a.thumbnails)
      );
    case PROJECT_CHANNELS.projectReport:
    case PROJECT_CHANNELS.copyText:
      return args.length === 1 && typeof a === 'string' && a.length < 16_000_000;
    case PROJECT_CHANNELS.clipboardWrite:
      return (
        args.length === 1 &&
        record(a) &&
        record(a.data) &&
        a.data.version === 1 &&
        Array.isArray(a.data.instances) &&
        record(a.assets)
      );
    case PROJECT_CHANNELS.recoveryStart:
      return args.length === 2 && project(a) && (b === null || text(b));
    case PROJECT_CHANNELS.recoveryChange:
      return args.length === 4 && text(a) && record(b) && Array.isArray(b.ops) && record(c) && record(d);
    case PROJECT_CHANNELS.recoveryClose:
      return args.length === 1 && text(a) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(a);
    default:
      return false;
  }
}
