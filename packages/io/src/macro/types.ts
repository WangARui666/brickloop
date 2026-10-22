import type { BBox, BrkDocument, IdGenerator } from '@brickloop/core';
import type { IoIssue } from '../issues';

export const MACRO_FORMAT_VERSION = 1;
export const MACRO_ORIGIN = 'bbox-bottom-center-grid' as const;
export type MacroName = string | Record<string, string>;
export interface MacroMetaInput {
  id: string;
  name: MacroName;
  category: string;
  author: string;
  createdAt: string;
}
export interface MacroMeta extends MacroMetaInput {
  partCount: number;
  /** Bounds in macro coordinates, including studs; LDraw -Y is up. */
  bboxLdu: BBox;
  partIds: string[];
  colorIds: string[];
  origin: { convention: typeof MACRO_ORIGIN; gridLdu: [20, 8, 20] };
}
export interface MacroPackage {
  meta: MacroMeta;
  document: BrkDocument;
  thumbnail?: Uint8Array;
}
export interface MacroServices {
  /** Actual local part geometry bounds, not merely instance origins. */
  bboxProvider: (partId: string) => BBox | undefined;
  id?: IdGenerator;
}
export type MacroReadResult = { ok: true; value: MacroPackage; issues: IoIssue[] } | { ok: false; issues: IoIssue[] };

export type MacroErrorCode =
  | 'INVALID_METADATA'
  | 'INVALID_MODEL'
  | 'EMPTY_SELECTION'
  | 'BOUNDS_MISSING'
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_VERSION'
  | 'MEMBER_MISSING'
  | 'HASH_MISMATCH'
  | 'UNLISTED_MEMBER'
  | 'INVALID_JSON'
  | 'INVALID_PLACEMENT';

export function macroIssue(code: MacroErrorCode, file?: string, detail?: string): IoIssue {
  return {
    code: `MACRO_${code}`,
    messageKey: `macro.errors.${code}`,
    severity: 'error',
    ...(file === undefined ? {} : { file }),
    ...(detail === undefined ? {} : { detail }),
  };
}
export class MacroError extends Error {
  constructor(public readonly issues: IoIssue[]) {
    super(issues.map((issue) => issue.code).join(', '));
    this.name = 'MacroError';
  }
}
export function macroName(name: MacroName, locale = 'zh-CN'): string {
  return typeof name === 'string' ? name : (name[locale] ?? name.en ?? name[Object.keys(name).sort()[0]!] ?? '');
}
