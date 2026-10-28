import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function requireValue(condition, message) {
  if (!condition) throw new Error(`AERIS_DEPENDENCY: ${message}`);
}

/** 核对归档与固定来源记录；真实 Pod 与 Receiver 行为由原生门禁验收。 */
export async function verifyAerisDependency(manifest, directory) {
  requireValue(/^[a-f0-9]{40}$/.test(manifest.source?.ref ?? ''), '必须固定完整源码 commit');
  requireValue(
    manifest.closing?.verified === true &&
      manifest.closing.protocol === 'AerisClosingMessageReceiver',
    '缺少已验证的关闭窗口能力',
  );
  requireValue(manifest.packages?.length === 2, '必须同时记录 Core 和 RNAdapter 归档');
  const packages = [];
  for (const item of manifest.packages) {
    requireValue(item.version === manifest.nativeVersion, `${item.name} 与 Pod 版本不匹配`);
    requireValue(item.sourceRef === manifest.source.ref, `${item.name} 与 Pod 来源不匹配`);
    requireValue(path.basename(item.file) === item.file, '归档文件名不能越出目录');
    const archive = path.join(directory, item.file);
    const bytes = await readFile(archive);
    requireValue(
      createHash('sha256').update(bytes).digest('hex') === item.sha256,
      `${item.name} 归档摘要不匹配，请按固定来源重新构建`,
    );
    const readArchive = (entry) =>
      execFileSync('tar', ['-xOf', archive, `package/${entry}`], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
    const metadata = JSON.parse(readArchive('package.json'));
    requireValue(
      metadata.name === item.name && metadata.version === item.version,
      `${item.name} 的实际归档元数据不匹配`,
    );
    for (const subpath of item.requiredExports) {
      const wildcard = metadata.exports?.['./*'];
      const exported = Object.hasOwn(metadata.exports ?? {}, subpath)
        ? metadata.exports[subpath]
        : wildcard;
      const resolve = (value) => value?.replace('*', subpath.slice(2));
      const js = resolve(exported?.import);
      const types = resolve(exported?.types);
      requireValue(
        js?.startsWith('./dist/') && types?.startsWith('./dist/'),
        `${item.name}/${subpath} 缺少可消费的 JS 或声明导出`,
      );
      readArchive(js.slice(2));
      readArchive(types.slice(2));
    }
    packages.push({ name: item.name, version: metadata.version, sha256: item.sha256 });
  }
  requireValue(
    new Set(packages.map((p) => p.name)).size === 2 &&
      packages.some((p) => p.name === 'aeris-client-core') &&
      packages.some((p) => p.name === 'aeris-react-native'),
    'Core/RN 插件重复或缺失',
  );
  return { nativeClosing: manifest.closing.availability, packages };
}
