import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const cliPath = fileURLToPath(new URL('../scripts/check-locales.ts', import.meta.url));
const temporaryDirectories: string[] = [];

async function createFixture(chinese: object, english: object): Promise<string> {
  const fixtureDirectory = join(projectDirectory, '.devdata', 'i18n-test-tmp');
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, 'i18n-check-'));
  temporaryDirectories.push(directory);
  for (const [language, messages] of [
    ['zh-CN', chinese],
    ['en', english],
  ] as const) {
    const languageDirectory = join(directory, language);
    await mkdir(languageDirectory);
    await writeFile(join(languageDirectory, 'common.json'), JSON.stringify(messages));
  }
  return directory;
}

function runCheck(directory: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, directory], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
  });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('i18n check CLI', () => {
  it('exits with code 1 for a missing Chinese key without changing shipped resources', async () => {
    const directory = await createFixture({ menu: {} }, { menu: { file: 'File' } });
    const result = runCheck(directory);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR zh-CN: missing key "common:menu.file"');
  });

  it('exits with code 0 and a warning for a missing English key', async () => {
    const directory = await createFixture({ menu: { file: '文件' } }, { menu: {} });
    const result = runCheck(directory);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARN en: missing key "common:menu.file"');
    expect(result.stdout).toContain('Passed');
  });

  it('discovers additional namespace files', async () => {
    const directory = await createFixture({ title: '积环' }, { title: 'Brickloop' });
    await writeFile(join(directory, 'en', 'model.json'), JSON.stringify({ save: 'Save' }));
    const result = runCheck(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('zh-CN: missing key "model:save"');
  });

  it('warns but passes when the entire English namespace file is missing', async () => {
    const directory = await createFixture({ menu: { file: '文件' } }, { menu: { file: 'File' } });
    await rm(join(directory, 'en', 'common.json'));
    const result = runCheck(directory);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARN en: missing key "common:menu.file"');
  });

  it('exits with code 1 for malformed resource JSON', async () => {
    const directory = await createFixture({}, {});
    await writeFile(join(directory, 'zh-CN', 'common.json'), '{');
    const result = runCheck(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[i18n:check] ERROR');
  });
});
