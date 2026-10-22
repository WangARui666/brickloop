/** Temporary header-only adapter until @brickloop/ldraw is integrated. No geometry execution. */
export interface LDrawHeader {
  title: string;
  category: string | null;
  keywords: string[];
  organization: string;
  legoIds: string[];
  aliasTarget: string | null;
  excluded: boolean;
  alias: boolean;
}

export function parseLDrawHeader(source: string): LDrawHeader {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const title = (lines.find((line) => /^0\s+\S/.test(line)) ?? '').replace(/^0\s+/, '').trim();
  let category: string | null = null;
  let organization = '';
  const keywords: string[] = [];
  const legoIds: string[] = [];
  let aliasTarget: string | null = null;
  for (const line of lines) {
    if (/^[1-5]\s/.test(line)) {
      if (line.startsWith('1 ')) aliasTarget = line.trim().split(/\s+/).slice(14).join(' ').toLowerCase();
      break;
    }
    const categoryMatch = /^0\s+!CATEGORY\s+(.+)/i.exec(line);
    if (categoryMatch) category = categoryMatch[1]!.trim();
    const keywordMatch = /^0\s+!KEYWORDS\s+(.+)/i.exec(line);
    if (keywordMatch)
      keywords.push(
        ...keywordMatch[1]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    const orgMatch = /^0\s+!LDRAW_ORG\s+(.+)/i.exec(line);
    if (orgMatch) organization = orgMatch[1]!.trim();
    const legoMatch = /^0\s+\/\/\s*LEGOID\s+([\d /,]+)/i.exec(line);
    if (legoMatch) legoIds.push(...(legoMatch[1]!.match(/\d+/g) ?? []));
  }
  const alias = /\bAlias\b/i.test(organization);
  return {
    title,
    category,
    keywords,
    organization,
    legoIds,
    aliasTarget,
    alias,
    excluded: /^~|^Moved to\b/i.test(title) || /(?:Subpart|Primitive)/i.test(organization),
  };
}

export function partIdFromFile(file: string): `ld:${string}` {
  return `ld:${file
    .replace(/\\/g, '/')
    .replace(/\.dat$/i, '')
    .toLowerCase()}`;
}

export function printedBase(file: string): `ld:${string}` | undefined {
  const match = /^(.*?)(?:pr?\d[\da-z]*)$/i.exec(file.replace(/\.dat$/i, ''));
  return match ? partIdFromFile(match[1]!) : undefined;
}
