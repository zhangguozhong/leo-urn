#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBaseline } from './baseline.mjs';
import { checkDependencies, dependencyRecommendations } from './dependencies.mjs';
import { createArtifactManifest, verifyArtifacts, inspectBundlePhases } from './artifacts.mjs';

const help = `URN 依赖、平台基线和离线产物检查
用法：
  node tooling/urn/cli.mjs check-baseline --baseline FILE --app DIR [--release]
  node tooling/urn/cli.mjs doctor --app DIR
  node tooling/urn/cli.mjs sync --dry-run --app DIR
  node tooling/urn/cli.mjs create-artifacts --app DIR --built-app APP --baseline FILE --project PBXPROJ --target NAME [--manifest FILE] [--release]
  node tooling/urn/cli.mjs verify-artifacts --app DIR --built-app APP --baseline FILE --project PBXPROJ --target NAME [--manifest FILE] [--release]
  node tooling/urn/cli.mjs --help
所有路径显式指定；sync 仅输出建议，不安装依赖或修改工程。`;

export function run(argv, write = console.log) {
  if (argv.length === 0 || argv.includes('--help')) {
    write(help);
    return;
  }
  const [command, ...args] = argv;
  if (
    !['check-baseline', 'doctor', 'sync', 'create-artifacts', 'verify-artifacts'].includes(command)
  )
    throw new Error(`未知命令 ${command}`);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--release', '--dry-run'].includes(arg)) {
      if (options[arg]) throw new Error(`重复参数 ${arg}`);
      options[arg] = true;
    } else if (
      ['--app', '--baseline', '--built-app', '--project', '--target', '--manifest'].includes(arg)
    ) {
      const value = args[++index];
      if (!value || value.startsWith('--') || options[arg])
        throw new Error(`${arg} 需要唯一的路径值`);
      options[arg] = arg === '--target' ? value : path.resolve(value);
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (!options['--app']) throw new Error('必须显式指定 --app DIR');
  const artifactCommand = ['create-artifacts', 'verify-artifacts'].includes(command);
  const artifactFlags = ['--built-app', '--project', '--target', '--manifest'];
  if (!artifactCommand && artifactFlags.some((flag) => options[flag]))
    throw new Error(`${command} 不接受产物参数`);
  if (artifactCommand) {
    if (options['--dry-run']) throw new Error('产物命令不接受 --dry-run');
    for (const required of ['--built-app', '--project', '--target', '--baseline']) {
      if (!options[required]) throw new Error(`必须显式指定 ${required}`);
    }
    const source = {
      app: options['--app'],
      baseline: options['--baseline'],
      project: options['--project'],
      target: options['--target'],
    };
    const inspected = inspectBundlePhases(source);
    const action = command === 'create-artifacts' ? createArtifactManifest : verifyArtifacts;
    write(
      JSON.stringify(
        action({
          app: source.app,
          baseline: source.baseline,
          builtApp: options['--built-app'],
          bundlePhaseCount: inspected.bundlePhaseCount,
          manifest: options['--manifest'],
          release: options['--release'] ?? false,
        }),
        null,
        2,
      ),
    );
  } else if (command === 'check-baseline') {
    if (!options['--baseline'] || options['--dry-run'])
      throw new Error('check-baseline 需要 --baseline FILE');
    write(
      JSON.stringify(
        checkBaseline({
          app: options['--app'],
          baseline: options['--baseline'],
          release: options['--release'] ?? false,
        }),
        null,
        2,
      ),
    );
  } else if (command === 'doctor') {
    if (options['--baseline'] || options['--release'] || options['--dry-run'])
      throw new Error('doctor 仅接受 --app');
    write(JSON.stringify(checkDependencies({ app: options['--app'] }), null, 2));
  } else {
    if (!options['--dry-run'] || options['--baseline'] || options['--release'])
      throw new Error('sync 仅支持 --dry-run --app DIR');
    write(
      JSON.stringify(
        {
          dryRun: true,
          app: options['--app'],
          recommendations: dependencyRecommendations({ app: options['--app'] }),
          message: '请由 App 维护者审阅直接依赖并执行项目既有安装流程；此命令不修改文件。',
        },
        null,
        2,
      ),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(`URN: ${error.message}`);
    process.exitCode = 1;
  }
}
