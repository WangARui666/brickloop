import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCatalogIndex, repositoryRoot } from '../src/catalog-index';
import { parsePatternRules, PatternCatalog } from '../src/patterns';

const index = await buildCatalogIndex();
const rules = parsePatternRules(
  JSON.parse(await readFile(path.join(repositoryRoot, 'library/macros/patterns.json'), 'utf8')) as unknown,
);
const patterns = new PatternCatalog(index, rules);
console.log(
  JSON.stringify(
    {
      libraryVersion: index.libraryVersion,
      rulesRevision: rules.revision,
      eligible: index.parts.filter((part) => part.flags?.includes('printed') && part.baseOf).length,
      groups: patterns.groups.map((group) => ({ groupId: group.groupId, count: group.parts.length })),
      unclassified: patterns.unclassified.length,
      examples: patterns.unclassified
        .slice(0, 20)
        .map((id) => ({ id, title: index.parts.find((part) => part.id === id)!.nameEn })),
    },
    null,
    2,
  ),
);
