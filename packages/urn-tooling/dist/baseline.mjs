import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { pathToFileURL } from 'node:url';
import {
  checkDependencies,
  readPackage,
  resolvePackage,
  codegenIdentity,
} from './dependencies.mjs';

const schema = JSON.parse(
  fs.readFileSync(new URL('./schemas/platform-baseline.schema.json', import.meta.url), 'utf8'),
);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(`BASELINE: ${message}`);
};

/** 使用与交付 schema 相同的规则；这里只实现该 schema 实际使用的 JSON Schema 关键字。 */
function validate(value, rule, location = '$') {
  if (rule.$ref) rule = schema.$defs[rule.$ref.split('/').at(-1)];
  if (Object.hasOwn(rule, 'const'))
    requireValue(value === rule.const, `${location} 必须为 ${rule.const}`);
  if (rule.enum) requireValue(rule.enum.includes(value), `${location} 非法枚举`);
  if (rule.type === 'object') {
    requireValue(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      `${location} 必须为对象`,
    );
    for (const name of rule.required ?? [])
      requireValue(Object.hasOwn(value, name), `${location}.${name} 缺失`);
    for (const name of Object.keys(value)) {
      requireValue(Object.hasOwn(rule.properties ?? {}, name), `${location}.${name} 非法字段`);
      validate(value[name], rule.properties[name], `${location}.${name}`);
    }
  }
  if (rule.type === 'array') {
    requireValue(Array.isArray(value), `${location} 必须为数组`);
    requireValue(value.length >= (rule.minItems ?? 0), `${location} 缺少条目`);
    value.forEach((item, index) => validate(item, rule.items, `${location}[${index}]`));
  }
  if (rule.type === 'string') {
    requireValue(
      typeof value === 'string' && value.length >= (rule.minLength ?? 0),
      `${location} 必须为非空字符串`,
    );
    requireValue(
      !/^(?:TODO|TBD|PLACEHOLDER|REPLACE[_-]?.*|CHANGEME|UNSET|UNKNOWN)$/i.test(value),
      `${location} 不允许占位值`,
    );
    if (rule.pattern) requireValue(new RegExp(rule.pattern).test(value), `${location} 格式非法`);
  }
}

export function validateBaseline(baseline) {
  validate(baseline, schema);
  const names = new Set();
  for (const plugin of baseline.nativePlugins) {
    requireValue(!names.has(plugin.name), `${plugin.name} nativePlugins 重复`);
    names.add(plugin.name);
    requireValue(
      new Set(plugin.pods.map((pod) => pod.name)).size === plugin.pods.length,
      `${plugin.name} Pods 重复`,
    );
  }
  return baseline;
}

export function detectToolchain() {
  const output = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return {
    node: process.versions.node,
    xcode: output('xcodebuild', ['-version']).match(/^Xcode (\S+)/m)?.[1],
    cocoaPods: output('pod', ['--version']),
  };
}

function installedPod(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(`^  - ${escaped} \\(([^)]+)\\)`, 'm'))?.[1];
}

export function checkBaseline({ app, baseline, toolchain, release = false }) {
  requireValue(typeof app === 'string' && app.length > 0, '必须显式指定 App 目录');
  app = fs.realpathSync(app);
  if (typeof baseline === 'string')
    baseline = JSON.parse(fs.readFileSync(path.resolve(baseline), 'utf8'));
  validateBaseline(baseline);
  const dependencies = checkDependencies({
    app,
    pinnedVersions: {
      'aeris-client-core': baseline.versions.aeris,
      'aeris-react-native': baseline.versions.aeris,
    },
  });
  for (const [name, expected] of Object.entries({
    react: baseline.versions.react,
    'react-native': baseline.versions.reactNative,
    'leo-urn': baseline.versions.urnJs,
  })) {
    requireValue(
      readPackage(dependencies.runtime[name]).version === expected,
      `${name} 实际版本与基线不匹配`,
    );
  }
  requireValue(baseline.versions.urnJs === baseline.versions.urnPod, 'URN JS/Pod 版本不匹配');
  const actualToolchain = toolchain ?? detectToolchain();
  for (const [name, expected] of Object.entries(baseline.toolchain))
    requireValue(
      actualToolchain[name] === expected,
      `toolchain.${name} 预期 ${expected}，实际 ${actualToolchain[name]}`,
    );
  const locks = new Map();
  for (const item of baseline.locks) {
    const filename = fs.realpathSync(path.resolve(app, item.path));
    requireValue(!locks.has(filename), `${item.path} 锁文件重复`);
    const bytes = fs.readFileSync(filename);
    requireValue(
      createHash('sha256').update(bytes).digest('hex') === item.sha256,
      `${item.path} sha256 不匹配`,
    );
    locks.set(filename, bytes.toString('utf8'));
  }
  requireValue(
    [...locks.keys()].some((filename) =>
      ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(
        path.basename(filename),
      ),
    ),
    '必须锁定 JS 包管理器锁文件',
  );
  const podEntry = [...locks].find(([filename]) => path.basename(filename) === 'Podfile.lock');
  requireValue(podEntry, '必须锁定 Podfile.lock');
  for (const [name, expected] of Object.entries({
    LeoURN: baseline.versions.urnPod,
    'React-Core': baseline.versions.reactNative,
    Aeris: baseline.versions.aeris,
    AerisContracts: baseline.versions.aeris,
    'AerisHost/ReactNative': baseline.versions.aeris,
    AerisRN: baseline.versions.aeris,
  }))
    requireValue(installedPod(podEntry[1], name) === expected, `${name} Pod 版本与基线不匹配`);
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(app, baseline.aeris.capabilitiesManifest), 'utf8'),
  );
  requireValue(
    manifest.source?.ref === baseline.aeris.sourceRef,
    'Aeris sourceRef 与 capability 不匹配',
  );
  requireValue(
    manifest.nativeVersion === baseline.versions.aeris,
    'Aeris nativeVersion 与基线不匹配',
  );
  requireValue(
    Array.isArray(manifest.packages) &&
      manifest.packages.length === 2 &&
      new Set(manifest.packages.map((p) => p.name)).size === 2 &&
      ['aeris-client-core', 'aeris-react-native'].every((name) =>
        manifest.packages.some((p) => p.name === name),
      ),
    'Aeris Core/RN capability 记录缺失或重复',
  );
  for (const item of manifest.packages) {
    requireValue(
      item.version === baseline.versions.aeris && item.sourceRef === baseline.aeris.sourceRef,
      `${item.name} version/sourceRef 与基线不匹配`,
    );
    // capability 已由独立归档校验器验证，此处检查 App 消费的版本。
    requireValue(
      resolvePackage(item.name, app).metadata.version === item.version,
      `${item.name} 实际版本不匹配`,
    );
  }
  if (release)
    requireValue(
      ['published', 'remote-verified'].includes(manifest.source?.availability),
      'release 需要已推送 published Aeris sourceRef',
    );
  requireValue(
    dependencies.nativePlugins.length === baseline.nativePlugins.length,
    'nativePlugins 并集与基线数量不一致',
  );
  for (const plugin of baseline.nativePlugins) {
    const declared = dependencies.nativePlugins.find((item) => item.name === plugin.name);
    requireValue(
      declared && semver.satisfies(plugin.version, declared.version),
      `${plugin.name} nativePlugins 与基线不匹配`,
    );
    requireValue(
      resolvePackage(plugin.name, app).metadata.version === plugin.version,
      `${plugin.name} 实际版本与基线不匹配`,
    );
    requireValue(
      codegenIdentity(plugin.codegen) === codegenIdentity(declared.codegen),
      `${plugin.name} Codegen 与基线不匹配`,
    );
    requireValue(
      plugin.pods.length === declared.pods.length,
      `${plugin.name} Pod 并集与基线不匹配`,
    );
    for (const pod of plugin.pods) {
      const expected = declared.pods.find((item) => item.name === pod.name);
      requireValue(
        expected &&
          semver.satisfies(pod.version, expected.version) &&
          installedPod(podEntry[1], pod.name) === pod.version,
        `${pod.name} Pod 与基线不匹配`,
      );
    }
  }
  return { ok: true, baselineId: baseline.baselineId, dependencies, locks: [...locks.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help')
    console.log(
      '平台基线检查库：请使用 node tooling/urn/cli.mjs check-baseline --baseline FILE --app DIR [--release]',
    );
  else {
    console.error('URN: 此文件为平台基线库，请使用 cli.mjs --help');
    process.exitCode = 1;
  }
}
