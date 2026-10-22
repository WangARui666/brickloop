import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { generatePack } from '../scripts/infer';
import { writeConnectorFile } from '../src';
import { connector, file } from './fixtures';

async function removeTestDirectory(directory: string, base: string): Promise<void> {
  const target = await fs.realpath(directory),
    allowed = await fs.realpath(base);
  if (!target.startsWith(allowed + path.sep)) throw new Error('Unexpected test directory');
  await fs.rm(target, { recursive: true, force: true });
}

it('generation covers the actual pack, preserves reviewed/draft bytes, and reports malformed existing data', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)),
    base = path.join(root, '.devdata/tmp');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'connect-infer-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const reviewed = { ...file([connector('stud')]), partId: 'ld:3001', status: 'reviewed' as const };
    const draft = { ...reviewed, partId: 'ld:3003', status: 'draft' as const };
    const original = writeConnectorFile(reviewed),
      draftBytes = writeConnectorFile(draft);
    await fs.writeFile(path.join(directory, '3001.json'), original);
    await fs.writeFile(path.join(directory, '3003.json'), draftBytes);
    await generatePack('demo', directory);
    expect(await fs.readFile(path.join(directory, '3001.json'), 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(directory, '3003.json'), 'utf8')).toBe(draftBytes);
    expect((await fs.readdir(directory)).filter((f) => f.endsWith('.json'))).toHaveLength(231);
    const deterministic = await fs.readFile(path.join(directory, '3020.json'), 'utf8');
    await fs.writeFile(path.join(directory, '3004.json'), '{bad json');
    await expect(generatePack('demo', directory)).rejects.toThrow('3004.json$: Invalid JSON');
    expect(await fs.readFile(path.join(directory, '3020.json'), 'utf8')).toBe(deterministic);
    expect(await fs.readFile(path.join(directory, '3004.json'), 'utf8')).toBe('{bad json');
  } finally {
    log.mockRestore();
    await removeTestDirectory(directory, base);
  }
}, 120000);
