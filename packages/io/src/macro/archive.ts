import { isRecord, parseDocument, serializeDocument } from '@brickloop/core';
import { hashBytes, readZip, text, utf8, writeZip } from '../binary';
import type { ProjectAssets } from '../binary';
import { MACRO_FORMAT_VERSION, MacroError, macroIssue } from './types';
import type { MacroPackage, MacroReadResult } from './types';
import { macroPackageIssues, validMeta } from './validation';

export function writeMacro(pkg: MacroPackage): Uint8Array {
  const issues = macroPackageIssues(pkg);
  if (issues.length) throw new MacroError(issues);
  const members: ProjectAssets = {
    'macro.json': utf8(JSON.stringify(pkg.meta)),
    'model.json': utf8(serializeDocument(pkg.document)),
    ...(pkg.thumbnail ? { 'thumbnail.png': pkg.thumbnail } : {}),
  };
  return writeZip({
    ...members,
    'manifest.json': utf8(
      JSON.stringify({
        format: 'brickloop-macro',
        formatVersion: MACRO_FORMAT_VERSION,
        members: Object.fromEntries(
          Object.entries(members).map(([name, bytes]) => [name, { size: bytes.length, sha256: hashBytes(bytes) }]),
        ),
      }),
    ),
  });
}

/** Corrupt/newer macros never expose a partially insertable package. */
export function readMacro(bytes: Uint8Array): MacroReadResult {
  const { members, issues } = readZip(bytes);
  const json = (name: string): unknown => {
    if (!members[name]) {
      issues.push(macroIssue('MEMBER_MISSING', name));
      return undefined;
    }
    try {
      return JSON.parse(text(members[name])) as unknown;
    } catch {
      issues.push(macroIssue('INVALID_JSON', name));
      return undefined;
    }
  };
  const manifest = json('manifest.json');
  if (
    !isRecord(manifest) ||
    manifest.format !== 'brickloop-macro' ||
    !Number.isInteger(manifest.formatVersion) ||
    !isRecord(manifest.members)
  ) {
    issues.push(macroIssue('INVALID_MANIFEST', 'manifest.json'));
    return { ok: false, issues };
  }
  if (manifest.formatVersion !== MACRO_FORMAT_VERSION)
    issues.push(macroIssue('UNSUPPORTED_VERSION', 'manifest.json', String(manifest.formatVersion)));
  for (const [name, entry] of Object.entries(manifest.members)) {
    if (
      name === 'manifest.json' ||
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.size) ||
      Number(entry.size) < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      issues.push(macroIssue('INVALID_MANIFEST', name));
      continue;
    }
    if (!members[name]) issues.push(macroIssue('MEMBER_MISSING', name));
    else if (entry.size !== members[name].length || entry.sha256 !== hashBytes(members[name]))
      issues.push(macroIssue('HASH_MISMATCH', name));
  }
  for (const name of Object.keys(members))
    if (name !== 'manifest.json' && !Object.hasOwn(manifest.members, name))
      issues.push(macroIssue('UNLISTED_MEMBER', name));
  if (issues.length) return { ok: false, issues };
  const meta = json('macro.json');
  if (!validMeta(meta)) issues.push(macroIssue('INVALID_METADATA', 'macro.json'));
  const parsed = parseDocument(members['model.json'] ? text(members['model.json']) : '');
  if (!parsed.doc || parsed.issues.length)
    issues.push(macroIssue('INVALID_MODEL', 'model.json', JSON.stringify(parsed.issues)));
  if (issues.length || !validMeta(meta) || !parsed.doc) return { ok: false, issues };
  const value: MacroPackage = {
    meta,
    document: parsed.doc,
    ...(members['thumbnail.png'] ? { thumbnail: members['thumbnail.png'] } : {}),
  };
  issues.push(...macroPackageIssues(value));
  return issues.length ? { ok: false, issues } : { ok: true, value, issues };
}
