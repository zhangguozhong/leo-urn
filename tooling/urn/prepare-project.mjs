import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadProfile, archiveName, validateArtifact } from './profile.mjs';
import { ensureAerisSource } from './aeris-source.mjs';
import { verifyAerisDependency } from './aeris-dependency.mjs';

/** 所有制品校验后才替换；npm/Git 认证沿用调用者配置，不拼接 shell。 */
export async function fetchArtifact(item, from, destination, cwd) {
  validateArtifact(item, item.name, item.version);
  const target = path.join(destination, archiveName(item));
  if (item.specifier.startsWith('file:')) {
    await fs.copyFile(path.resolve(from, item.specifier.slice(5)), target);
  } else {
    let packed;
    try {
      const output = execFileSync(
        'npm',
        ['pack', item.specifier, '--json', '--ignore-scripts', '--pack-destination', destination],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      packed = JSON.parse(output).at(-1)?.filename;
    } catch {
      throw new Error(`PREPARE: 无法取得 ${item.name} 固定制品；请检查 npm 私有仓库读取权限`);
    }
    if (!packed || path.basename(packed) !== packed) throw new Error('PREPARE: npm 返回非法制品名');
    const packedPath = path.join(destination, packed);
    if (packedPath !== target) await fs.rename(packedPath, target);
  }
  const bytes = await fs.readFile(target);
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
    throw new Error(`PREPARE: ${item.name} 摘要不匹配`);
  let metadata;
  try {
    metadata = JSON.parse(
      execFileSync('tar', ['-xOf', target, 'package/package.json'], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    throw new Error(`PREPARE: ${item.name} 包元数据不可读取`);
  }
  if (metadata.name !== item.name || metadata.version !== item.version)
    throw new Error(`PREPARE: ${item.name} 包身份或版本不匹配`);
  return target;
}

export async function prepareProject({ app, profile: profilePath }) {
  app = path.resolve(app);
  const { profile, directory } = await loadProfile(
    profilePath ?? path.join(app, 'urn.profile.json'),
  );
  const cache = path.join(app, '.urn');
  await fs.mkdir(cache, { recursive: true });
  const lock = path.join(cache, '.prepare-lock');
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('PREPARE: 已有依赖准备任务，请勿并发执行');
    throw error;
  }
  let stage;
  try {
    stage = await fs.mkdtemp(path.join(cache, '.packages-'));
    for (const item of profile.packages) await fetchArtifact(item, directory, stage, app);
    await verifyAerisDependency(profile.aeris, stage);
    const sourceRoot = await ensureAerisSource(profile.aeris.source, path.join(cache, 'aeris'));
    const output = path.join(cache, 'packages');
    await fs.mkdir(output, { recursive: true });
    for (const item of profile.packages)
      await fs.rename(path.join(stage, archiveName(item)), path.join(output, archiveName(item)));
    await fs.writeFile(
      path.join(cache, 'prepared.json'),
      JSON.stringify(
        {
          sourceRef: profile.aeris.source.ref,
          sourceRoot: '.urn/aeris',
          packages: profile.packages.map(({ name, version, sha256 }) => ({
            name,
            version,
            sha256,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return { sourceRoot, packages: profile.packages.length };
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    await fs.rmdir(lock);
  }
}
