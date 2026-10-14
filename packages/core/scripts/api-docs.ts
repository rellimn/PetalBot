import { mkdir, writeFile } from 'node:fs/promises';
import { renderApiDocuments } from '../src/server/api-docs.ts';

const target = new URL('../../../docs/api/', import.meta.url);
await mkdir(target, { recursive: true });
for (const [name, content] of Object.entries(await renderApiDocuments())) {
  await writeFile(new URL(name, target), content);
  process.stdout.write(`wrote docs/api/${name}\n`);
}
