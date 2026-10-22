export interface LocaleMessages {
  [key: string]: string | LocaleMessages;
}

export type LocaleResources = Record<string, Record<string, LocaleMessages>>;

export interface LocaleCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function collectKeys(messages: LocaleMessages, prefix: string): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = `${prefix}${key}`;
    return typeof value === 'string' ? [path] : collectKeys(value, `${path}.`);
  });
}

export function checkLocaleKeys(resources: LocaleResources): LocaleCheckResult {
  const keysByLanguage = new Map(
    Object.entries(resources).map(([language, namespaces]) => [
      language,
      new Set(Object.entries(namespaces).flatMap(([namespace, messages]) => collectKeys(messages, `${namespace}:`))),
    ]),
  );
  // Compare with the union, so keys present only in English still require Chinese.
  const allKeys = [...new Set([...keysByLanguage.values()].flatMap((keys) => [...keys]))].sort();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const language of new Set(['zh-CN', 'en', ...keysByLanguage.keys()])) {
    const keys = keysByLanguage.get(language);
    const issues = language === 'zh-CN' ? errors : warnings;

    if (!keys) {
      issues.push(`${language}: missing language resources`);
      continue;
    }

    for (const key of allKeys) {
      if (!keys.has(key)) {
        issues.push(`${language}: missing key "${key}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
