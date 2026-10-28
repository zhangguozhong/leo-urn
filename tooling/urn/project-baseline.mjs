import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadProfile } from './profile.mjs';
import { detectToolchain, validateBaseline } from './baseline.mjs';
import { checkDependencies, resolvePackage } from './dependencies.mjs';
import semver from 'semver';

/** 只捕获真实安装结果；已存在的基线不会被覆盖，后续更新使用另一个 output。 */
export async function captureBaseline({ app, output }) {
  app = fs.realpathSync(app);
  const { profile } = await loadProfile(path.join(app, 'urn.profile.json'));
  const project = JSON.parse(fs.readFileSync(path.join(app, 'urn.project.json'), 'utf8'));
  const podLock = path.join(path.dirname(path.resolve(app, project.iosProject)), 'Podfile.lock');
  const files = [path.join(app, 'package-lock.json'), podLock];
  const dependencies = checkDependencies({ app });
  const podText = fs.readFileSync(podLock, 'utf8');
  const nativePlugins = dependencies.nativePlugins.map((plugin) => ({
    ...plugin,
    version: resolvePackage(plugin.name, app).metadata.version,
    pods: plugin.pods.map((pod) => {
      const escaped = pod.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const version = podText.match(new RegExp(`^  - ${escaped} \\(([^)]+)\\)`, 'm'))?.[1];
      if (!version || !semver.satisfies(version, pod.version))
        throw new Error(`BASELINE: ${pod.name} 缺少兼容的实际 Pod 安装版本`);
      return { name: pod.name, version };
    }),
  }));
  const baseline = validateBaseline({
    schemaVersion: 1,
    baselineId: profile.baselineId,
    versions: {
      react: '19.2.3',
      reactNative: '0.87.0',
      urnJs: '0.1.0',
      urnPod: '0.1.0',
      aeris: '0.25.0',
    },
    aeris: { sourceRef: profile.aeris.source.ref, capabilitiesManifest: 'aeris-capabilities.json' },
    toolchain: detectToolchain(),
    minIos: '15.1',
    architecture: 'new',
    nativePlugins,
    locks: files.map((filename) => ({
      path: path.relative(app, filename),
      sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    })),
  });
  const filename = path.resolve(app, output ?? 'platform-baseline.json');
  fs.writeFileSync(filename, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
  return { filename, reviewRequired: true };
}
