import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MAGIC = Buffer.from('c61fbc03c103191f', 'hex');
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MACHINES = { 'arm64-v8a': [2, 183], x86_64: [2, 62], 'armeabi-v7a': [1, 40], x86: [1, 3] };
const requireValue = (condition, message) => {
  if (!condition) throw new Error(`ANDROID_ARTIFACT: ${message}`);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function safeEntry(name, allowDirectory = false) {
  requireValue(
    typeof name === 'string' && name.length > 0 && !/[\\\x00-\x1f\x7f:*?\[\]]/.test(name),
    `非法归档路径 ${JSON.stringify(name)}`,
  );
  const canonical = allowDirectory && name.endsWith('/') ? name.slice(0, -1) : name;
  requireValue(
    !canonical.startsWith('/') &&
      !canonical.startsWith('-') &&
      canonical.split('/').every((part) => part && part !== '.' && part !== '..'),
    `非法归档路径 ${JSON.stringify(name)}`,
  );
  return canonical;
}
function fileHash(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; )
      hash.update(buffer.subarray(0, read));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function readAt(fd, offset, size, fileSize) {
  requireValue(
    Number.isSafeInteger(offset) &&
      Number.isSafeInteger(size) &&
      offset >= 0 &&
      size >= 0 &&
      offset + size <= fileSize,
    'ZIP 数据范围越界',
  );
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const next = fs.readSync(fd, buffer, read, size - read, offset + read);
    requireValue(next > 0, 'ZIP 文件被截断');
    read += next;
  }
  return buffer;
}
function unzip(args, maxBuffer) {
  try {
    return execFileSync('unzip', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer,
      timeout: 60000,
    });
  } catch (error) {
    throw new Error(`ANDROID_ARTIFACT: unzip 读取失败: ${error.message}`);
  }
}

// 先独立检查中央目录与本地文件头，再用真实 unzip 列表/读取；从不把归档路径写到文件系统。
function readArchive(filename) {
  requireValue(typeof filename === 'string' && filename.length > 0, '必须提供 artifact 路径');
  const resolved = fs.realpathSync(path.resolve(filename));
  const stat = fs.statSync(resolved);
  requireValue(stat.isFile(), 'artifact 必须是文件');
  const artifactSha256 = fileHash(resolved);
  const fd = fs.openSync(resolved, 'r');
  const entries = [];
  const byName = new Map();
  try {
    const tailOffset = Math.max(0, stat.size - 65557);
    const tail = readAt(fd, tailOffset, stat.size - tailOffset, stat.size);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--)
      if (
        tail.readUInt32LE(at) === 0x06054b50 &&
        at + 22 + tail.readUInt16LE(at + 20) === tail.length
      ) {
        eocd = at;
        break;
      }
    requireValue(eocd >= 0, '不是完整的 ZIP 归档');
    const count = tail.readUInt16LE(eocd + 10),
      directorySize = tail.readUInt32LE(eocd + 12),
      directoryOffset = tail.readUInt32LE(eocd + 16);
    requireValue(
      tail.readUInt16LE(eocd + 4) === 0 &&
        tail.readUInt16LE(eocd + 6) === 0 &&
        tail.readUInt16LE(eocd + 8) === count,
      '不支持跨磁盘 ZIP',
    );
    requireValue(
      count > 0 && count < 65535 && directorySize !== 0xffffffff && directoryOffset !== 0xffffffff,
      '不支持空 ZIP 或 ZIP64 归档',
    );
    requireValue(
      directorySize <= MAX_DIRECTORY_BYTES && directoryOffset + directorySize === tailOffset + eocd,
      'ZIP 中央目录范围无效',
    );
    const central = readAt(fd, directoryOffset, directorySize, stat.size);
    let at = 0;
    const ranges = [];
    for (let index = 0; index < count; index++) {
      requireValue(
        at + 46 <= central.length && central.readUInt32LE(at) === 0x02014b50,
        'ZIP 中央目录损坏',
      );
      const flags = central.readUInt16LE(at + 8),
        method = central.readUInt16LE(at + 10),
        compressed = central.readUInt32LE(at + 20),
        size = central.readUInt32LE(at + 24);
      const nameSize = central.readUInt16LE(at + 28),
        extraSize = central.readUInt16LE(at + 30),
        commentSize = central.readUInt16LE(at + 32),
        localOffset = central.readUInt32LE(at + 42);
      requireValue(
        at + 46 + nameSize + extraSize + commentSize <= central.length,
        'ZIP 条目被截断',
      );
      let name;
      try {
        name = decode(central.subarray(at + 46, at + 46 + nameSize));
      } catch {
        throw new Error('ANDROID_ARTIFACT: ZIP 路径不是合法 UTF-8');
      }
      const key = safeEntry(name, true),
        directory = name.endsWith('/');
      requireValue(!byName.has(key), `ZIP 重复条目 ${name}`);
      requireValue(
        !(flags & 1) && !(flags & 0x40) && [0, 8].includes(method),
        `不支持加密或压缩格式: ${name}`,
      );
      requireValue(
        size <= MAX_ENTRY_BYTES &&
          compressed !== 0xffffffff &&
          localOffset !== 0xffffffff &&
          central.readUInt16LE(at + 34) === 0,
        `ZIP 条目超出大小或 ZIP64 边界: ${name}`,
      );
      const fileType = (central.readUInt32LE(at + 38) >>> 16) & 0xf000;
      requireValue([0, 0x8000, 0x4000].includes(fileType), `禁止 ZIP 符号链接或特殊文件: ${name}`);
      requireValue(fileType !== 0x4000 || directory, `ZIP 目录类型与路径不匹配: ${name}`);
      const local = readAt(fd, localOffset, 30, stat.size);
      requireValue(
        local.readUInt32LE(0) === 0x04034b50 &&
          local.readUInt16LE(6) === flags &&
          local.readUInt16LE(8) === method,
        `ZIP 本地文件头不匹配: ${name}`,
      );
      const localNameSize = local.readUInt16LE(26),
        localExtra = local.readUInt16LE(28);
      const localName = readAt(fd, localOffset + 30, localNameSize, stat.size);
      requireValue(
        localName.equals(central.subarray(at + 46, at + 46 + nameSize)),
        `ZIP 本地路径与中央目录不匹配: ${name}`,
      );
      const end = localOffset + 30 + localNameSize + localExtra + compressed;
      requireValue(end <= directoryOffset, `ZIP 文件数据越过中央目录: ${name}`);
      ranges.push([localOffset, end]);
      const entry = { path: name, size, compressedSize: compressed, directory };
      entries.push(entry);
      byName.set(key, entry);
      at += 46 + nameSize + extraSize + commentSize;
    }
    requireValue(at === central.length, 'ZIP 中央目录条目数量不匹配');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
      requireValue(ranges[i][0] >= ranges[i - 1][1], 'ZIP 文件数据重叠');
    for (const entry of entries) {
      const parts = entry.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = byName.get(parts.slice(0, i).join('/'));
        requireValue(!parent || parent.directory, `ZIP 文件与目录冲突: ${entry.path}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  let listed;
  try {
    listed = decode(unzip(['-Z1', resolved], MAX_DIRECTORY_BYTES));
  } catch (error) {
    throw new Error(`ANDROID_ARTIFACT: ZIP 列表读取失败: ${error.message}`);
  }
  if (listed.endsWith('\n')) listed = listed.slice(0, -1);
  requireValue(
    JSON.stringify(listed.split('\n')) === JSON.stringify(entries.map((entry) => entry.path)),
    'unzip 列表与 ZIP 中央目录不一致',
  );
  function read(name) {
    safeEntry(name);
    const entry = byName.get(name);
    requireValue(entry && !entry.directory, `缺少归档文件 ${name}`);
    const bytes = unzip(['-p', resolved, name], MAX_ENTRY_BYTES + 1);
    requireValue(bytes.length === entry.size, `ZIP 解压大小不匹配: ${name}`);
    return bytes;
  }
  return {
    artifact: { path: resolved, size: stat.size, sha256: artifactSha256 },
    entries,
    byName,
    read,
    inspect(name) {
      const bytes = read(name);
      return { path: name, size: bytes.length, sha256: sha256(bytes) };
    },
    unchanged() {
      requireValue(fileHash(resolved) === artifactSha256, '审计过程中 artifact 发生变化');
    },
  };
}
function requestedStrings(value, description) {
  requireValue(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.length > 0) &&
      new Set(value).size === value.length,
    `${description} 必须是不重复字符串数组`,
  );
  return [...value].sort(lexical);
}
function inspectNative(archive, prefix) {
  const files = archive.entries.filter(
    (entry) => !entry.directory && entry.path.startsWith(prefix) && entry.path.endsWith('.so'),
  );
  return files
    .map((entry) => {
      const parts = entry.path.slice(prefix.length).split('/');
      requireValue(
        parts.length === 2 && MACHINES[parts[0]],
        `不支持的 native ABI 路径: ${entry.path}`,
      );
      const [abi, library] = parts,
        expected = MACHINES[abi],
        bytes = archive.read(entry.path);
      requireValue(
        bytes.length >= 20 &&
          bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
          bytes[4] === expected[0] &&
          bytes[5] === 1 &&
          bytes[6] === 1 &&
          bytes.readUInt16LE(16) === 3 &&
          bytes.readUInt16LE(18) === expected[1],
        `ELF 架构与 native ABI 不匹配: ${entry.path}`,
      );
      return {
        path: entry.path,
        size: bytes.length,
        sha256: sha256(bytes),
        abi,
        library,
        elfClass: expected[0] === 2 ? 64 : 32,
        elfMachine: expected[1],
      };
    })
    .sort((a, b) => lexical(a.path, b.path));
}
function bundleExpectation(bundle) {
  if (bundle === undefined) return {};
  if (typeof bundle === 'string') return { path: bundle };
  requireValue(
    bundle && typeof bundle === 'object' && !Array.isArray(bundle),
    'bundle 必须是文件路径或 {path, sha256, entry}',
  );
  return bundle;
}

/** 只审计已有 APK/AAB；不启动 Hermes、不验证签名、不构建或发布。bundle 可指定外部文件或 {path, sha256, entry}。 */
export function auditAndroidArtifact({ artifact, bundle, abis, resources = [] } = {}) {
  const format = path
    .extname(artifact ?? '')
    .slice(1)
    .toLowerCase();
  requireValue(['apk', 'aab'].includes(format), 'artifact 必须为 APK 或 AAB');
  const archive = readArchive(artifact),
    prefix = format === 'aab' ? 'base/' : '';
  const manifest = archive.inspect(
    prefix + (format === 'aab' ? 'manifest/AndroidManifest.xml' : 'AndroidManifest.xml'),
  );
  requireValue(manifest.size > 0, 'AndroidManifest.xml 不能为空');
  const expectation = bundleExpectation(bundle),
    bundlePath = expectation.entry ?? `${prefix}assets/index.android.bundle`;
  safeEntry(bundlePath);
  requireValue(bundlePath.startsWith(`${prefix}assets/`), 'bundle 必须来自当前模块 assets 路径');
  const bundleBytes = archive.read(bundlePath);
  requireValue(
    bundleBytes.subarray(0, MAGIC.length).equals(MAGIC),
    `bundle 不是 Hermes bytecode magic: ${bundlePath}`,
  );
  const bundleInfo = {
    path: bundlePath,
    size: bundleBytes.length,
    sha256: sha256(bundleBytes),
    hermesMagic: MAGIC.toString('hex'),
  };
  if (expectation.sha256 !== undefined)
    requireValue(
      typeof expectation.sha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(expectation.sha256) &&
        expectation.sha256.toLowerCase() === bundleInfo.sha256,
      'bundle SHA256 与预期不匹配',
    );
  if (expectation.path !== undefined) {
    requireValue(
      typeof expectation.path === 'string' && fs.statSync(expectation.path).isFile(),
      'bundle 同源文件必须存在',
    );
    requireValue(
      fileHash(expectation.path) === bundleInfo.sha256,
      'bundle SHA256 与外部同源文件不匹配',
    );
    bundleInfo.sourcePath = fs.realpathSync(expectation.path);
  }
  const dexPrefix = format === 'aab' ? 'base/dex/' : '';
  const dex = archive.entries
    .filter(
      (entry) =>
        !entry.directory &&
        entry.path.startsWith(dexPrefix) &&
        !entry.path.slice(dexPrefix.length).includes('/') &&
        entry.path.endsWith('.dex'),
    )
    .map((entry) => {
      requireValue(
        new RegExp(`^${dexPrefix}classes(?:[2-9]|[1-9][0-9]+)?\\.dex$`).test(entry.path),
        `DEX 文件名无效: ${entry.path}`,
      );
      const bytes = archive.read(entry.path);
      requireValue(
        bytes.length >= 8 && /^dex\n[0-9]{3}\x00$/.test(bytes.subarray(0, 8).toString('latin1')),
        `DEX magic 无效: ${entry.path}`,
      );
      return { path: entry.path, size: bytes.length, sha256: sha256(bytes) };
    })
    .sort((a, b) => lexical(a.path, b.path));
  requireValue(
    dex.some((entry) => entry.path === `${dexPrefix}classes.dex`),
    '缺少主 DEX classes.dex',
  );
  const nativeLibraries = inspectNative(archive, `${prefix}lib/`),
    actualAbis = [...new Set(nativeLibraries.map((entry) => entry.abi))].sort(lexical);
  requireValue(actualAbis.length > 0, '没有 native ABI 库');
  if (abis !== undefined)
    requireValue(
      JSON.stringify(requestedStrings(abis, 'abis')) === JSON.stringify(actualAbis),
      `native ABI 集合不匹配: ${actualAbis.join(',')}`,
    );
  for (const abi of actualAbis)
    for (const library of ['liburnbindings.so', 'libhermesvm.so', 'libreactnative.so'])
      requireValue(
        nativeLibraries.some((entry) => entry.abi === abi && entry.library === library),
        `ABI ${abi} 缺少 ${library}`,
      );
  const requested = requestedStrings(resources, 'resources').map((name) => {
    safeEntry(name);
    return prefix && !name.startsWith(prefix) ? prefix + name : name;
  });
  for (const name of requested)
    requireValue(
      name !== bundlePath &&
        (name.startsWith(`${prefix}res/`) ||
          name.startsWith(`${prefix}assets/`) ||
          name === `${prefix}resources.arsc` ||
          name === `${prefix}resources.pb`),
      `RN 资源路径无效: ${name}`,
    );
  const resourceEntries = archive.entries.filter(
    (entry) =>
      !entry.directory &&
      entry.path !== bundlePath &&
      (entry.path.startsWith(`${prefix}res/`) ||
        entry.path.startsWith(`${prefix}assets/`) ||
        entry.path === `${prefix}resources.arsc` ||
        entry.path === `${prefix}resources.pb`),
  );
  for (const name of requested)
    requireValue(
      resourceEntries.some((entry) => entry.path === name),
      `缺少 RN 资源 ${name}`,
    );
  const result = {
    ok: true,
    schemaVersion: 1,
    format,
    artifact: archive.artifact,
    bundle: bundleInfo,
    abis: actualAbis,
    nativeLibraries,
    manifest,
    dex,
    resources: resourceEntries
      .map((entry) => ({
        ...archive.inspect(entry.path),
        required: requested.includes(entry.path),
      }))
      .sort((a, b) => lexical(a.path, b.path)),
    entries: archive.entries
      .filter((entry) => !entry.directory)
      .map(({ path: name, size }) => ({ path: name, size }))
      .sort((a, b) => lexical(a.path, b.path)),
    verification: { archiveOnly: true, hermesExecution: false, signatureVerified: false },
  };
  if (format === 'aab') result.bundleConfig = archive.inspect('BundleConfig.pb');
  archive.unchanged();
  return result;
}

/** AAR Maven 候选静态检查；requiredClasses 支持 Java 全限定名或 .class 归档路径。 */
export function auditAndroidAar({ artifact, requiredClasses = [], requiredNativeAbis = [] } = {}) {
  requireValue(path.extname(artifact ?? '').toLowerCase() === '.aar', 'artifact 必须为 AAR');
  const archive = readArchive(artifact),
    manifest = archive.inspect('AndroidManifest.xml'),
    classesJar = archive.inspect('classes.jar');
  requireValue(manifest.size > 0, 'AndroidManifest.xml 不能为空');
  const consumerNames = ['proguard.txt', 'consumer-rules.pro'].filter((name) =>
    archive.byName.has(name),
  );
  requireValue(consumerNames.length > 0, 'AAR 缺少 consumer ProGuard 规则');
  const consumerRules = consumerNames.map((name) => archive.inspect(name));
  requireValue(
    consumerRules.some((entry) => entry.size > 0),
    'AAR consumer ProGuard 规则不能为空',
  );
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'urn-aar-classes-'));
  let classes;
  try {
    const jar = path.join(work, 'classes.jar');
    fs.writeFileSync(jar, archive.read('classes.jar'), { flag: 'wx' });
    const nested = readArchive(jar),
      names = nested.entries
        .filter((entry) => !entry.directory && entry.path.endsWith('.class'))
        .map((entry) => entry.path)
        .sort(lexical);
    requireValue(names.length > 0, 'classes.jar 没有 class 条目');
    const required = requestedStrings(requiredClasses, 'requiredClasses').map((name) =>
      name.includes('/') ? name : name.replace(/\.class$/, '').replaceAll('.', '/') + '.class',
    );
    for (const name of required) {
      safeEntry(name);
      requireValue(names.includes(name), `classes.jar 缺少 ${name}`);
    }
    // 读取所有 class，验证真实 classfile magic 与 CRC，而非只检查文件名。
    for (const name of names)
      requireValue(
        nested.read(name).subarray(0, 4).equals(Buffer.from('cafebabe', 'hex')),
        `无效 classfile magic: ${name}`,
      );
    classes = { count: names.length, entries: names, required };
    nested.unchanged();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const nativeLibraries = inspectNative(archive, 'jni/'),
    actualAbis = [...new Set(nativeLibraries.map((entry) => entry.abi))].sort(lexical);
  for (const abi of requestedStrings(requiredNativeAbis, 'requiredNativeAbis'))
    requireValue(MACHINES[abi] && actualAbis.includes(abi), `AAR 缺少 native ABI ${abi}`);
  archive.unchanged();
  return {
    ok: true,
    schemaVersion: 1,
    format: 'aar',
    artifact: archive.artifact,
    manifest,
    classesJar,
    classes,
    consumerRules,
    abis: actualAbis,
    nativeLibraries,
    verification: { archiveOnly: true, bytecodeExecution: false, signatureVerified: false },
  };
}

/** 检查归档内每个 ELF 的 LOAD 段；不替代 zipalign、签名检查或16KiB设备运行。 */
export function auditAndroidPageAlignment({ artifact } = {}) {
  const archive = readArchive(artifact);
  const format = path.extname(artifact).slice(1).toLowerCase();
  requireValue(['apk', 'aab', 'aar'].includes(format), 'artifact 必须为 APK、AAB 或 AAR');
  // AAB的动态feature也能携带原生库，不能只检查base模块。
  const prefixes =
    format === 'aab'
      ? [
          ...new Set(
            archive.entries.map((entry) => entry.path.match(/^[^/]+\/lib\//)?.[0]).filter(Boolean),
          ),
        ]
      : [format === 'aar' ? 'jni/' : 'lib/'];
  const nativeLibraries = prefixes.flatMap((prefix) => inspectNative(archive, prefix));
  requireValue(nativeLibraries.length > 0, '归档内没有 ELF 原生库');
  for (const library of nativeLibraries) {
    const bytes = archive.read(library.path);
    const wide = library.elfClass === 64;
    requireValue(bytes.length >= (wide ? 64 : 52), `ELF header 被截断: ${library.path}`);
    const offset = wide ? bytes.readBigUInt64LE(32) : BigInt(bytes.readUInt32LE(28));
    const entrySize = bytes.readUInt16LE(wide ? 54 : 42);
    const count = bytes.readUInt16LE(wide ? 56 : 44);
    requireValue(
      count > 0 &&
        entrySize >= (wide ? 56 : 32) &&
        offset + BigInt(entrySize) * BigInt(count) <= BigInt(bytes.length),
      `ELF program header 越界: ${library.path}`,
    );
    let loadSegments = 0;
    for (let index = 0; index < count; index++) {
      const at = Number(offset) + index * entrySize;
      if (bytes.readUInt32LE(at) !== 1) continue;
      loadSegments++;
      const alignment = wide ? bytes.readBigUInt64LE(at + 48) : BigInt(bytes.readUInt32LE(at + 28));
      const fileOffset = wide ? bytes.readBigUInt64LE(at + 8) : BigInt(bytes.readUInt32LE(at + 4));
      const address = wide ? bytes.readBigUInt64LE(at + 16) : BigInt(bytes.readUInt32LE(at + 8));
      requireValue(
        alignment >= 16384n &&
          (alignment & (alignment - 1n)) === 0n &&
          fileOffset % 16384n === address % 16384n,
        `ELF LOAD 段未满足16KiB对齐: ${library.path}`,
      );
    }
    requireValue(loadSegments > 0, `ELF 没有 LOAD 段: ${library.path}`);
    library.loadSegments = loadSegments;
  }
  archive.unchanged();
  return {
    ok: true,
    pageSize: 16384,
    artifact: archive.artifact,
    nativeLibraries,
    deviceExecuted: false,
  };
}
