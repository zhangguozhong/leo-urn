import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDependencies, resolvePackage, codegenIdentity } from './dependencies.mjs';
import { validateProfile } from './profile.mjs';

const fixed = Object.freeze({
  react: '19.2.3',
  'react-native': '0.87.0',
  'leo-urn': '0.3.0-preview.1',
  'aeris-client-core': '0.26.0-preview.2',
  'aeris-react-native': '0.26.0-preview.2',
});
const probeScript = fileURLToPath(new URL('./android-probe.gradle', import.meta.url));
const fail = (message) => {
  throw new Error(`ANDROID_PROJECT: ${message}`);
};
const need = (condition, message) => {
  if (!condition) fail(message);
};
const json = (filename) => {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${filename}: ${error.message}`);
  }
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = (filename) => hash(fs.readFileSync(filename));
const exists = (filename) => fs.existsSync(filename);
const gradleFile = (directory, stem) =>
  ['.gradle', '.gradle.kts'].map((ext) => path.join(directory, stem + ext)).find(exists);
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stable = (value) => JSON.stringify(value, null, 2);
// npm 会规范化 lock 中对象的键顺序；比较 JSON 语义，仍保留数组顺序。
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(lexical)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const same = (a, b, label) =>
  need(stable(canonical(a)) === stable(canonical(b)), `${label} 与实际工程不匹配`);
const git = (directory, args) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export function readAndroidProject(app) {
  need(typeof app === 'string' && app.length > 0, '必须指定 App 目录');
  app = fs.realpathSync(app);
  const config = json(path.join(app, 'urn.project.json'));
  need(
    config.schemaVersion === 1 && config.platform === 'android',
    'urn.project.json 必须是 Android 工程',
  );
  need(['standalone', 'embedded'].includes(config.mode), 'Android mode 必须为 standalone/embedded');
  need(
    typeof config.androidProject === 'string' && config.androidProject.length > 0,
    '缺少 androidProject',
  );
  need(
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(config.appModule ?? ''),
    'appModule 必须为单个合法 Gradle 模块名',
  );
  need(
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(config.applicationId ?? ''),
    'applicationId 非法',
  );
  const projectDir = fs.realpathSync(path.resolve(app, config.androidProject));
  need(
    fs.statSync(projectDir).isDirectory() && gradleFile(projectDir, 'settings'),
    '宿主缺少 settings.gradle(.kts)',
  );
  need(
    gradleFile(path.join(projectDir, config.appModule), 'build'),
    '宿主缺少指定 App 模块 build.gradle(.kts)',
  );
  return {
    app,
    projectDir,
    appModule: config.appModule,
    applicationId: config.applicationId,
    mode: config.mode,
  };
}

function nativeAndroid(root, label, codegenName, javaPackage) {
  const metadata = json(path.join(root, 'package.json'));
  need(
    gradleFile(path.join(root, 'android'), 'build'),
    `${label} 缺少 Android 原生实现；旧公开 iOS profile 不适用于 Android`,
  );
  need(
    codegenIdentity(metadata.codegenConfig) === `${codegenName}:modules` &&
      metadata.codegenConfig.android?.javaPackageName === javaPackage,
    `${label} Android Codegen 身份不匹配`,
  );
  const specs = path.resolve(root, metadata.codegenConfig.jsSrcsDir ?? 'src/specs');
  need(
    fs.existsSync(specs) && fs.readdirSync(specs).some((name) => /^Native.*\.[jt]sx?$/.test(name)),
    `${label} 缺少真实 Codegen spec`,
  );
  const source = path.join(root, 'android/src/main');
  need(
    exists(source) && collect(source, (name) => /\.(kt|java)$/.test(name)).length > 0,
    `${label} 缺少 Android Native 源码`,
  );
  return { root, metadata };
}

/** 使用同一依赖检查器验证 runtime 单例和业务插件并集，然后检查 Android 真实输入。 */
export function androidDoctor({ app }) {
  const project = readAndroidProject(app);
  const dependencies = checkDependencies({ app: project.app, pinnedVersions: fixed });
  const profile = validateProfile(json(path.join(project.app, 'urn.profile.json')));
  const source = fs.realpathSync(path.join(project.app, '.urn/aeris'));
  const aerisAndroidRoot = path.join(source, 'native/android');
  const core = path.join(aerisAndroidRoot, 'aeris');
  const build = gradleFile(core, 'build');
  need(
    build && /namespace\s*(?:=\s*)?["']com\.aeris\.sdk["']/.test(fs.readFileSync(build, 'utf8')),
    '固定 .urn/aeris 缺少 com.aeris.sdk Android Core；不能使用旧公开 iOS profile',
  );
  const engine = path.join(core, 'src/main/java/com/aeris/sdk/BridgeEngine.kt');
  need(
    exists(engine) && /package\s+com\.aeris\.sdk\b/.test(fs.readFileSync(engine, 'utf8')),
    'Aeris Core 源码 namespace 不匹配',
  );
  need(
    fs.realpathSync(git(source, ['rev-parse', '--show-toplevel'])) === source &&
      git(source, ['rev-parse', 'HEAD']) === profile.aeris.source.ref,
    'Aeris sourceRef 与固定检出不匹配',
  );
  need(
    git(source, ['status', '--porcelain', '--untracked-files=all']) === '',
    '固定 Aeris 源码包含未提交修改',
  );
  const rn = resolvePackage('react-native', project.app);
  const nodeModules = path.dirname(rn.root);
  need(path.basename(nodeModules) === 'node_modules', 'RN 必须来自真实 node_modules 安装图');
  need(
    exists(path.join(rn.root, 'ReactAndroid')) && exists(path.join(rn.root, 'cli.js')),
    'react-native 缺少 Android 实现或 CLI',
  );
  const codegen = resolvePackage('@react-native/codegen', project.app);
  need(
    codegen.metadata.version === fixed['react-native'] &&
      exists(path.join(codegen.root, 'lib/cli/combine/combine-js-to-schema-cli.js')),
    'RN Codegen 版本或实现缺失',
  );
  const gradlePlugin = resolvePackage('@react-native/gradle-plugin', project.app);
  need(
    gradlePlugin.metadata.version === fixed['react-native'] &&
      gradleFile(gradlePlugin.root, 'settings'),
    'RN Gradle 插件版本或实现缺失',
  );
  const urn = nativeAndroid(
    resolvePackage('leo-urn', project.app).root,
    'leo-urn',
    'URNSpec',
    'com.urn.sdk.codegen',
  );
  const candidate = process.env.URN_AERIS_RN_CANDIDATE;
  const adapter = nativeAndroid(
    candidate
      ? fs.realpathSync(path.resolve(project.app, candidate))
      : resolvePackage('aeris-react-native', project.app).root,
    'aeris-react-native',
    'NativeUnifiedBridgeSpec',
    'com.aeris.sdk.reactnative.codegen',
  );
  need(
    adapter.metadata.name === 'aeris-react-native' &&
      adapter.metadata.version === fixed['aeris-react-native'],
    'Aeris RN candidate 身份或版本不匹配',
  );
  // 每个业务插件都捕获已安装的版本与 Codegen，而不是把声明范围冒充实际版本。
  const nativePlugins = dependencies.nativePlugins.map((plugin) => {
    const installed =
      plugin.name === 'aeris-react-native' ? adapter : resolvePackage(plugin.name, project.app);
    need(
      gradleFile(path.join(installed.root, 'android'), 'build'),
      `${plugin.name} 插件缺少 Android 实现`,
    );
    return {
      ...plugin,
      version: installed.metadata.version,
      ...(installed.metadata.codegenConfig ? { codegen: installed.metadata.codegenConfig } : {}),
    };
  });
  return {
    ok: true,
    ...project,
    nodeModules,
    aerisAndroidRoot,
    sourceRoot: source,
    sourceRef: profile.aeris.source.ref,
    profile,
    nativePlugins,
    urnRoot: urn.root,
    adapterRoot: adapter.root,
    candidateOverride: Boolean(candidate),
    dependencies,
  };
}

function gradleInvocation(project, doctor) {
  const command = path.join(
    project.projectDir,
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
  );
  need(exists(command), '宿主缺少 Gradle wrapper');
  return {
    command,
    args: [],
    cwd: project.projectDir,
    env: {
      ...process.env,
      ORG_GRADLE_PROJECT_urnNodeModules: doctor.nodeModules,
      ORG_GRADLE_PROJECT_aerisNodeModulesDir: doctor.nodeModules,
      ORG_GRADLE_PROJECT_aerisAndroidRoot: doctor.aerisAndroidRoot,
    },
  };
}

export function androidBuildInvocation({
  app,
  variant = 'debug',
  metro = false,
  bundle = false,
  install = false,
}) {
  need(['debug', 'release'].includes(variant), 'variant 只能为 debug/release');
  need(
    [metro, bundle, install].every((value) => typeof value === 'boolean'),
    '构建选项必须为 boolean',
  );
  need(!(variant === 'release' && metro), 'Release 禁止 Metro');
  need(!(bundle && install), 'AAB bundle 不能直接 install');
  need(
    !(variant === 'release' && install),
    'Release 使用 assembleRelease/bundleRelease，安装由宿主管理',
  );
  const doctor = androidDoctor({ app });
  const invocation = gradleInvocation(doctor, doctor);
  const action = bundle ? 'bundle' : install ? 'install' : 'assemble';
  invocation.args = [
    `:${doctor.appModule}:${action}${variant === 'debug' ? 'Debug' : 'Release'}`,
    `-PurnMetro=${metro}`,
    '-PurnCompileSdk=37',
    '--no-daemon',
    '--console=plain',
  ];
  return invocation;
}

function collect(directory, accept) {
  if (!exists(directory)) return [];
  const result = [];
  for (const item of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => lexical(a.name, b.name))) {
    if (['build', '.gradle', '.git', 'node_modules', '.idea', '.cxx'].includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...collect(filename, accept));
    else if (item.isFile() && accept(item.name)) result.push(filename);
  }
  return result;
}
function configuration(doctor) {
  const configName = (name) =>
    /(?:\.gradle(?:\.kts)?|\.properties|\.toml|\.pro|\.cmake)$/.test(name) ||
    ['gradlew', 'gradlew.bat', 'gradle-wrapper.jar', 'CMakeLists.txt'].includes(name);
  const groups = [
    ['project', doctor.projectDir, collect(doctor.projectDir, configName)],
    [
      'app',
      doctor.app,
      [
        'package.json',
        'package-lock.json',
        'urn.project.json',
        'urn.profile.json',
        'react-native.config.js',
        'react-native.config.cjs',
      ]
        .map((name) => path.join(doctor.app, name))
        .filter(exists),
    ],
    ['aeris', doctor.aerisAndroidRoot, collect(doctor.aerisAndroidRoot, configName)],
    ['urn', doctor.urnRoot, collect(path.join(doctor.urnRoot, 'android'), configName)],
    ['adapter', doctor.adapterRoot, collect(path.join(doctor.adapterRoot, 'android'), configName)],
    [
      'rn',
      resolvePackage('react-native', doctor.app).root,
      collect(
        path.join(resolvePackage('react-native', doctor.app).root, 'ReactAndroid'),
        configName,
      ),
    ],
    [
      'rn-gradle-plugin',
      resolvePackage('@react-native/gradle-plugin', doctor.app).root,
      collect(
        resolvePackage('@react-native/gradle-plugin', doctor.app).root,
        (name) => configName(name) || /\.(?:kt|java)$/.test(name),
      ),
    ],
    ...(doctor.candidateOverride
      ? [
          [
            'candidate',
            doctor.adapterRoot,
            [
              ...collect(path.join(doctor.adapterRoot, 'android'), (name) =>
                /\.(?:kt|java|cpp|h)$/.test(name),
              ),
              ...collect(path.join(doctor.adapterRoot, 'src'), (name) => /\.[jt]sx?$/.test(name)),
            ],
          ],
        ]
      : []),
  ];
  const files = groups.flatMap(([label, directory, names]) =>
    names.map((filename) => ({
      path: `${label}/${path.relative(directory, filename).split(path.sep).join('/')}`,
      sha256: digest(filename),
    })),
  );
  for (const name of [
    ...Object.keys(fixed),
    ...doctor.nativePlugins.map((plugin) => plugin.name),
    '@react-native/codegen',
    '@react-native/gradle-plugin',
  ]) {
    const root =
      name === 'aeris-react-native' ? doctor.adapterRoot : resolvePackage(name, doctor.app).root;
    files.push({
      path: `dependency/${name}/package.json`,
      sha256: digest(path.join(root, 'package.json')),
    });
  }
  files.push({ path: 'tooling/android-probe.gradle', sha256: digest(probeScript) });
  const unique = [...new Map(files.map((file) => [file.path, file])).values()].sort((a, b) =>
    lexical(a.path, b.path),
  );
  return { configurationFingerprint: hash(stable(unique)), configurationFiles: unique };
}
function environmentFingerprint() {
  const names = Object.keys(process.env)
    .filter(
      (name) =>
        name.startsWith('ORG_GRADLE_PROJECT_') ||
        [
          'JAVA_HOME',
          'PATH',
          'ANDROID_HOME',
          'ANDROID_SDK_ROOT',
          'GRADLE_USER_HOME',
          'JAVA_TOOL_OPTIONS',
          'GRADLE_OPTS',
        ].includes(name),
    )
    .sort();
  const inputs = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const home = process.env.GRADLE_USER_HOME ?? path.join(process.env.HOME ?? '', '.gradle');
  const properties = path.join(home, 'gradle.properties');
  inputs.userGradleProperties = exists(properties) ? digest(properties) : null;
  return hash(stable(inputs));
}

export function parseAndroidProbe(text, expected = {}) {
  need(typeof text === 'string', 'Gradle probe 输出必须为文本');
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('URN_ANDROID_PROBE='));
  need(lines.length === 1, '必须只有一条 URN_ANDROID_PROBE JSON 输出');
  let model;
  try {
    model = JSON.parse(lines[0].slice('URN_ANDROID_PROBE='.length));
  } catch {
    fail('Gradle probe JSON 损坏');
  }
  need(model && model.schemaVersion === 1, 'Gradle probe schemaVersion 非法');
  for (const key of ['projectDir', 'appModule', 'applicationId']) {
    need(typeof model[key] === 'string' && model[key].length > 0, `Gradle probe 缺少 ${key}`);
    if (expected[key] !== undefined) same(model[key], expected[key], `Gradle probe ${key}`);
  }
  return model;
}

export function validateAndroidModel(model, { release = false } = {}) {
  need(model && model.schemaVersion === 1, 'Gradle probe schemaVersion 非法');
  need(/^17(?:\.|$)/.test(model.javaVersion ?? ''), 'Android 基线需要 JDK 17');
  need(model.gradleVersion === '9.4.1', 'Android 基线需要 Gradle 9.4.1');
  need(model.agpVersion === '9.2.1', 'Android 基线需要 AGP 9.2.1');
  need(model.compileSdk === 37, 'Android compileSdk 必须为 37');
  need(Number.isInteger(model.minSdk) && model.minSdk >= 24, 'Android minSdk 必须为 >=24 的整数');
  need(
    Number.isInteger(model.targetSdk) &&
      model.targetSdk >= model.minSdk &&
      model.targetSdk <= model.compileSdk,
    'Android targetSdk 不合法',
  );
  need(model.ndkVersion === '27.1.12297006', 'Android NDK 必须为 27.1.12297006');
  need(
    model.hermesEnabled === true && model.newArchEnabled === true,
    'Android 必须启用 Hermes 和新架构',
  );
  need(typeof model.r8Enabled === 'boolean', 'Gradle probe 必须记录实际 R8 开关');
  if (release) need(model.r8Enabled, 'Release 必须由实际 Gradle probe 确认开启 R8');
  return model;
}

export function runAndroidProbe({ app, output } = {}) {
  const doctor = androidDoctor({ app });
  const before = configuration(doctor);
  const invocation = gradleInvocation(doctor, doctor);
  invocation.args = [
    '-I',
    probeScript,
    `:${doctor.appModule}:urnAndroidProbe`,
    `-PurnAppModule=${doctor.appModule}`,
    '--no-daemon',
    '--console=plain',
  ];
  const stdout = execFileSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const model = parseAndroidProbe(stdout, doctor);
  same(configuration(doctor), before, 'probe 运行期间的 Gradle 配置');
  const probe = {
    ...model,
    ...before,
    environmentFingerprint: environmentFingerprint(),
    capturedAt: new Date().toISOString(),
  };
  const filename = path.resolve(doctor.app, output ?? '.urn/android-probe.json');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, stable(probe) + '\n');
  return { ...probe, filename };
}

function loadProbe(doctor, probeFile) {
  const filename = path.resolve(doctor.app, probeFile ?? '.urn/android-probe.json');
  const probe = exists(filename)
    ? json(filename)
    : runAndroidProbe({ app: doctor.app, output: filename });
  parseAndroidProbe('URN_ANDROID_PROBE=' + JSON.stringify(probe), doctor);
  const current = configuration(doctor);
  same(probe.configurationFingerprint, current.configurationFingerprint, '陈旧 probe 的配置指纹');
  same(probe.configurationFiles, current.configurationFiles, '陈旧 probe 的配置输入');
  same(probe.environmentFingerprint, environmentFingerprint(), '陈旧 probe 的 Gradle 环境');
  return probe;
}

function locks(doctor) {
  const filename = path.join(doctor.app, 'package-lock.json');
  const lock = json(filename);
  const app = json(path.join(doctor.app, 'package.json'));
  need(
    [2, 3].includes(lock.lockfileVersion) && lock.packages?.[''],
    'package-lock 缺少真实 packages 安装图',
  );
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    same(lock.packages[''][field] ?? {}, app[field] ?? {}, `package-lock 根 ${field}`);
  for (const name of new Set([
    ...Object.keys(fixed),
    ...doctor.nativePlugins.map((plugin) => plugin.name),
  ])) {
    const installed = resolvePackage(name, doctor.app);
    let entry = lock.packages[`node_modules/${name}`];
    need(entry, `package-lock 缺少 ${name}`);
    if (entry.link) entry = lock.packages[entry.resolved];
    need(
      entry?.version === installed.metadata.version,
      `package-lock ${name} 与实际安装版本不一致`,
    );
    need(
      (typeof entry.integrity === 'string' &&
        /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) ||
        lock.packages[`node_modules/${name}`].link === true,
      `package-lock ${name} 缺少完整性摘要`,
    );
  }
  const wrapper = path.join(doctor.projectDir, 'gradle/wrapper/gradle-wrapper.properties');
  const wrapperJar = path.join(doctor.projectDir, 'gradle/wrapper/gradle-wrapper.jar');
  need(exists(wrapper) && exists(wrapperJar), '缺少真实 Gradle wrapper 属性或 jar');
  need(
    /distributionUrl=.*gradle-9\.4\.1-(?:bin|all)\.zip\s*$/m.test(fs.readFileSync(wrapper, 'utf8')),
    'Gradle wrapper distribution 必须固定 9.4.1',
  );
  return [filename, wrapper, wrapperJar].map((file) => ({
    path: path.relative(doctor.app, file).split(path.sep).join('/'),
    sha256: digest(file),
  }));
}
function baselineModel(doctor, probe) {
  return {
    schemaVersion: 1,
    platform: 'android',
    baselineId: doctor.profile.baselineId,
    versions: {
      react: fixed.react,
      reactNative: fixed['react-native'],
      urnJs: fixed['leo-urn'],
      urnAndroid: fixed['leo-urn'],
      aeris: fixed['aeris-client-core'],
    },
    project: {
      appModule: doctor.appModule,
      applicationId: doctor.applicationId,
      mode: doctor.mode,
    },
    aeris: { sourceRef: doctor.sourceRef },
    toolchain: {
      javaVersion: probe.javaVersion,
      gradleVersion: probe.gradleVersion,
      agpVersion: probe.agpVersion,
    },
    android: {
      compileSdk: probe.compileSdk,
      minSdk: probe.minSdk,
      targetSdk: probe.targetSdk,
      ndkVersion: probe.ndkVersion,
      hermesEnabled: probe.hermesEnabled,
      newArchEnabled: probe.newArchEnabled,
      r8Enabled: probe.r8Enabled,
    },
    nativePlugins: doctor.nativePlugins,
    locks: locks(doctor),
    ...configuration(doctor),
  };
}

export function captureAndroidBaseline({ app, output, probeFile } = {}) {
  const doctor = androidDoctor({ app });
  const filename = path.resolve(doctor.app, output ?? 'android-baseline.json');
  need(!exists(filename), '已有 Android 基线不会被覆盖，请另选 output 后审阅');
  const probe = validateAndroidModel(loadProbe(doctor, probeFile));
  const baseline = baselineModel(doctor, probe);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, stable(baseline) + '\n', { flag: 'wx' });
  return { filename, reviewRequired: true, baseline };
}

export function checkAndroidBaseline({ app, baseline, probeFile, release = false } = {}) {
  const doctor = androidDoctor({ app });
  const expected =
    typeof baseline === 'object' && baseline !== null
      ? baseline
      : json(path.resolve(doctor.app, baseline ?? 'android-baseline.json'));
  need(
    expected.schemaVersion === 1 && expected.platform === 'android',
    'Android baseline 格式非法',
  );
  const probe = validateAndroidModel(loadProbe(doctor, probeFile), { release });
  const actual = baselineModel(doctor, probe);
  same(expected, actual, 'Android baseline（依赖/锁/Codegen/工具链/配置）');
  return { ok: true, baseline: expected, probe };
}
