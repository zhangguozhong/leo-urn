import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readAndroidProject,
  androidDoctor,
  androidBuildInvocation,
  runAndroidProbe,
  captureAndroidBaseline,
  checkAndroidBaseline,
} from './android-project.mjs';
import { auditAndroidArtifact, auditAndroidAar } from './android-artifacts.mjs';

export function isAndroidProject(app) {
  const filename = path.resolve(app, 'urn.project.json');
  return (
    fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).platform === 'android'
  );
}

const specifications = {
  'android-build': [
    '--app',
    '--variant',
    '--metro',
    '--bundle',
    '--install',
    '--launch',
    '--activity',
    '--baseline',
  ],
  'android-probe': ['--app', '--output'],
  'android-audit': ['--app', '--artifact', '--bundle-file', '--bundle-sha', '--abis', '--resource'],
  'android-aar': ['--app', '--artifact', '--required-class', '--abis'],
  baseline: ['--app', '--output', '--probe'],
  'check-baseline': ['--app', '--baseline', '--probe', '--release'],
  doctor: ['--app'],
};
const booleans = new Set(['--metro', '--bundle', '--install', '--launch', '--release']);
const repeated = new Set(['--resource', '--required-class']);

/** 参数严格按命令校验，所有外部进程均使用参数数组。 */
export function parseAndroidArguments(argv) {
  const [command, ...args] = argv;
  const accepted = specifications[command];
  if (!accepted) throw new Error(`未知 Android 命令 ${command}`);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!accepted.includes(flag)) throw new Error(`${command} 不接受 ${flag}`);
    if (options[flag] !== undefined && !repeated.has(flag)) throw new Error(`重复参数 ${flag}`);
    if (booleans.has(flag)) options[flag] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 需要值`);
      if (repeated.has(flag)) (options[flag] ??= []).push(value);
      else options[flag] = value;
    }
  }
  if (!options['--app']) throw new Error('必须显式指定 --app DIR');
  const app = path.resolve(options['--app']);
  if (command === 'android-build') {
    const variant = options['--variant'] ?? 'debug';
    if (!['debug', 'release'].includes(variant)) throw new Error('variant 只能为 debug/release');
    if (
      variant === 'release' &&
      (options['--metro'] || options['--install'] || options['--launch'])
    )
      throw new Error('Release 禁止 Metro、自动安装和启动');
    if (options['--bundle'] && (options['--install'] || options['--launch']))
      throw new Error('AAB 不能直接安装或启动');
    if (options['--launch'] && !options['--install'])
      throw new Error('--launch 必须同时指定 --install');
    if (options['--activity'] && !options['--launch'])
      throw new Error('--activity 仅用于 --launch');
    if (options['--baseline'] && variant !== 'release')
      throw new Error('--baseline 仅用于 Release');
  }
  for (const key of ['--artifact'])
    if (accepted.includes(key) && !options[key]) throw new Error(`必须指定 ${key}`);
  if (options['--bundle-file'] && options['--bundle-sha'])
    throw new Error('bundle 文件和摘要只指定一种');
  if (options['--bundle-sha'] && !/^[a-f0-9]{64}$/.test(options['--bundle-sha']))
    throw new Error('bundle 摘要必须为 SHA256');
  return { command, options, app };
}

export function runAndroidCLI(argv, write = console.log) {
  const { command, options: o, app } = parseAndroidArguments(argv);
  let result;
  if (command === 'doctor') result = androidDoctor({ app });
  else if (command === 'baseline')
    result = captureAndroidBaseline({ app, output: o['--output'], probeFile: o['--probe'] });
  else if (command === 'check-baseline')
    result = checkAndroidBaseline({
      app,
      baseline: o['--baseline'],
      probeFile: o['--probe'],
      release: o['--release'] ?? false,
    });
  else if (command === 'android-probe') result = runAndroidProbe({ app, output: o['--output'] });
  else if (command === 'android-build') {
    const project = readAndroidProject(app);
    // 嵌入工程的入口属于业务，不能猜测或覆盖原 Activity。
    if (o['--launch'] && project.mode === 'embedded' && !o['--activity'])
      throw new Error('嵌入工程启动必须显式指定 --activity');
    const activity = o['--activity'] ?? `${project.applicationId}.MainActivity`;
    if (o['--launch'] && !/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(activity))
      throw new Error('Activity 类名非法');
    if ((o['--variant'] ?? 'debug') === 'release') {
      const probe = runAndroidProbe({ app });
      checkAndroidBaseline({
        app,
        baseline: o['--baseline'],
        probeFile: probe.filename,
        release: true,
      });
    }
    const invocation = androidBuildInvocation({
      app,
      variant: o['--variant'] ?? 'debug',
      metro: o['--metro'] ?? false,
      bundle: o['--bundle'] ?? false,
      install: o['--install'] ?? false,
    });
    execFileSync(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'inherit',
    });
    if (o['--launch'])
      execFileSync(
        'adb',
        ['shell', 'am', 'start', '-W', '-n', `${project.applicationId}/${activity}`],
        { stdio: 'inherit' },
      );
    result = {
      ok: true,
      projectDir: project.projectDir,
      task: invocation.args[0],
      launched: o['--launch'] ?? false,
    };
  } else {
    // 审计绑定真实项目和依赖，不能把另一工程的制品冒充当前基线通过。
    const project = androidDoctor({ app });
    const common = {
      artifact: path.resolve(app, o['--artifact']),
      ...(o['--abis'] ? { abis: o['--abis'].split(',') } : {}),
    };
    result =
      command === 'android-aar'
        ? auditAndroidAar({
            ...common,
            requiredClasses: o['--required-class'],
            requiredNativeAbis: common.abis,
          })
        : auditAndroidArtifact({
            ...common,
            bundle: o['--bundle-file']
              ? path.resolve(app, o['--bundle-file'])
              : o['--bundle-sha']
                ? { sha256: o['--bundle-sha'] }
                : undefined,
            resources: o['--resource'],
          });
    result.project = { applicationId: project.applicationId, sourceRef: project.sourceRef };
  }
  write(JSON.stringify(result, null, 2));
  return result;
}
