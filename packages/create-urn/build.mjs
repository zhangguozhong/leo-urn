import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(import.meta.dirname, 'lib');
await fs.mkdir(dist, { recursive: true });
for (const file of [
  'aeris-source.mjs',
  'aeris-dependency.mjs',
  'profile.mjs',
  'prepare-project.mjs',
]) {
  await fs.copyFile(path.join(root, 'tooling/urn', file), path.join(dist, file));
}
