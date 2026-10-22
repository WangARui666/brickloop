import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LocaleMessages, LocaleResources } from './locale-keys';

function isLocaleMessages(value: unknown): value is LocaleMessages {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry: unknown) => typeof entry === 'string' || isLocaleMessages(entry))
  );
}

export async function loadLocales(directory: string): Promise<LocaleResources> {
  const languages = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (languages.length === 0) {
    throw new Error(`No language directories in ${directory}`);
  }

  const resources: LocaleResources = {};
  for (const language of languages) {
    const languageDirectory = join(directory, language);
    const files = (await readdir(languageDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();

    const namespaces: Record<string, LocaleMessages> = {};
    for (const file of files) {
      const path = join(languageDirectory, file);
      const messages: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isLocaleMessages(messages)) {
        throw new Error(`Expected nested objects with translation strings in ${path}`);
      }
      namespaces[basename(file, '.json')] = messages;
    }
    resources[language] = namespaces;
  }

  return resources;
}
