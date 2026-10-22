import { fileURLToPath } from 'node:url';
import { checkLocaleKeys } from './locale-keys';
import { loadLocales } from './load-locales';

try {
  const directory = process.argv[2] ?? fileURLToPath(new URL('../locales/', import.meta.url));
  const resources = await loadLocales(directory);
  const result = checkLocaleKeys(resources);

  for (const warning of result.warnings) {
    console.warn(`[i18n:check] WARN ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`[i18n:check] ERROR ${error}`);
  }

  process.exitCode = result.ok ? 0 : 1;
  if (result.ok) {
    console.log(`[i18n:check] Passed (${Object.keys(resources).join(', ')}; ${result.warnings.length} warnings).`);
  }
} catch (error: unknown) {
  console.error(`[i18n:check] ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
