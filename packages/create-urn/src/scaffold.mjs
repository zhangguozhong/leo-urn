import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProfile, relocateProfile } from '../lib/profile.mjs';
import { prepareProject } from '../lib/prepare-project.mjs';
import { templates } from './templates.mjs';

const safePath = (value) => /^[A-Za-z0-9_. /@+-]+$/.test(value);
async function exists(filename) {
  return fs.lstat(filename).then(
    () => true,
    () => false,
  );
}

export async function scaffold(options) {
  if (!options.directory || !options.iosProject || !options.target || !options.profile)
    throw new Error('需要输出目录、--ios-project、--target 和 --profile');
  let directory = path.resolve(options.directory);
  const project = await fs.realpath(path.resolve(options.iosProject));
  if (!safePath(directory) || !safePath(project) || !/^[A-Za-z0-9_. -]+$/.test(options.target))
    throw new Error(
      '路径或 target 不支持中文及 shell 转义字符，请使用英文字母、数字、空格、横线或下划线',
    );
  if (!project.endsWith('.xcodeproj')) throw new Error('--ios-project 必须是已有 .xcodeproj');
  let pbx;
  try {
    pbx = JSON.parse(
      execFileSync(
        'plutil',
        ['-convert', 'json', '-o', '-', path.join(project, 'project.pbxproj')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  } catch {
    throw new Error('无法读取已有 Xcode 工程，需要 macOS plutil 和有效 project.pbxproj');
  }
  if (
    Object.values(pbx.objects ?? {}).filter(
      (o) =>
        o.isa === 'PBXNativeTarget' &&
        o.productType === 'com.apple.product-type.application' &&
        o.name === options.target,
    ).length !== 1
  )
    throw new Error('未找到唯一 App target，请检查 --target');
  const { profile, directory: profileRoot } = await loadProfile(path.resolve(options.profile));
  if (await exists(directory)) throw new Error('输出目录已存在，不覆盖已有文件；请选择一个新目录');
  const name =
    options.name ??
    (path
      .basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') ||
      'urn-app');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('--name 必须是小写 npm 包名');
  if (options.dryRun)
    return { directory, iosProject: project, target: options.target, name, dryRun: true };
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const parent = await fs.realpath(path.dirname(directory));
  directory = path.join(parent, path.basename(directory));
  if (!safePath(directory)) throw new Error('实际路径不支持中文或 shell 转义字符');
  if (await exists(directory)) throw new Error('输出目录已存在');
  const temporary = await fs.mkdtemp(path.join(parent, '.urn-create-'));
  let committed = false;
  try {
    const files = templates({
      profile: relocateProfile(profile, profileRoot, directory),
      name,
      iosProject: path.relative(directory, project),
      target: options.target,
      hostFromApp: path.relative(directory, path.dirname(project)),
      appFromHost: path.relative(path.dirname(project), directory),
    });
    for (const [filename, content] of Object.entries(files)) {
      const destination = path.join(temporary, filename);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    // 同层临时目录保持本地制品相对路径语义；校验失败不留下半工程。
    await prepareProject({ app: temporary });
    await fs.rename(temporary, directory);
    committed = true;
    if (options.install) {
      try {
        execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: directory,
          stdio: 'inherit',
        });
      } catch {
        throw new Error(
          `工程已生成于 ${directory}，但 npm install 失败；请修复依赖/认证后在此目录重试，不要重新覆盖工程`,
        );
      }
    }
    return {
      directory,
      iosProject: project,
      target: options.target,
      installed: Boolean(options.install),
    };
  } finally {
    if (!committed) await fs.rm(temporary, { recursive: true, force: true });
  }
}
