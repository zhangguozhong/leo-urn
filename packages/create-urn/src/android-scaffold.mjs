import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProfile, relocateProfile, archiveName } from '../lib/profile.mjs';
import { prepareProject } from '../lib/prepare-project.mjs';
import { androidTemplates } from './android-templates.mjs';
const safePath = (value) => /^[A-Za-z0-9_. /@+-]+$/.test(value);
const exists = (file) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );

function assertAndroidInputs(stage, profile) {
  const core = path.join(
    stage,
    '.urn/aeris/native/android/aeris/src/main/java/com/aeris/sdk/BridgeEngine.kt',
  );
  return fs
    .readFile(core, 'utf8')
    .then((source) => {
      if (!source.startsWith('package com.aeris.sdk'))
        throw Error('Android profile 的原生 Core 包名不匹配');
      for (const name of ['leo-urn', 'aeris-react-native']) {
        const item = profile.packages.find((p) => p.name === name);
        const archive = path.join(stage, '.urn/packages', archiveName(item));
        const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
        if (!/package\/android\/build.gradle(?:\.kts)?\n/.test(entries))
          throw Error(`Android profile 缺少 ${name} 原生实现，不能使用尚不含 Android 的公开旧包`);
        if (name === 'aeris-react-native') {
          const metadata = JSON.parse(
            execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }),
          );
          if (
            metadata.codegenConfig?.android?.javaPackageName !== 'com.aeris.sdk.reactnative.codegen'
          )
            throw Error('Android RN 插件 Codegen 包名不匹配');
        }
      }
    })
    .catch((error) => {
      if (error.code === 'ENOENT')
        throw Error(
          'Android profile 的固定 Aeris 来源尚未包含 Android Core，请使用当前候选/已发布 Android 版本的 profile',
        );
      throw error;
    });
}

export async function scaffoldAndroid(options) {
  if (!options.directory || !options.profile) throw Error('需要输出目录和 --profile');
  const mode = options.mode ?? (options.androidProject ? 'embedded' : 'standalone');
  if (!['standalone', 'embedded'].includes(mode))
    throw Error('Android mode 必须为 standalone 或 embedded');
  let directory = path.resolve(options.directory);
  const applicationId = options.applicationId ?? 'com.urn.example';
  const appModule = options.appModule ?? 'app';
  if (!safePath(directory)) throw Error('路径不支持中文及 shell 转义字符');
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/.test(applicationId))
    throw Error('applicationId 必须为至少三级的小写 Android 包名');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(appModule))
    throw Error('app-module 只支持单个合法 Gradle application 模块名');
  if (await exists(directory)) throw Error('输出目录已存在，不覆盖文件');
  let host;
  if (mode === 'embedded') {
    if (!options.androidProject) throw Error('embedded 模式必须指定 --android-project 宿主目录');
    host = await fs.realpath(path.resolve(options.androidProject));
    if (!safePath(host)) throw Error('宿主路径不支持中文');
    if (
      !(await exists(path.join(host, 'settings.gradle'))) &&
      !(await exists(path.join(host, 'settings.gradle.kts')))
    )
      throw Error('宿主缺少 settings.gradle(.kts)');
    if (
      !(await exists(path.join(host, appModule, 'build.gradle'))) &&
      !(await exists(path.join(host, appModule, 'build.gradle.kts')))
    )
      throw Error('宿主缺少指定 App 模块');
  } else if (options.androidProject) throw Error('standalone 模式不能指定已有 Android 宿主');
  const { profile, directory: profileRoot } = await loadProfile(path.resolve(options.profile));
  const name =
    options.name ??
    path
      .basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw Error('--name 必须为小写 npm 包名');
  if (options.dryRun) return { directory, mode, applicationId, appModule, dryRun: true };
  await fs.mkdir(path.dirname(directory), { recursive: true });
  directory = path.join(await fs.realpath(path.dirname(directory)), path.basename(directory));
  if (!safePath(directory)) throw Error('实际路径不支持中文或 shell 转义字符');
  host ??= path.join(directory, 'android');
  const stage = await fs.mkdtemp(path.join(path.dirname(directory), '.urn-android-'));
  let committed = false;
  try {
    const files = androidTemplates({
      profile: relocateProfile(profile, profileRoot, directory),
      name,
      mode,
      appFromHost: path.relative(host, directory),
      hostFromApp: path.relative(directory, host),
      appModule,
      applicationId,
    });
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(stage, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    await prepareProject({ app: stage });
    await assertAndroidInputs(stage, profile);
    if (mode === 'standalone') {
      await fs.cp(new URL('../assets/android/', import.meta.url), path.join(stage, 'android'), {
        recursive: true,
      });
      await fs.chmod(path.join(stage, 'android/gradlew'), 0o755);
    }
    if (await exists(directory)) throw Error('输出目录已存在');
    await fs.rename(stage, directory);
    committed = true;
    if (options.install)
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: directory,
        stdio: 'inherit',
      });
    return {
      directory,
      mode,
      applicationId,
      appModule,
      androidProject: host,
      installed: Boolean(options.install),
    };
  } finally {
    if (!committed) await fs.rm(stage, { recursive: true, force: true });
  }
}
