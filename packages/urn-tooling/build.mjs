import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(import.meta.dirname, 'dist');
await fs.mkdir(dist, { recursive: true });
for (const file of [
  'cli.mjs',
  'baseline.mjs',
  'dependencies.mjs',
  'artifacts.mjs',
  'bundle-ios.sh',
  'aeris-source.mjs',
  'aeris-dependency.mjs',
  'profile.mjs',
  'prepare-project.mjs',
  'project-baseline.mjs',
]) {
  await fs.copyFile(path.join(root, 'tooling/urn', file), path.join(dist, file));
}
await fs.cp(path.join(root, 'tooling/urn/schemas'), path.join(dist, 'schemas'), {
  recursive: true,
});
