import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = fileURLToPath(new URL('../../../.devdata/io-schema/', import.meta.url));
const sources = {
  'collada_schema_1_4_1.xsd':
    'https://raw.githubusercontent.com/KhronosGroup/OpenCOLLADA/6031fa956e1da4bbdd910af3a8f9e924ef0fca7a/DAEValidator/xsd/collada_schema_1_4_1.xsd',
  'xml.xsd': 'https://www.w3.org/2001/03/xml.xsd',
};
await mkdir(directory, { recursive: true });
const manifest: Record<string, { url: string; sha256: string }> = {};
for (const [name, url] of Object.entries(sources)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!new TextDecoder().decode(bytes).includes('schema')) throw new Error(`Not a schema: ${url}`);
  await writeFile(path.join(directory, name), bytes);
  manifest[name] = { url, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(path.join(directory, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory, sources: manifest }, null, 2));
