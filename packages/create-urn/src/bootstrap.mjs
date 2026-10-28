/** 生成工程中的冷启动入口只使用 Node 标准库，不依赖 node_modules。 */
export const bootstrapScript = `import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

async function prepare() {
const app = path.dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(await fs.readFile(path.join(app, 'urn.profile.json'), 'utf8'));
const item = profile.bootstrap;
if (!item || item.name !== 'create-leo-urn' || item.version !== '0.1.0' || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error('URN bootstrap 来源非法');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'urn-bootstrap-'));
try {
  let archive;
  if (item.specifier?.startsWith('file:')) {
    archive = path.resolve(app, item.specifier.slice(5));
  } else {
    if (item.specifier !== 'create-leo-urn@0.1.0') {
      const url = new URL(item.specifier);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('URN bootstrap 需要固定制品，认证交给 npm 配置');
    }
    const packed = JSON.parse(execFileSync('npm', ['pack', item.specifier, '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).at(-1)?.filename;
    if (!packed || path.basename(packed) !== packed) throw new Error('npm 制品路径非法');
    archive = path.join(temporary, packed);
  }
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  if (digest !== item.sha256) throw new Error('URN bootstrap 制品摘要不匹配');
  // 独立工作目录避免 npm exec 依赖尚未准备好的 App 安装图。
  const output = execFileSync('npm', ['exec', '--yes', '--package=' + archive, '--', 'create-leo-urn', 'prepare', '--app', app], { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  console.log(output.trim());
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
}
try { await prepare(); } catch {
  // npm/Git 原始错误可能包含私有信息，只提供固定诊断。
  console.error('URN 依赖恢复失败：请检查 profile、制品摘要和 npm/Git 读取权限');
  process.exitCode = 1;
}
`;
