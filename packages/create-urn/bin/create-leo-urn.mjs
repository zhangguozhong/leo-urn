#!/usr/bin/env node
import path from 'node:path';
import { scaffold } from '../src/scaffold.mjs';
import { prepareProject } from '../lib/prepare-project.mjs';
const help = `create-leo-urn：为已有 iOS App 创建 URN 代码工程
用法：
  create-leo-urn OUTPUT --ios-project FILE.xcodeproj --target NAME --profile FILE [--name NAME] [--install] [--dry-run]
  create-leo-urn prepare --app DIR
当前尚未发布，请从固定本地/私有 tarball 启动。目录名由 OUTPUT 决定；不覆盖原生工程。`;
try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log(help);
  } else if (args[0] === 'prepare') {
    if (args.length !== 3 || args[1] !== '--app') throw new Error(help);
    console.log(JSON.stringify(await prepareProject({ app: path.resolve(args[2]) }), null, 2));
  } else {
    const options = { directory: args.shift() };
    const used = new Set();
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (used.has(flag)) throw new Error(`重复参数 ${flag}`);
      used.add(flag);
      if (['--install', '--dry-run'].includes(flag)) {
        options[flag === '--install' ? 'install' : 'dryRun'] = true;
        continue;
      }
      const key = {
        '--ios-project': 'iosProject',
        '--target': 'target',
        '--profile': 'profile',
        '--name': 'name',
      }[flag];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error(`未知或缺值参数 ${flag}`);
      options[key] = args[++i];
    }
    if (options.install && options.dryRun) throw new Error('--install 与 --dry-run 不能同时使用');
    console.log(JSON.stringify(await scaffold(options), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
