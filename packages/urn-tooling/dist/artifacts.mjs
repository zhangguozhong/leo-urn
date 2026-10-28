import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBaseline, validateBaseline } from './baseline.mjs';

const requireValue = (condition, message) => {
  if (!condition) throw new Error(`ARTIFACT: ${message}`);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// 排序对象键，让摘要不受 JSON 缩进和字段顺序影响；数组顺序仍属于基线契约。
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
function readJSON(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function readPlist(filename) {
  try {
    return JSON.parse(
      execFileSync('plutil', ['-convert', 'json', '-o', '-', filename], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    throw new Error(`ARTIFACT: 无法通过 plutil 读取 ${filename}: ${error.message}`);
  }
}
function safePath(root, relative) {
  requireValue(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !relative.includes('\\') &&
      !relative.includes('\0') &&
      !path.posix.isAbsolute(relative) &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    `非法产物路径 ${relative}`,
  );
  const filename = path.join(root, relative);
  requireValue(fs.existsSync(filename), `缺少 ${relative}`);
  const real = fs.realpathSync(filename);
  const inside = path.relative(root, real);
  requireValue(
    inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside),
    `符号链接逃逸 App: ${relative}`,
  );
  return filename;
}
function inventory(root) {
  const entries = [];
  function walk(relative, ancestors) {
    const filename = safePath(root, relative);
    const real = fs.realpathSync(filename);
    const stat = fs.statSync(filename);
    if (stat.isDirectory()) {
      requireValue(!ancestors.has(real), `符号链接目录循环: ${relative}`);
      const next = new Set([...ancestors, real]);
      for (const name of fs.readdirSync(filename).sort()) walk(`${relative}/${name}`, next);
    } else {
      requireValue(stat.isFile(), `不支持的产物文件类型: ${relative}`);
      entries.push({ path: relative, size: stat.size, sha256: sha256(fs.readFileSync(filename)) });
    }
  }
  for (const name of fs.readdirSync(root).sort()) walk(name, new Set([root]));
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function inspectInfo(root, baseline) {
  const info = readPlist(safePath(root, 'Info.plist'));
  requireValue(
    info.URNBundleMode === 'embedded',
    '实际 Info.plist 必须声明 URNBundleMode=embedded，禁止 Metro',
  );
  requireValue(
    info.URNBuildConfiguration === 'Release',
    '实际 Info.plist 必须声明 URNBuildConfiguration=Release',
  );
  requireValue(
    info.URNBaselineId === baseline.baselineId,
    '实际 Info.plist URNBaselineId 与基线不匹配',
  );
  function checkRemote(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      requireValue(
        !/metro|(?:bundle|javascript|js)(?:source)?url|remote(?:config|bundle|url)/i.test(key) ||
          item === '' ||
          item === null ||
          item === false,
        `离线产物禁止 Metro/远程配置 ${key}`,
      );
      requireValue(
        !/^(?:URNDebug|RCTDevMode)$/i.test(key) || item === false || item === 0,
        `离线产物禁止 Debug 配置 ${key}`,
      );
      checkRemote(item);
    }
  }
  checkRemote(info);
}
function context(options) {
  const baseline =
    typeof options.baseline === 'string'
      ? readJSON(path.resolve(options.baseline))
      : options.baseline;
  // sourceRef 真值来自既有 capability 与基线检查，绝不在产物工具中硬编码。
  checkBaseline({
    app: options.app,
    baseline,
    toolchain: options.toolchain,
    release: options.release ?? false,
  });
  requireValue(
    options.bundlePhaseCount === 1,
    '必须提供实际工程扫描的唯一 RN bundle phase (bundlePhaseCount=1)',
  );
  requireValue(
    typeof options.builtApp === 'string' && options.builtApp.endsWith('.app'),
    '必须指定实际 builtApp .app 目录',
  );
  const builtApp = fs.realpathSync(options.builtApp);
  requireValue(fs.statSync(builtApp).isDirectory(), 'builtApp 必须为目录');
  inspectInfo(builtApp, baseline);
  const bundle = safePath(builtApp, 'main.jsbundle');
  requireValue(
    fs.statSync(bundle).isFile() && fs.statSync(bundle).size > 0,
    'main.jsbundle 不能为空',
  );
  for (const asset of options.requiredAssets ?? [])
    requireValue(fs.statSync(safePath(builtApp, asset)).isFile(), `必需资源不是文件: ${asset}`);
  const capability = readJSON(path.resolve(options.app, baseline.aeris.capabilitiesManifest));
  const manifestPath =
    typeof options.manifest === 'string'
      ? path.resolve(options.manifest)
      : `${builtApp}.urn-artifacts.json`;
  requireValue(
    !fs.lstatSync(manifestPath, { throwIfNoEntry: false })?.isSymbolicLink(),
    'manifest 路径不能是符号链接',
  );
  const resolvedManifest = path.join(
    fs.realpathSync(path.dirname(manifestPath)),
    path.basename(manifestPath),
  );
  const relativeManifest = path.relative(builtApp, resolvedManifest);
  requireValue(
    relativeManifest === '..' ||
      relativeManifest.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeManifest),
    'manifest 必须保存到 App 外，避免修改签名产物或将清单包含自身',
  );
  requireValue(
    typeof capability.source.availability === 'string' && capability.source.availability.length > 0,
    'Aeris capability 缺少 source availability 证据',
  );
  return { baseline, builtApp, manifestPath, availability: capability.source.availability };
}

/** 对实际构建目录生成清单；不会改写 .app，也不负责安装依赖、推送或发布。 */
export function createArtifactManifest(options) {
  const { baseline, builtApp, manifestPath, availability } = context(options);
  const manifest = {
    schemaVersion: 1,
    baseline: structuredClone(baseline),
    baselineSha256: sha256(canonical(baseline)),
    aerisSourceAvailability: availability,
    bundleMode: 'embedded',
    configuration: 'Release',
    bundlePhaseCount: options.bundlePhaseCount,
    entries: inventory(builtApp),
  };
  // 独占创建同目录临时文件，再替换目录项；既有 sidecar 即使是硬链接也不会改写 App。
  const temporary = path.join(path.dirname(manifestPath), `.urn-manifest-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, manifestPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { ok: true, baselineId: baseline.baselineId, builtApp, manifestPath, manifest };
}

/** 校验输入基线和真实文件，清单本身不能替代 checkBaseline 或原生 plist 检查。 */
export function verifyArtifacts(options) {
  const { baseline, builtApp, manifestPath, availability } = context(options);
  const manifest =
    options.manifest && typeof options.manifest === 'object'
      ? options.manifest
      : readJSON(manifestPath);
  requireValue(manifest.schemaVersion === 1, '不支持的 manifest schemaVersion');
  requireValue(
    canonical(manifest.baseline) === canonical(baseline) &&
      manifest.baselineSha256 === sha256(canonical(baseline)),
    '产物清单与当前固定基线不匹配',
  );
  requireValue(
    manifest.aerisSourceAvailability === availability,
    'Aeris sourceRef 可用性与 capability 不匹配',
  );
  requireValue(
    manifest.bundleMode === 'embedded' &&
      manifest.configuration === 'Release' &&
      manifest.bundlePhaseCount === 1,
    '产物清单必须为唯一 bundle phase 的 embedded Release',
  );
  requireValue(Array.isArray(manifest.entries), 'manifest entries 必须为数组');
  const seen = new Set();
  for (const entry of manifest.entries) {
    requireValue(entry && typeof entry === 'object', 'manifest entry 必须为对象');
    safePath(builtApp, entry.path);
    requireValue(!seen.has(entry.path), `清单重复路径 ${entry.path}`);
    seen.add(entry.path);
    requireValue(
      Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256),
      `清单文件摘要格式非法 ${entry.path}`,
    );
    const filename = safePath(builtApp, entry.path);
    requireValue(fs.statSync(filename).isFile(), `清单路径不是文件 ${entry.path}`);
    requireValue(fs.statSync(filename).size === entry.size, `${entry.path} 大小不匹配`);
    requireValue(sha256(fs.readFileSync(filename)) === entry.sha256, `${entry.path} sha256 不匹配`);
  }
  requireValue(
    seen.has('main.jsbundle') && seen.has('Info.plist'),
    '清单缺少 main.jsbundle 或 Info.plist',
  );
  requireValue(
    inventory(builtApp).every((entry) => seen.has(entry.path)),
    'App 存在清单未记录的文件',
  );
  return { ok: true, baselineId: baseline.baselineId, builtApp, manifestPath, manifest };
}

const jsLockNames = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

function nearestJsLock(app) {
  for (let directory = app; ; directory = path.dirname(directory)) {
    const locks = jsLockNames
      .map((name) => path.join(directory, name))
      .filter((filename) => fs.existsSync(filename));
    requireValue(locks.length <= 1, `App 同级存在多个 JS 锁文件，无法绑定 ${directory}`);
    if (locks.length === 1) return fs.realpathSync(locks[0]);
    requireValue(path.dirname(directory) !== directory, 'App 缺少实际 JS 锁文件');
  }
}

function inspectHostLocks({ app, host, baseline }) {
  baseline = typeof baseline === 'string' ? readJSON(path.resolve(baseline)) : baseline;
  validateBaseline(baseline);
  const locks = baseline.locks.map((item) => ({
    ...item,
    filename: fs.realpathSync(path.resolve(app, item.path)),
  }));
  for (const filename of [nearestJsLock(app), fs.realpathSync(path.join(host, 'Podfile.lock'))]) {
    const declared = locks.filter((item) => item.filename === filename);
    requireValue(declared.length === 1, `基线必须绑定唯一实际宿主/App 锁文件 ${filename}`);
    requireValue(
      sha256(fs.readFileSync(filename)) === declared[0].sha256,
      `实际宿主/App 锁文件 sha256 不匹配 ${filename}`,
    );
  }
}

/** 官方脚本将任意非空 SKIP_BUNDLING（包括字符串 0）视为跳过，必须构建前阻断。 */
export function inspectBuildSettings({ settings, target }) {
  requireValue(Array.isArray(settings), 'build settings 必须为 xcodebuild JSON 数组');
  const hosts = settings.filter((item) => item.target === target);
  requireValue(hosts.length === 1, `无法从 build settings 确定唯一宿主 target ${target}`);
  const buildSettings = hosts[0].buildSettings;
  requireValue(buildSettings && typeof buildSettings === 'object', '宿主缺少 build settings');
  requireValue(
    buildSettings.SKIP_BUNDLING === undefined || buildSettings.SKIP_BUNDLING === '',
    '宿主 build settings 含非空 SKIP_BUNDLING，会跳过实际 bundle 构建',
  );
  return buildSettings;
}

/** 仅支持文档化的七行标准 phase；不尝试用子串推断任意 shell 程序的运行语义。 */
export function inspectBundlePhases({ project, target, app, baseline }) {
  requireValue(typeof app === 'string' && app.length > 0, '工程扫描必须指定实际 app 目录');
  app = fs.realpathSync(app);
  project = fs.realpathSync(project);
  requireValue(
    path.basename(project) === 'project.pbxproj' &&
      path.basename(path.dirname(project)).endsWith('.xcodeproj'),
    '必须指定实际 .xcodeproj/project.pbxproj',
  );
  const host = path.dirname(path.dirname(project));
  const { objects } = readPlist(project);
  const targets = Object.values(objects).filter(
    (item) => item.isa === 'PBXNativeTarget' && item.name === target,
  );
  requireValue(targets.length === 1, `工程必须含唯一宿主 target ${target}`);
  const phases = (targets[0].buildPhases ?? [])
    .map((id) => objects[id])
    .filter(
      (item) =>
        item?.isa === 'PBXShellScriptBuildPhase' &&
        (/react-native-xcode\.sh|ENTRY_FILE|(?:react-native|cli\.js)[^\n]*\bbundle\b/.test(
          item.shellScript ?? '',
        ) ||
          /Bundle React Native/i.test(item.name ?? '')),
    );
  requireValue(phases.length === 1, `宿主 RN bundle phase 数量必须为 1，实际 ${phases.length}`);
  const phase = phases[0];
  requireValue(
    phase.shellPath === '/bin/sh' &&
      (phase.runOnlyForDeploymentPostprocessing === '0' ||
        phase.runOnlyForDeploymentPostprocessing === 0) &&
      (phase.buildActionMask === '2147483647' || phase.buildActionMask === 2147483647) &&
      (phase.alwaysOutOfDate === '1' || phase.alwaysOutOfDate === 1),
    'RN bundle phase 执行元数据必须使用 /bin/sh、普通构建启用、完整 buildActionMask 和 alwaysOutOfDate=1',
  );
  requireValue(
    (phase.platformFilter === undefined || phase.platformFilter === '') &&
      (phase.platformFilters === undefined ||
        (Array.isArray(phase.platformFilters) && phase.platformFilters.length === 0)),
    'RN bundle phase 不支持 platform 过滤，必须在 iOS Simulator 和 Archive 中均执行',
  );
  const lines = phases[0].shellScript.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // PROJECT_ROOT 只允许 PROJECT_DIR 加静态相对路径，拒绝变量展开、命令替换和条件。
  const root = lines[1]?.match(/^export PROJECT_ROOT="\$PROJECT_DIR\/([A-Za-z0-9_. /@+-]+)"$/)?.[1];
  const wrapper = lines[6]?.match(
    /^\/bin\/bash "\$PROJECT_DIR\/([A-Za-z0-9_. /@+-]+)" "\$PROJECT_ROOT" "\$RN_ROOT"$/,
  )?.[1];
  const expected = [
    'set -e',
    lines[1],
    'export ENTRY_FILE=index.container.js',
    'export FORCE_BUNDLING=1',
    'export NODE_BINARY="${NODE_BINARY:-$(command -v node)}"',
    `RN_ROOT="$("$NODE_BINARY" -p 'require("path").dirname(require.resolve("react-native/package.json", {paths: [process.env.PROJECT_ROOT]}))')"`,
    lines[6],
  ];
  requireValue(
    root &&
      wrapper &&
      !path.isAbsolute(wrapper) &&
      !path.isAbsolute(root) &&
      lines.length === expected.length &&
      lines.every((line, index) => line === expected[index]),
    '只支持 canonical 七行标准 RN bundle phase（入口 index.container.js）；条件、注释替代、重复赋值或额外命令均不支持',
  );
  requireValue(
    fs.realpathSync(path.resolve(host, wrapper)) ===
      fs.realpathSync(fileURLToPath(new URL('./bundle-ios.sh', import.meta.url))),
    'canonical bundle phase 必须使用平台 bundle-ios.sh 包装器',
  );
  const projectRoot = fs.realpathSync(path.resolve(host, root));
  requireValue(
    projectRoot === app,
    '宿主 PROJECT_ROOT 与指定 App 不匹配；请先明确修改宿主 phase 和 Pods 接入',
  );
  inspectHostLocks({ app, host, baseline });
  return { bundlePhaseCount: phases.length, entryFile: 'index.container.js', app: projectRoot };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help')
    console.log('产物校验库：请使用 node tooling/urn/cli.mjs --help');
  else {
    console.error('URN: 此文件为产物校验库，请使用 cli.mjs --help');
    process.exitCode = 1;
  }
}
