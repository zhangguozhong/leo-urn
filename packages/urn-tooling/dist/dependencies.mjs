import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import semver from 'semver';
import { pathToFileURL } from 'node:url';

export const codegenIdentity = (value) => (value ? `${value.name}:${value.type}` : null);

export const runtimePackages = ['react', 'react-native', 'leo-urn'];
// 用 DNF 累计交集，保留 OR 范围并避免后续业务重新放宽约束。
const intersectRanges = (left, right) =>
  new semver.Range(left).set
    .flatMap((a) =>
      new semver.Range(right).set.map((b) => [...a, ...b].map((c) => c.value).join(' ')),
    )
    .join(' || ');
const fail = (message, code) => {
  const error = new Error(`DEPENDENCIES: ${message}`);
  if (code) error.code = code;
  throw error;
};
export const readPackage = (directory) =>
  JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));

/** 始终从消费者所在的真实目录解析，不假设依赖安装在 App 下。 */
export function resolvePackage(name, consumer) {
  const require = createRequire(path.join(fs.realpathSync(consumer), 'package.json'));
  let filename;
  try {
    filename = require.resolve(`${name}/package.json`);
  } catch {
    try {
      filename = require.resolve(name);
    } catch (error) {
      // import-only 包可能隐藏元数据导出；沿该消费者的 Node 搜索路径查找，
      // 再由 require.resolve 解析绝对元数据路径，不依赖全局或用户目录。
      const candidates = (require.resolve.paths(name) ?? [])
        .filter((directory) => path.basename(directory) === 'node_modules')
        .map((directory) => path.join(directory, name, 'package.json'));
      const metadata = candidates.find((candidate) => fs.existsSync(candidate));
      if (!metadata) fail(`${name} 无法从 ${consumer} 解析：${error.message}`, 'MODULE_NOT_FOUND');
      filename = require.resolve(metadata);
    }
    let cursor = path.dirname(filename);
    while (!fs.existsSync(path.join(cursor, 'package.json'))) {
      const parent = path.dirname(cursor);
      if (parent === cursor) fail(`${name} 缺少 package.json`);
      cursor = parent;
    }
    filename = path.join(cursor, 'package.json');
  }
  const root = fs.realpathSync(path.dirname(filename));
  const metadata = readPackage(root);
  if (metadata.name !== name) fail(`${name} 实际解析成 ${metadata.name}`);
  return { root, metadata };
}

function satisfies(version, range, label) {
  if (!semver.valid(version) || !semver.validRange(range) || !semver.satisfies(version, range)) {
    fail(`${label} 版本 ${version} 不满足 ${range}`);
  }
}

function pluginDeclaration(item) {
  if (
    !item ||
    typeof item !== 'object' ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    !semver.validRange(item.version) ||
    !Array.isArray(item.pods)
  )
    fail('nativePlugins 声明必须包含 name、version 和 pods');
  if (Object.keys(item).some((key) => !['name', 'version', 'pods', 'codegen'].includes(key)))
    fail(`${item.name} nativePlugins 含未知字段`);
  for (const pod of item.pods) {
    if (
      !pod ||
      typeof pod.name !== 'string' ||
      !pod.name ||
      !semver.validRange(pod.version) ||
      Object.keys(pod).some((key) => !['name', 'version'].includes(key))
    )
      fail(`${item.name} Pod 声明非法`);
  }
  if (
    item.codegen &&
    (Object.keys(item.codegen).some((key) => !['name', 'type'].includes(key)) ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(item.codegen.name) ||
      !['modules', 'components', 'all'].includes(item.codegen.type))
  )
    fail(`${item.name} Codegen 声明非法`);
  return item;
}

/** 并集先检查身份，再核对真实安装版本，避免依赖顺序掩盖冲突。 */
export function collectNativePlugins(consumers) {
  const union = new Map();
  const pods = new Map();
  const codegen = new Map();
  for (const consumer of consumers) {
    const declarations = consumer.metadata.urn?.nativePlugins ?? [];
    if (!Array.isArray(declarations)) fail(`${consumer.metadata.name} nativePlugins 必须是数组`);
    const seen = new Set();
    for (const value of declarations) {
      const item = pluginDeclaration(value);
      if (seen.has(item.name)) fail(`${item.name} nativePlugins 重复声明`);
      seen.add(item.name);
      const existing = union.get(item.name);
      if (existing && !semver.intersects(existing.version, item.version))
        fail(`${item.name} 版本交集为空`);
      if (existing && codegenIdentity(existing.codegen) !== codegenIdentity(item.codegen))
        fail(`${item.name} Codegen 身份冲突`);
      if (
        existing &&
        existing.pods
          .map((p) => p.name)
          .sort()
          .join(',') !==
          item.pods
            .map((p) => p.name)
            .sort()
            .join(',')
      )
        fail(`${item.name} Pod 身份冲突`);
      for (const pod of item.pods) {
        const identity = pod.name.split('/')[0];
        const owner = pods.get(identity);
        if (owner && owner.name !== item.name)
          fail(`${pod.name} Pod 身份冲突：${owner.name} 与 ${item.name}`);
        if (owner && !semver.intersects(owner.version, pod.version))
          fail(`${pod.name} Pod 版本交集为空`);
        pods.set(identity, {
          name: item.name,
          version: owner ? intersectRanges(owner.version, pod.version) : pod.version,
        });
      }
      if (item.codegen) {
        const owner = codegen.get(item.codegen.name);
        if (owner && owner !== item.name)
          fail(`${item.codegen.name} Codegen 身份冲突：${owner} 与 ${item.name}`);
        codegen.set(item.codegen.name, item.name);
      }
      union.set(item.name, {
        ...item,
        pods: item.pods.map((p) => ({
          name: p.name,
          version: pods.get(p.name.split('/')[0]).version,
        })),
        version: existing ? intersectRanges(existing.version, item.version) : item.version,
      });
    }
  }
  return [...union.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function checkPeers(consumer, host, app) {
  for (const [name, range] of Object.entries(consumer.metadata.peerDependencies ?? {})) {
    if (!Object.hasOwn(host.dependencies ?? {}, name))
      fail(`${name} 必须列入 App 直接依赖（${consumer.metadata.name} peer）`);
    const installed = resolvePackage(name, app);
    satisfies(installed.metadata.version, range, `${name} peer`);
    const own = resolvePackage(name, consumer.root);
    satisfies(own.metadata.version, range, `${name} peer`);
    if (
      own.root !== installed.root &&
      (runtimePackages.includes(name) ||
        consumer.metadata.urn?.nativePlugins?.some((p) => p.name === name))
    )
      fail(`${name} peer 单例不一致`);
    const appRange = host.dependencies[name];
    if (semver.validRange(appRange))
      satisfies(installed.metadata.version, appRange, `${name} App 直接依赖`);
  }
}

function isNative(root, metadata) {
  return Boolean(
    metadata.codegenConfig || fs.readdirSync(root).some((file) => file.endsWith('.podspec')),
  );
}

export function checkDependencies({ app, features, pinnedVersions = {} }) {
  app = fs.realpathSync(app);
  const host = readPackage(app);
  const configured = features ?? host.urn?.features ?? [];
  if (
    !Array.isArray(configured) ||
    configured.some((item) => typeof item !== 'string' || !item.trim())
  )
    fail('urn.features 必须为目录路径数组');
  for (const [name, version] of Object.entries(pinnedVersions)) {
    if (!Object.hasOwn(host.dependencies ?? {}, name)) fail(`${name} 必须列入 App 直接依赖`);
    if (resolvePackage(name, app).metadata.version !== version)
      fail(`${name} App 版本与固定基线 ${version} 不一致`);
  }
  const consumers = configured.map((directory) => {
    const root = fs.realpathSync(path.resolve(app, directory));
    return { root, metadata: readPackage(root) };
  });
  if (new Set(consumers.map((c) => c.root)).size !== consumers.length) fail('features 重复目录');
  const runtime = {};
  for (const name of runtimePackages) {
    if (!Object.hasOwn(host.dependencies ?? {}, name)) fail(`${name} 必须列入 App 直接依赖`);
    const installed = resolvePackage(name, app);
    runtime[name] = installed.root;
    const range = host.dependencies[name];
    if (semver.validRange(range)) satisfies(installed.metadata.version, range, `${name} App`);
    for (const consumer of consumers) {
      const resolved = resolvePackage(name, consumer.root);
      if (resolved.root !== installed.root)
        fail(`${name} 单例不一致：${consumer.root} → ${resolved.root}；App → ${installed.root}`);
    }
  }
  const sdk = { root: runtime['leo-urn'], metadata: readPackage(runtime['leo-urn']) };
  const nativePlugins = collectNativePlugins([{ root: app, metadata: host }, ...consumers]);
  for (const item of nativePlugins) {
    if (!Object.hasOwn(host.dependencies ?? {}, item.name))
      fail(`${item.name} 必须列入 App 直接依赖`);
    if (!host.urn?.nativePlugins?.some((p) => p.name === item.name))
      fail(`${item.name} 缺少 App nativePlugins 声明`);
    const installed = resolvePackage(item.name, app);
    satisfies(installed.metadata.version, item.version, `${item.name} nativePlugins`);
    if (codegenIdentity(installed.metadata.codegenConfig) !== codegenIdentity(item.codegen))
      fail(`${item.name} Codegen 身份与已安装包不一致`);
    for (const consumer of consumers.filter((c) =>
      c.metadata.urn?.nativePlugins?.some((p) => p.name === item.name),
    )) {
      if (resolvePackage(item.name, consumer.root).root !== installed.root)
        fail(`${item.name} nativePlugins 单例不一致`);
    }
  }
  for (const consumer of [...consumers, sdk]) checkPeers(consumer, host, app);
  for (const consumer of [{ root: app, metadata: host }, ...consumers]) {
    const seen = new Set();
    const visit = (owner, inheritedRuntime = false) => {
      const peers = owner.metadata.peerDependencies ?? {};
      const names = new Set([
        ...Object.keys(owner.metadata.dependencies ?? {}),
        ...Object.keys(owner.metadata.optionalDependencies ?? {}),
        ...Object.keys(peers),
      ]);
      for (const name of names) {
        let dependency;
        try {
          dependency = resolvePackage(name, owner.root);
        } catch (error) {
          const optionalOnlyPeer =
            !Object.hasOwn(owner.metadata.dependencies ?? {}, name) &&
            owner.metadata.peerDependenciesMeta?.[name]?.optional === true;
          const optionalDependency = Object.hasOwn(owner.metadata.optionalDependencies ?? {}, name);
          if (
            (optionalDependency || (owner !== consumer && optionalOnlyPeer)) &&
            error.code === 'MODULE_NOT_FOUND'
          )
            continue;
          throw error;
        }
        if (
          Object.hasOwn(pinnedVersions, name) &&
          dependency.metadata.version !== pinnedVersions[name]
        )
          fail(`${name} 传递依赖版本与固定基线 ${pinnedVersions[name]} 不一致`);
        if (runtimePackages.includes(name) && dependency.root !== runtime[name])
          fail(`${name} 嵌套依赖单例不一致：${owner.root}`);
        // 每条边都要验证，再对节点去重；否则共享节点的第二个不兼容要求会漏检。
        const requested =
          owner.metadata.optionalDependencies?.[name] ?? owner.metadata.dependencies?.[name];
        if (requested !== undefined && semver.validRange(requested))
          satisfies(dependency.metadata.version, requested, `${name} dependency`);
        if (Object.hasOwn(peers, name))
          satisfies(dependency.metadata.version, peers[name], `${name} peer`);
        const infrastructure = inheritedRuntime || runtimePackages.includes(name);
        // 业务不重复声明容器内部依赖；同一插件若也是业务直接需求，仍逐边核查声明。
        if (
          !infrastructure &&
          isNative(dependency.root, dependency.metadata) &&
          consumer.root !== app &&
          !consumer.metadata.urn?.nativePlugins?.some((p) => p.name === name)
        )
          fail(`${name} 必须列入 ${consumer.metadata.name} nativePlugins`);
        // 同一包经容器基础链和业务链到达时，业务链仍须检查其原生后代。
        const visitKey = JSON.stringify([dependency.root, infrastructure]);
        if (seen.has(visitKey)) continue;
        seen.add(visitKey);
        const declaration = nativePlugins.find((item) => item.name === name);
        if (declaration) {
          const shared = resolvePackage(name, app);
          if (dependency.root !== shared.root) fail(`${name} 原生依赖单例不一致：${owner.root}`);
          satisfies(dependency.metadata.version, declaration.version, `${name} 传递原生依赖`);
          if (
            codegenIdentity(dependency.metadata.codegenConfig) !==
            codegenIdentity(declaration.codegen)
          )
            fail(`${name} 传递原生依赖 Codegen 身份不一致`);
        }
        visit(dependency, infrastructure);
      }
    };
    visit(consumer);
  }
  return { ok: true, app, features: consumers.map((c) => c.root), runtime, nativePlugins };
}

/** Metro 别名只影响共享 runtime；其他请求保留原业务目录与默认解析规则。 */
export function createRuntimeResolver({ app }) {
  app = fs.realpathSync(app);
  const roots = Object.fromEntries(
    runtimePackages.map((name) => [name, resolvePackage(name, app).root]),
  );
  return (context, moduleName, platform) => {
    const shared = runtimePackages.find(
      (name) => moduleName === name || moduleName.startsWith(`${name}/`),
    );
    if (!shared) return context.resolveRequest(context, moduleName, platform);
    const hostContext = {
      ...context,
      originModulePath: path.join(app, 'package.json'),
      disableHierarchicalLookup: true,
      nodeModulesPaths: [],
      extraNodeModules: { [shared]: roots[shared] },
    };
    return context.resolveRequest(hostContext, moduleName, platform);
  };
}

/** 只生成可审阅的依赖建议，不执行包管理器或写入工程。 */
export function dependencyRecommendations({ app }) {
  app = fs.realpathSync(app);
  const host = readPackage(app);
  const requirements = new Map(
    Object.entries(host.dependencies ?? {}).map(([name, version]) => [name, new Set([version])]),
  );
  const consumers = (host.urn?.features ?? []).map((directory) => ({
    root: path.resolve(app, directory),
    metadata: readPackage(path.resolve(app, directory)),
  }));
  for (const consumer of [{ root: app, metadata: host }, ...consumers]) {
    for (const [name, range] of Object.entries(consumer.metadata.peerDependencies ?? {})) {
      if (!requirements.has(name)) requirements.set(name, new Set());
      requirements.get(name).add(range);
    }
  }
  for (const plugin of collectNativePlugins([{ root: app, metadata: host }, ...consumers])) {
    if (!requirements.has(plugin.name)) requirements.set(plugin.name, new Set());
    requirements.get(plugin.name).add(plugin.version);
  }
  return [...requirements]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ranges]) => ({
      name,
      constraints: [...ranges],
      directDependency: host.dependencies?.[name] ?? null,
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help')
    console.log(
      '依赖检查库：请使用 node tooling/urn/cli.mjs doctor --app DIR 或 sync --dry-run --app DIR',
    );
  else {
    console.error('URN: 此文件为依赖检查库，请使用 cli.mjs --help');
    process.exitCode = 1;
  }
}
