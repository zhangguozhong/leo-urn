import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { resolvePackage } from './dependencies.mjs';

function read(file) {
  if (fs.statSync(file).size > 256 * 1024) throw new Error('配置超过256KiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 只检查实际安装和明确声明的接线，不将静态检查宣称为设备验收。 */
export function inspectContainer({ app }) {
  app = fs.realpathSync(app);
  const checks = [];
  const add = (code, state, message) => checks.push({ code, state, message });
  let sdk;
  try {
    sdk = resolvePackage('leo-urn', app).metadata;
    add('SDK_INSTALLED', 'passed', `leo-urn ${sdk.version}`);
  } catch {
    add('SDK_NOT_INSTALLED', 'failed', '请先安装项目锁定的leo-urn');
  }
  if (!fs.existsSync(path.join(app, 'package-lock.json'))) {
    add('LOCK_MISSING', 'not_applicable', '尚未提供package-lock.json，不能确认锁定来源');
  }
  const configFile = path.join(app, 'container.project.json');
  if (!fs.existsSync(configFile)) {
    add('HOST_CONFIGURATION_MISSING', 'not_applicable', '未提供container.project.json平台接线声明');
  } else {
    const config = read(configFile);
    if (config.schemaVersion !== 1 || !config.platforms || Array.isArray(config.platforms)) {
      throw new Error('container.project.json需要schemaVersion=1及platforms');
    }
    const entries = Object.entries(config.platforms);
    if (!entries.length || entries.some(([p]) => !['ios', 'android'].includes(p))) {
      throw new Error('platforms只能声明非空ios/android配置');
    }
    for (const [platform, entry] of entries) {
      for (const key of [
        'project',
        ...(platform === 'ios' ? ['podfile'] : []),
        ...(entry.bundle ? ['bundle'] : []),
      ]) {
        const relative = entry[key];
        const exists =
          typeof relative === 'string' &&
          relative.length > 0 &&
          fs.existsSync(path.resolve(app, relative));
        add(
          `${platform.toUpperCase()}_${key.toUpperCase()}`,
          exists ? 'passed' : 'failed',
          `${platform} ${key}${exists ? '存在' : '缺失'}`,
        );
      }
      if (
        platform === 'ios' &&
        typeof entry.podfile === 'string' &&
        fs.existsSync(path.resolve(app, entry.podfile))
      ) {
        const text = fs.readFileSync(path.resolve(app, entry.podfile), 'utf8');
        const linked = text.includes('use_native_modules!') || /pod\s+['"]LeoURN['"]/.test(text);
        add(
          'IOS_AUTOLINK',
          linked ? 'passed' : 'failed',
          linked ? '发现RN自动链接或LeoURN声明' : '未发现RN自动链接或LeoURN声明',
        );
      }
    }
  }
  // 缺锁单独列出，不将存在的原生文件检查误报为运行通过。
  const relevant = checks.filter((c) => c.code !== 'LOCK_MISSING');
  return {
    schemaVersion: 1,
    runtimeVerified: false,
    state: checks.some((c) => c.state === 'failed')
      ? 'failed'
      : relevant.some((c) => c.state === 'not_applicable')
        ? 'not_applicable'
        : 'ready',
    sdk: sdk ? { name: sdk.name, version: sdk.version } : null,
    checks,
  };
}

/** 升级目标可以使用公开profile；这里只报告差异，绝不修改依赖或放宽基线。 */
export function planUpgrade({ app, target }) {
  const metadata = read(path.join(app, 'package.json'));
  const items = target?.packages;
  if (
    target?.schemaVersion !== 1 ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > 64
  ) {
    throw new Error('升级目标需要schemaVersion=1和1至64项精确packages');
  }
  const seen = new Set();
  const changes = [];
  for (const item of items) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name) ||
      !semver.valid(item.version) ||
      seen.has(item.name)
    ) {
      throw new Error('升级目标包名、精确版本或唯一性不合法');
    }
    seen.add(item.name);
    let installed;
    try {
      installed = resolvePackage(item.name, app).metadata.version;
    } catch {
      /* 未安装时报告直接声明。 */
    }
    const current =
      installed ??
      metadata.dependencies?.[item.name] ??
      metadata.devDependencies?.[item.name] ??
      null;
    if (current !== item.version) changes.push({ name: item.name, current, target: item.version });
  }
  return {
    schemaVersion: 1,
    dryRun: true,
    changes,
    steps: [
      '审阅完整配套profile及原生插件并集',
      '由宿主更新依赖并重新生成锁文件',
      '运行Pod/Gradle、Codegen和baseline检查',
      '完成Debug/Release与设备场景验收后采用新基线',
    ],
    message: '本命令未修改任何文件；版本相同也不能替代Native及设备验收。',
  };
}

export function runContainerTools(argv, write) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (Object.hasOwn(options, key)) throw new Error(`重复参数${key}`);
    if (key === '--dry-run') options[key] = true;
    else if (['--app', '--target'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--'))
      options[key] = path.resolve(args[++i]);
    else throw new Error(`不支持参数${key}`);
  }
  if (!options['--app']) throw new Error('必须指定--app');
  if (command === 'upgrade') {
    if (!options['--target'] || !options['--dry-run'])
      throw new Error('upgrade需要--target和--dry-run');
    write(
      JSON.stringify(
        planUpgrade({ app: options['--app'], target: read(options['--target']) }),
        null,
        2,
      ),
    );
  } else {
    if (options['--target'] || options['--dry-run']) throw new Error('capabilities仅接受--app');
    write(JSON.stringify(inspectContainer({ app: options['--app'] }), null, 2));
  }
}
