import { createWorkspace, isRecord, isUlid, parseDocument, serializeDocument } from '@brickloop/core';
import type { BrkDocument, Workspace } from '@brickloop/core';
import { hashBytes, readZip, text, utf8, writeZip } from './binary';
import type { ProjectAssets } from './binary';
import { issue } from './issues';
import type { IoIssue } from './issues';
import { emptyThumbnail } from './thumbnail';

let fallbackThumbnail: Uint8Array | undefined;

export const PROJECT_FORMAT_VERSION = 1;
export interface ManifestMember {
  size: number;
  sha256: string;
  [key: string]: unknown;
}
export interface ProjectManifest {
  format: 'brickloop';
  formatVersion: number;
  documentId: string;
  revision: number;
  savedAt: string;
  appVersion: string;
  catalogPack: BrkDocument['catalogPack'];
  members: Record<string, ManifestMember>;
  [key: string]: unknown;
}
export interface ProjectPreservation {
  manifest: Record<string, unknown>;
  members: ProjectAssets;
}
export interface PackProjectOptions {
  savedAt?: string;
  appVersion?: string;
  thumbnail?: Uint8Array;
  history?: string;
  instructions?: unknown;
  preservation?: ProjectPreservation;
  /** Refuse accidentally rewriting a newer version unless explicitly requested. */
  allowNewerVersion?: boolean;
}
// Assets carry opaque members as well, so the ordinary unpack → pack call retains them.
const preservedProjects = new WeakMap<ProjectAssets, ProjectPreservation>();
export function packProject(
  doc: BrkDocument,
  workspace: Workspace,
  assets: ProjectAssets = {},
  options: PackProjectOptions = {},
): Uint8Array {
  const previous = options.preservation ?? preservedProjects.get(assets);
  const version = Number(previous?.manifest.formatVersion ?? PROJECT_FORMAT_VERSION);
  if (version > PROJECT_FORMAT_VERSION && !options.allowNewerVersion) throw new Error('PROJECT_NEWER_VERSION');
  const members: ProjectAssets = { ...previous?.members, ...assets };
  delete members['manifest.json'];
  members['document.json'] = utf8(serializeDocument(doc));
  members['workspace.json'] = utf8(JSON.stringify(workspace));
  if (options.thumbnail) members['thumbnail.png'] = options.thumbnail;
  if (!members['thumbnail.png']) members['thumbnail.png'] = fallbackThumbnail ??= emptyThumbnail();
  if (options.history !== undefined) members['ai/history.jsonl'] = utf8(options.history);
  if (options.instructions !== undefined) members['instructions.json'] = utf8(JSON.stringify(options.instructions));
  const oldMembers = isRecord(previous?.manifest.members) ? previous.manifest.members : {};
  const previousAppVersion = previous?.manifest.appVersion;
  const manifest: ProjectManifest = {
    ...previous?.manifest,
    format: 'brickloop',
    formatVersion: Math.max(PROJECT_FORMAT_VERSION, version),
    documentId: doc.documentId,
    revision: doc.revision,
    savedAt: options.savedAt ?? new Date().toISOString(),
    appVersion:
      options.appVersion ??
      (typeof previousAppVersion === 'string' && previousAppVersion.trim() ? previousAppVersion : '0.1.0'),
    catalogPack: doc.catalogPack,
    // manifest.json is necessarily excluded: a manifest cannot contain its own SHA-256.
    members: Object.fromEntries(
      Object.entries(members).map(([name, bytes]) => [
        name,
        { ...(isRecord(oldMembers[name]) ? oldMembers[name] : {}), size: bytes.length, sha256: hashBytes(bytes) },
      ]),
    ),
  };
  return writeZip({ ...members, 'manifest.json': utf8(JSON.stringify(manifest)) });
}
export interface MigrationInput {
  manifest: Record<string, unknown>;
  members: ProjectAssets;
}
export type ProjectMigration = (input: MigrationInput) => MigrationInput;
/** Explicit compatibility fixture: version 0 supports the same JSON payload layout only. */
export const projectMigrations: Readonly<Record<number, ProjectMigration>> = {
  0: ({ manifest, members }) => ({ manifest: { ...manifest, format: 'brickloop', formatVersion: 1 }, members }),
};
export interface UnpackedProject {
  doc: BrkDocument | null;
  workspace: Workspace;
  assets: ProjectAssets;
  issues: IoIssue[];
  manifest: Record<string, unknown> | null;
  preservation: ProjectPreservation;
  readOnly: boolean;
}
function readJson(members: ProjectAssets, name: string, issues: IoIssue[]): unknown {
  if (!members[name]) return undefined;
  try {
    return JSON.parse(text(members[name])) as unknown;
  } catch (error) {
    issues.push(issue('PROJECT_JSON_INVALID', name, String(error)));
    return undefined;
  }
}
function validWorkspaceShape(value: unknown): value is Workspace {
  if (!isRecord(value) || !isRecord(value.camera) || !isRecord(value.grid) || !isRecord(value.panelState)) return false;
  const camera = value.camera;
  const instancePath = (path: unknown): boolean =>
    Array.isArray(path) && path.every((id: unknown) => typeof id === 'string' && isUlid(id));
  const paths = (paths: unknown): boolean => Array.isArray(paths) && paths.every(instancePath);
  const vector = (v: unknown): boolean =>
    Array.isArray(v) && v.length === 3 && v.every((n: unknown) => typeof n === 'number' && Number.isFinite(n));
  return (
    instancePath(value.activeModelPath) &&
    paths(value.selection) &&
    paths(value.hidden) &&
    ['perspective', 'ortho'].includes(String(camera.mode)) &&
    ['position', 'target', 'up'].every((key) => vector(camera[key])) &&
    typeof value.camera.fov === 'number' &&
    value.camera.fov > 0 &&
    value.camera.fov < 180 &&
    [1, 0.5, 0.25].includes(Number(value.grid.horizontal)) &&
    ['plate', 'brick', 'free'].includes(String(value.grid.vertical)) &&
    typeof value.snapEnabled === 'boolean' &&
    typeof value.collisionEnabled === 'boolean'
  );
}
export function unpackProject(
  bytes: Uint8Array,
  options: { migrations?: Readonly<Record<number, ProjectMigration>> } = {},
): UnpackedProject {
  const archive = readZip(bytes);
  let { members } = archive;
  const { issues } = archive;
  let rawManifest = readJson(members, 'manifest.json', issues);
  let manifest = isRecord(rawManifest) ? rawManifest : null;
  let readOnly = false;
  if (
    !manifest ||
    !isRecord(manifest.members) ||
    manifest.format !== 'brickloop' ||
    !Number.isInteger(manifest.formatVersion)
  ) {
    issues.push(issue('PROJECT_MANIFEST_INVALID', 'manifest.json'));
  }
  if (manifest && isRecord(manifest.members)) {
    for (const [name, entry] of Object.entries(manifest.members)) {
      const member = members[name];
      if (!member) issues.push(issue('PROJECT_MEMBER_MISSING', name));
      else if (!isRecord(entry) || entry.size !== member.length || entry.sha256 !== hashBytes(member))
        issues.push(issue('PROJECT_HASH_MISMATCH', name));
    }
    for (const name of Object.keys(members))
      if (name !== 'manifest.json' && !Object.hasOwn(manifest.members, name))
        issues.push(issue('PROJECT_UNLISTED_MEMBER', name, undefined, 'warning'));
    let version = Number(manifest.formatVersion);
    const migrations = options.migrations ?? projectMigrations;
    while (version < PROJECT_FORMAT_VERSION) {
      const migrate = migrations[version];
      if (!migrate) {
        issues.push(issue('PROJECT_VERSION_UNSUPPORTED', 'manifest.json', String(version)));
        readOnly = true;
        break;
      }
      const migrated = migrate({ manifest, members });
      if (Number(migrated.manifest.formatVersion) !== version + 1)
        throw new Error('Migration must advance exactly one version');
      manifest = migrated.manifest;
      members = migrated.members;
      version++;
      issues.push(issue('PROJECT_MIGRATED', 'manifest.json', String(version), 'info'));
    }
    if (version > PROJECT_FORMAT_VERSION) {
      readOnly = true;
      issues.push(issue('PROJECT_NEWER_VERSION', 'manifest.json', String(version), 'warning'));
    }
  }
  rawManifest = manifest;
  const parsed = parseDocument(members['document.json'] ? text(members['document.json']) : '');
  for (const problem of parsed.issues)
    issues.push(
      issue('PROJECT_DOCUMENT_INVALID', 'document.json', `${problem.code}: ${problem.path}`, problem.severity),
    );
  if (
    parsed.doc &&
    manifest &&
    (manifest.documentId !== parsed.doc.documentId || manifest.revision !== parsed.doc.revision)
  )
    issues.push(issue('PROJECT_MANIFEST_INVALID', 'manifest.json', 'Document identity/revision mismatch'));
  const rawWorkspace = readJson(members, 'workspace.json', issues);
  const defaults = createWorkspace();
  const validWorkspace = validWorkspaceShape(rawWorkspace);
  const workspace = validWorkspace ? { ...defaults, ...rawWorkspace } : defaults;
  if (!validWorkspace) issues.push(issue('PROJECT_WORKSPACE_RESET', 'workspace.json', undefined, 'warning'));
  const assets = { ...members };
  for (const name of ['manifest.json', 'document.json', 'workspace.json']) delete assets[name];
  const preservation = { manifest: isRecord(rawManifest) ? rawManifest : {}, members: assets };
  preservedProjects.set(assets, preservation);
  return { doc: parsed.doc, workspace, assets, issues, manifest, preservation, readOnly };
}
