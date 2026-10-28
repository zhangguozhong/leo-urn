import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export async function verifySource(directory, ref, repository) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? '')) throw new Error('必须固定完整源码 commit');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('源码缓存不能是符号链接');
  const root = await fs.realpath(directory);
  if ((await fs.realpath(git(directory, ['rev-parse', '--show-toplevel']))) !== root)
    throw new Error('源码目录必须是完整检出根目录');
  if (git(directory, ['rev-parse', 'HEAD']) !== ref)
    throw new Error('源码 commit 与能力清单不匹配');
  if (repository && git(directory, ['remote', 'get-url', 'origin']) !== repository)
    throw new Error('源码缓存远程与能力清单不匹配');
  if (git(directory, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('源码包含未提交修改，请保留现场并使用干净检出');
  // 编译可能读取被忽略的文件；仅允许既有构建产物，不允许 src/Sources 内混入新输入。
  const ignored = git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  const allowed =
    /^(?:packages\/[^/]+\/(?:node_modules|dist)\/|(?:node_modules|build|\.build|artifacts|Pods|DerivedData|\.bundle)\/|tooling\/node_modules\/)/;
  if (
    ignored
      .split('\0')
      .some(
        (file) =>
          file && !allowed.test(file) && !file.endsWith('/.DS_Store') && file !== '.DS_Store',
      )
  )
    throw new Error('源码含被忽略的额外输入，不能沿用固定 commit');
  const candidates = [
    ...git(directory, ['ls-files', '--stage', '-z'])
      .split('\0')
      .filter((entry) => entry.startsWith('120000 '))
      .map((entry) => entry.split('\t')[1]),
    ...ignored.split('\0').filter(Boolean),
  ];
  for (const relative of candidates) {
    const file = path.join(directory, relative);
    if (!(await fs.lstat(file)).isSymbolicLink()) continue;
    let actual;
    try {
      actual = await fs.realpath(file);
    } catch {
      throw new Error('固定源码包含失效符号链接');
    }
    const within = path.relative(root, actual);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
      throw new Error('固定源码的符号链接不能越出检出目录');
  }
  return path.resolve(directory);
}

/** 缓存只在准备成功后可见；拒绝重置既有目录，保留调用方的修改。 */
export async function ensureAerisSource(source, destination) {
  const { repository, ref } = source;
  if (!/^[a-f0-9]{40}$/.test(ref ?? '')) throw new Error('必须固定完整源码 commit');
  if (typeof repository !== 'string' || !repository || repository.startsWith('-'))
    throw new Error('源码远程地址无效');
  if (/^https?:\/\//i.test(repository)) {
    const url = new URL(repository);
    if (url.username || url.password)
      throw new Error('源码地址不得包含凭据，请使用本机 Git 凭据管理');
  }
  const directory = path.resolve(destination);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const lock = `${directory}.lock`;
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('依赖源码正在准备，请等待当前任务完成');
    throw error;
  }
  let temporary;
  try {
    const exists = await fs.lstat(directory).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) return await verifySource(directory, ref, repository);
    temporary = await fs.mkdtemp(`${directory}.tmp-`);
    git(temporary, ['init', '--quiet']);
    git(temporary, ['remote', 'add', 'origin', repository]);
    try {
      git(temporary, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', ref]);
      git(temporary, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    } catch {
      throw new Error('固定依赖准备失败：请检查本机 Git 私有仓库读取权限、远程地址和完整 commit');
    }
    await verifySource(temporary, ref, repository);
    await fs.rename(temporary, directory);
    temporary = undefined;
    return directory;
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.rmdir(lock);
  }
}
