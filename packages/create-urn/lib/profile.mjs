import fs from 'node:fs/promises';
import path from 'node:path';

export const versions = Object.freeze({
  'leo-urn': '0.1.0',
  'leo-urn-tooling': '0.1.0',
  'aeris-client-core': '0.25.0',
  'aeris-react-native': '0.25.0',
});
const fail = (message) => {
  throw new Error(`PROFILE: ${message}`);
};
export const archiveName = (item) => `${item.name}-${item.version}.tgz`;
export function validateArtifact(item, name, version) {
  if (
    !item ||
    item.name !== name ||
    item.version !== version ||
    !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')
  )
    fail(`${name} 的名称、固定版本或摘要非法`);
  const spec = item.specifier;
  if (typeof spec !== 'string') fail(`${name} 缺少固定来源`);
  if (spec.startsWith('file:')) {
    if (!spec.slice(5) || !/\.t(?:ar\.gz|gz)$/.test(spec)) fail(`${name} 仅接受固定本地 tarball`);
  } else if (spec.startsWith('https:')) {
    const url = new URL(spec);
    if (url.username || url.password || url.search || url.hash)
      fail('制品 URL 不能包含凭据或查询参数，私有认证请使用 npm registry 配置');
  } else if (spec !== `${name}@${version}`) fail(`${name} 必须使用固定版本或带摘要的 tarball`);
}
export function validateProfile(profile) {
  if (
    !profile ||
    profile.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(profile.baselineId ?? '')
  )
    fail('profile 版本或 baselineId 非法');
  if (
    !Array.isArray(profile.packages) ||
    profile.packages.length !== 4 ||
    new Set(profile.packages.map((p) => p?.name)).size !== 4
  )
    fail('必须提供 URN、工具、Aeris Core/RN 四个包');
  for (const [name, version] of Object.entries(versions))
    validateArtifact(
      profile.packages.find((p) => p.name === name),
      name,
      version,
    );
  validateArtifact(profile.bootstrap, 'create-leo-urn', '0.1.0');
  const cap = profile.aeris;
  if (
    !/^[a-f0-9]{40}$/.test(cap?.source?.ref ?? '') ||
    typeof cap.source.repository !== 'string' ||
    cap.nativeVersion !== '0.25.0' ||
    cap.closing?.verified !== true ||
    cap.closing.protocol !== 'AerisClosingMessageReceiver'
  )
    fail('Aeris 来源或关闭能力不匹配');
  if (cap.source.repository.startsWith('https:')) {
    const url = new URL(cap.source.repository);
    if (url.username || url.password || url.search || url.hash) fail('Git 来源不能包含凭据');
  }
  if (
    !Array.isArray(cap.packages) ||
    cap.packages.length !== 2 ||
    new Set(cap.packages.map((p) => p.name)).size !== 2
  )
    fail('Aeris 来源必须包含 Core/RN 两项');
  for (const name of ['aeris-client-core', 'aeris-react-native']) {
    const p = profile.packages.find((p) => p.name === name),
      c = cap.packages.find((p) => p.name === name);
    if (
      !c ||
      c.version !== p.version ||
      c.sourceRef !== cap.source.ref ||
      c.sha256 !== p.sha256 ||
      c.file !== archiveName(p)
    )
      fail(`${name} 来源/摘要与 Native capability 不一致`);
  }
  return profile;
}
export async function loadProfile(filename) {
  const profile = validateProfile(JSON.parse(await fs.readFile(filename, 'utf8')));
  return { profile, directory: path.dirname(path.resolve(filename)) };
}
export function relocateProfile(profile, from, to) {
  const move = (item) => ({
    ...item,
    specifier: item.specifier.startsWith('file:')
      ? `file:${path.relative(to, path.resolve(from, item.specifier.slice(5)))}`
      : item.specifier,
  });
  return { ...profile, packages: profile.packages.map(move), bootstrap: move(profile.bootstrap) };
}
