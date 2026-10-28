#!/usr/bin/env node
import path from 'node:path';
import { run } from '../dist/cli.mjs';
import { prepareProject } from '../dist/prepare-project.mjs';
import { captureBaseline } from '../dist/project-baseline.mjs';
try {
  const [command, ...args] = process.argv.slice(2);
  if (['prepare', 'baseline'].includes(command)) {
    const options = { app: process.cwd() };
    for (let i = 0; i < args.length; i++) {
      const key = { '--app': 'app', '--output': 'output' }[args[i]];
      if (
        !key ||
        !args[i + 1] ||
        args[i + 1].startsWith('--') ||
        (key === 'output' && command !== 'baseline')
      )
        throw new Error('参数非法：prepare [--app DIR]；baseline [--app DIR] [--output FILE]');
      options[key] = path.resolve(args[++i]);
    }
    console.log(
      JSON.stringify(
        await (command === 'prepare' ? prepareProject(options) : captureBaseline(options)),
        null,
        2,
      ),
    );
  } else {
    if (!command || command === '--help')
      console.log(
        '补充命令：urn prepare [--app DIR]；urn baseline [--app DIR] [--output FILE]，基线生成后须审阅。',
      );
    run(process.argv.slice(2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
